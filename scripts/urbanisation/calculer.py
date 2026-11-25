"""
Surface bâtie par wilaya (69 wilayas), de 1975 à 2030 par pas de 5 ans, à partir de GHS-BUILT-S R2023A
(Global Human Settlement Layer, Centre commun de recherche de la Commission européenne, CC BY 4.0).

La grille GHSL (3 secondes d'arc, environ 90 m, valeur = m² de surface bâtie dans la cellule) est lue tuile par tuile
(10° × 10°, seules les tuiles qui touchent une wilaya), puis additionnée à l'intérieur des contours des wilayas
publiés sur data-dz (`divisions-administratives`, fichier `wilaya-boundaries`, GeoAlgeria, ODbL).

    python -m venv .venv && .venv/bin/pip install -r scripts/urbanisation/requirements.txt
    .venv/bin/python scripts/urbanisation/calculer.py [--epoques 1975-2030] [--cache DOSSIER] [--sortie DOSSIER]

Écrit dans le dossier de sortie (par défaut scripts/urbanisation/sortie/, ignoré par git) :
  - surface-batie-wilayas.json et .csv : une ligne par wilaya et par époque ;
  - surface-batie-nationale.json et .csv : totaux nationaux en format long ;
  - rapport.json : tuiles lues, totaux nationaux, sources.

1975–2020 : estimations tirées des images Landsat et Sentinel-2 ; 2025 et 2030 : projections du JRC.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window

URL_API = "https://api.data-dz.com"
BASE_GHSL = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_S_GLOBE_R2023A"
NOM_TUILE = "GHS_BUILT_S_E{epoque}_GLOBE_R2023A_4326_3ss_V1_0_R{ligne}_C{colonne}"
URL_TUILE = BASE_GHSL + "/GHS_BUILT_S_E{epoque}_GLOBE_R2023A_4326_3ss/V1-0/tiles/" + NOM_TUILE + ".zip"
DOI_GHSL = "https://doi.org/10.2905/9F06F36F-4B11-47EC-ABB0-4F8B7B1D72EA"
EPOQUES = list(range(1975, 2031, 5))
# Les époques 2025 et 2030 sont extrapolées par le JRC ; les autres viennent d'images satellites.
DERNIERE_EPOQUE_OBSERVEE = 2020
AGENT = "data-dz-urbanisation/1.0 (+https://github.com/new-algeria/api-dz-backend)"
HAUTEUR_BLOC = 2000
# Tuiles de 10° × 10° : colonne 1 = 180° O, ligne 1 = 70,9° N environ (bords lus dans chaque tuile, voir plus bas).
TAILLE_TUILE = 10.0
OUEST_GRILLE = -180.00791656
NORD_GRILLE = 89.09958326
# Surface bâtie nationale plausible (km²) : hors plage, erreur de tuile, d'unité ou de contours.
PLAGE_NATIONALE_KM2 = (300.0, 20_000.0)

DOSSIER = Path(__file__).resolve().parent


def telecharger(url: str, destination: Path) -> Path:
    """Télécharge une fois (le fichier en cache est réutilisé), en passant par un fichier temporaire."""
    if destination.exists() and destination.stat().st_size > 0:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporaire = destination.with_suffix(destination.suffix + ".part")
    print(f"Téléchargement de {url}")
    requete = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(requete, timeout=300) as reponse, open(temporaire, "wb") as fichier:
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


def charger_population(cache: Path) -> dict[tuple[int, int], int]:
    """Population par (wilaya, année) de la donnée `population-wilayas` de data-dz (2015–2030) ; vide si absente."""
    try:
        chemin = telecharger(
            f"{URL_API}/v1/datasets/population-wilayas/download?format=json&file=population-wilayas&inline=1",
            cache / "population-wilayas.json",
        )
        lignes = json.loads(chemin.read_text(encoding="utf-8"))
        return {(int(l["code_wilaya"]), int(l["annee"])): int(l["valeur"]) for l in lignes}
    except Exception as erreur:  # La population ne sert qu'au m² par habitant : son absence n'arrête rien.
        print(f"Population indisponible ({erreur}) : pas de surface par habitant.")
        return {}


def points(geometrie: dict) -> list[tuple[float, float]]:
    """Tous les sommets d'un Polygon / MultiPolygon GeoJSON."""
    polygones = [geometrie["coordinates"]] if geometrie["type"] == "Polygon" else geometrie["coordinates"]
    return [(x, y) for polygone in polygones for anneau in polygone for x, y, *_ in anneau]


