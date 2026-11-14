"""
Population par wilaya (69 wilayas), de 2015 à 2030, à partir de WorldPop « Global 2 » (R2025A, CC BY 4.0).

La grille WorldPop (100 m, « constrained » : population répartie sur les zones bâties) est additionnée
à l'intérieur des contours des wilayas publiés sur data-dz (`divisions-administratives`, fichier
`wilaya-boundaries`, GeoAlgeria, ODbL). Résultat au format long : une ligne par wilaya et par année.

    python -m venv .venv && .venv/bin/pip install -r scripts/population/requirements.txt
    .venv/bin/python scripts/population/calculer.py [--annees 2015-2030] [--cache DOSSIER] [--sortie DOSSIER]

Écrit dans le dossier de sortie (par défaut scripts/population/sortie/, ignoré par git) :
  - population-wilayas.json et .csv : code_wilaya, wilaya, wilaya_ar, annee, valeur (habitants), unite, type ;
  - rapport.json : totaux nationaux, part de la population tombée hors des contours, sources.

Ce sont des estimations par modèle (WorldPop), pas un recensement : `type` vaut « estimation »
jusqu'à ANNEE_DERNIERE_ESTIMATION, puis « projection ».
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window

URL_API = "https://api.data-dz.com"
URL_WORLDPOP = (
    "https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/{annee}/DZA/v1/100m/constrained/"
    "dza_pop_{annee}_CN_100m_R2025A_v1.tif"
)
DOI_WORLDPOP = "https://doi.org/10.5258/SOTON/WP00839"
# Dernière année calée sur des données observées dans la version R2025A ; les suivantes sont projetées.
ANNEE_DERNIERE_ESTIMATION = 2025
# L'API refuse l'agent par défaut de urllib (« Python-urllib ») : le script se présente sous son nom.
AGENT = "data-dz-population/1.0 (+https://github.com/new-algeria/api-dz-backend)"
HAUTEUR_BLOC = 1024  # lignes de la grille lues à la fois (mémoire raisonnable)

DOSSIER = Path(__file__).resolve().parent


def telecharger(url: str, destination: Path) -> Path:
    """Télécharge une fois (le fichier en cache est réutilisé), en passant par un fichier temporaire."""
    if destination.exists() and destination.stat().st_size > 0:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporaire = destination.with_suffix(destination.suffix + ".part")
    print(f"Téléchargement de {url}")
    requete = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(requete, timeout=120) as reponse, open(temporaire, "wb") as fichier:
        while bloc := reponse.read(1 << 20):
            fichier.write(bloc)
    temporaire.replace(destination)
    return destination


def charger_wilayas(cache: Path) -> tuple[list[dict], dict[int, dict]]:
    """Contours (GeoJSON) et noms des 69 wilayas, depuis l'API publique de data-dz."""
    base = f"{URL_API}/v1/datasets/divisions-administratives/download"
    contours = telecharger(f"{base}?format=geojson&file=wilaya-boundaries&inline=1", cache / "wilaya-boundaries.geojson")
    noms = telecharger(f"{base}?format=json&file=wilayas&inline=1", cache / "wilayas.json")
    entites = json.loads(contours.read_text(encoding="utf-8"))["features"]
    liste = json.loads(noms.read_text(encoding="utf-8"))["wilayas"]
    par_code = {int(w["code"]): w for w in liste}
    codes = sorted(int(e["properties"]["code"]) for e in entites)
    if codes != sorted(par_code) or len(codes) != 69:
        sys.exit(f"Contours et noms des wilayas ne correspondent pas ({len(codes)} contours, {len(par_code)} noms).")
    return entites, par_code


def masque_wilayas(entites: list[dict], profil: dict) -> np.ndarray:
    """Grille du même format que WorldPop où chaque cellule porte le code de sa wilaya (0 = hors contours)."""
    formes = ((e["geometry"], int(e["properties"]["code"])) for e in entites)
    return rasterize(
        formes,
        out_shape=(profil["height"], profil["width"]),
        transform=profil["transform"],
        fill=0,
        dtype="uint8",
        all_touched=False,
    )


