"""
Indicateurs mensuels de sécheresse par wilaya à partir de la réanalyse ERA5-Land.

- Source climatique : Copernicus Climate Change Service (C3S), ERA5-Land monthly means,
  grille 0,1° (~9 km), depuis 1950. Le produit mensuel est retardé d'environ 2 à 3 mois.
- Période conservée : janvier 1981 jusqu'au dernier mois complet considéré disponible
  (mois courant moins trois mois). Normale de référence : 1991-2020.
- Agrégation spatiale : moyenne surfacique des cellules ERA5-Land dont le centre tombe
  dans chaque contour de wilaya GeoAlgeria ; poids cos(latitude).
- Indices : SPI-3 et SPI-12 (loi Gamma + probabilité de précipitation nulle), anomalie
  mensuelle de précipitation (%) et percentile mensuel d'humidité du sol 0-100 cm.

La réanalyse est une estimation modélisée, non une mesure de station. Les indicateurs
sont des moyennes à l'échelle de la wilaya et masquent les contrastes à l'intérieur.

Usage (le fichier ~/.cdsapirc doit contenir le jeton CDS) :
    python scripts/secheresse/calculer.py --cache /tmp/cache --sortie /tmp/sortie
"""
from __future__ import annotations

import argparse
import calendar
import csv
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests
import rasterio
import xarray as xr
from rasterio.features import rasterize
from rasterio.transform import from_origin
from scipy.special import gammainc
from scipy.stats import norm

API_URL = os.environ.get("API_URL", "https://api.data-dz.com").rstrip("/")
DATASET_API = "reanalysis-era5-land-monthly-means"
DOI = "https://doi.org/10.24381/cds.68d2bb30"
LICENCE = "CC-BY-4.0"
BASELINE_START = "1991-01"
BASELINE_END = "2020-12"
FIRST_MONTH = "1981-01"
SAFE_LAG_MONTHS = 3
OVERLAP_MONTHS = 2
VISUEL_MOIS = 60
RESOLUTION_NOMINALE_DEG = 0.1
FICHIER = "secheresse-wilayas"
FICHIER_HISTORIQUE = "secheresse-historique"
SLUG = "secheresse"
DOSSIER = Path(__file__).resolve().parent
USER_AGENT = "data-dz-secheresse/1.0 (+https://github.com/new-algeria/api-dz-backend)"
VARIABLES = [
    "total_precipitation",
    "volumetric_soil_water_layer_1",
    "volumetric_soil_water_layer_2",
    "volumetric_soil_water_layer_3",
    "volumetric_soil_water_layer_4",
    "2m_temperature",
]
ALIASES = {
    "precipitation": ("tp", "total_precipitation"),
    "soil_0_7": ("swvl1", "volumetric_soil_water_layer_1"),
    "soil_7_28": ("swvl2", "volumetric_soil_water_layer_2"),
    "soil_28_100": ("swvl3", "volumetric_soil_water_layer_3"),
    "soil_100_289": ("swvl4", "volumetric_soil_water_layer_4"),
    "temperature": ("t2m", "2m_temperature"),
}


def month_index(value: str) -> int:
    year, month = map(int, value[:7].split("-"))
    return year * 12 + month - 1


def precipitation_mm_mois(taux_m_par_jour: float, annee: int, mois: int) -> float:
    """Convertit ERA5-Land moda (m d'eau équivalente/jour) en total mensuel (mm)."""
    if not np.isfinite(taux_m_par_jour) or taux_m_par_jour < 0:
        raise ValueError("Taux de précipitation invalide.")
    return float(taux_m_par_jour * 1000.0 * calendar.monthrange(annee, mois)[1])


def humidite_racine_ponderee(sm1: float, sm2: float, sm3: float) -> float:
    """Moyenne volumique pondérée par l'épaisseur des couches 0–7, 7–28 et 28–100 cm."""
    valeurs = (sm1, sm2, sm3)
    if any(not np.isfinite(v) or v < 0 or v > 1 for v in valeurs):
        raise ValueError("Humidité volumique du sol hors de [0, 1].")
    return float((7 * sm1 + 21 * sm2 + 72 * sm3) / 100)


def month_string(index: int) -> str:
    year, month0 = divmod(index, 12)
    return f"{year:04d}-{month0 + 1:02d}"


def shift_month(value: str, offset: int) -> str:
    return month_string(month_index(value) + offset)


def months_between(start: str, end: str) -> list[str]:
    first, last = month_index(start), month_index(end)
    if last < first:
        return []
    return [month_string(i) for i in range(first, last + 1)]


def safe_latest_month(today: date | None = None) -> str:
    """ERA5-Land mensuel arrive avec 2-3 mois de retard : on garde une marge de trois mois."""
    today = today or datetime.now(timezone.utc).date()
    current = f"{today.year:04d}-{today.month:02d}"
    return shift_month(current, -SAFE_LAG_MONTHS)


