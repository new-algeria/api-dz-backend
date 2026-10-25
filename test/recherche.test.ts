import { describe, expect, it } from "vitest";
import { filtresRecherche, motsRecherche } from "../src/lib/recherche.js";

describe("recherche du catalogue", () => {
  it("découpe en mots, en minuscules, sans doublon", () => {
    expect(motsRecherche("  Pharmacie   ALGER pharmacie ")).toEqual(["pharmacie", "alger"]);
  });

  it("ramène un pluriel à son singulier", () => {
    expect(motsRecherche("pharmacies hôpitaux bus")).toEqual(["pharmacie", "hôpitau", "bus"]);
  });

  it("garde les mots arabes avec leurs signes diacritiques", () => {
    expect(motsRecherche("صَيْدَلِيَّة الجزائر")).toEqual(["صَيْدَلِيَّة", "الجزائر"]);
  });

  it("retire tout ce qui pourrait casser le filtre PostgREST", () => {
    expect(motsRecherche("a,b(c)*d:e\"f")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(motsRecherche("),or(statut.eq.brouillon")).toEqual(["or", "statut", "eq", "brouillon"]);
    expect(filtresRecherche("),(*:").join("")).toBe("");
  });

  it("cherche chaque mot en préfixe plein texte et dans les titres et descriptions", () => {
    const [filtre] = filtresRecherche("pharma");
    expect(filtre).toContain("recherche.fts(simple).pharma:*");
    expect(filtre).toContain("titre->>fr.ilike.*pharma*");
    expect(filtre).toContain("description->>ar.ilike.*pharma*");
  });

  it("ne filtre rien pour une recherche vide et limite le nombre de mots", () => {
    expect(filtresRecherche("   ")).toEqual([]);
    expect(filtresRecherche("a b c d e f g h")).toHaveLength(6);
  });
});
