import { describe, expect, it } from "vitest";
import { calculer, estHydrocarbure, lireFlux, lirePays, sectionDe, verifier, versionDepuisPage, type Flux } from "../scripts/commerce-exterieur/calculer.js";

const pays = lirePays(
  ["country_code,country_name,country_iso2,country_iso3", "12,Algeria,DZ,DZA", "380,Italy,IT,ITA", "156,China,CN,CHN", "724,Spain,ES,ESP"].join("\n")
);

describe("lecture de BACI", () => {
  it("flux de l'Algérie seulement, code produit sur 6 chiffres, quantité facultative", () => {
    expect(lireFlux('2024,12,380,"270900",15000000.5,22000000', "12")).toEqual({ annee: 2024, exportateur: "12", importateur: "380", produit: "270900", valeur: 15000000.5, quantite: 22000000 });
    expect(lireFlux("2024,156,12,80410,1200,", "12")).toMatchObject({ produit: "080410", quantite: null });
    expect(lireFlux("2024,156,380,270900,10,1", "12")).toBeNull();
  });

  it("sections du Système harmonisé et hydrocarbures", () => {
    expect(sectionDe("080410").code).toBe("II");
    expect(sectionDe("270900").code).toBe("V");
    expect(sectionDe("870323").code).toBe("XVII");
    expect(estHydrocarbure("271121")).toBe(true);
    expect(estHydrocarbure("310210")).toBe(false);
  });

  it("dernière version annoncée sur la page du CEPII", () => {
    expect(versionDepuisPage('<a href="/DATA_DOWNLOAD/baci/data/BACI_HS92_V202501.zip"> <a href="BACI_HS92_V202601.zip">')).toBe("202601");
    expect(versionDepuisPage("rien")).toBeNull();
  });
});

describe("calcul", () => {
  const flux: Flux[] = [];
  for (let annee = 1995; annee <= 2024; annee++) {
    flux.push({ annee, exportateur: "12", importateur: "380", produit: "271121", valeur: 20_000_000, quantite: 30_000_000 });
    flux.push({ annee, exportateur: "12", importateur: "724", produit: "310210", valeur: 1_000_000, quantite: 2_000_000 });
    flux.push({ annee, exportateur: "156", importateur: "12", produit: "851712", valeur: 6_000_000, quantite: null });
    flux.push({ annee, exportateur: "724", importateur: "12", produit: "100190", valeur: 4_000_000, quantite: 15_000_000 });
  }
  const resultat = calculer(flux, "12", pays, new Map([["271121", "Natural gas, gaseous"]]));

  it("séries annuelles, partenaires nommés en français et en arabe, produits", () => {
    const valeur = (indicateur: string) => resultat.echanges.find((l) => l.annee === 2024 && l.indicateur === indicateur)!.valeur;
    expect(valeur("Exportations (total)")).toBe(21);
    expect(valeur("Importations (total)")).toBe(10);
    expect(valeur("Solde commercial")).toBe(11);
    expect(valeur("Exportations hors hydrocarbures")).toBe(1);
    expect(valeur("Importations alimentaires")).toBe(4);
    expect(Object.keys(resultat.echanges[0])).toEqual(["annee", "indicateur", "valeur", "unite"]);
    const client = resultat.partenaires.find((l) => l.annee === 2024 && l.flux === "exportations" && l.rang === 1)!;
    expect(client).toMatchObject({ code_iso3: "ITA", pays: "Italie", pays_en: "Italy", valeur_musd: 20000 });
    expect(client.pays_ar).toMatch(/إيطاليا/);
    expect(resultat.produits.find((l) => l.annee === 2024 && l.flux === "exportations" && l.rang === 1)).toMatchObject({ produit: "Gaz naturel (gazeux, par gazoduc)", quantite_t: 30_000_000 });
    expect(resultat.rapport.derniere_annee_chiffres).toMatchObject({ premier_client: "Italie", premier_fournisseur: "Chine", part_hydrocarbures_pct: 95.2 });
    expect(() => verifier(resultat, 2026)).not.toThrow();
  });

  it("refuse des montants invraisemblables ou une série trop ancienne", () => {
    const enorme = calculer(flux.map((f) => ({ ...f, valeur: f.valeur * 1000 })), "12", pays, new Map());
    expect(() => verifier(enorme, 2026)).toThrow(/invraisemblables/);
    expect(() => verifier(calculer(flux.filter((f) => f.annee <= 2018), "12", pays, new Map()), 2026)).toThrow(/trop ancienne/);
  });
});
