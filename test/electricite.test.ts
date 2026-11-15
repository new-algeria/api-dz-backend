import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import { analyserCsv } from "../scripts/electricite/calculer.js";

const champs = [
  "Area", "ISO 3 code", "Year", "Electricity source", "Is aggregated source",
  "Generation (TWh)", "Generation YoY change (TWh)", "Generation YoY change (%)",
  "Share of generation (%)", "Share of generation YoY change (% points)", "Capacity (GW)",
  "Emissions (MtCO2e)", "Emissions YoY change (MtCO2e)", "Emissions YoY change (%)",
  "Share of emissions (%)", "Emissions intensity (gCO2e/kWh)",
];

function creerCsv(): string {
  const lignes: Record<string, string | number | boolean | null>[] = [];
  for (let annee = 2000; annee <= 2024; annee++) {
    const actuel = annee === 2024;
    const production = actuel ? 96.36 : 25 + (annee - 2000) * 2.9;
    const demande = actuel ? 93.84 : production - 0.1;
    const commun = {
      Area: "Algeria",
      "ISO 3 code": "DZA",
      Year: annee,
      "Generation YoY change (TWh)": null,
      "Generation YoY change (%)": null,
      "Share of generation YoY change (% points)": null,
      "Emissions YoY change (MtCO2e)": null,
      "Emissions YoY change (%)": null,
    };
    lignes.push(
      {
        ...commun,
        "Electricity source": "Total generation",
        "Is aggregated source": true,
        "Generation (TWh)": production,
        "Share of generation (%)": 100,
        "Capacity (GW)": actuel ? 27.99 : 5,
        "Emissions (MtCO2e)": actuel ? 60.981 : 16,
        "Share of emissions (%)": 100,
        "Emissions intensity (gCO2e/kWh)": actuel ? 632.846 : 638,
      },
      {
        ...commun,
        "Electricity source": "Demand",
        "Is aggregated source": true,
        "Generation (TWh)": demande,
        "Share of generation (%)": (demande / production) * 100,
        "Capacity (GW)": null,
        "Emissions (MtCO2e)": null,
        "Share of emissions (%)": null,
        "Emissions intensity (gCO2e/kWh)": null,
      },
      {
        ...commun,
        "Electricity source": "Net imports",
        "Is aggregated source": false,
        "Generation (TWh)": actuel ? -2.52 : -0.1,
        "Share of generation (%)": actuel ? -2.615 : -0.4,
        "Capacity (GW)": null,
        "Emissions (MtCO2e)": null,
        "Share of emissions (%)": null,
        "Emissions intensity (gCO2e/kWh)": null,
      },
      {
        ...commun,
        "Electricity source": "Gas",
        "Is aggregated source": false,
        "Generation (TWh)": actuel ? 95 : production * 0.98,
        "Share of generation (%)": actuel ? 98.589 : 98,
        "Capacity (GW)": actuel ? 25.83 : 4.6,
        "Emissions (MtCO2e)": actuel ? 60.5 : 15.8,
        "Share of emissions (%)": actuel ? 99.2 : 99,
        "Emissions intensity (gCO2e/kWh)": actuel ? 637 : 639,
      },
      {
        ...commun,
        "Electricity source": "Solar",
        "Is aggregated source": false,
        "Generation (TWh)": actuel ? 0.99 : 0,
        "Share of generation (%)": actuel ? 1.027 : 0,
        "Capacity (GW)": actuel ? 0.46 : 0,
        "Emissions (MtCO2e)": actuel ? 0.3 : 0,
        "Share of emissions (%)": actuel ? 0.5 : 0,
        "Emissions intensity (gCO2e/kWh)": actuel ? 250 : null,
      },
      {
        ...commun,
        "Electricity source": "Hydro",
        "Is aggregated source": false,
        "Generation (TWh)": actuel ? 0.02 : 0,
        "Share of generation (%)": actuel ? 0.021 : 0,
        "Capacity (GW)": actuel ? 0.13 : 0,
        "Emissions (MtCO2e)": actuel ? 0.01 : 0,
        "Share of emissions (%)": actuel ? 0.02 : 0,
        "Emissions intensity (gCO2e/kWh)": actuel ? 20 : null,
      }
    );
  }
  lignes.push({
    Area: "World", "ISO 3 code": "WLD", Year: 2024,
    "Electricity source": "Total generation", "Is aggregated source": true,
    "Generation (TWh)": 30000,
  });
  return Papa.unparse({ fields: champs, data: lignes });
}

