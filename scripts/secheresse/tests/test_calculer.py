from datetime import date

import numpy as np
import pytest

import calculer


def test_month_window_and_safe_lag():
    assert calculer.safe_latest_month(date(2026, 11, 14)) == "2026-08"
    assert len(calculer.months_between("1981-01", "2026-08")) == 548


def test_cds_groups_do_not_request_partial_year_months():
    groups = calculer.groupes_requetes("1981-03", "1992-02", max_annees=5)
    assert groups[0] == (["1981"], [f"{m:02d}" for m in range(3, 13)])
    assert groups[-1] == (["1992"], ["01", "02"])
    assert all(len(years) <= 5 for years, _ in groups)
    assert calculer.groupes_requetes("2026-06", "2026-08") == [(["2026"], ["06", "07", "08"])]


def test_monthly_precipitation_conversion_uses_calendar_days():
    assert calculer.precipitation_mm_mois(0.001, 2024, 2) == pytest.approx(29.0)
    assert calculer.precipitation_mm_mois(0.001, 2025, 2) == pytest.approx(28.0)
    with pytest.raises(ValueError):
        calculer.precipitation_mm_mois(-0.01, 2025, 1)


def test_root_zone_soil_water_is_depth_weighted():
    assert calculer.humidite_racine_ponderee(0.1, 0.2, 0.3) == pytest.approx((7 * .1 + 21 * .2 + 72 * .3) / 100)
    with pytest.raises(ValueError):
        calculer.humidite_racine_ponderee(1.1, .2, .3)


def test_spi_gamma_zero_mass_and_insufficient_reference():
    reference = np.asarray([0.0, *np.linspace(8.0, 55.0, 29)])
    calculated = calculer.cdf_spi(reference, np.asarray([0.0, 8.0, 20.0, 80.0]))
    assert calculated.shape == (4,)
    assert np.all(np.isfinite(calculated))
    assert calculated[0] < calculated[1]
    assert calculated[-1] > calculated[2]
    too_short = calculer.cdf_spi(np.asarray([0.0, 1.0, 2.0]), np.asarray([1.0]))
    assert np.isnan(too_short[0])


def test_monthly_indicators_are_baseline_calibrated_and_keep_nulls_when_missing():
    lines = []
    for year in range(1981, 2024):
        for month in range(1, 13):
            rainfall = 12 + month * 3 + ((year * 7 + month * 3) % 17)
            soil = 0.08 + month / 100 + ((year + month) % 7) / 100
            lines.append({
                "code_wilaya": "01", "wilaya": "Adrar", "date": f"{year:04d}-{month:02d}-01",
                "precipitation_mm": rainfall,
                "humidite_sol_0_7_cm": soil,
                "humidite_sol_7_28_cm": soil + .01,
                "humidite_sol_28_100_cm": soil + .02,
                "humidite_sol_100_289_cm": soil + .03,
                "humidite_sol_0_100_cm": soil + .017,
                "humidite_sol_0_289_cm": soil + .025,
                "temperature_moyenne_c": 20.0,
                "nb_cellules": 3,
            })
    enriched = calculer.calculer_indicateurs(lines)
    current = next(row for row in enriched if row["date"] == "2023-08-01")
    assert current["precipitation_normale_mm"] is not None
    assert current["anomalie_precipitation_pct"] is not None
    assert current["spi_3"] is not None
    assert current["spi_12"] is not None
    assert current["percentile_humidite_sol"] is not None
    assert "nb_cellules" not in current
    assert list(current).index("spi_3") < list(current).index("precipitation_mm")

    gap_lines = [row for row in lines if row["date"] != "2020-05-01"]
    gap_enriched = calculer.calculer_indicateurs(gap_lines)
    row_after_gap = next(row for row in gap_enriched if row["date"] == "2020-06-01")
    assert row_after_gap["spi_3"] is None
    assert row_after_gap["spi_12"] is None


def test_data_validation_requires_all_69_wilayas_for_every_month():
    names = {i: {"fr": f"Wilaya {i}", "ar": f"ولاية {i}"} for i in range(1, 70)}
    rows = []
    for month in ("2025-01-01", "2025-02-01"):
        for code in range(1, 70):
            rows.append({
                "code_wilaya": f"{code:02d}", "wilaya": f"Wilaya {code}", "date": month,
                "precipitation_mm": 10.0,
                "humidite_sol_0_7_cm": .1, "humidite_sol_7_28_cm": .2,
                "humidite_sol_28_100_cm": .3, "humidite_sol_100_289_cm": .4,
                "humidite_sol_0_100_cm": .27, "humidite_sol_0_289_cm": .35,
                "temperature_moyenne_c": 20.0, "spi_3": None, "spi_12": None,
                "precipitation_normale_mm": None, "anomalie_precipitation_pct": None,
                "percentile_humidite_sol": None,
            })
    report = calculer.verifier_donnees(rows, names, "2025-01", "2025-02")
    assert report["nb_lignes"] == 138
    with pytest.raises(ValueError, match="Période mensuelle discontinue"):
        calculer.verifier_donnees(rows[:69] + rows[138:], names, "2025-01", "2025-02")
