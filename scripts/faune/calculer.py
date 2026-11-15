#!/usr/bin/env python3
"""
Construit un inventaire agrégé de la faune algérienne depuis un téléchargement GBIF.

Le téléchargement DWCA est asynchrone et authentifié. Le traitement ne publie jamais
les occurrences individuelles, les identifiants des enregistrements, les observateurs
ni les coordonnées exactes.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

API = "https://api.gbif.org/v1"
API_DEMANDE = API + "/occurrence/download/request"
CHECKLIST_COL = "7ddf754f-d193-4cc9-b351-99906754a03b"
SOURCE_URL = "https://www.gbif.org/occurrence/search?country=DZ"
DOC_URL = "https://techdocs.gbif.org/en/data-use/api-downloads"
LICENCES = ("CC0_1_0", "CC_BY_4_0")
AGENT = "data-dz-faune-algerie/1.0 (+https://github.com/new-algeria/api-dz-backend)"
STATUTS_IUCN = ("EX", "EW", "CR", "EN", "VU", "NT", "LC", "DD", "NE", "NA")
NOMS_IUCN = {
    "EX": "Éteinte", "EW": "Éteinte à l'état sauvage",
    "CR": "En danger critique", "EN": "En danger", "VU": "Vulnérable",
    "NT": "Quasi menacée", "LC": "Préoccupation mineure",
    "DD": "Données insuffisantes", "NE": "Non évaluée",
    "NA": "Non applicable",
}
FICHIERS = {
    "especes": "faune-algerie-especes",
    "regions": "faune-algerie-regions",
    "conservation": "faune-algerie-conservation",
    "historique": "faune-algerie-historique",
    "sources": "faune-algerie-sources",
    "indicateurs": "faune-algerie-indicateurs",
    "qualite": "faune-algerie-qualite",
}


def construire_requete(email: str) -> dict[str, Any]:
    """Périmètre inclusif pour l'inventaire, sans imposer de coordonnées."""
    return {
        "notificationAddresses": [email],
        "sendNotification": True,
        "format": "DWCA",
        "checklistKey": CHECKLIST_COL,
        "predicate": {
            "type": "and",
            "predicates": [
                {"type": "equals", "key": "COUNTRY", "value": "DZ"},
                {"type": "equals", "key": "OCCURRENCE_STATUS", "value": "PRESENT"},
                {"type": "in", "key": "LICENSE", "values": list(LICENCES)},
            ],
        },
    }


def valider_identifiant_gbif(username: str) -> None:
    """GBIF attend le nom d'utilisateur du compte, jamais son adresse e-mail."""
    if "@" in username:
        raise ValueError(
            "GBIF_USERNAME doit être le nom d'utilisateur GBIF (identifiant de connexion), "
            "pas l'adresse e-mail du compte."
        )