const csv = creerCsv();

describe("extraction Ember pour l'Algérie", () => {
  it("filtre le code DZA et conserve la production, la demande et les filières séparément", () => {
    const resultat = analyserCsv(csv);
    expect(resultat.rapport).toMatchObject({
      pays: "Algérie",
      code_iso3: "DZA",
      premiere_annee: 2000,
      derniere_annee: 2024,
      nb_series: 25,
      reference_2024: {
        production_totale_twh: 96.36,
        demande_electricite_twh: 93.84,
        controle: "conforme",
      },
    });
    expect(resultat.lignes).toHaveLength(150);
    expect(resultat.lignes.every((ligne) => ligne.code_iso3 === "DZA")).toBe(true);
    expect(resultat.lignes.find((ligne) => ligne.annee === 2024 && ligne.type_ligne === "production_totale")?.valeur_twh).toBe(96.36);
    expect(resultat.lignes.find((ligne) => ligne.annee === 2024 && ligne.type_ligne === "demande")?.valeur_twh).toBe(93.84);
    expect(resultat.lignes.find((ligne) => ligne.annee === 2024 && ligne.source_electricite === "Gas")?.part_generation_pct).toBe(98.589);
  });

  it("prépare une courbe au format long natif Data-DZ et identifie les agrégats", () => {
    const resultat = analyserCsv(csv);
    expect(resultat.graphique).toHaveLength(150);
    expect(resultat.graphique.find((ligne) => ligne.annee === 2024 && ligne.filiere === "Gas")).toMatchObject({
      valeur: 95,
      unite: "TWh",
    });
    expect(resultat.graphique.find((ligne) => ligne.annee === 2024 && ligne.filiere === "Total generation (agrégat)")?.valeur).toBe(96.36);
    expect(resultat.graphique.find((ligne) => ligne.annee === 2024 && ligne.filiere === "Demand")?.valeur).toBe(93.84);
    expect(Object.keys(resultat.graphique[0])).toEqual(["annee", "filiere", "valeur", "unite"]);
  });

  it("produit une synthèse annuelle sans additionner les agrégats et les filières", () => {
    const resultat = analyserCsv(csv);
    expect(resultat.indicateurs).toHaveLength(25);
    expect(resultat.indicateurs.at(-1)).toMatchObject({
      annee: 2024,
      production_totale_twh: 96.36,
      demande_electricite_twh: 93.84,
      importations_nettes_twh: -2.52,
      capacite_installee_gw: 27.99,
      emissions_mtco2e: 60.981,
      intensite_emissions_gco2e_kwh: 632.846,
    });
  });

  it("conserve les valeurs manquantes en null au lieu de les remplacer par zéro", () => {
    const resultat = analyserCsv(csv);
    const demande = resultat.lignes.find((ligne) => ligne.annee === 2024 && ligne.type_ligne === "demande");
    expect(demande?.capacite_gw).toBeNull();
    expect(demande?.emissions_mtco2e).toBeNull();
  });

  it("refuse un fichier sans code ISO DZA", () => {
    expect(() => analyserCsv(csv.replaceAll("DZA", "TUN"))).toThrow(/Aucune ligne algérienne/);
  });

  it("refuse un CSV dont le schéma a changé", () => {
    expect(() => analyserCsv("Area,Year\nAlgeria,2024\n")).toThrow(/Colonnes Ember manquantes/);
  });

  it("refuse une référence 2024 manifestement incohérente", () => {
    expect(() => analyserCsv(csv.replace("96.36", "150"))).toThrow(/Contrôle 2024 inattendu/);
  });
});
