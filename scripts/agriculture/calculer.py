#!/usr/bin/env python3
"""Construit les séries agricoles algériennes depuis le bulk FAOSTAT QCL."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SOURCE_URL = "https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_All_Data_(Normalized).zip"
SOURCE_PAGE = "https://www.fao.org/faostat/en/#data/QCL"
SOURCE_NAME = "FAOSTAT — Crops and livestock products (QCL)"
AGENT = "Data-DZ-Agriculture/1.0 (+https://github.com/new-algeria/api-dz-backend)"
FICHIERS = {
    "series": "agriculture-algerie-series",
    "indicateurs": "agriculture-algerie-indicateurs",
    "qualite": "agriculture-algerie-qualite",
}


def nombre(valeur: Any) -> float | None:
    if valeur is None:
        return None
    texte = str(valeur).strip().replace(",", ".")
    if not texte or texte in {"<NA>", "NA", "nan", "NaN"}:
        return None
    try:
        resultat = float(texte)
    except ValueError:
        return None
    return resultat if resultat == resultat and abs(resultat) != float("inf") else None


def normaliser_ligne(ligne: dict[str, str]) -> dict[str, Any] | None:
    """Normalise une ligne FAOSTAT sans convertir ni additionner des unités différentes."""
    if (ligne.get("Area") or "").strip().casefold() != "algeria":
        return None
    annee = int(ligne["Year"]) if (ligne.get("Year") or "").strip().isdigit() else None
    valeur = nombre(ligne.get("Value"))
    if annee is None or valeur is None:
        return None
    return {
        "annee": annee,
        "code_zone": (ligne.get("Area Code (M49)") or ligne.get("Area Code") or "").strip(),
        "zone": (ligne.get("Area") or "").strip(),
        "code_element": (ligne.get("Element Code") or "").strip(),
        "indicateur": (ligne.get("Element") or "").strip(),
        "code_item": (ligne.get("Item Code (CPC)") or ligne.get("Item Code") or "").strip(),
        "produit": (ligne.get("Item") or "").strip(),
        "unite": (ligne.get("Unit") or "").strip(),
        "valeur": valeur,
        "code_qualite": (ligne.get("Flag") or "").strip(),
        "qualite": (ligne.get("Flag Description") or "").strip(),
        "note": (ligne.get("Note") or "").strip(),
    }


def construire_sorties(lignes: list[dict[str, str]]) -> dict[str, Any]:
    series = []
    for ligne in lignes:
        normalisee = normaliser_ligne(ligne)
        if normalisee is not None:
            series.append(normalisee)
    series.sort(key=lambda x: (x["annee"], x["produit"], x["indicateur"]))
    if not series:
        raise ValueError("Aucune ligne FAOSTAT pour Algeria : schéma ou source inattendus.")

    annees = [x["annee"] for x in series]
    produits = sorted({x["produit"] for x in series})
    elements = sorted({x["indicateur"] for x in series})
    qualite = []
    compte_qualite = Counter((x["code_qualite"], x["qualite"]) for x in series)
    for (code, libelle), total in sorted(compte_qualite.items()):
        qualite.append({
            "code_qualite": code or "NON_RENSEIGNE",
            "qualite": libelle or "Non renseignée",
            "nb_observations": total,
        })

    par_element = Counter(x["indicateur"] for x in series)
    indicateurs = [
        {"indicateur": "premiere_annee", "valeur": min(annees), "unite": "année"},
        {"indicateur": "derniere_annee", "valeur": max(annees), "unite": "année"},
        {"indicateur": "nb_observations", "valeur": len(series), "unite": "observations"},
        {"indicateur": "nb_produits", "valeur": len(produits), "unite": "produits"},
        {"indicateur": "nb_types_indicateurs", "valeur": len(elements), "unite": "indicateurs"},
    ]
    for element, total in sorted(par_element.items()):
        indicateurs.append({
            "indicateur": "observations — " + element,
            "valeur": total,
            "unite": "observations",
        })
    return {
        "series": series,
        "indicateurs": indicateurs,
        "qualite": qualite,
        "premiere_annee": min(annees),
        "derniere_annee": max(annees),
        "nb_observations": len(series),
        "nb_produits": len(produits),
        "nb_types_indicateurs": len(elements),
    }


def telecharger(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    requete = urllib.request.Request(url, headers={"User-Agent": AGENT})
    temporaire = destination.with_suffix(destination.suffix + ".part")
    try:
        with urllib.request.urlopen(requete, timeout=300) as reponse, temporaire.open("wb") as fichier:
            while bloc := reponse.read(1024 * 1024):
                fichier.write(bloc)
        temporaire.replace(destination)
    except Exception:
        temporaire.unlink(missing_ok=True)
        raise


def lire_archive(archive: Path) -> tuple[list[dict[str, str]], str]:
    empreinte = hashlib.sha256()
    with archive.open("rb") as fichier:
        for bloc in iter(lambda: fichier.read(1024 * 1024), b""):
            empreinte.update(bloc)
    with zipfile.ZipFile(archive) as zf:
        noms = [n for n in zf.namelist() if n.lower().endswith(".csv") and "flag" not in n.lower()]
        if not noms:
            raise ValueError("Aucun CSV principal dans l'archive FAOSTAT.")
        nom = max(noms, key=lambda n: zf.getinfo(n).file_size)
        with zf.open(nom) as brut:
            texte = io.TextIOWrapper(brut, encoding="utf-8-sig", errors="replace", newline="")
            lecteur = csv.DictReader(texte)
            requis = {"Area", "Year", "Element", "Item", "Unit", "Value"}
            if not lecteur.fieldnames or not requis.issubset(set(lecteur.fieldnames)):
                raise ValueError("Colonnes FAOSTAT inattendues : " + str(lecteur.fieldnames))
            lignes = [ligne for ligne in lecteur if (ligne.get("Area") or "").strip().casefold() == "algeria"]
    return lignes, empreinte.hexdigest()


def ecrire(sortie: Path, nom: str, lignes: list[dict[str, Any]]) -> None:
    sortie.mkdir(parents=True, exist_ok=True)
    (sortie / (nom + ".json")).write_text(
        json.dumps(lignes, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    champs = list(lignes[0].keys()) if lignes else ["indicateur", "valeur", "unite"]
    with (sortie / (nom + ".csv")).open("w", encoding="utf-8-sig", newline="") as fichier:
        writer = csv.DictWriter(fichier, fieldnames=champs, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(lignes)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=Path(".cache/agriculture"))
    parser.add_argument("--sortie", type=Path, default=Path("sortie"))
    args = parser.parse_args()
    archive = args.cache / "faostat-qcl.zip"
    print("Source FAOSTAT : téléchargement du bulk QCL (cultures et produits de l'élevage)…", flush=True)
    if not archive.exists() or archive.stat().st_size == 0:
        telecharger(SOURCE_URL, archive)
    lignes, empreinte = lire_archive(archive)
    resultat = construire_sorties(lignes)
    for cle, nom in FICHIERS.items():
        ecrire(args.sortie, nom, resultat[cle])
    rapport = {
        "source": SOURCE_NAME,
        "source_url": SOURCE_PAGE,
        "api_url": SOURCE_URL,
        "licence": "CC BY 4.0 IGO",
        "empreinte_sha256_archive": empreinte,
        "filtres": {"area": "Algeria", "domain": "QCL"},
        "methode": "Bulk CSV normalisé FAOSTAT ; conservation des observations nationales par année, produit, élément et unité. Aucune somme entre unités ou produits distincts.",
        **{k: resultat[k] for k in (
            "premiere_annee", "derniere_annee", "nb_observations",
            "nb_produits", "nb_types_indicateurs"
        )},
        "nb_lignes_series": len(resultat["series"]),
        "nb_lignes_indicateurs": len(resultat["indicateurs"]),
        "nb_lignes_qualite": len(resultat["qualite"]),
        "date_calcul_utc": datetime.now(timezone.utc).isoformat(),
    }
    (args.sortie / "rapport.json").write_text(json.dumps(rapport, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"FAOSTAT Algérie : {rapport['nb_observations']} observations, "
        f"{rapport['nb_produits']} produits, {rapport['premiere_annee']}–{rapport['derniere_annee']}.",
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as erreur:
        print(f"ERREUR AGRICULTURE FAOSTAT : {erreur}", file=sys.stderr)
        raise
