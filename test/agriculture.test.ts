import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { SELECTION, calculer, lireCsvAlgerie, lireLignes, verifier, type ValeurFao } from "../scripts/agriculture/calculer.js";

/** Valeurs synthétiques : chaque série de la sélection de 1961 à 2024, officielles jusqu'en 2021 puis imputées. */
function valeurs(): ValeurFao[] {
  const resultat: ValeurFao[] = [];
  for (const serie of SELECTION) {
    for (let annee = 1961; annee <= 2024; annee++) {
      resultat.push({
        code_produit: serie.code,
        produit: `Produit ${serie.code}`,
        mesure: serie.mesure,
        unite: serie.mesure === "Stocks" ? "An" : "t",
        annee,
        valeur: serie.code === "1717" ? 3_000_000 : serie.code === "1735" || serie.code === "1738" ? 5_000_000 : 100_000 + Number(serie.code),
        statut: annee <= 2021 ? "A" : "I",
      });
    }
  }
  for (let i = 0; i < 60; i++) resultat.push({ code_produit: String(2000 + i), produit: `Autre ${i}`, mesure: "Area harvested", unite: "ha", annee: 2024, valeur: 10, statut: "E" });
  return resultat;
}

describe("lecture du CSV FAOSTAT", () => {
  it("garde l'Algérie, passe du format large au format long, ignore les valeurs manquantes (M)", async () => {
    const csv = [
      "Area Code,Area Code (M49),Area,Item Code,Item Code (CPC),Item,Element Code,Element,Unit,Y2020,Y2020F,Y2020N,Y2021,Y2021F,Y2021N,Y2022,Y2022F,Y2022N",
      '"4","\'012","Algeria","577","\'01314","Dates","5510","Production","t","1151909.000000","A",,"1188803.000000","A",,"","M",',
      '"159","\'504","Morocco","577","\'01314","Dates","5510","Production","t","1.0","A",,"2.0","A",,"3.0","A",',
    ].join("\n");
    const lignes = await lireCsvAlgerie(createInterface({ input: Readable.from([csv]) }));
    expect(lignes).toHaveLength(1);
    expect(lireLignes(lignes)).toEqual([
      { code_produit: "577", produit: "Dates", mesure: "Production", unite: "t", annee: 2020, valeur: 1151909, statut: "A" },
      { code_produit: "577", produit: "Dates", mesure: "Production", unite: "t", annee: 2021, valeur: 1188803, statut: "A" },
    ]);
  });
});

describe("calcul", () => {
  const resultat = calculer(valeurs());

  it("sélection en format long avec statut, dernière année officielle et classement", () => {
    expect(Object.keys(resultat.selection[0])).toEqual(["annee", "indicateur", "valeur", "unite", "code_statut"]);
    expect(resultat.rapport).toMatchObject({ premiere_annee: 1961, derniere_annee: 2024, derniere_annee_officielle: 2021, nb_indicateurs: SELECTION.length });
    expect(resultat.rapport.part_officielle_par_annee["2021"]).toBe(100);
    expect(resultat.rapport.part_officielle_par_annee["2022"]).toBe(0);
    const dattes2024 = resultat.selection.find((l) => l.indicateur === "Dattes" && l.annee === 2024)!;
    expect(dattes2024).toMatchObject({ code_statut: "I", unite: "tonnes" });
    expect(resultat.selection.find((l) => l.indicateur === "Moutons (cheptel)")?.unite).toBe("têtes");
    // Classement : agrégats exclus, années 2021 et 2024.
    expect(new Set(resultat.classement.map((l) => l.annee))).toEqual(new Set([2021, 2024]));
    expect(resultat.classement.some((l) => Number(l.code_produit) >= 1700)).toBe(false);
    expect(resultat.classement.find((l) => l.code_produit === "577")?.produit_fr).toBe("Dattes");
    expect(() => verifier(resultat, 2026)).not.toThrow();
  });

  it("refuse une série absente ou un agrégat invraisemblable", () => {
    expect(() => calculer(valeurs().filter((v) => v.code_produit !== "577"))).toThrow(/Dattes/);
    expect(() => calculer(valeurs().map((v) => (v.code_produit === "1717" ? { ...v, valeur: 3e9 } : v)))).toThrow(/invraisemblable/);
  });

  it("vérification : refuse une série trop ancienne", () => {
    expect(() => verifier(calculer(valeurs().filter((v) => v.annee <= 2018)), 2026)).toThrow(/trop ancienne/);
  });
});
