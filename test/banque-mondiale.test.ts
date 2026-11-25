import { describe, expect, it } from "vitest";
import { INDICATEURS, calculer, dictionnaire, lireReponse, verifier, type Observation, type ReponseBm } from "../scripts/banque-mondiale/calculer.js";

const pib = INDICATEURS.find((i) => i.code === "NY.GDP.MKTP.CD")!;

describe("lecture de l'API de la Banque mondiale", () => {
  it("valeurs nulles ignorées, conversion en milliards, tri par année", () => {
    const reponse: ReponseBm = [{ lastupdated: "2026-11-11" }, [
      { date: "2025", value: 287_031_225_987.7 },
      { date: "2024", value: null },
      { date: "2023", value: 247_600_000_000 },
    ]];
    expect(lireReponse(pib, reponse)).toEqual([{ annee: 2023, valeur: 247.6 }, { annee: 2025, valeur: 287.03 }]);
  });

  it("refuse une valeur invraisemblable, une série vide ou un indicateur inconnu", () => {
    expect(() => lireReponse(pib, [{}, [{ date: "2025", value: 287 }]])).toThrow(/invraisemblable/);
    expect(() => lireReponse(pib, [{}, [{ date: "2025", value: null }]])).toThrow(/vide/);
    expect(() => lireReponse(pib, [{ message: [{ value: "The indicator was not found" }] }, null])).toThrow(/not found/);
  });
});

describe("calcul", () => {
  const series = new Map<string, Observation[]>(
    INDICATEURS.map((i) => {
      const valeur = (i.plage[0] + i.plage[1]) / 2;
      const debut = i.code === "SL.UEM.TOTL.ZS" ? 1991 : 1960;
      return [i.code, Array.from({ length: 2025 - debut + 1 }, (_, k) => ({ annee: debut + k, valeur }))];
    })
  );
  const { lignes, bilan, rapport } = calculer(series, "2026-11-11");

  it("format long minimal, bilan large et dictionnaire", () => {
    expect(Object.keys(lignes[0])).toEqual(["annee", "indicateur", "valeur", "unite"]);
    expect(rapport).toMatchObject({ premiere_annee: 1960, derniere_annee: 2025, nb_indicateurs: INDICATEURS.length, nb_annees: 66 });
    expect(bilan[0]["SL.UEM.TOTL.ZS"]).toBeNull();
    expect(bilan.at(-1)!["SP.POP.TOTL"]).toBe((5e6 + 1e8) / 2);
    expect(dictionnaire(rapport.periodes).find((l) => l.code_bm === "SL.UEM.TOTL.ZS")).toMatchObject({ estimation_modelisee: true, premiere_annee: 1991 });
    expect(() => verifier(rapport, 2026)).not.toThrow();
  });

  it("refuse un indicateur absent ou une série phare trop ancienne", () => {
    const incomplet = new Map(series);
    incomplet.delete("SP.POP.TOTL");
    expect(() => calculer(incomplet)).toThrow(/SP\.POP\.TOTL/);
    const ancien = new Map(series);
    ancien.set("NY.GDP.MKTP.CD", [{ annee: 1960, valeur: 10 }, { annee: 2015, valeur: 100 }]);
    expect(() => verifier(calculer(ancien).rapport, 2026)).toThrow(/NY\.GDP\.MKTP\.CD s'arrête en 2015/);
  });
});