def tuiles_utiles(entites: list[dict]) -> list[tuple[int, int]]:
    """Tuiles (ligne, colonne) qui recouvrent l'emprise d'au moins une wilaya."""
    tuiles: set[tuple[int, int]] = set()
    for entite in entites:
        sommets = points(entite["geometry"])
        ouest, est = min(x for x, _ in sommets), max(x for x, _ in sommets)
        sud, nord = min(y for _, y in sommets), max(y for _, y in sommets)
        for colonne in range(int((ouest - OUEST_GRILLE) // TAILLE_TUILE) + 1, int((est - OUEST_GRILLE) // TAILLE_TUILE) + 2):
            for ligne in range(int((NORD_GRILLE - nord) // TAILLE_TUILE) + 1, int((NORD_GRILLE - sud) // TAILLE_TUILE) + 2):
                tuiles.add((ligne, colonne))
    return sorted(tuiles)


def chemin_tif(zip_tuile: Path) -> str:
    noms = [n for n in zipfile.ZipFile(zip_tuile).namelist() if n.lower().endswith(".tif")]
    if len(noms) != 1:
        sys.exit(f"Archive inattendue : {zip_tuile.name}")
    return f"zip://{zip_tuile}!{noms[0]}"


def surface_cellules(transform, hauteur: int, largeur: int) -> np.ndarray:
    """Surface (km²) d'une cellule de la grille, ligne par ligne (elle dépend de la latitude)."""
    rayon = 6_371.0088
    pas_x, pas_y = abs(transform.a), abs(transform.e)
    latitudes = transform.f - (np.arange(hauteur) + 0.5) * pas_y
    return (np.radians(pas_x) * rayon) * (np.radians(pas_y) * rayon) * np.cos(np.radians(latitudes))


def calculer(entites: list[dict], epoques: list[int], cache: Path) -> tuple[dict, dict, list[str]]:
    """Surface bâtie (m²) par époque et par code de wilaya, et surface (km²) de chaque wilaya."""
    bati = {epoque: np.zeros(256, dtype=np.float64) for epoque in epoques}
    surfaces = np.zeros(256, dtype=np.float64)
    lues: list[str] = []
    for ligne, colonne in tuiles_utiles(entites):
        try:
            reference = telecharger(
                URL_TUILE.format(epoque=epoques[0], ligne=ligne, colonne=colonne),
                cache / f"{NOM_TUILE.format(epoque=epoques[0], ligne=ligne, colonne=colonne)}.zip",
            )
        except urllib.error.HTTPError as erreur:
            if erreur.code == 404:  # Tuile sans terre (mer) : le JRC ne la publie pas.
                print(f"Tuile R{ligne}_C{colonne} absente du JRC : ignorée.")
                continue
            raise
        with rasterio.open(chemin_tif(reference)) as grille:
            profil = {"height": grille.height, "width": grille.width, "transform": grille.transform}
        formes = ((e["geometry"], int(e["properties"]["code"])) for e in entites)
        masque = rasterize(formes, out_shape=(profil["height"], profil["width"]), transform=profil["transform"], fill=0, dtype="uint8")
        if not masque.any():
            continue
        lues.append(f"R{ligne}_C{colonne}")
        aires = surface_cellules(profil["transform"], profil["height"], profil["width"])
        surfaces += np.bincount(masque.ravel(), weights=np.repeat(aires, profil["width"]), minlength=256)
        for epoque in epoques:
            archive = telecharger(
                URL_TUILE.format(epoque=epoque, ligne=ligne, colonne=colonne),
                cache / f"{NOM_TUILE.format(epoque=epoque, ligne=ligne, colonne=colonne)}.zip",
            )
            with rasterio.open(chemin_tif(archive)) as grille:
                if (grille.height, grille.width, grille.transform) != (profil["height"], profil["width"], profil["transform"]):
                    sys.exit(f"Grille différente pour {archive.name} : masque à recalculer.")
                absente = grille.nodata
                for debut in range(0, grille.height, HAUTEUR_BLOC):
                    hauteur = min(HAUTEUR_BLOC, grille.height - debut)
                    codes = masque[debut : debut + hauteur]
                    if not codes.any():
                        continue
                    valeurs = grille.read(1, window=Window(0, debut, grille.width, hauteur)).astype(np.float64)
                    # Une cellule de 3" mesure au plus ≈ 8 600 m² : au-delà (65535…), valeur absente.
                    valides = (codes > 0) & (valeurs > 0) & (valeurs <= 10_000)
                    if absente is not None:
                        valides &= valeurs != absente
                    bati[epoque] += np.bincount(codes[valides], weights=valeurs[valides], minlength=256)
        print(f"Tuile R{ligne}_C{colonne} lue ({len(epoques)} époques).")
    return bati, {"surfaces": surfaces}, lues


def main() -> None:
    arguments = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    arguments.add_argument("--epoques", default="1975-2030", help="ex. 1975-2030 ou 2020")
    arguments.add_argument("--cache", type=Path, default=DOSSIER / "cache")
    arguments.add_argument("--sortie", type=Path, default=DOSSIER / "sortie")
    options = arguments.parse_args()

    debut, _, fin = options.epoques.partition("-")
    epoques = [e for e in EPOQUES if int(debut) <= e <= int(fin or debut)]
    if not epoques:
        sys.exit("Aucune époque GHSL dans l'intervalle demandé (1975, 1980… 2030).")
    entites, noms = charger_wilayas(options.cache)
    population = charger_population(options.cache)
    bati, extra, tuiles = calculer(entites, epoques, options.cache)
    surfaces = extra["surfaces"]

    lignes: list[dict] = []
    nationaux: list[dict] = []
    territoire = float(sum(surfaces[code] for code in noms))
    for epoque in epoques:
        total_km2 = float(sum(bati[epoque][code] for code in noms)) / 1e6
        if not PLAGE_NATIONALE_KM2[0] <= total_km2 <= PLAGE_NATIONALE_KM2[1]:
            sys.exit(f"Surface bâtie nationale invraisemblable en {epoque} : {total_km2:.0f} km².")
        type_ = "estimation" if epoque <= DERNIERE_EPOQUE_OBSERVEE else "projection"
        habitants_pays = sum(population.get((code, epoque), 0) for code in noms)
        nationaux += [
            {"annee": epoque, "indicateur": "Surface bâtie", "valeur": round(total_km2, 1), "unite": "km²", "type": type_},
            {"annee": epoque, "indicateur": "Part du territoire bâtie", "valeur": round(100 * total_km2 / territoire, 3), "unite": "%", "type": type_},
        ]
        if habitants_pays:
            nationaux.append(
                {"annee": epoque, "indicateur": "Surface bâtie par habitant", "valeur": round(total_km2 * 1e6 / habitants_pays, 1), "unite": "m² par habitant", "type": type_}
            )
        for code in sorted(noms):
            km2 = float(bati[epoque][code]) / 1e6
            habitants = population.get((code, epoque))
            lignes.append(
                {
                    "code_wilaya": f"{code:02d}",
                    "wilaya": noms[code]["name_fr"],
                    "wilaya_ar": noms[code]["name_ar"],
                    "annee": epoque,
                    "type": type_,
                    "surface_batie_km2": round(km2, 2),
                    "part_territoire_pct": round(100 * km2 / float(surfaces[code]), 3) if surfaces[code] else None,
                    "m2_bati_par_habitant": round(km2 * 1e6 / habitants, 1) if habitants else None,
                }
            )
        print(f"{epoque} ({type_}) : {total_km2:,.0f} km² bâtis.")

    # Croissance depuis la première époque, par wilaya (indice 100 = première époque).
    premiere = {l["code_wilaya"]: l["surface_batie_km2"] for l in lignes if l["annee"] == epoques[0]}
    for ligne in lignes:
        base = premiere.get(ligne["code_wilaya"])
        ligne[f"indice_{epoques[0]}_100"] = round(100 * ligne["surface_batie_km2"] / base, 1) if base else None

    options.sortie.mkdir(parents=True, exist_ok=True)
    for nom, donnees in (("surface-batie-wilayas", lignes), ("surface-batie-nationale", nationaux)):
        (options.sortie / f"{nom}.json").write_text(json.dumps(donnees, ensure_ascii=False) + "\n", encoding="utf-8")
        with open(options.sortie / f"{nom}.csv", "w", newline="", encoding="utf-8") as fichier:
            ecrivain = csv.DictWriter(fichier, fieldnames=list(donnees[0]))
            ecrivain.writeheader()
            ecrivain.writerows(donnees)

    national = {n["annee"]: n["valeur"] for n in nationaux if n["indicateur"] == "Surface bâtie"}
    rapport = {
        "genere_le": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "epoques": epoques,
        "derniere_epoque_observee": DERNIERE_EPOQUE_OBSERVEE,
        "nb_wilayas": len(noms),
        "tuiles": tuiles,
        "territoire_km2": round(territoire),
        "surface_batie_nationale_km2": national,
        "avec_population": bool(population),
        "nb_lignes_wilayas": len(lignes),
        "nb_lignes_nationales": len(nationaux),
        "sources": {
            "bati": {"nom": "GHS-BUILT-S R2023A (JRC), 3 secondes d'arc, EPSG:4326", "licence": "CC-BY-4.0", "doi": DOI_GHSL},
            "contours": {"nom": "GeoAlgeria, via data-dz (divisions-administratives / wilaya-boundaries)", "licence": "ODbL-1.0"},
            "population": {"nom": "WorldPop via data-dz (population-wilayas)", "licence": "CC-BY-4.0"},
        },
    }
    (options.sortie / "rapport.json").write_text(json.dumps(rapport, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(lignes)} lignes par wilaya et {len(nationaux)} lignes nationales écrites dans {options.sortie}")


if __name__ == "__main__":
    main()
