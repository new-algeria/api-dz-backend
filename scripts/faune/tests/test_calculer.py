from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from calculer import agreger_occurrences, construire_requete  # noqa: E402


def ligne(**modifications):
    resultat = {
        "kingdom": "Animalia",
        "speciesKey": "123",
        "acceptedTaxonKey": "999",
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


class FauneGbifTests(unittest.TestCase):
    def test_construit_le_corpus_de_telechargement_sans_filtrer_les_coordonnees(self):
        requete = construire_requete("faune@example.org")
        predicates = requete["predicate"]["predicates"]
        self.assertEqual(requete["format"], "DWCA")
        self.assertTrue(requete["checklistKey"])
        self.assertEqual(predicates[0], {"type": "equals", "key": "COUNTRY", "value": "DZ"})
        self.assertEqual(predicates[1], {"type": "equals", "key": "OCCURRENCE_STATUS", "value": "PRESENT"})
        self.assertEqual(predicates[2]["key"], "LICENSE")
        self.assertNotIn("HAS_COORDINATE", str(requete))

    def test_agrege_les_observations_par_espece_sans_exposer_les_occurrences(self):
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
        self.assertEqual(resultat["total_animaux"], 4)
        self.assertEqual(resultat["nb_especes"], 2)

        loup, renard = resultat["especes"]
        self.assertEqual(loup["espece_key"], "123")
        self.assertEqual(loup["nom_scientifique"], "Canis lupus Linnaeus, 1758")
        self.assertEqual(loup["nom_court"], "Canis lupus")
        self.assertEqual(loup["nb_occurrences"], 2)
        self.assertEqual(loup["premiere_annee"], 2020)
        self.assertEqual(loup["derniere_annee"], 2022)
        self.assertEqual(loup["nb_regions_gadm"], 1)
        self.assertEqual(loup["nb_occurrences_geolocalisees"], 1)
        self.assertEqual(loup["statut_iucn"], "EN")
        self.assertEqual(loup["mode_etablissement"], "NATIVE")
        self.assertNotIn("decimalLatitude", loup)
        self.assertNotIn("decimalLongitude", loup)
        self.assertEqual(renard["espece_key"], "456")
        self.assertEqual(renard["statut_iucn"], "LC")

        adrar = next(r for r in resultat["regions"] if r["region_gadm"] == "Adrar")
        self.assertEqual(adrar["nb_especes_distinctes"], 1)
        self.assertEqual(adrar["nb_occurrences_geolocalisees"], 2)

    def test_ne_force_pas_un_statut_iucn_qui_varie_entre_occurrences(self):
        resultat = agreger_occurrences([
            ligne(iucnRedListCategory="EN"),
            ligne(iucnRedListCategory="VU", year="2021"),
        ])
        espece = resultat["especes"][0]
        self.assertEqual(espece["statut_iucn"], "MULTIPLE")
        self.assertEqual(espece["statuts_iucn_source"], "EN;VU")

    def test_les_donnees_sans_coordonnees_restent_dans_le_catalogue(self):
        resultat = agreger_occurrences([
            ligne(hasCoordinate="false", level1Gid="", level1Name=""),
        ])
        self.assertEqual(resultat["total_animaux"], 1)
        self.assertEqual(resultat["nb_especes"], 1)
        self.assertEqual(resultat["especes"][0]["nb_occurrences"], 1)
        self.assertEqual(resultat["especes"][0]["nb_regions_gadm"], 0)
        self.assertEqual(resultat["regions"], [])


if __name__ == "__main__":
    unittest.main()