def groupes_requetes(start: str, end: str, max_annees: int = 5) -> list[tuple[list[str], list[str]]]:
    """Regroupe les sélections CDS sans demander les mois absents des années partielles."""
    if month_index(end) < month_index(start):
        return []
    first_year, first_month = map(int, start.split("-"))
    last_year, last_month = map(int, end.split("-"))
    groupes: list[tuple[list[str], list[str]]] = []
    if first_year == last_year:
        return [([str(first_year)], [f"{m:02d}" for m in range(first_month, last_month + 1)])]
    if first_month != 1:
        groupes.append(([str(first_year)], [f"{m:02d}" for m in range(first_month, 13)]))
        first_year += 1
    if first_year < last_year:
        annees_completes = list(range(first_year, last_year))
        for offset in range(0, len(annees_completes), max_annees):
            subset = annees_completes[offset : offset + max_annees]
            groupes.append(([str(y) for y in subset], [f"{m:02d}" for m in range(1, 13)]))
    groupes.append(([str(last_year)], [f"{m:02d}" for m in range(1, last_month + 1)]))
    return groupes


def telecharger_texte(url: str, destination: Path, cle: str | None = None) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 0:
        return destination
    headers = {"User-Agent": USER_AGENT}
    if cle:
        headers["Authorization"] = f"Bearer {cle}"
    response = requests.get(url, headers=headers, timeout=90)
    response.raise_for_status()
    temporaire = destination.with_suffix(destination.suffix + ".part")
    temporaire.write_bytes(response.content)
    temporaire.replace(destination)
    return destination


def charger_wilayas(cache: Path) -> tuple[list[dict[str, Any]], dict[int, dict[str, str]]]:
    """Charge les 69 contours et leurs libellés bilingues depuis les fichiers publics data-dz."""
    base = f"{API_URL}/v1/datasets/divisions-administratives/download"
    contours = telecharger_texte(
        f"{base}?format=geojson&file=wilaya-boundaries&inline=1", cache / "wilaya-boundaries.geojson"
    )
    noms = telecharger_texte(f"{base}?format=json&file=wilayas&inline=1", cache / "wilayas.json")
    collection = json.loads(contours.read_text(encoding="utf-8"))
    nomenclature = json.loads(noms.read_text(encoding="utf-8"))
    features = collection.get("features")
    wilayas = nomenclature.get("wilayas")
    if collection.get("type") != "FeatureCollection" or not isinstance(features, list) or not isinstance(wilayas, list):
        raise ValueError("Les référentiels GeoAlgeria ne respectent pas le schéma attendu.")
    par_code: dict[int, dict[str, str]] = {}
    for wilaya in wilayas:
        code = int(wilaya["code"])
        if code in par_code or not wilaya.get("name_fr") or not wilaya.get("name_ar"):
            raise ValueError(f"Nom/code de wilaya invalide ou dupliqué : {code}.")
        par_code[code] = {"fr": str(wilaya["name_fr"]), "ar": str(wilaya["name_ar"])}
    codes = []
    for feature in features:
        code = int((feature.get("properties") or {}).get("code"))
        if code not in par_code or not feature.get("geometry"):
            raise ValueError(f"Contour GeoAlgeria sans nomenclature pour le code {code}.")
        codes.append(code)
    if len(features) != 69 or len(set(codes)) != 69 or set(codes) != set(range(1, 70)) or len(par_code) != 69:
        raise ValueError("La couverture doit contenir exactement les 69 wilayas, codes 01 à 69.")
    return features, par_code


def emprise(features: list[dict[str, Any]]) -> list[float]:
    """Retourne l'emprise CDS [nord, ouest, sud, est], avec une marge de deux mailles."""
    from shapely.geometry import shape

    bounds = [shape(feature["geometry"]).bounds for feature in features]
    west = min(item[0] for item in bounds) - 0.2
    south = min(item[1] for item in bounds) - 0.2
    east = max(item[2] for item in bounds) + 0.2
    north = max(item[3] for item in bounds) + 0.2
    return [round(north, 1), round(west, 1), round(south, 1), round(east, 1)]


