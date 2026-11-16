from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from calculer import construire_sorties, normaliser_ligne  # noqa: E402


def ligne(**modifications):
    resultat = {
        "Area": "Algeria",
        "Area Code": "4",
        "Item Code": "15",
        "Item": "Wheat",
        "Element Code": "5510",
        "Element": "Production",
        "Year": "2020",
        "Unit": "tonnes",
        "Value": "1000",
        "Flag": "A",
        "Flag Description": "Official figure",
        "Note": "",
    }
    resultat.update(modifications)
    return resultat


class AgricultureFaostatTests(unittest.TestCase):
    def test_ignore_les_autres_pays(self):
        self.assertIsNone(normaliser_ligne(ligne(Area="Morocco")))

    def test_normalise_une_observation_sans_perdre_unite_et_qualite(self):
        observation = normaliser_ligne(ligne(Value="1,25"))
        self.assertEqual(observation["annee"], 2020)
        self.assertEqual(observation["valeur"], 1.25)
        self.assertEqual(observation["unite"], "tonnes")
        self.assertEqual(observation["qualite"], "Official figure")

    def test_ignore_valeurs_absentes_et_annees_invalides(self):
        self.assertIsNone(normaliser_ligne(ligne(Value="")))
        self.assertIsNone(normaliser_ligne(ligne(Year="unknown")))

    def test_conserve_les_series_sans_additionner_des_unites_differentes(self):
        resultat = construire_sorties([
            ligne(),
            ligne(Year="2021", Value="1500"),
            ligne(Item="Barley", Element="Area harvested", Unit="ha", Value="20"),
            ligne(Area="France", Value="999999"),
        ])
        self.assertEqual(resultat["nb_observations"], 3)
        self.assertEqual(resultat["nb_produits"], 2)
        self.assertEqual(resultat["premiere_annee"], 2020)
        self.assertEqual(resultat["derniere_annee"], 2021)
        self.assertEqual(len(resultat["qualite"]), 1)
        self.assertEqual(resultat["series"][0]["valeur"], 20)
        self.assertEqual(resultat["series"][0]["unite"], "ha")


if __name__ == "__main__":
    unittest.main()
