"""
Pollution atmosphérique en Algérie — réanalyse CAMS EAC4 mensuelle.

Source : Copernicus Atmosphere Monitoring Service (CAMS), EAC4 monthly averaged fields.
Grille native 0,75° (~80 km), 2003–2025. La sortie conserve la grille :
aucune précision par wilaya n'est inférée à partir de cette maille globale.

Usage :
    python scripts/pollution_atmospherique/calculer.py --cache /tmp/cams/cache --sortie /tmp/cams/sortie
"""
from __future__ import annotations

import argparse
import calendar
import csv
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests
import xarray as xr
from shapely.geometry import Point, shape
from shapely.ops import unary_union

DATASET_API = "cams-global-reanalysis-eac4-monthly"
DATASET_URL = "https://ads.atmosphere.copernicus.eu/datasets/cams-global-reanalysis-eac4-monthly"
DOI = "https://doi.org/10.24381/fd75fff2"
LICENCE = "CC-BY-4.0"
API_URL = os.environ.get("API_URL", "https://api.data-dz.com").rstrip("/")
USER_AGENT = "data-dz-pollution-atmospherique/1.0 (+https://github.com/new-algeria/api-dz-backend)"
DEBUT = "2003-01"
FIN = "2025-12"
RESOLUTION_DEG = 0.75
MAX_ANNEES_REQUETE = 5

# Les particules sont des diagnostics de surface ; les gaz sont demandés au niveau modèle 60,
# le niveau atmosphérique le plus bas disponible dans les moyennes mensuelles CAMS.
PARTICULES = {
    "PM2.5": {
        "api": "particulate_matter_2.5um",
        "aliases": ["pm2p5", "pm2_5", "particulate_matter_2.5um"],
        "unite_source": "kg m-3",
        "unite_sortie": "µg/m³",
        "conversion": "kg/m3 × 1e9",
    },
    "PM10": {
        "api": "particulate_matter_10um",
        "aliases": ["pm10", "particulate_matter_10um"],
        "unite_source": "kg m-3",
        "unite_sortie": "µg/m³",
        "conversion": "kg/m3 × 1e9",
    },
}
GAZ = {
    "CO": {
        "api": "carbon_monoxide",
        "aliases": ["co", "carbon_monoxide"],
        "masse_molaire": 28.0101,
        "unite_source": "kg kg-1",
        "unite_sortie": "ppbv",
    },
    "NO2": {
        "api": "nitrogen_dioxide",
        "aliases": ["no2", "nitrogen_dioxide"],
        "masse_molaire": 46.0055,
        "unite_source": "kg kg-1",
        "unite_sortie": "ppbv",
    },
    "O3": {
        "api": "ozone",
        "aliases": ["go3", "o3", "ozone"],
        "masse_molaire": 47.9982,
        "unite_source": "kg kg-1",
        "unite_sortie": "ppbv",
    },
    "SO2": {
        "api": "sulphur_dioxide",
        "aliases": ["so2", "sulphur_dioxide", "sulfur_dioxide"],
        "masse_molaire": 64.066,
        "unite_source": "kg kg-1",
        "unite_sortie": "ppbv",
    },
}
MASSE_MOLAIRE_AIR_SEC = 28.9647
VARIABLES = {**PARTICULES, **GAZ}
FICHIER_PRINCIPAL = "pollution-atmospherique-algerie"
FICHIER_GRILLE = "pollution-atmospherique-grille"
FICHIER_GRILLE_RECENTE = "pollution-atmospherique-grille-recente"
FICHIER_INDICATEURS = "pollution-atmospherique-indicateurs"


def mois_index(mois: str) -> int:
    annee, numero = map(int, mois[:7].split("-"))
    return annee * 12 + numero - 1


def mois_texte(index: int) -> str:
    annee, numero0 = divmod(index, 12)
    return f"{annee:04d}-{numero0 + 1:02d}"


def mois_entre(debut: str, fin: str) -> list[str]:
    a, b = mois_index(debut), mois_index(fin)
    return [mois_texte(i) for i in range(a, b + 1)] if b >= a else []