def sommer(chemin: Path, masque: np.ndarray) -> tuple[np.ndarray, float]:
    """Population par code de wilaya (indice = code) et population hors contours, bloc par bloc."""
    totaux = np.zeros(256, dtype=np.float64)
    with rasterio.open(chemin) as grille:
        absente = grille.nodata
        for debut in range(0, grille.height, HAUTEUR_BLOC):
            hauteur = min(HAUTEUR_BLOC, grille.height - debut)
            valeurs = grille.read(1, window=Window(0, debut, grille.width, hauteur)).astype(np.float64)
            codes = masque[debut : debut + hauteur]
            valides = np.isfinite(valeurs) & (valeurs > 0)
            if absente is not None:
                valides &= valeurs != absente
            totaux += np.bincount(codes[valides], weights=valeurs[valides], minlength=256)
    return totaux, float(totaux[0])


def main() -> None:
    arguments = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    arguments.add_argument("--annees", default="2015-2030", help="ex. 2015-2030 ou 2020")
    arguments.add_argument("--cache", type=Path, default=DOSSIER / "cache")
    arguments.add_argument("--sortie", type=Path, default=DOSSIER / "sortie")
    options = arguments.parse_args()

    debut, _, fin = options.annees.partition("-")
    annees = list(range(int(debut), int(fin or debut) + 1))
    entites, noms = charger_wilayas(options.cache)

    lignes: list[dict] = []
    nationaux: dict[int, dict] = {}
    masque = None
    profil_reference = None
    for annee in annees:
        chemin = telecharger(URL_WORLDPOP.format(annee=annee), options.cache / f"dza_pop_{annee}_CN_100m_R2025A_v1.tif")
        with rasterio.open(chemin) as grille:
            profil = {"height": grille.height, "width": grille.width, "transform": grille.transform, "crs": str(grille.crs)}
        # Toutes les années partagent la même grille : le masque des wilayas n'est calculé qu'une fois.
        if masque is None:
            masque, profil_reference = masque_wilayas(entites, profil), profil
        elif profil != profil_reference:
            sys.exit(f"La grille {annee} diffère de celle de {annees[0]} : masque à recalculer.")

        totaux, hors = sommer(chemin, masque)
        total = float(totaux.sum())
        nationaux[annee] = {"total": round(total), "hors_contours": round(hors), "part_hors_contours": round(hors / total, 5) if total else None}
        print(f"{annee} : {total:,.0f} habitants, dont {hors:,.0f} hors des contours ({nationaux[annee]['part_hors_contours']:.3%})")
        for code in sorted(noms):
            lignes.append(
                {
                    "code_wilaya": f"{code:02d}",
                    "wilaya": noms[code]["name_fr"],
                    "wilaya_ar": noms[code]["name_ar"],
                    "annee": annee,
                    # « valeur » + « unite » : convention des séries de data-dz (carte du catalogue, visuel automatique).
                    "valeur": int(round(totaux[code])),
                    "unite": "habitants",
                    "type": "estimation" if annee <= ANNEE_DERNIERE_ESTIMATION else "projection",
                }
            )

    options.sortie.mkdir(parents=True, exist_ok=True)
    (options.sortie / "population-wilayas.json").write_text(json.dumps(lignes, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    with open(options.sortie / "population-wilayas.csv", "w", newline="", encoding="utf-8") as fichier:
        ecrivain = csv.DictWriter(fichier, fieldnames=list(lignes[0]))
        ecrivain.writeheader()
        ecrivain.writerows(lignes)
    rapport = {
        "genere_le": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "annees": annees,
        "nb_wilayas": len(noms),
        "nationaux": nationaux,
        "sources": {
            "population": {"nom": "WorldPop Global 2 (R2025A v1), 100 m, constrained", "licence": "CC-BY-4.0", "doi": DOI_WORLDPOP},
            "contours": {"nom": "GeoAlgeria, via data-dz (divisions-administratives / wilaya-boundaries)", "licence": "ODbL-1.0"},
        },
    }
    (options.sortie / "rapport.json").write_text(json.dumps(rapport, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(lignes)} lignes écrites dans {options.sortie}")


if __name__ == "__main__":
    main()