def _requete_http(url: str, *, username: str | None = None, password: str | None = None,
                  method: str = "GET", body: bytes | None = None,
                  timeout: int = 120) -> bytes:
    headers = {"User-Agent": AGENT, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if username is not None and password is not None:
        jeton = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        headers["Authorization"] = "Basic " + jeton
    requete = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(requete, timeout=timeout) as reponse:
            return reponse.read()
    except urllib.error.HTTPError as erreur:
        detail = erreur.read(2000).decode("utf-8", errors="replace")
        if erreur.code == 401 and url == API_DEMANDE:
            raise RuntimeError(
                "GBIF HTTP 401 : identifiants refusés. GBIF_USERNAME doit être le nom "
                "d'utilisateur GBIF (pas l'adresse e-mail) et GBIF_PASSWORD le mot de "
                "passe du compte GBIF. Vérifie aussi que les secrets GitHub sont ceux "
                "du même compte et qu'ils ne contiennent pas de guillemets ajoutés."
            ) from erreur
        if erreur.code == 403 and url == API_DEMANDE:
            raise RuntimeError(
                "GBIF HTTP 403 : le compte authentifié n'est pas autorisé à créer ce "
                "téléchargement. Vérifie le compte GBIF et ses permissions."
            ) from erreur
        raise RuntimeError(f"GBIF HTTP {erreur.code} sur {url}: {detail}") from erreur
    except urllib.error.URLError as erreur:
        raise RuntimeError(f"Connexion GBIF impossible sur {url}: {erreur}") from erreur


def demander_telechargement(username: str, password: str, email: str) -> str:
    corps = json.dumps(construire_requete(email), ensure_ascii=False).encode("utf-8")
    reponse = _requete_http(API_DEMANDE, username=username, password=password,
                            method="POST", body=corps, timeout=120)
    texte = reponse.decode("utf-8").strip()
    try:
        valeur = json.loads(texte)
        if isinstance(valeur, str):
            texte = valeur
        elif isinstance(valeur, dict):
            texte = str(valeur.get("key") or valeur.get("downloadKey") or "")
    except json.JSONDecodeError:
        pass
    cle = texte.strip().strip('"')
    if not re.fullmatch(r"[0-9]{3,}-[0-9A-Za-z-]+", cle):
        raise RuntimeError("GBIF n'a pas renvoyé de clé de téléchargement reconnaissable.")
    return cle


def attendre_telechargement(cle: str, delai_max: int = 3600,
                            intervalle: int = 30) -> dict[str, Any]:
    echeance = time.monotonic() + delai_max
    dernier_statut = ""
    while time.monotonic() < echeance:
        contenu = _requete_http(f"{API}/occurrence/download/{cle}", timeout=60)
        statut = json.loads(contenu.decode("utf-8"))
        etat = str(statut.get("status", "")).upper()
        if etat != dernier_statut:
            print(f"GBIF téléchargement {cle} : {etat or 'statut inconnu'}.", flush=True)
            dernier_statut = etat
        if etat == "SUCCEEDED":
            return statut
        if etat in ("FAILED", "KILLED", "CANCELLED"):
            raise RuntimeError(f"Le téléchargement GBIF {cle} a échoué : {statut.get('downloadLink') or statut}.")
        time.sleep(intervalle)
    raise TimeoutError(f"Le téléchargement GBIF {cle} n'est pas prêt après {delai_max} secondes.")


def telecharger_archive(url: str, destination: Path) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    requete = urllib.request.Request(url, headers={"User-Agent": AGENT})
    empreinte = hashlib.sha256()
    temporaire = destination.with_suffix(destination.suffix + ".part")
    try:
        with urllib.request.urlopen(requete, timeout=120) as reponse, temporaire.open("wb") as fichier:
            while bloc := reponse.read(1024 * 1024):
                fichier.write(bloc)
                empreinte.update(bloc)
        if temporaire.stat().st_size < 1024:
            raise RuntimeError("L'archive GBIF téléchargée est anormalement petite.")
        temporaire.replace(destination)
    except Exception:
        temporaire.unlink(missing_ok=True)
        raise
    return empreinte.hexdigest()


def _texte(ligne: dict[str, str], *noms: str) -> str:
    for nom in noms:
        valeur = ligne.get(nom)
        if valeur is not None and str(valeur).strip():
            return str(valeur).strip()
    return ""


def _booleen(valeur: str) -> bool:
    return valeur.strip().lower() in ("true", "1", "yes", "oui")


def _annee(valeur: str) -> int | None:
    try:
        annee = int(valeur)
    except (TypeError, ValueError):
        return None
    return annee if 1500 <= annee <= datetime.now(timezone.utc).year + 1 else None


def agreger_occurrences(lignes: Iterable[dict[str, str]]) -> dict[str, Any]:
    """Agrège les occurrences en mémoire limitée aux espèces, années, régions et sources."""
    especes: dict[str, dict[str, Any]] = {}
    regions: dict[str, dict[str, Any]] = {}
    annees: dict[tuple[int, str], dict[str, Any]] = {}
    sources: dict[str, dict[str, Any]] = {}
    qualite: Counter[str] = Counter()
    total_animaux = 0
    total_geolocalisees_valides = 0
    premiere_annee: int | None = None
    derniere_annee: int | None = None

    for ligne in lignes:
        if _texte(ligne, "kingdom").casefold() != "animalia":
            continue
        total_animaux += 1
        qualite["occurrences_animales"] += 1

        statut = _texte(ligne, "occurrenceStatus")
        if statut and statut.upper() != "PRESENT":
            qualite["statut_inattendu"] += 1

        base = _texte(ligne, "basisOfRecord") or "NON_RENSEIGNE"
        rang = _texte(ligne, "taxonRank").upper()
        # speciesKey suit le référentiel sélectionné par checklistKey (Catalogue of Life).
        # acceptedTaxonKey peut désigner le taxon accepté dans le Backbone et ne doit pas
        # remplacer la clé espèce du référentiel utilisé pour grouper le catalogue.
        cle_espece = _texte(ligne, "speciesKey")
        # species est le nom du taxon au rang espèce ; acceptedScientificName peut
        # être plus précis (ex. sous-espèce) et reste conservé dans un champ séparé.
        nom = _texte(ligne, "species", "acceptedScientificName", "scientificName")
        nom_complet = _texte(ligne, "acceptedScientificName", "scientificName") or nom
        if not cle_espece or not nom:
            qualite["sans_espece_identifiee"] += 1
            cle_espece = ""
        else:
            entree = especes.get(cle_espece)
            if entree is None:
                entree = {
                    "espece_key": cle_espece,
                    "nom_scientifique": nom,
                    "nom_complet_gbif": nom_complet,
                    "nom_court": nom,
                    "embranchement": _texte(ligne, "phylum"),
                    "classe": _texte(ligne, "class"),
                    "ordre": _texte(ligne, "order"),
                    "famille": _texte(ligne, "family"),
                    "genre": _texte(ligne, "genus"),
                    "rang_observation": rang or "INCONNU",
                    "statuts_iucn": set(),
                    "modes_etablissement": set(),
                    "types_enregistrement": set(),
                    "nb_occurrences_fossiles": 0,
                    "nb_occurrences_non_fossiles": 0,
                    "regions": {},
                    "nb_occurrences": 0,
                    "nb_occurrences_geolocalisees": 0,
                    "premiere_annee": None,
                    "derniere_annee": None,
                }
                especes[cle_espece] = entree
            entree["nb_occurrences"] += 1
            entree["types_enregistrement"].add(base)
            if base == "FOSSIL_SPECIMEN":
                entree["nb_occurrences_fossiles"] += 1
            else:
                entree["nb_occurrences_non_fossiles"] += 1
            # Conserver la meilleure information taxonomique disponible si certaines lignes sont incomplètes.
            for champ, cle in (
                ("embranchement", "phylum"), ("classe", "class"), ("ordre", "order"),
                ("famille", "family"), ("genre", "genus")
            ):
                if not entree[champ]:
                    entree[champ] = _texte(ligne, cle)
            categorie = _texte(ligne, "iucnRedListCategory").upper()
            if categorie in STATUTS_IUCN:
                entree["statuts_iucn"].add(categorie)
            elif categorie:
                qualite["statuts_iucn_inattendus"] += 1

            mode_etablissement = _texte(ligne, "establishmentMeans").upper()
            if mode_etablissement:
                entree["modes_etablissement"].add(mode_etablissement)

        annee = _annee(_texte(ligne, "year"))
        if annee is None:
            qualite["sans_annee"] += 1
        else:
            premiere_annee = annee if premiere_annee is None else min(premiere_annee, annee)
            derniere_annee = annee if derniere_annee is None else max(derniere_annee, annee)
            if cle_espece:
                if especes[cle_espece]["premiere_annee"] is None:
                    especes[cle_espece]["premiere_annee"] = annee
                    especes[cle_espece]["derniere_annee"] = annee
                else:
                    especes[cle_espece]["premiere_annee"] = min(especes[cle_espece]["premiere_annee"], annee)
                    especes[cle_espece]["derniere_annee"] = max(especes[cle_espece]["derniere_annee"], annee)
            cle_annee = (annee, base)
            point = annees.setdefault(cle_annee, {"annee": annee, "type_enregistrement": base,
                                                   "occurrences": 0, "especes": set()})
            point["occurrences"] += 1
            if cle_espece:
                point["especes"].add(cle_espece)

        # Uniquement une affectation administrative fournie par GADM, pour des coordonnées valides.
        # Aucune coordonnée, adresse ou donnée individuelle n'est conservée dans les sorties.
        coordonnees_valides = _booleen(_texte(ligne, "hasCoordinate")) and not _booleen(_texte(ligne, "hasGeospatialIssues"))
        if coordonnees_valides:
            total_geolocalisees_valides += 1
            if cle_espece:
                especes[cle_espece]["nb_occurrences_geolocalisees"] += 1
            gid = _texte(ligne, "level1Gid")
            nom_region = _texte(ligne, "level1Name")
            if gid and nom_region:
                region = regions.setdefault(gid, {
                    "region_gadm_key": gid, "region_gadm": nom_region,
                    "occurrences": 0, "especes": set(), "familles": set(),
                })
                region["occurrences"] += 1
                if cle_espece:
                    region["especes"].add(cle_espece)
                    famille = _texte(ligne, "family")
                    if famille:
                        region["familles"].add(famille)
                if cle_espece:
                    especes[cle_espece]["regions"][gid] = nom_region
            elif not gid or not nom_region:
                qualite["coordonnees_sans_region_gadm"] += 1
        else:
            qualite["sans_coordonnees_valides"] += 1

        dataset_key = _texte(ligne, "datasetKey") or "NON_RENSEIGNE"
        dataset_name = _texte(ligne, "datasetName", "datasetTitle") or dataset_key
        source = sources.setdefault(dataset_key, {
            "dataset_key": dataset_key, "jeu_de_donnees": dataset_name,
            "occurrences": 0, "especes": set(),
        })
        source["occurrences"] += 1
        if cle_espece:
            source["especes"].add(cle_espece)

    # Les catégories IUCN contradictoires ne sont pas arbitrairement départagées.
    lignes_especes: list[dict[str, Any]] = []
    categories_especes: Counter[str] = Counter()
    for entree in especes.values():
        statuts = sorted(entree.pop("statuts_iucn"))
        if len(statuts) == 1:
            statut_iucn = statuts[0]
        elif len(statuts) > 1:
            statut_iucn = "MULTIPLE"
        else:
            statut_iucn = "NON_RENSEIGNE"
        categories_especes[statut_iucn] += 1
        entree["statut_iucn"] = statut_iucn
        entree["statuts_iucn_source"] = ";".join(statuts)
        entree["libelle_iucn"] = NOMS_IUCN.get(statut_iucn, "Statut non renseigné ou contradictoire")
        modes = sorted(entree.pop("modes_etablissement"))
        entree["mode_etablissement"] = modes[0] if len(modes) == 1 else ("MULTIPLE" if modes else "NON_RENSEIGNE")
        entree["modes_etablissement_source"] = ";".join(modes)
        bases = sorted(entree.pop("types_enregistrement"))
        entree["types_enregistrement"] = ";".join(bases)
        entree["fossile_uniquement"] = (
            entree["nb_occurrences_fossiles"] > 0 and entree["nb_occurrences_non_fossiles"] == 0
        )
        entree["nb_regions_gadm"] = len(entree["regions"])
        entree["regions_gadm"] = ";".join(sorted(entree["regions"].values()))
        entree.pop("regions")
        lignes_especes.append(entree)
    lignes_especes.sort(key=lambda x: (-x["nb_occurrences"], x["nom_scientifique"].casefold()))

    lignes_regions: list[dict[str, Any]] = []
    for entree in regions.values():
        lignes_regions.append({
            "region_gadm_key": entree["region_gadm_key"],
            "region_gadm": entree["region_gadm"],
            "nb_occurrences_geolocalisees": entree["occurrences"],
            "nb_especes_distinctes": len(entree["especes"]),
            "nb_familles_distinctes": len(entree["familles"]),
            "unite": "enregistrements et taxons distincts",
        })
    lignes_regions.sort(key=lambda x: (-x["nb_especes_distinctes"], x["region_gadm"]))

    lignes_conservation = []
    for statut in (*STATUTS_IUCN, "MULTIPLE", "NON_RENSEIGNE"):
        nombre = categories_especes.get(statut, 0)
        if nombre:
            lignes_conservation.append({
                "categorie_iucn": statut,
                "libelle": NOMS_IUCN.get(statut, "Statut multiple" if statut == "MULTIPLE" else "Non renseigné"),
                "nb_especes": nombre,
                "part_pct": round(nombre * 100 / max(len(lignes_especes), 1), 4),
            })

    lignes_historique = []
    for (annee, base), entree in sorted(annees.items()):
        lignes_historique.append({
            "annee": annee, "type_enregistrement": base,
            "nb_occurrences": entree["occurrences"],
            "nb_especes_distinctes": len(entree["especes"]),
            "unite": "signalements GBIF",
        })

    lignes_sources = []
    for entree in sources.values():
        lignes_sources.append({
            "dataset_key": entree["dataset_key"],
            "jeu_de_donnees": entree["jeu_de_donnees"],
            "nb_occurrences": entree["occurrences"],
            "nb_especes_distinctes": len(entree["especes"]),
            "url_gbif": "https://www.gbif.org/dataset/" + entree["dataset_key"] if entree["dataset_key"] != "NON_RENSEIGNE" else "",
        })
    lignes_sources.sort(key=lambda x: (-x["nb_occurrences"], x["jeu_de_donnees"].casefold()))
    lignes_sources = lignes_sources[:100]

    indicateurs = [
        {"indicateur": "Occurrences animales GBIF", "valeur": total_animaux, "unite": "enregistrements"},
        {"indicateur": "Espèces animales distinctes identifiées", "valeur": len(lignes_especes), "unite": "espèces"},
        {"indicateur": "Occurrences avec coordonnées valides", "valeur": total_geolocalisees_valides, "unite": "enregistrements"},
        {"indicateur": "Régions GADM de niveau 1 présentes", "valeur": len(lignes_regions), "unite": "régions"},
        {"indicateur": "Familles représentées", "valeur": len({x["famille"] for x in lignes_especes if x["famille"]}), "unite": "familles"},
        {"indicateur": "Occurrences sans espèce identifiée", "valeur": qualite["sans_espece_identifiee"], "unite": "enregistrements"},
        {"indicateur": "Occurrences sans année exploitable", "valeur": qualite["sans_annee"], "unite": "enregistrements"},
        {"indicateur": "Occurrences sans coordonnées valides", "valeur": qualite["sans_coordonnees_valides"], "unite": "enregistrements"},
        {"indicateur": "Occurrences géolocalisées sans région GADM", "valeur": qualite["coordonnees_sans_region_gadm"], "unite": "enregistrements"},
        {"indicateur": "Espèces avec statut IUCN renseigné", "valeur": len(lignes_especes) - categories_especes.get("NON_RENSEIGNE", 0), "unite": "espèces"},
    ]
    qualite_lignes = [{"indicateur": cle, "valeur": valeur} for cle, valeur in sorted(qualite.items())]
    return {
        "especes": lignes_especes,
        "regions": lignes_regions,
        "conservation": lignes_conservation,
        "historique": lignes_historique,
        "sources": lignes_sources,
        "indicateurs": indicateurs,
        "qualite": qualite_lignes,
        "total_animaux": total_animaux,
        "total_geolocalisees_valides": total_geolocalisees_valides,
        "premiere_annee": premiere_annee,
        "derniere_annee": derniere_annee,
        "nb_especes": len(lignes_especes),
        "nb_regions_gadm": len(lignes_regions),
    }


def ecrire_csv(chemin: Path, lignes: list[dict[str, Any]]) -> None:
    if not lignes:
        # Un CSV vide avec une ligne d'en-tête stable reste exploitable.
        chemin.write_text("aucune_donnee\n", encoding="utf-8-sig")
        return
    colonnes = list(lignes[0].keys())
    with chemin.open("w", encoding="utf-8-sig", newline="") as fichier:
        auteur = csv.DictWriter(fichier, fieldnames=colonnes, extrasaction="ignore")
        auteur.writeheader()
        auteur.writerows(lignes)


def ecrire_sorties(sortie: Path, resultat: dict[str, Any], rapport: dict[str, Any]) -> None:
    sortie.mkdir(parents=True, exist_ok=True)
    rapport_complet = {
        "genere_le": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **rapport,
        "occurrences_animales": resultat["total_animaux"],
        "occurrences_geolocalisees_valides": resultat["total_geolocalisees_valides"],
        "nb_especes": resultat["nb_especes"],
        "nb_regions_gadm": resultat["nb_regions_gadm"],
        "premiere_annee": resultat["premiere_annee"],
        "derniere_annee": resultat["derniere_annee"],
        "nb_lignes_especes": len(resultat["especes"]),
        "nb_lignes_regions": len(resultat["regions"]),
        "nb_lignes_conservation": len(resultat["conservation"]),
        "nb_lignes_historique": len(resultat["historique"]),
        "nb_lignes_sources": len(resultat["sources"]),
        "nb_indicateurs": len(resultat["indicateurs"]),
        "nb_lignes_qualite": len(resultat["qualite"]),
    }
    tables = {
        "especes": resultat["especes"],
        "regions": resultat["regions"],
        "conservation": resultat["conservation"],
        "historique": resultat["historique"],
        "sources": resultat["sources"],
        "indicateurs": resultat["indicateurs"],
        "qualite": resultat["qualite"],
    }
    for cle, lignes in tables.items():
        nom = FICHIERS[cle]
        (sortie / f"{nom}.json").write_text(
            json.dumps(lignes, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        ecrire_csv(sortie / f"{nom}.csv", lignes)
    (sortie / "rapport.json").write_text(
        json.dumps(rapport_complet, ensure_ascii=False, allow_nan=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (sortie / "qualite.json").write_text(
        json.dumps(resultat["qualite"], ensure_ascii=False, allow_nan=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"{resultat['total_animaux']:,} occurrences animales, {resultat['nb_especes']:,} espèces, "
        f"{resultat['nb_regions_gadm']} régions GADM ; période "
        f"{resultat['premiere_annee'] or '—'}–{resultat['derniere_annee'] or '—'}.",
        flush=True,
    )


def trouver_occurrence(archive: zipfile.ZipFile) -> str:
    candidats = [nom for nom in archive.namelist() if nom.replace("\\", "/").endswith("occurrence.txt")]
    if not candidats:
        raise RuntimeError("L'archive Darwin Core GBIF ne contient pas occurrence.txt.")
    return min(candidats, key=len)


def calculer_archive(archive_path: Path, sortie: Path, metadata: dict[str, Any],
                     empreinte_archive: str) -> dict[str, Any]:
    with zipfile.ZipFile(archive_path) as archive:
        nom_occurrence = trouver_occurrence(archive)
        with archive.open(nom_occurrence) as contenu:
            flux = io.TextIOWrapper(contenu, encoding="utf-8-sig", newline="")
            lecteur = csv.DictReader(flux, delimiter="\t", quotechar='"')
            champs_requis = {"kingdom", "speciesKey", "acceptedScientificName"}
            disponibles = set(lecteur.fieldnames or [])
            absents = champs_requis - disponibles
            if absents:
                raise RuntimeError("Colonnes attendues absentes de occurrence.txt : " + ", ".join(sorted(absents)))
            resultat = agreger_occurrences(lecteur)

    if resultat["total_animaux"] <= 0 or resultat["nb_especes"] <= 0:
        raise RuntimeError("Le téléchargement GBIF ne contient aucune espèce animale exploitable.")
    rapport = {
        "source": "GBIF Occurrence Download API — Darwin Core Archive",
        "source_url": SOURCE_URL,
        "api_url": API_DEMANDE,
        "cle_telechargement": metadata.get("key"),
        "doi": metadata.get("doi"),
        "citation_gbif": metadata.get("citation"),
        "total_enregistrements_telechargement": metadata.get("totalRecords"),
        "format": "DWCA",
        "checklist_taxonomique": "Catalogue of Life Extended Release",
        "checklist_key": CHECKLIST_COL,
        "filtres": {
            "country": "DZ",
            "occurrenceStatus": "PRESENT",
            "license": list(LICENCES),
            "royaume_publie": "Animalia (filtré lors de l'agrégation)",
            "coordonnees_obligatoires": False,
        },
        "licences_incluses": list(LICENCES),
        "empreinte_sha256_archive": empreinte_archive,
        "nb_occurrences_animales": resultat["total_animaux"],
        "nb_especes": resultat["nb_especes"],
        "avertissement": (
            "Une occurrence est un enregistrement de présence, pas un effectif de population. "
            "La couverture dépend des contributeurs et de l'effort d'observation. "
            "Les répartitions utilisent les régions GADM de niveau 1 fournies par GBIF ; "
            "les coordonnées exactes et les fiches individuelles ne sont pas publiées. "
            "Les catégories IUCN sont celles interprétées par GBIF et peuvent être absentes."
        ),
    }
    ecrire_sorties(sortie, resultat, rapport)
    return rapport


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--sortie", type=Path, required=True)
    parser.add_argument("--attente-max-secondes", type=int, default=3600)
    args = parser.parse_args()

    username = os.environ.get("GBIF_USERNAME", "").strip()
    password = os.environ.get("GBIF_PASSWORD", "").strip()
    email = os.environ.get("GBIF_EMAIL", "").strip()
    if not username or not password or not email:
        raise RuntimeError(
            "Secrets GBIF manquants : configure GBIF_USERNAME, GBIF_PASSWORD et GBIF_EMAIL "
            "dans les secrets du dépôt GitHub (compte GBIF personnel requis)."
        )
    valider_identifiant_gbif(username)

    args.cache.mkdir(parents=True, exist_ok=True)
    print("Demande d'un téléchargement GBIF complet pour les occurrences présentes en Algérie…", flush=True)
    cle = demander_telechargement(username, password, email)
    print(f"Clé de téléchargement GBIF : {cle}", flush=True)
    metadata = attendre_telechargement(cle, delai_max=args.attente_max_secondes)
    url = str(metadata.get("downloadLink") or f"https://api.gbif.org/occurrence/download/request/{cle}.zip")
    archive_path = args.cache / f"gbif-faune-{cle}.zip"
    empreinte = telecharger_archive(url, archive_path)
    calculer_archive(archive_path, args.sortie, metadata | {"key": cle}, empreinte)


if __name__ == "__main__":
    try:
        main()
    except Exception as erreur:
        print(f"ERREUR FAUNE GBIF : {erreur}", file=sys.stderr)
        raise