def groupes_requetes(debut: str = DEBUT, fin: str = FIN, taille: int = MAX_ANNEES_REQUETE) -> list[list[str]]:
    """Découpe les années pour limiter chaque tâche de récupération ADS."""
    if int(debut[:4]) > int(fin[:4]):
        return []
    premiere, derniere = int(debut[:4]), int(fin[:4])
    annees = list(range(premiere, derniere + 1))
    return [[str(y) for y in annees[i:i + taille]] for i in range(0, len(annees), taille)]


def convertir_pm_ug_m3(valeur_kg_m3: float) -> float:
    """Convertit une concentration massique CAMS de kg/m³ vers µg/m³."""
    if not np.isfinite(valeur_kg_m3) or valeur_kg_m3 < 0:
        raise ValueError(f"Concentration PM invalide : {valeur_kg_m3!r} kg/m³.")
    return float(valeur_kg_m3 * 1_000_000_000)


def convertir_melange_ppbv(valeur_kg_kg: float, masse_molaire_polluant: float) -> float:
    """Convertit un rapport massique kg/kg en rapport volumique ppbv (gaz parfaits)."""
    if not np.isfinite(valeur_kg_kg) or valeur_kg_kg < 0:
        raise ValueError(f"Rapport massique invalide : {valeur_kg_kg!r} kg/kg.")
    if not np.isfinite(masse_molaire_polluant) or masse_molaire_polluant <= 0:
        raise ValueError("Masse molaire du polluant invalide.")
    return float(valeur_kg_kg * MASSE_MOLAIRE_AIR_SEC / masse_molaire_polluant * 1_000_000_000)


def valider_annee_mois(mois: str) -> None:
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", mois):
        raise ValueError(f"Mois invalide : {mois}.")


def charger_limites_algerie(cache: Path) -> tuple[Any, list[float]]:
    """Combine les 69 contours publics data-dz pour découper la grille CAMS au pays."""
    cache.mkdir(parents=True, exist_ok=True)
    chemin = cache / "wilaya-boundaries.geojson"
    if not chemin.exists() or chemin.stat().st_size == 0:
        url = f"{API_URL}/v1/datasets/divisions-administratives/download?format=geojson&file=wilaya-boundaries&inline=1"
        reponse = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=120)
        reponse.raise_for_status()
        chemin.write_bytes(reponse.content)
    collection = json.loads(chemin.read_text(encoding="utf-8"))
    features = collection.get("features") if isinstance(collection, dict) else None
    if collection.get("type") != "FeatureCollection" or not isinstance(features, list) or len(features) != 69:
        raise ValueError("Le référentiel public doit contenir exactement les 69 contours GeoAlgeria.")
    geometries = []
    for feature in features:
        geom = feature.get("geometry")
        if not geom:
            raise ValueError("Un contour GeoAlgeria est dépourvu de géométrie.")
        geometries.append(shape(geom))
    pays = unary_union(geometries)
    west, south, east, north = pays.bounds
    # Ordre requis par l'API Copernicus : nord, ouest, sud, est.
    area = [round(north + 0.5, 2), round(west - 0.5, 2), round(south - 0.5, 2), round(east + 0.5, 2)]
    return pays, area


def _client_ads():
    """Configure explicitement l'endpoint ADS ; accepte le secret ADS_API_KEY ou l'ancien CDS_API_KEY."""
    cle = os.environ.get("ADS_API_KEY", "").strip() or os.environ.get("CDS_API_KEY", "").strip()
    if not cle:
        raise RuntimeError(
            "Jeton Copernicus manquant : ajoute ADS_API_KEY (jeton personnel Atmosphere Data Store) "
            "ou réutilise CDS_API_KEY si ce jeton est également autorisé sur ADS."
        )
    chemin = Path.home() / ".cdsapirc"
    chemin.write_text(f"url: https://ads.atmosphere.copernicus.eu/api\nkey: {cle}\n", encoding="utf-8")
    chemin.chmod(0o600)
    try:
        import cdsapi
    except ImportError as erreur:
        raise RuntimeError("Dépendance cdsapi absente ; installe scripts/pollution_atmospherique/requirements.txt.") from erreur
    return cdsapi.Client()


