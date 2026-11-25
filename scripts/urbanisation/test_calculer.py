"""Tests de calculer.py : python -m unittest discover -s scripts/urbanisation (rasterio et numpy requis)."""

import unittest

from affine import Affine

from calculer import surface_cellules, tuiles_utiles


def carre(ouest: float, sud: float, est: float, nord: float) -> dict:
    return {"geometry": {"type": "Polygon", "coordinates": [[[ouest, sud], [est, sud], [est, nord], [ouest, nord], [ouest, sud]]]}, "properties": {"code": 1}}


class TestTuiles(unittest.TestCase):
    def test_alger_dans_une_seule_tuile(self):
        # Alger (≈ 3° E, 36,7° N) : tuile R6_C19 (0°–10° E, 29,1°–39,1° N).
        self.assertEqual(tuiles_utiles([carre(2.8, 36.5, 3.3, 36.9)]), [(6, 19)])

    def test_wilaya_a_cheval_sur_quatre_tuiles(self):
        self.assertEqual(tuiles_utiles([carre(-1, 28, 1, 30)]), [(6, 18), (6, 19), (7, 18), (7, 19)])

    def test_extreme_sud(self):
        # In Guezzam descend sous 19,1° N : tuile de la ligne 8.
        self.assertIn((8, 19), tuiles_utiles([carre(5.0, 18.96, 6.0, 20.0)]))


class TestSurfaces(unittest.TestCase):
    def test_surface_des_cellules(self):
        pas = 3 / 3600
        aires = surface_cellules(Affine(pas, 0, 0, 0, -pas, 0.5 * pas), 1, 1)  # cellule centrée sur l'équateur
        self.assertAlmostEqual(aires[0], 0.008587, places=5)  # ≈ 92,7 m × 92,7 m
        nord = surface_cellules(Affine(pas, 0, 0, 0, -pas, 60 + 0.5 * pas), 1, 1)
        self.assertAlmostEqual(nord[0] / aires[0], 0.5, places=3)  # cos(60°)


if __name__ == "__main__":
    unittest.main()
