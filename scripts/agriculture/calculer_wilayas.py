#!/usr/bin/env python3
"""Extrait le tableau « Total céréales d'hiver » de la Série B 2019 du MADR.

Le script échoue volontairement si la structure ou les totaux ne correspondent
pas au document attendu : il ne publie jamais une extraction partielle.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import urllib.request
from pathlib import Path

SOURCE_URL = "https://madr.gov.dz/wp-content/uploads/2022/04/SERIE-B-2019.pdf"
EXPECTED_TOTAL_QX = 56_259_902
EXPECTED_WILAYAS = 48
# Code officiel de wilaya du découpage historique utilisé dans le rapport 2019.
WILAYAS = {
    "ADRAR": "01", "CHLEF": "02", "LAGHOUAT": "03", "O.E.BOUAGHI": "04",
    "BATNA": "05", "BEJAIA": "06", "BISKRA": "07", "BECHAR": "08",
    "BLIDA": "09", "BOUIRA": "10", "TAMANRASSET": "11", "TEBESSA": "12",
    "TLEMCEN": "13", "TIARET": "14", "TIZI-OUZOU": "15", "ALGER": "16",
    "DJELFA": "17", "JIJEL": "18", "SETIF": "19", "SAIDA": "20",
    "SKIKDA": "21", "S.B.ABBES": "22", "ANNABA": "23", "GUELMA": "24",
    "CONSTANTINE": "25", "MEDEA": "26", "MOSTAGANEM": "27", "M'SILA": "28",
    "MASCARA": "29", "OUARGLA": "30", "ORAN": "31", "EL-BAYADH": "32",
    "ILLIZI": "33", "B.B.ARRERIDJ": "34", "BOUMERDES": "35", "EL-TARF": "36",
    "TINDOUF": "37", "TISSEMSILT": "38", "EL-OUED": "39", "KHENCHELA": "40",
    "SOUK-AHRAS": "41", "TIPAZA": "42", "MILA": "43", "AIN-DEFLA": "44",
    "NAAMA": "45", "A.TEMOUCHENT": "46", "GHARDAIA": "47", "RELIZANE": "48",
}
FIELDS = [
    "code_wilaya", "wilaya", "annee",
    "cereales_hiver_superficie_emblavee_ha",
    "cereales_hiver_superficie_recoltee_ha",
    "cereales_hiver_taux_recolte_pct",
    "cereales_hiver_production_qx",
    "cereales_hiver_rendement_qx_ha",
]
NUMBER = re.compile(r"^-?[0-9][0-9 ]*(?:,[0-9]+)?$")


def number(value: object) -> float | int:
    text = str(value or "").replace("\u00a0", " ").strip()
    if not NUMBER.fullmatch(text):
        raise ValueError(f"Valeur numérique invalide : {value!r}")
    parsed = float(text.replace(" ", "").replace(",", "."))
    return int(parsed) if parsed.is_integer() else parsed


def wilaya_name(value: object) -> str | None:
    text = re.sub(r"^\s*\d+\s+", "", str(value or "")).strip().upper()
    return text if text in WILAYAS else None


def normalize_table(rows: list[list[object]]) -> list[dict[str, object]]:
    """Prend les lignes d'une table PDF après extraction des cellules."""
    result = []
    for row in rows:
        if not row or len(row) < 11:
            continue
        name = wilaya_name(row[0])
        if not name:
            continue
        values = [number(v) for v in row[6:11]]
        result.append(dict(zip(FIELDS, [WILAYAS[name], name, 2019, *values])))
    if len(result) != EXPECTED_WILAYAS:
        raise ValueError(f"{len(result)} wilayas extraites, {EXPECTED_WILAYAS} attendues")
    if len({row["code_wilaya"] for row in result}) != EXPECTED_WILAYAS:
        raise ValueError("Codes de wilaya dupliqués")
    total = sum(int(row["cereales_hiver_production_qx"]) for row in result)
    if total != EXPECTED_TOTAL_QX:
        raise ValueError(f"Total extrait {total:,} QX != total officiel {EXPECTED_TOTAL_QX:,} QX")
    return result


def extract(pdf_path: Path) -> list[dict[str, object]]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise RuntimeError("Installer pdfplumber (requirements agriculture)") from exc
    with pdfplumber.open(pdf_path) as pdf:
        candidates = []
        diagnostics = []
        for page_number, page in enumerate(pdf.pages, start=1):
            text = (page.extract_text() or "").upper()
            if "CEREAL" not in text:
                continue
            tables = page.extract_tables() or []
            diagnostics.append({
                "page": page_number,
                "text": text[:1800],
                "tables": tables[:3],
            })
            for table in tables:
                try:
                    candidates.append(normalize_table(table))
                except (ValueError, TypeError):
                    continue
        if not candidates:
            print("DIAGNOSTIC_EXTRACTION=" + json.dumps(diagnostics, ensure_ascii=False, default=str)[:18000])
            raise ValueError("Aucune table céréales ne contient 48 wilayas et le total officiel attendu")
    return candidates[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--sortie", type=Path, required=True)
    args = parser.parse_args()
    args.sortie.mkdir(parents=True, exist_ok=True)
    pdf_path = args.pdf or args.sortie / "serie-b-2019.pdf"
    if args.pdf is None:
        urllib.request.urlretrieve(SOURCE_URL, pdf_path)
    rows = extract(pdf_path)
    digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    (args.sortie / "agriculture-wilayas-2019.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (args.sortie / "agriculture-wilayas-2019.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    report = {
        "source": "Ministère de l'Agriculture et du Développement Rural — Série B 2019",
        "source_url": SOURCE_URL,
        "annee_campagne": "2018/2019",
        "annee_statistique": 2019,
        "decoupage": "48 wilayas historiques",
        "indicateur": "Total céréales d'hiver",
        "unites": {"superficies": "ha", "production": "qx", "rendement": "qx/ha"},
        "nb_wilayas": len(rows),
        "production_totale_qx": sum(int(row["cereales_hiver_production_qx"]) for row in rows),
        "empreinte_sha256_pdf": digest,
        "methode": "Extraction PDF, validation de 48 codes uniques et rapprochement du total national publié.",
        "limite": "Ne pas réaffecter les valeurs aux 69 wilayas actuelles sans données communales ou table officielle de ventilation.",
    }
    (args.sortie / "rapport.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