def telecharger_groupes(
    groupe: list[str], variables: list[str], nature: str, cache: Path, area: list[float], sans_cache: bool = False
) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / f"cams-eac4-{nature}-{groupe[0]}-{groupe[-1]}.nc"
    if sans_cache and destination.exists():
        destination.unlink()
    if destination.exists() and destination.stat().st_size > 1024:
        return destination

    demande: dict[str, Any] = {
        "product_type": ["monthly_mean"],
        "variable": variables,
        "year": groupe,
        "month": [f"{m:02d}" for m in range(1, 13)],
        "data_format": "netcdf",
        "download_format": "unarchived",
        "area": area,
    }
    if nature == "gaz":
        demande["model_level"] = ["60"]
    temporaire = destination.with_suffix(".part.nc")
    print(f"ADS CAMS EAC4 ({nature}) : {groupe[0]}–{groupe[-1]} ; mailles algériennes, requête de moyenne mensuelle.")
    _client_ads().retrieve(DATASET_API, demande, str(temporaire))
    if not temporaire.exists() or temporaire.stat().st_size < 1024:
        raise RuntimeError(f"ADS n'a pas fourni de NetCDF exploitable : {destination.name}.")
    temporaire.replace(destination)
    return destination


def nom_variable(ds: xr.Dataset, aliases: list[str]) -> str:
    """Retrouve le champ NetCDF malgré les différences de shortName entre convertisseurs."""
    normaliser = lambda texte: re.sub(r"[^a-z0-9]", "", texte.lower())
    cibles = {normaliser(alias) for alias in aliases}
    for nom in ds.data_vars:
        if normaliser(nom) in cibles:
            return nom
    for nom in ds.data_vars:
        attrs = ds[nom].attrs
        textes = [str(attrs.get(cle, "")) for cle in ("long_name", "standard_name", "GRIB_name", "GRIB_shortName")]
        if any(normaliser(texte) in cibles for texte in textes):
            return nom
    raise ValueError(
        f"Variable CAMS absente. Alias attendus : {aliases}. Variables reçues : {list(ds.data_vars)}."
    )


def normaliser_coordonnees(ds: xr.Dataset) -> xr.Dataset:
    changements = {}
    for cible, possibles in {
        "latitude": ("latitude", "lat"),
        "longitude": ("longitude", "lon"),
        "time": ("time", "valid_time"),
    }.items():
        if cible not in ds.coords:
            trouve = next((nom for nom in possibles if nom in ds.coords or nom in ds.dims), None)
            if trouve:
                changements[trouve] = cible
    if changements:
        ds = ds.rename(changements)
    if not {"latitude", "longitude", "time"}.issubset(set(ds.coords)):
        raise ValueError(f"Coordonnées NetCDF inattendues : coords={list(ds.coords)}, dims={list(ds.dims)}.")
    for dimension in ("level", "model_level", "hybrid"):
        if dimension in ds.dims:
            coord = ds[dimension] if dimension in ds.coords else None
            if coord is not None and 60 in np.asarray(coord.values).tolist():
                ds = ds.sel({dimension: 60})
            elif ds.sizes[dimension] == 1:
                ds = ds.isel({dimension: 0})
            else:
                raise ValueError(f"Le NetCDF CAMS contient plusieurs niveaux {dimension}, le niveau de surface 60 doit être sélectionné.")
    autres = [dim for dim in ds.dims if dim not in ("time", "latitude", "longitude")]
    if autres:
        ds = ds.squeeze(dim=autres, drop=True)
    return ds