def masque_wilayas(features: list[dict[str, Any]], latitude: np.ndarray, longitude: np.ndarray) -> np.ndarray:
    """Rasterise les contours sur les centres de cellules ERA5-Land ; 0 = hors des 69 wilayas."""
    if len(latitude) < 2 or len(longitude) < 2:
        raise ValueError("Grille ERA5-Land insuffisante pour déterminer sa résolution.")
    lat = np.asarray(latitude, dtype=float)
    lon = np.asarray(longitude, dtype=float)
    if not np.all(np.diff(lat) < 0):
        raise ValueError("La latitude ERA5-Land doit être triée du nord au sud après normalisation.")
    if not np.all(np.diff(lon) > 0):
        raise ValueError("La longitude ERA5-Land doit être triée de l'ouest à l'est après normalisation.")
    res_lat = float(np.median(-np.diff(lat)))
    res_lon = float(np.median(np.diff(lon)))
    if not (0.07 <= res_lat <= 0.13 and 0.07 <= res_lon <= 0.13):
        raise ValueError(f"Résolution inattendue de la grille ERA5-Land : {res_lat:.4f}° × {res_lon:.4f}°.")
    transform = from_origin(float(lon[0]) - res_lon / 2, float(lat[0]) + res_lat / 2, res_lon, res_lat)
    formes = [((feature["geometry"]), int(feature["properties"]["code"])) for feature in features]
    mask = rasterize(
        formes,
        out_shape=(len(lat), len(lon)),
        transform=transform,
        fill=0,
        dtype="uint8",
        all_touched=False,
    )
    codes, counts = np.unique(mask, return_counts=True)
    couverture = {int(code): int(count) for code, count in zip(codes, counts) if code != 0}
    manquantes = sorted(set(range(1, 70)) - set(couverture))
    if manquantes:
        raise ValueError(f"Aucune cellule ERA5-Land dans les wilayas : {manquantes}.")
    return mask


def nom_variable(ds: xr.Dataset, aliases: tuple[str, ...]) -> str:
    for nom in aliases:
        if nom in ds.data_vars:
            return nom
    raise ValueError(f"Variable absente du NetCDF ERA5-Land : l'une de {aliases} est attendue ; reçues : {list(ds.data_vars)}")


def normaliser_dataset(ds: xr.Dataset) -> xr.Dataset:
    """Normalise coordonnées/variables CDS et conserve les seuls champs nécessaires."""
    if "valid_time" in ds.dims or "valid_time" in ds.coords:
        ds = ds.rename({"valid_time": "time"})
    if "latitude" not in ds.coords or "longitude" not in ds.coords or "time" not in ds.coords:
        raise ValueError(f"Coordonnées NetCDF inattendues : {list(ds.coords)}.")
    noms = {cle: nom_variable(ds, alias) for cle, alias in ALIASES.items()}
    ds = ds.rename({v: k for k, v in noms.items()})
    if "expver" in ds.dims:
        # Plusieurs versions (préliminaire/finale) peuvent coexister : priorité à la première valeur non manquante.
        versions = [ds.isel(expver=i, drop=True) for i in range(ds.sizes["expver"])]
        fusion = versions[0]
        for version in versions[1:]:
            fusion = fusion.combine_first(version)
        ds = fusion
    ds = ds.sortby("latitude", ascending=False).sortby("longitude")
    ds = ds[["precipitation", "soil_0_7", "soil_7_28", "soil_28_100", "soil_100_289", "temperature"]]
    return ds


