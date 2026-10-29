import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { champsDepuisProposition, formatProposition, nomLogique, slugDepuisTitre, xlsxEnCsv } from "../src/lib/propositions.js";

const proposition = {
  id: "7b0c1d9e-1111-4c2a-9f00-000000000001",
  type: "nouvelle_donnee" as const,
  statut: "acceptee",
  dataset_id: null,
  titre: { ar: "صيدليات الجزائر", en: "Pharmacies in Algeria" },
  description: { fr: "Liste des pharmacies" },
  categorie_slug: "sante",
  licence_code: "ODbL-1.0",
  source_nom: "Ministère de la Santé",
  source_url: "https://www.sante.gov.dz",
  mots_cles: ["pharmacie"],
  wilayas: ["16"],
  periode_debut: "2020-01-01",
  periode_fin: "2024-12-31",
  soumission_fichiers: [],
};

describe("mise en ligne d'une proposition", () => {
  it("tire un slug du titre, sans accents ni tiret final", () => {
    expect(slugDepuisTitre("Pharmacies d'Algérie (2026)")).toBe("pharmacies-d-algerie-2026");
    expect(slugDepuisTitre("صيدليات")).toBe("");
    expect(slugDepuisTitre(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
  });

  it("donne un nom de fichier accepté par l'API", () => {
    expect(nomLogique("Pharmacies Été 2026.geojson")).toBe("pharmacies-ete-2026");
    expect(nomLogique("_données_.csv")).toBe("donnees_");
    expect(nomLogique("صيدليات.csv")).toBe("donnees");
    expect(nomLogique("pharmacies.csv")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
  });

  it("reconnaît les formats publiables et ignore les autres", () => {
    expect(formatProposition("a.GeoJSON", null)).toBe("geojson");
    expect(formatProposition("a.json", "application/geo+json")).toBe("geojson");
    expect(formatProposition("a.json", "application/json")).toBe("json");
    expect(formatProposition("a.csv", "text/csv")).toBe("csv");
    expect(formatProposition("a.xlsx", null)).toBe("xlsx");
    expect(formatProposition("a.pdf", "application/pdf")).toBeNull();
    expect(formatProposition("a.zip", null)).toBeNull();
  });

  it("reprend le contenu de la proposition (titre français complété, source communauté, période)", () => {
    const champs = champsDepuisProposition(proposition);
    expect(champs.titre).toEqual({ fr: "Pharmacies in Algeria", en: "Pharmacies in Algeria", ar: "صيدليات الجزائر" });
    expect(champs.source_slug).toBe("communaute");
    expect(champs.url_source).toBe("https://www.sante.gov.dz");
    expect(champs.infos_source).toEqual({ soumission_id: proposition.id, source_nom: "Ministère de la Santé", periode: "2020-2024" });
    expect(champsDepuisProposition({ ...proposition, periode_debut: "2023-01-01", periode_fin: "2023-06-30", source_nom: null }).infos_source).toEqual({
      soumission_id: proposition.id,
      periode: "2023",
    });
  });

  it("convertit la première feuille d'un Excel en CSV", () => {
    const classeur = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(classeur, XLSX.utils.aoa_to_sheet([["wilaya", "nb"], ["Alger", 120]]), "data");
    XLSX.utils.book_append_sheet(classeur, XLSX.utils.aoa_to_sheet([["autre"]]), "notes");
    const octets = XLSX.write(classeur, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    expect(xlsxEnCsv(octets)).toBe("wilaya,nb\nAlger,120");
  });
});
