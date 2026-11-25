import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { INDICATEURS, calculer, lireSeriesAlgerie, valeurEia, verifier, type SerieEia } from "../scripts/petrole-gaz/calculer.js";

/** Série synthétique de 1973 (ou 1980) à 2025, valeur constante. */
function serie(id: string, valeur: number, debut = 1980, fin = 2025): SerieEia {
  const data: [string, number | string][] = [];
  for (let annee = fin; annee >= 1973; annee--) data.push([String(annee), annee >= debut ? valeur : "NA"]);
  return { series_id: id, f: "A", last_updated: "2026-11-19T10:00:00-05:00", data };
}

const VALEURS: Record<string, number> = {
  petrole_brut_production_kbj: 1100,
  liquides_production_kbj: 1400,
  lgn_production_kbj: 260,
  liquides_consommation_kbj: 470,
  petrole_brut_exportations_kbj: 600,
  gaz_production_gm3: 100,
  gaz_consommation_gm3: 55,
  gaz_exportations_gm3: 45,
};
const toutes = () => INDICATEURS.map((indicateur) => serie(indicateur.id, VALEURS[indicateur.cle], indicateur.cle.startsWith("petrole_brut_p") ? 1973 : 1980));

describe("valeurs EIA", () => {
  it("nombres gardés, codes d'absence → null (jamais zéro)", () => {
    expect(valeurEia(12.5)).toBe(12.5);
    expect(valeurEia("3.2")).toBe(3.2);
    for (const code of ["NA", "--", "(s)", "W", "", null]) expect(valeurEia(code)).toBeNull();
  });
});

describe("calcul", () => {
  const resultat = calculer(toutes());

  it("format long et bilan annuel avec la part de gaz exportée", () => {
    expect(resultat.rapport).toMatchObject({ premiere_annee: 1973, derniere_annee: 2025, nb_annees: 53, nb_indicateurs: 8 });
    const ligne2025 = resultat.bilan.find((ligne) => ligne.annee === 2025)!;
    expect(ligne2025).toMatchObject({ petrole_brut_production_kbj: 1100, gaz_production_gm3: 100, part_gaz_exportee_pct: 45 });
    // 1975 : seul le brut existe, les autres colonnes restent vides.
    expect(resultat.bilan.find((ligne) => ligne.annee === 1975)).toMatchObject({ gaz_production_gm3: null, part_gaz_exportee_pct: null });
    expect(resultat.series[0]).toMatchObject({ indicateur: "Gaz naturel : consommation", unite: "milliards de m³" });
    expect(() => verifier(resultat, 2026)).not.toThrow();
  });

  it("refuse une série absente ou une valeur invraisemblable", () => {
    expect(() => calculer(toutes().slice(1))).toThrow(/absente/);
    const fausses = toutes();
    fausses[0].data![0] = ["2025", 12];
    expect(() => calculer(fausses)).toThrow(/invraisemblable/);
  });

  it("vérification : refuse une série qui s'arrête trop tôt", () => {
    const anciennes = toutes().map((s) => (s.series_id.includes("26-1") ? serie(s.series_id, 100, 1980, 2015) : s));
    expect(() => verifier(calculer(anciennes), 2026)).toThrow(/gaz_production_gm3 s'arrête en 2015/);
  });
});

describe("lecture du fichier groupé", () => {
  it("ne garde que les séries voulues de l'Algérie", async () => {
    const lignes = [
      JSON.stringify(serie("INTL.26-1-DZA-BCM.A", 100)),
      JSON.stringify(serie("INTL.26-1-MAR-BCM.A", 1)),
      JSON.stringify(serie("INTL.26-1-DZA-BCF.A", 3500)),
      JSON.stringify({ category_id: "1", name: "catégorie" }),
    ].join("\n");
    const series = await lireSeriesAlgerie(createInterface({ input: Readable.from([lignes]) }));
    expect(series.map((s) => s.series_id)).toEqual(["INTL.26-1-DZA-BCM.A"]);
  });
});