def agreger_netcdf(path: Path, features: list[dict[str, Any]], noms: dict[int, dict[str, str]]) -> list[dict[str, Any]]:
    """Calcule les moyennes mensuelles par wilaya, pondérées par la surface des cellules (cos latitude)."""
    with xr.open_dataset(path, engine="netcdf4") as original:
        ds = normaliser_dataset(original.load())
    latitude = np.asarray(ds.latitude.values, dtype=float)
    longitude = np.asarray(ds.longitude.values, dtype=float)
    mask = masque_wilayas(features, latitude, longitude)
    dates = np.asarray(ds.time.values).astype("datetime64[M]")
    dates_texte = [str(d.astype("datetime64[M]")) for d in dates]
    if len(set(dates_texte)) != len(dates_texte):
        raise ValueError(f"Le fichier {path.name} contient des mois dupliqués.")
    poids = np.cos(np.deg2rad(latitude))[:, None] * np.ones((1, len(longitude)), dtype=float)
    lignes: list[dict[str, Any]] = []
    for code in range(1, 70):
        selection = mask == code
        poids_cellules = poids[selection]
        nb_cellules = int(selection.sum())
        if nb_cellules == 0:
            raise ValueError(f"Aucune cellule pour la wilaya {code:02d}.")
        variables: dict[str, np.ndarray] = {}
        for nom in ("precipitation", "soil_0_7", "soil_7_28", "soil_28_100", "soil_100_289", "temperature"):
            valeurs = np.asarray(ds[nom].transpose("time", "latitude", "longitude").values, dtype=np.float64)[:, selection]
            valides = np.isfinite(valeurs)
            numerateur = np.sum(np.where(valides, valeurs * poids_cellules[None, :], 0.0), axis=1)
            denominateur = np.sum(np.where(valides, poids_cellules[None, :], 0.0), axis=1)
            moyenne = np.divide(numerateur, denominateur, out=np.full(len(dates_texte), np.nan), where=denominateur > 0)
            variables[nom] = moyenne
        for indice, mois in enumerate(dates_texte):
            if any(not np.isfinite(variables[nom][indice]) for nom in variables):
                # Une ligne manquante est explicite : on ne fabrique jamais 0 mm ou 0 d'humidité.
                continue
            annee, numero_mois = map(int, mois.split("-"))
            sm1 = float(variables["soil_0_7"][indice])
            sm2 = float(variables["soil_7_28"][indice])
            sm3 = float(variables["soil_28_100"][indice])
            sm4 = float(variables["soil_100_289"][indice])
            temp_c = float(variables["temperature"][indice] - 273.15)
            if any(v < -0.001 or v > 1.0 for v in (sm1, sm2, sm3, sm4)):
                raise ValueError(f"Humidité du sol hors plage physique plausible ({code:02d}, {mois}).")
            precipitation_mm = precipitation_mm_mois(float(variables["precipitation"][indice]), annee, numero_mois)
            lignes.append({
                "code_wilaya": f"{code:02d}",
                "wilaya": noms[code]["fr"],
                "date": f"{mois}-01",
                "precipitation_mm": round(precipitation_mm, 3),
                "humidite_sol_0_7_cm": round(sm1, 5),
                "humidite_sol_7_28_cm": round(sm2, 5),
                "humidite_sol_28_100_cm": round(sm3, 5),
                "humidite_sol_100_289_cm": round(sm4, 5),
                "humidite_sol_0_100_cm": round(humidite_racine_ponderee(sm1, sm2, sm3), 5),
                "humidite_sol_0_289_cm": round((7 * sm1 + 21 * sm2 + 72 * sm3 + 189 * sm4) / 289, 5),
                "temperature_moyenne_c": round(temp_c, 3),
                "nb_cellules": nb_cellules,
            })
    return lignes


def lire_historique(api_url: str, cle: str | None) -> list[dict[str, Any]]:
    """Lit l'archive JSON complète via la route admin, sans transmettre la clé à R2."""
    if not cle:
        return []
    url = f"{api_url.rstrip('/')}/v1/admin/datasets/{SLUG}/files/{FICHIER_HISTORIQUE}?format=json"
    response = requests.get(url, headers={"Authorization": f"Bearer {cle}", "User-Agent": USER_AGENT}, allow_redirects=False, timeout=60)
    if response.status_code in (404, 422):
        return []
    if 300 <= response.status_code < 400:
        location = response.headers.get("location")
        if not location:
            raise RuntimeError("L'API a répondu une redirection sans URL de fichier.")
        fichier = requests.get(location, headers={"User-Agent": USER_AGENT}, timeout=180)
        fichier.raise_for_status()
        contenu = fichier.json()
        if not isinstance(contenu, list):
            raise ValueError("Le fichier de l'historique doit être un tableau JSON.")
        return contenu
    response.raise_for_status()
    raise RuntimeError(f"Réponse inattendue de l'API pour l'historique : HTTP {response.status_code}.")


def telecharger_groupes(start: str, end: str, area: list[float], cache: Path, sans_cache: bool = False) -> list[Path]:
    fichier_auth = Path.home() / ".cdsapirc"
    cle_cds = os.environ.get("CDS_API_KEY", "").strip()
    if not fichier_auth.exists() and cle_cds:
        # Création d'un fichier à permissions privées ; le jeton n'est jamais affiché dans les journaux.
        fichier_auth.write_text(f"url: https://cds.climate.copernicus.eu/api\nkey: {cle_cds}\n", encoding="utf-8")
        fichier_auth.chmod(0o600)
    if not fichier_auth.exists():
        raise RuntimeError("CDS_API_KEY manquant : ajoute le jeton personnel Copernicus dans les secrets GitHub Actions.")
    try:
        import cdsapi
    except ImportError as erreur:
        raise RuntimeError("Dépendance cdsapi absente ; installe scripts/secheresse/requirements.txt.") from erreur
    client = cdsapi.Client()
    fichiers: list[Path] = []
    for numero, (annees, mois) in enumerate(groupes_requetes(start, end), start=1):
        nom = f"era5-land-{annees[0]}-{annees[-1]}-{mois[0]}-{mois[-1]}.nc"
        destination = cache / nom
        if sans_cache and destination.exists():
            destination.unlink()
        if destination.exists() and destination.stat().st_size > 0:
            fichiers.append(destination)
            continue
        cache.mkdir(parents=True, exist_ok=True)
        demande = {
            "product_type": ["monthly_averaged_reanalysis"],
            "variable": VARIABLES,
            "year": annees,
            "month": mois,
            "time": ["00:00"],
            "data_format": "netcdf",
            "download_format": "unarchived",
            "area": area,
        }
        temporaire = destination.with_suffix(".part.nc")
        print(f"CDS ERA5-Land : années {annees[0]}–{annees[-1]}, mois {mois[0]}–{mois[-1]} (requête {numero}).")
        client.retrieve(DATASET_API, demande, str(temporaire))
        if not temporaire.exists() or temporaire.stat().st_size < 1024:
            raise RuntimeError(f"Le CDS n'a pas fourni de NetCDF exploitable pour {nom}.")
        temporaire.replace(destination)
        fichiers.append(destination)
    return fichiers