def extraire_champs(fichiers: list[Path], famille: dict[str, dict[str, Any]]) -> tuple[list[str], np.ndarray, np.ndarray, dict[str, np.ndarray]]:
    """Lit les fichiers annuels CAMS, concatène la dimension temps et vérifie la grille."""
    dates: list[str] = []
    latitudes: np.ndarray | None = None
    longitudes: np.ndarray | None = None
    valeurs: dict[str, list[np.ndarray]] = {nom: [] for nom in famille}

    for chemin in fichiers:
        with xr.open_dataset(chemin) as source:
            ds = normaliser_coordonnees(source.load())
            lat = np.asarray(ds.latitude.values, dtype=np.float64)
            lon = np.asarray(ds.longitude.values, dtype=np.float64)
            lon = ((lon + 180.0) % 360.0) - 180.0
            if latitudes is None:
                latitudes, longitudes = lat, lon
            elif not np.allclose(latitudes, lat) or not np.allclose(longitudes, lon):
                raise ValueError("Les fichiers CAMS n'utilisent pas la même grille latitude/longitude.")
            temps = np.asarray(ds.time.values)
            dates_fichier = []
            for temps_valeur in temps:
                date_texte = np.datetime_as_string(np.datetime64(temps_valeur), unit="M")
                valider_annee_mois(date_texte)
                dates_fichier.append(date_texte)
            if len(set(dates_fichier)) != len(dates_fichier):
                raise ValueError(f"Dates mensuelles dupliquées dans {chemin.name}.")
            dates.extend(dates_fichier)
            for nom, configuration in famille.items():
                champ = nom_variable(ds, configuration["aliases"])
                tableau = np.asarray(ds[champ].transpose("time", "latitude", "longitude").values, dtype=np.float64)
                if tableau.shape != (len(dates_fichier), len(lat), len(lon)):
                    raise ValueError(f"Forme inattendue pour {nom} dans {chemin.name}: {tableau.shape}.")
                if np.any(np.isfinite(tableau) & (tableau < 0)):
                    raise ValueError(f"Valeurs négatives détectées dans le champ CAMS {nom}.")
                valeurs[nom].append(tableau)

    if latitudes is None or longitudes is None:
        raise ValueError("Aucun NetCDF CAMS n'a été chargé.")
    dates_np = np.asarray(dates)
    if len(set(dates)) != len(dates):
        raise ValueError("Plusieurs fichiers CAMS contiennent le même mois.")
    ordre = np.argsort(dates_np)
    dates_tries = dates_np[ordre].tolist()
    champs_tries: dict[str, np.ndarray] = {}
    for nom, morceaux in valeurs.items():
        empiles = np.concatenate(morceaux, axis=0)
        champs_tries[nom] = empiles[ordre]
    return dates_tries, latitudes, longitudes, champs_tries


def construire_cellules(
    pays: Any, latitudes: np.ndarray, longitudes: np.ndarray
) -> list[tuple[int, int, str, float, float, float]]:
    """Retient les centres des mailles CAMS contenus dans le territoire algérien."""
    cellules = []
    for i, latitude in enumerate(latitudes):
        for j, longitude in enumerate(longitudes):
            point = Point(float(longitude), float(latitude))
            if pays.covers(point):
                identifiant = f"{latitude:.3f}_{longitude:.3f}"
                poids = float(np.cos(np.deg2rad(latitude)))
                cellules.append((i, j, identifiant, float(latitude), float(longitude), poids))
    if len(cellules) < 20:
        raise ValueError(f"Seulement {len(cellules)} centres de maille CAMS tombent dans les contours algériens.")
    if len({c[2] for c in cellules}) != len(cellules):
        raise ValueError("Identifiants de cellules CAMS dupliqués.")
    return cellules


