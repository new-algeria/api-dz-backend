from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from calculer import agreger_occurrences, construire_requete  # noqa: E402


def ligne(**modifications):
    resultat = {
        "kingdom": "Animalia",
        "speciesKey": "123",
        "acceptedScientificName": "Canis lupus Linnaeus, 1758",
        "species": "Canis lupus",
        "taxonRank": "SPECIES",
        "phylum": "Chordata",
        "class": "Mammalia",
        "order": "Carnivora",
        "family": "Canidae",
        "genus": "Canis",
        "iucnRedListCategory": "EN",
        "year": "2020",
        "basisOfRecord": "HUMAN_OBSERVATION",
        "hasCoordinate": "true",
        "hasGeospatialIssues": "false",
        "level1Gid": "DZA.1_1",
        "level1Name": "Adrar",
        "datasetKey": "dataset-a",
        "datasetName": "Jeu de données A",
        "establishmentMeans": "NATIVE",
        "occurrenceStatus": "PRESENT",
    }
    resultat.update(modifications)
    return resultat


def test_construit_le_corpus_de_telechargement_sans_filtrer_les_coordonnees():
    requete = construire_requete("faune@example.org")
    predicates = requete["predicate"]["predicates"]
    assert requete["format"] == "DWCA"
    assert requete["checklistKey"]
    assert predicates[0] == {"type": "equals", "key": "COUNTRY", "value": "DZ"}
    assert predicates[1] == {"type": "equals", "key": "OCCURRENCE_STATUS", "value": "PRESENT"}
    assert predicates[2]["key"] == "LICENSE"
    assert "HAS_COORDINATE" not in str(requete)


def test_agrege_les_observations_par_espece_sans_exposer_les_occurrences():
    lignes = [
        ligne(),
        ligne(year="2022", basisOfRecord="MATERIAL_SAMPLE",
              hasCoordinate="false", hasGeospatialIssues="false"),
        ligne(speciesKey="456", acceptedScientificName="Vulpes vulpes (Linnaeus, 1758)",
              species="Vulpes vulpes", family="Canidae", iucnRedListCategory="LC",
              level1Gid="DZA.2_1", level1Name="Chlef", datasetKey="dataset-b",
              datasetName="Jeu de données B"),
        ligne(kingdom="Plantae", speciesKey="789", acceptedScientificName="Olea europaea L."),
        ligne(speciesKey="", acceptedScientificName="", scientificName="Animalia indet.",
              taxonRank="KINGDOM", year="", basisOfRecord="UNKNOWN"),
    ]
    resultat = agreger_occurrences(lignes)
    assert resultat["total_animaux"] == 4
    assert resultat["nb_especes"] == 2

    loup, renard = resultat["especes"]
    assert loup["espece_key"] == "123"
    assert loup["nb_occurrences"] == 2
    assert loup["premiere_annee"] == 2020
    assert loup["derniere_annee"] == 2022
    assert loup["nb_regions_gadm"] == 1
    assert loup["statut_iucn"] == "EN"
    assert loup["mode_etablissement"] == "NATIVE"
    assert "decimalLatitude" not in loup and "decimalLongitude" not in loup
    assert renard["espece_key"] == "456"
    assert renard["statut_iucn"] == "LC"

    adrar = next(r for r in resultat["regions"] if r["region_gadm"] == "Adrar")
    assert adrar["nb_especes_distinctes"] == 1
    assert adrar["nb_occurrences_geolocalisees"] == 1


def test_ne_force_pas_un_statut_iucn_qui_varie_entre_occurrences():
    resultat = agreger_occurrences([
        ligne(iucnRedListCategory="EN"),
        ligne(iucnRedListCategory="VU", year="2021"),
    ])
    espece = resultat["especes"][0]
    assert espece["statut_iucn"] == "MULTIPLE"
    assert espece["statuts_iucn_source"] == "EN;VU"


def test_les_donnees_sans_coordonnees_restent_dans_le_catalogue():
    resultat = agreger_occurrences([
        ligne(hasCoordinate="false", level1Gid="", level1Name=""),
    ])
    assert resultat["total_animaux"] == 1
    assert resultat["nb_especes"] == 1
    assert resultat["especes"][0]["nb_occurrences"] == 1
    assert resultat["especes"][0]["nb_regions_gadm"] == 0
    assert resultat["regions"] == []