def cdf_spi(reference: np.ndarray, valeurs: np.ndarray) -> np.ndarray:
    """SPI paramétrique (Gamma + masse en zéro), calibré par wilaya et mois sur 1991-2020."""
    result = np.full(len(valeurs), np.nan, dtype=float)
    ref = reference[np.isfinite(reference) & (reference >= 0)]
    positives = ref[ref > 0]
    # En dessous de 15 années positives, l'ajustement Gamma est trop fragile : SPI non calculé.
    if len(ref) < 20 or len(positives) < 15 or float(np.std(positives)) < 1e-6:
        return result
    p0 = float(np.count_nonzero(ref == 0) / len(ref))
    moyenne = float(np.mean(positives))
    variance = float(np.var(positives, ddof=1))
    if variance <= 1e-12 or moyenne <= 0:
        return result
    shape = max(0.05, moyenne * moyenne / variance)
    scale = variance / moyenne
    indices = np.flatnonzero(np.isfinite(valeurs) & (valeurs >= 0))
    x = valeurs[indices]
    cdf = np.where(x <= 0, p0, p0 + (1 - p0) * gammainc(shape, x / scale))
    result[indices] = norm.ppf(np.clip(cdf, 1e-6, 1 - 1e-6))
    return result


def calculer_indicateurs(lignes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ajoute normales, anomalies, SPI-3/SPI-12 et percentile du sol sur chaque série de wilaya."""
    par_code: dict[str, list[dict[str, Any]]] = {}
    for ligne in lignes:
        par_code.setdefault(str(ligne["code_wilaya"]), []).append(dict(ligne))
    enrichies: list[dict[str, Any]] = []
    baseline_debut, baseline_fin = month_index(BASELINE_START), month_index(BASELINE_END)
    for code, serie in sorted(par_code.items()):
        serie.sort(key=lambda ligne: month_index(str(ligne["date"])))
        dates = [str(ligne["date"])[:7] for ligne in serie]
        if len(set(dates)) != len(dates):
            raise ValueError(f"Mois dupliqué pour la wilaya {code}.")
        indices = [month_index(d) for d in dates]
        mois = [int(d[5:7]) for d in dates]
        precipitation = np.asarray([float(ligne["precipitation_mm"]) for ligne in serie])
        humidite = np.asarray([float(ligne["humidite_sol_0_100_cm"]) for ligne in serie])
        # Précipitations normales du mois calendaire (moyenne 1991-2020).
        normales: dict[int, float | None] = {}
        for m in range(1, 13):
            positions = [i for i, idx in enumerate(indices) if idx >= baseline_debut and idx <= baseline_fin and mois[i] == m]
            valeurs = precipitation[positions] if positions else np.array([], dtype=float)
            normales[m] = float(np.mean(valeurs)) if len(valeurs) >= 20 else None
        # Cumuls mobiles complets, sans combler les trous par des zéros.
        cumuls: dict[int, np.ndarray] = {}
        for echelle in (3, 12):
            cumul = np.full(len(serie), np.nan, dtype=float)
            for i in range(echelle - 1, len(serie)):
                fenetre_indices = indices[i - echelle + 1 : i + 1]
                if fenetre_indices[-1] - fenetre_indices[0] != echelle - 1:
                    continue
                bloc = precipitation[i - echelle + 1 : i + 1]
                if np.all(np.isfinite(bloc)):
                    cumul[i] = float(np.sum(bloc))
            cumuls[echelle] = cumul
        spi: dict[int, np.ndarray] = {}
        for echelle in (3, 12):
            valeurs_spi = np.full(len(serie), np.nan, dtype=float)
            for m in range(1, 13):
                ref_idx = [i for i, idx in enumerate(indices) if baseline_debut <= idx <= baseline_fin and mois[i] == m]
                ref = cumuls[echelle][ref_idx] if ref_idx else np.array([], dtype=float)
                cible_idx = np.asarray([i for i, mm in enumerate(mois) if mm == m], dtype=int)
                if len(cible_idx):
                    valeurs_spi[cible_idx] = cdf_spi(ref, cumuls[echelle][cible_idx])
            spi[echelle] = valeurs_spi
        percentiles = np.full(len(serie), np.nan, dtype=float)
        anomalies = np.full(len(serie), np.nan, dtype=float)
        for i, m in enumerate(mois):
            positions = [j for j, idx in enumerate(indices) if baseline_debut <= idx <= baseline_fin and mois[j] == m and np.isfinite(humidite[j])]
            ref_sm = humidite[positions] if positions else np.array([], dtype=float)
            if len(ref_sm) >= 20 and np.isfinite(humidite[i]):
                percentiles[i] = 100.0 * (np.count_nonzero(ref_sm < humidite[i]) + 0.5 * np.count_nonzero(ref_sm == humidite[i])) / len(ref_sm)
            normal = normales[m]
            if normal is not None and normal > 0:
                anomalies[i] = 100.0 * (precipitation[i] / normal - 1.0)
        for i, ligne in enumerate(serie):
            normal = normales[mois[i]]
            ligne["precipitation_normale_mm"] = round(normal, 3) if normal is not None else None
            ligne["anomalie_precipitation_pct"] = round(float(anomalies[i]), 2) if np.isfinite(anomalies[i]) else None
            ligne["spi_3"] = round(float(spi[3][i]), 3) if np.isfinite(spi[3][i]) else None
            ligne["spi_12"] = round(float(spi[12][i]), 3) if np.isfinite(spi[12][i]) else None
            ligne["percentile_humidite_sol"] = round(float(percentiles[i]), 1) if np.isfinite(percentiles[i]) else None
            # Les colonnes numériques en tête déterminent la mesure par défaut de la carte data-dz.
            # Le nombre de cellules reste dans rapport.json et ne doit pas devenir une fausse mesure cartographique.
            ordre = (
                "code_wilaya", "wilaya", "date", "spi_3", "spi_12", "precipitation_mm",
                "precipitation_normale_mm", "anomalie_precipitation_pct", "percentile_humidite_sol",
                "humidite_sol_0_100_cm", "humidite_sol_0_289_cm", "humidite_sol_0_7_cm",
                "humidite_sol_7_28_cm", "humidite_sol_28_100_cm", "humidite_sol_100_289_cm",
                "temperature_moyenne_c",
            )
            enrichies.append({nom: ligne[nom] for nom in ordre})
    enrichies.sort(key=lambda ligne: (str(ligne["date"]), str(ligne["code_wilaya"])))
    return enrichies


def verifier_donnees(lignes: list[dict[str, Any]], nombres: dict[int, dict[str, str]], premiere: str, derniere: str) -> dict[str, Any]:
    if len(nombres) != 69:
        raise ValueError("Le référentiel ne contient pas 69 noms de wilayas.")
    par_mois: dict[str, set[str]] = {}
    par_code: dict[str, int] = {}
    for ligne in lignes:
        code = str(ligne.get("code_wilaya", ""))
        date_ligne = str(ligne.get("date", ""))
        if code not in {f"{n:02d}" for n in range(1, 70)}:
            raise ValueError(f"Code wilaya invalide : {code}.")
        if date_ligne != date_ligne[:7] + "-01" or len(date_ligne) != 10:
            raise ValueError(f"Date mensuelle invalide : {date_ligne}.")
        if not isinstance(ligne.get("wilaya"), str) or ligne["wilaya"] != nombres[int(code)]["fr"]:
            raise ValueError(f"Nom de wilaya absent ou incohérent : {code}.")
        pluie = ligne.get("precipitation_mm")
        if pluie is None or not np.isfinite(float(pluie)) or float(pluie) < 0:
            raise ValueError(f"Précipitation invalide : {code}, {date_ligne}.")
        for nom in ("humidite_sol_0_7_cm", "humidite_sol_7_28_cm", "humidite_sol_28_100_cm", "humidite_sol_100_289_cm", "humidite_sol_0_100_cm", "humidite_sol_0_289_cm"):
            valeur = ligne.get(nom)
            if valeur is None or not np.isfinite(float(valeur)) or not 0 <= float(valeur) <= 1:
                raise ValueError(f"Humidité du sol invalide : {code}, {date_ligne}, {nom}.")
        par_mois.setdefault(date_ligne, set())
        if code in par_mois[date_ligne]:
            raise ValueError(f"Ligne dupliquée : {code}, {date_ligne}.")
        par_mois[date_ligne].add(code)
        par_code[code] = par_code.get(code, 0) + 1
    if not par_mois:
        raise ValueError("Aucune donnée climatique calculée.")
    incomplets = {date: sorted({f"{n:02d}" for n in range(1, 70)} - codes) for date, codes in par_mois.items() if len(codes) != 69}
    # Les frontières peuvent avoir 1-2 cellules sans données dans certains mois. Le script écarte un mois entier
    # s'il n'est pas complet ; toutes les périodes publiées restent donc comparables entre les 69 wilayas.
    if incomplets:
        raise ValueError(f"Mois sans couverture complète des 69 wilayas : {list(incomplets.items())[:3]}.")
    dates = sorted(par_mois)
    attendues = months_between(premiere, derniere)
    observees = [date[:7] for date in dates]
    if observees != attendues:
        manquantes = sorted(set(attendues) - set(observees))
        inattendues = sorted(set(observees) - set(attendues))
        raise ValueError(f"Période mensuelle discontinue : {dates[0][:7]}–{dates[-1][:7]} ; mois manquants={manquantes[:6]}, inattendus={inattendues[:6]}.")
    return {
        "nb_wilayas": 69,
        "nb_mois": len(dates),
        "premier_mois": dates[0][:7],
        "dernier_mois": dates[-1][:7],
        "nb_lignes": len(lignes),
        "wilayas": {code: count for code, count in sorted(par_code.items())},
        "couverture_spi_3": sum(1 for ligne in lignes if ligne.get("spi_3") is not None),
        "couverture_spi_12": sum(1 for ligne in lignes if ligne.get("spi_12") is not None),
        "couverture_percentile_sol": sum(1 for ligne in lignes if ligne.get("percentile_humidite_sol") is not None),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", type=Path, default=DOSSIER / "cache")
    parser.add_argument("--sortie", type=Path, default=DOSSIER / "sortie")
    parser.add_argument("--sans-cache", action="store_true", help="Télécharge à nouveau les fichiers NetCDF du passage.")
    options = parser.parse_args()
    options.cache.mkdir(parents=True, exist_ok=True)
    options.sortie.mkdir(parents=True, exist_ok=True)

    cle_sync = os.environ.get("CLE_SYNCHRO", "").strip()
    historique = lire_historique(API_URL, cle_sync or None)
    features, noms = charger_wilayas(options.cache)
    fin = safe_latest_month()
    if historique:
        derniere_historique = max(str(ligne["date"])[:7] for ligne in historique)
        debut = max(FIRST_MONTH, shift_month(derniere_historique, -OVERLAP_MONTHS))
        if month_index(debut) > month_index(fin):
            debut = shift_month(fin, -OVERLAP_MONTHS)
    else:
        debut = FIRST_MONTH
    print(f"Période cible ERA5-Land : {debut} → {fin} ; normale climatique : {BASELINE_START}–{BASELINE_END}.")

    if month_index(fin) < month_index(BASELINE_END):
        raise RuntimeError(f"Le produit ERA5-Land disponible ({fin}) ne couvre pas la normale {BASELINE_START}–{BASELINE_END}.")
    area = emprise(features)
    print(f"Emprise CDS : N={area[0]}, W={area[1]}, S={area[2]}, E={area[3]}.")
    fichiers = telecharger_groupes(debut, fin, area, options.cache, sans_cache=options.sans_cache)
    nouveaux: list[dict[str, Any]] = []
    for path in fichiers:
        print(f"Agrégation de {path.name}.")
        nouveaux.extend(agreger_netcdf(path, features, noms))
    # Merge idempotent : les deux derniers mois sont re-téléchargés pour intégrer une éventuelle révision CDS.
    fusion: dict[tuple[str, str], dict[str, Any]] = {}
    for ligne in historique + nouveaux:
        key = (str(ligne["code_wilaya"]), str(ligne["date"]))
        fusion[key] = {k: ligne[k] for k in (
            "code_wilaya", "wilaya", "date", "precipitation_mm", "humidite_sol_0_7_cm", "humidite_sol_7_28_cm",
            "humidite_sol_28_100_cm", "humidite_sol_100_289_cm", "humidite_sol_0_100_cm", "humidite_sol_0_289_cm", "temperature_moyenne_c", "nb_cellules"
        ) if k in ligne}
    mois_attendus = months_between(FIRST_MONTH, fin)
    lignes_brutes = list(fusion.values())
    indices_par_mois: dict[str, set[str]] = {}
    for ligne in lignes_brutes:
        indices_par_mois.setdefault(str(ligne["date"]), set()).add(str(ligne["code_wilaya"]))
    # On retire uniquement les mois partiels (ex. première livraison CDS), jamais les zéros ou valeurs manquantes.
    mois_complets = {m for m in mois_attendus if len(indices_par_mois.get(f"{m}-01", set())) == 69}
    lignes_brutes = [ligne for ligne in lignes_brutes if str(ligne["date"])[:7] in mois_complets]
    dates_brutes = sorted({str(ligne["date"])[:7] for ligne in lignes_brutes})
    if not dates_brutes or dates_brutes[0] != FIRST_MONTH or dates_brutes[-1] != fin:
        raise RuntimeError(f"Historique incomplet après fusion : {dates_brutes[0] if dates_brutes else 'vide'}–{dates_brutes[-1] if dates_brutes else 'vide'}, attendu {FIRST_MONTH}–{fin}.")
    # Chaque wilaya doit avoir une observation pour chaque mois publié.
    enrichies = calculer_indicateurs(lignes_brutes)
    controle = verifier_donnees(enrichies, noms, FIRST_MONTH, fin)

    # Le visuel JSON doit rester sous la limite de 5 Mo du site ; l'archive complète est publiée à part.
    debut_visuel = shift_month(fin, -(VISUEL_MOIS - 1))
    visuelles = [ligne for ligne in enrichies if month_index(str(ligne["date"])[:7]) >= month_index(debut_visuel)]
    chemins = {
        "visuel_json": options.sortie / f"{FICHIER}.json",
        "visuel_csv": options.sortie / f"{FICHIER}.csv",
        "historique_json": options.sortie / f"{FICHIER_HISTORIQUE}.json",
        "historique_csv": options.sortie / f"{FICHIER_HISTORIQUE}.csv",
        "rapport": options.sortie / "rapport.json",
    }
    chemins["visuel_json"].write_text(json.dumps(visuelles, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    chemins["historique_json"].write_text(json.dumps(enrichies, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    for nom, contenu in (("visuel_csv", visuelles), ("historique_csv", enrichies)):
        with chemins[nom].open("w", newline="", encoding="utf-8") as fichier:
            writer = csv.DictWriter(fichier, fieldnames=list(contenu[0].keys()))
            writer.writeheader()
            writer.writerows(contenu)
    rapport = {
        "genere_le": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "periode": {"debut": FIRST_MONTH, "fin": fin},
        "reference_spi_et_anomalies": {"debut": BASELINE_START, "fin": BASELINE_END},
        "source": "Copernicus Climate Change Service (C3S), ERA5-Land monthly averaged reanalysis",
        "doi": DOI,
        "licence_source": LICENCE,
        "resolution_grille": f"{RESOLUTION_NOMINALE_DEG:.1f}° (~9 km)",
        "delai_source_mois": SAFE_LAG_MONTHS,
        "agregation": "Moyenne surfacique des cellules dont le centre tombe dans le contour GeoAlgeria ; poids cos(latitude).",
        "indicateurs": ["precipitation_mm", "anomalie_precipitation_pct", "spi_3", "spi_12", "humidite_sol_0_7_cm", "humidite_sol_7_28_cm", "humidite_sol_28_100_cm", "humidite_sol_100_289_cm", "humidite_sol_0_100_cm", "humidite_sol_0_289_cm", "percentile_humidite_sol", "temperature_moyenne_c"],
        "controle": controle,
        "cellules_par_wilaya": {code: int(next(ligne["nb_cellules"] for ligne in lignes_brutes if ligne["code_wilaya"] == code)) for code in sorted({ligne["code_wilaya"] for ligne in lignes_brutes})},
        "notes": [
            "ERA5-Land est une réanalyse modélisée, pas un réseau de mesures au sol.",
            "La précipitation mensuelle est calculée en convertissant le taux moyen quotidien du produit mensuel en mm/mois.",
            "SPI-3 et SPI-12 utilisent une distribution Gamma avec probabilité de mois sans pluie, calibrée sur 1991-2020 par wilaya et mois calendaire.",
            "Le percentile d'humidité du sol compare chaque mois au même mois de la normale 1991-2020.",
            "Les indices SPI ou percentiles sont nuls (JSON null) lorsque l'échantillon de référence est insuffisant ; ils ne sont jamais remplacés par zéro.",
        ],
    }
    rapport["fichiers"] = {
        "visuel": {"nom": FICHIER, "nb_lignes": len(visuelles), "debut": debut_visuel, "fin": fin},
        "historique": {"nom": FICHIER_HISTORIQUE, "nb_lignes": len(enrichies), "debut": FIRST_MONTH, "fin": fin},
    }
    rapport["taille_octets"] = {nom: chemin.stat().st_size for nom, chemin in chemins.items() if nom != "rapport"}
    if chemins["visuel_json"].stat().st_size > 4_500_000:
        raise RuntimeError("Le JSON principal dépasse 4,5 Mo : réduire VISUEL_MOIS pour respecter la limite de visualisation du site.")
    chemins["rapport"].write_text(json.dumps(rapport, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(enrichies):,} lignes historiques ; {len(visuelles):,} lignes dans le visuel ({debut_visuel} → {fin}).")
    print(f"Couverture SPI-3 : {controle['couverture_spi_3']:,} valeurs ; SPI-12 : {controle['couverture_spi_12']:,} ; humidité : {controle['couverture_percentile_sol']:,}.")
    print(f"Fichiers écrits dans {options.sortie}.")


if __name__ == "__main__":
    main()