def construire_lignes(
    dates: list[str],
    cellules: list[tuple[int, int, str, float, float, float]],
    champs: dict[str, np.ndarray],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Construit la grille historique et les moyennes nationales pondérées par cos(latitude)."""
    lignes_grille: list[dict[str, Any]] = []
    lignes_nationales: list[dict[str, Any]] = []
    for nom, configuration in VARIABLES.items():
        cube = champs[nom]
        if cube.shape[0] != len(dates):
            raise ValueError(f"Nombre de mois incohérent pour {nom}.")
        for index, date in enumerate(dates):
            valides: list[tuple[float, float]] = []
            for i, j, identifiant, latitude, longitude, poids in cellules:
                brute = float(cube[index, i, j])
                if not np.isfinite(brute):
                    raise ValueError(f"Valeur CAMS manquante : {nom}, {date}, maille {identifiant}.")
                if nom in PARTICULES:
                    valeur = convertir_pm_ug_m3(brute)
                else:
                    valeur = convertir_melange_ppbv(brute, float(configuration["masse_molaire"]))
                if not np.isfinite(valeur):
                    raise ValueError(f"Conversion CAMS non finie : {nom}, {date}, {identifiant}.")
                lignes_grille.append({
                    "date": date + "-01",
                    "annee": int(date[:4]),
                    "mois": int(date[5:7]),
                    "cellule": identifiant,
                    "latitude": round(latitude, 4),
                    "longitude": round(longitude, 4),
                    "polluant": nom,
                    "valeur": round(valeur, 6),
                    "unite": str(configuration["unite_sortie"]),
                })
                valides.append((valeur, poids))
            poids_total = sum(p for _, p in valides)
            moyenne = sum(v * p for v, p in valides) / poids_total
            lignes_nationales.append({
                "date": date + "-01",
                "annee": int(date[:4]),
                "mois": int(date[5:7]),
                "filiere": nom,
                "valeur": round(moyenne, 6),
                "unite": str(configuration["unite_sortie"]),
                "nb_mailles": len(valides),
            })
    lignes_grille.sort(key=lambda r: (r["date"], r["cellule"], r["polluant"]))
    lignes_nationales.sort(key=lambda r: (r["date"], r["filiere"]))
    return lignes_grille, lignes_nationales


def construire_indicateurs(lignes_nationales: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Calcule les moyennes annuelles pondérées par le nombre de jours de chaque mois."""
    groupes: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for ligne in lignes_nationales:
        groupes.setdefault((ligne["filiere"], ligne["annee"]), []).append(ligne)
    sortie = []
    for (polluant, annee), lignes in sorted(groupes.items()):
        lignes.sort(key=lambda r: r["mois"])
        jours = [calendar.monthrange(annee, int(ligne["mois"]))[1] for ligne in lignes]
        valeurs = [float(ligne["valeur"]) for ligne in lignes]
        if len(lignes) != 12:
            raise ValueError(f"Année incomplète pour {polluant} en {annee} : {len(lignes)} mois.")
        moyenne = float(np.average(valeurs, weights=jours))
        sortie.append({
            "annee": annee,
            "polluant": polluant,
            "valeur_moyenne": round(moyenne, 6),
            "minimum_mensuel": round(min(valeurs), 6),
            "maximum_mensuel": round(max(valeurs), 6),
            "nb_mois": len(lignes),
            "unite": lignes[0]["unite"],
        })
    return sortie


def ecrire_csv(chemin: Path, lignes: list[dict[str, Any]]) -> None:
    if not lignes:
        raise ValueError(f"Refus d'écrire un CSV vide : {chemin.name}.")
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with chemin.open("w", encoding="utf-8-sig", newline="") as fichier:
        auteur = csv.DictWriter(fichier, fieldnames=list(lignes[0].keys()), extrasaction="raise")
        auteur.writeheader()
        auteur.writerows(lignes)


def ecrire_json(chemin: Path, lignes: Any) -> None:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    chemin.write_text(json.dumps(lignes, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n", encoding="utf-8")


def empreinte_fichiers(fichiers: list[Path]) -> str:
    empreinte = hashlib.sha256()
    for chemin in sorted(fichiers, key=lambda p: p.name):
        empreinte.update(chemin.name.encode("utf-8"))
        with chemin.open("rb") as fichier:
            for bloc in iter(lambda: fichier.read(1024 * 1024), b""):
                empreinte.update(bloc)
    return empreinte.hexdigest()


def analyser(cache: Path, sortie: Path, sans_cache: bool = False) -> dict[str, Any]:
    pays, area = charger_limites_algerie(cache)
    annees = groupes_requetes()
    client_famille: dict[str, list[Path]] = {"pm": [], "gaz": []}
    for famille, configuration in (
        ("pm", PARTICULES),
        ("gaz", GAZ),
    ):
        variables = [item["api"] for item in configuration.values()]
        for groupe in annees:
            client_famille[famille].append(
                telecharger_groupes(groupe, variables, famille, cache, area, sans_cache=sans_cache)
            )

    dates_pm, lat_pm, lon_pm, champs_pm = extraire_champs(client_famille["pm"], PARTICULES)
    dates_gaz, lat_gaz, lon_gaz, champs_gaz = extraire_champs(client_famille["gaz"], GAZ)
    if dates_pm != dates_gaz or not np.allclose(lat_pm, lat_gaz) or not np.allclose(lon_pm, lon_gaz):
        raise ValueError("Les produits PM et gaz n'ont pas la même période ou la même grille.")
    dates_attendues = mois_entre(DEBUT, FIN)
    if dates_pm != dates_attendues:
        raise ValueError(
            f"Couverture CAMS discontinue ou incomplète : attendu {DEBUT}–{FIN} ({len(dates_attendues)} mois), "
            f"reçu {dates_pm[0] if dates_pm else 'vide'}–{dates_pm[-1] if dates_pm else 'vide'} ({len(dates_pm)} mois)."
        )
    champs = {**champs_pm, **champs_gaz}
    cellules = construire_cellules(pays, lat_pm, lon_pm)
    grille, nationales = construire_lignes(dates_pm, cellules, champs)
    indicateurs = construire_indicateurs(nationales)
    date_recente = dates_pm[-1]
    grille_recente = [ligne for ligne in grille if ligne["date"] == date_recente + "-01"]

    netcdf = sorted(cache.glob("cams-eac4-*.nc"))
    rapport = {
        "genere_le": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Copernicus Atmosphere Monitoring Service (CAMS), EAC4 monthly averaged fields",
        "dataset_api": DATASET_API,
        "url_source": DATASET_URL,
        "doi": DOI,
        "licence": LICENCE,
        "periode": {"debut": dates_pm[0], "fin": dates_pm[-1], "nb_mois": len(dates_pm)},
        "resolution_grille": "0,75° × 0,75° (~80 km)",
        "emprise_requete_nord_ouest_sud_est": area,
        "methode_spatiale": "Centres des mailles CAMS couverts par l'union des 69 contours de wilayas data-dz ; moyenne nationale pondérée par cos(latitude). Aucune valeur par wilaya n'est calculée.",
        "methode_unites": {
            "PM2.5 et PM10": "kg/m³ × 1e9 = µg/m³",
            "CO, NO2, O3 et SO2": "kg/kg × (M_air_sec / M_polluant) × 1e9 = ppbv",
            "masse_molaire_air_sec_g_mol": MASSE_MOLAIRE_AIR_SEC,
        },
        "polluants": {nom: {"unite": cfg["unite_sortie"], "variable_cams": cfg["api"]} for nom, cfg in VARIABLES.items()},
        "nb_mailles": len(cellules),
        "nb_lignes_nationales": len(nationales),
        "nb_lignes_grille": len(grille),
        "nb_lignes_grille_recente": len(grille_recente),
        "nb_indicateurs_annuels": len(indicateurs),
        "empreinte_sha256_netcdf": empreinte_fichiers(netcdf),
        "fichiers_netcdf": [{"nom": p.name, "octets": p.stat().st_size} for p in netcdf],
        "avertissement": "Réanalyse modélisée de fond régional, pas mesure de station, indice AQI réglementaire ou alerte sanitaire. La maille d'environ 80 km ne permet pas une interprétation à l'échelle d'une commune ou d'une rue.",
    }
    ecrire_csv(sortie / f"{FICHIER_PRINCIPAL}.csv", nationales)
    ecrire_json(sortie / f"{FICHIER_PRINCIPAL}.json", nationales)
    ecrire_csv(sortie / f"{FICHIER_GRILLE}.csv", grille)
    ecrire_csv(sortie / f"{FICHIER_GRILLE_RECENTE}.csv", grille_recente)
    ecrire_csv(sortie / f"{FICHIER_INDICATEURS}.csv", indicateurs)
    ecrire_json(sortie / f"{FICHIER_INDICATEURS}.json", indicateurs)
    ecrire_json(sortie / "rapport.json", rapport)
    print(
        f"{len(nationales):,} lignes nationales, {len(grille):,} points maillés, "
        f"{len(cellules)} mailles, période {dates_pm[0]}–{dates_pm[-1]}."
    )
    return rapport


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--sortie", type=Path, required=True)
    parser.add_argument("--sans-cache", action="store_true")
    args = parser.parse_args()
    analyser(args.cache, args.sortie, sans_cache=args.sans_cache)


if __name__ == "__main__":
    try:
        main()
    except Exception as erreur:
        print(f"ERREUR CAMS : {erreur}")
        raise
