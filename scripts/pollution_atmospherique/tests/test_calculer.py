import numpy as np
import pytest

from scripts.pollution_atmospherique.calculer import (
    MASSE_MOLAIRE_AIR_SEC,
    convertir_melange_ppbv,
    convertir_pm_ug_m3,
    groupes_requetes,
    mois_entre,
)


def test_conversion_pm_kg_m3_vers_microgrammes_m3():
    assert convertir_pm_ug_m3(1e-9) == pytest.approx(1.0)
    assert convertir_pm_ug_m3(2.5e-8) == pytest.approx(25.0)


def test_conversion_rapport_massique_vers_ppbv():
    # 1 ppm molaire de CO vaut 1 000 ppbv.
    q = 1_000e-9 * 28.0101 / MASSE_MOLAIRE_AIR_SEC
    assert convertir_melange_ppbv(q, 28.0101) == pytest.approx(1_000.0)


@pytest.mark.parametrize("valeur", [-1.0, float("nan"), float("inf")])
def test_refuse_concentration_pm_invalide(valeur):
    with pytest.raises(ValueError):
        convertir_pm_ug_m3(valeur)


@pytest.mark.parametrize("valeur", [-1.0, float("nan"), float("inf")])
def test_refuse_rapport_massique_invalide(valeur):
    with pytest.raises(ValueError):
        convertir_melange_ppbv(valeur, 28.01)


def test_groupes_requetes_decoupe_par_cinq_annees():
    assert groupes_requetes("2003-01", "2025-12") == [
        ["2003", "2004", "2005", "2006", "2007"],
        ["2008", "2009", "2010", "2011", "2012"],
        ["2013", "2014", "2015", "2016", "2017"],
        ["2018", "2019", "2020", "2021", "2022"],
        ["2023", "2024", "2025"],
    ]


def test_mois_couvrent_les_276_mois_attendus():
    mois = mois_entre("2003-01", "2025-12")
    assert len(mois) == 276
    assert mois[0] == "2003-01"
    assert mois[-1] == "2025-12"


def test_refuse_un_ordre_de_dates_inverse():
    assert groupes_requetes("2025-01", "2024-12") == []
