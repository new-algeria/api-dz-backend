import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { calculer, editionsCandidates, lireLigne, lireProduction, verifier, type Espece, type LigneFao } from "../scripts/peche-aquaculture/calculer.js";

const espece = (code: string, fr: string): Espece => ({ code, fr, en: code, ar: "", scientifique: code, groupe: "Groupe" });
const especes = new Map(Array.from({ length: 40 }, (_, i) => `E${String(i).padStart(2, "0")}`).map((code) => [code, espece(code, `Espèce ${code}`)]));
especes.set("PIL", espece("PIL", "Sardine commune"));
especes.set("SBG", espece("SBG", "Dorade royale"));

/** 1950–2024 : sardine pêchée en mer, dorade d'élevage depuis 2000, petites captures de 40 espèces ; 2024 estimée. */
function lignes(): LigneFao[] {
  const resultat: LigneFao[] = [];
  for (let annee = 1950; annee <= 2024; annee++) {
    const statut = annee === 2024 ? "I" : "A";
    resultat.push({ espece: "PIL", zone: "37", mode: "CAPTURE", annee, tonnes: 30_000, statut });
    resultat.push({ espece: "E00", zone: "01", mode: "CAPTURE", annee, tonnes: 1_000, statut: "A" });
    if (annee >= 2000) resultat.push({ espece: "SBG", zone: "37", mode: "MARINE", annee, tonnes: 3_000, statut });
    for (const code of especes.keys()) if (code.startsWith("E") && code !== "E00") resultat.push({ espece: code, zone: "37", mode: "CAPTURE", annee, tonnes: 10, statut: "A" });
  }
  return resultat;
}

describe("lecture du CSV FAO", () => {
  it("ne garde que l'Algérie en tonnes", async () => {
    expect(lireLigne(["012", "PIL", "37", "CAPTURE", "Q_tlw", "2023", "31205", "A"])).toEqual({ espece: "PIL", zone: "37", mode: "CAPTURE", annee: 2023, tonnes: 31205, statut: "A" });
    expect(lireLigne(["504", "PIL", "37", "CAPTURE", "Q_tlw", "2023", "1", "A"])).toBeNull();
    expect(() => lireLigne(["012", "PIL", "37", "INCONNU", "Q_tlw", "2023", "1", "A"])).toThrow(/inconnu/);
    const csv = ['"COUNTRY.UN_CODE","SPECIES.ALPHA_3_CODE","AREA.CODE","PRODUCTION_SOURCE_DET.CODE","MEASURE","PERIOD","VALUE","STATUS"',
      '"012","PIL","37","CAPTURE","Q_tlw",2024,31205,"I"', '"504","PIL","34","CAPTURE","Q_tlw",2024,9,"A"'].join("\n");
    const resultat = await lireProduction(createInterface({ input: Readable.from([csv]) }));
    expect(resultat).toHaveLength(1);
  });

  it("éditions candidates de la plus récente à la plus ancienne", () => {
    expect(editionsCandidates(2026).slice(0, 4)).toEqual(["2027.3.0", "2027.2.0", "2027.1.0", "2026.3.0"]);
  });
});

describe("calcul", () => {
  const resultat = calculer(lignes(), especes);

  it("filières, part officielle et espèces principales", () => {
    const total2024 = resultat.production.find((l) => l.annee === 2024 && l.indicateur === "Pêche et aquaculture (total)")!;
    expect(total2024.valeur).toBe(30_000 + 1_000 + 3_000 + 39 * 10);
    expect(total2024.part_officielle_pct).toBeCloseTo((1390 / 34_390) * 100, 1);
    expect(resultat.production.find((l) => l.annee === 1999 && l.indicateur === "Aquaculture marine")).toBeUndefined();
    expect(resultat.production.find((l) => l.annee === 2024 && l.indicateur === "Pêche en eaux continentales")?.valeur).toBe(1000);
    expect(resultat.principales[0]).toMatchObject({ rang: 1, espece: "Sardine commune", milieu: "pêche", statut: "estimation FAO", moyenne_10_ans_tonnes: 30_000 });
    expect(resultat.rapport.annees_majoritairement_estimees).toEqual([2024]);
    expect(resultat.rapport.nb_indicateurs).toBe(5); // ni eau douce ni eau saumâtre dans ces données
    expect(() => verifier(resultat, 2026)).toThrow(/5 indicateurs/);
  });

  it("refuse une espèce inconnue ou un total invraisemblable", () => {
    expect(() => calculer([...lignes(), { espece: "ZZZ", zone: "37", mode: "CAPTURE", annee: 2024, tonnes: 1, statut: "A" }], especes)).toThrow(/ZZZ/);
    expect(() => calculer(lignes().map((l) => ({ ...l, tonnes: l.tonnes * 1000 })), especes)).toThrow(/invraisemblable/);
  });

  it("vérification : refuse une série trop ancienne", () => {
    expect(() => verifier(calculer(lignes().filter((l) => l.annee <= 2015), especes), 2026)).toThrow(/trop ancienne/);
  });
});
