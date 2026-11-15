import { describe, expect, it } from "vitest";
import { construireResultat, creerUrlRequete, type ReponseGbif } from "../scripts/biodiversite/calculer.js";

function reponse(count: number, facets: { field: string; counts: { name: string; count: number }[] }[] = []): ReponseGbif {
  return { count, facets };
}

const global = reponse(10, [
  { field: "KINGDOM_KEY", counts: [{ name: "1", count: 6 }, { name: "6", count: 3 }] },
  { field: "YEAR", counts: [{ name: "2020", count: 2 }, { name: "2021", count: 7 }] },
  { field: "STATE_PROVINCE", counts: [{ name: "Alger", count: 4 }, { name: "Tizi Ouzou", count: 3 }] },
  { field: "BASIS_OF_RECORD", counts: [{ name: "HUMAN_OBSERVATION", count: 8 }, { name: "PRESERVED_SPECIMEN", count: 2 }] },
]);

describe("agrégation des facettes GBIF pour l'Algérie", () => {
  it("construit une série annuelle par règne et conserve le total", () => {
    const resultat = construireResultat(global, {
      1: reponse(6, [{ field: "YEAR", counts: [{ name: "2020", count: 1 }, { name: "2021", count: 4 }] }]),
      6: reponse(3, [{ field: "YEAR", counts: [{ name: "2020", count: 1 }, { name: "2021", count: 2 }] }]),
    });
    expect(resultat.rapport).toMatchObject({
      occurrences_total: 10, nb_regnes: 2, premiere_annee: 2020, derniere_annee: 2021,
    });
    expect(resultat.graphique).toContainEqual({
      annee: 2021, filiere: "Animaux (Animalia)", valeur: 4, unite: "occurrences",
    });
    expect(resultat.graphique).toContainEqual({
      annee: 2021, filiere: "Toutes les occurrences", valeur: 7, unite: "occurrences",
    });
  });

  it("calcule les résidus de régions, années et règnes non renseignés", () => {
    const resultat = construireResultat(global, {
      1: reponse(6, [{ field: "YEAR", counts: [{ name: "2020", count: 1 }, { name: "2021", count: 4 }] }]),
      6: reponse(3, [{ field: "YEAR", counts: [{ name: "2020", count: 1 }, { name: "2021", count: 2 }] }]),
    });
    expect(resultat.details).toContainEqual(expect.objectContaining({ dimension: "regne", modalite: "non_classe", valeur: 1 }));
    expect(resultat.details).toContainEqual(expect.objectContaining({ dimension: "annee", modalite: "non_renseignee", valeur: 1 }));
    expect(resultat.details).toContainEqual(expect.objectContaining({
      dimension: "region_declaree", modalite: "non_renseignee_ou_hors_facettes", valeur: 3,
    }));
  });

  it("conserve les types d'enregistrement dans une dimension indépendante", () => {
    const resultat = construireResultat(global, {
      1: reponse(6, [{ field: "YEAR", counts: [{ name: "2020", count: 1 }, { name: "2021", count: 4 }] }]),
      6: reponse(3, [{ field: "YEAR", counts: [{ name: "2020", count: 1 }, { name: "2021", count: 2 }] }]),
    });
    expect(resultat.details).toContainEqual(expect.objectContaining({
      dimension: "type_enregistrement", modalite: "HUMAN_OBSERVATION", valeur: 8,
    }));
  });

  it("refuse des facettes taxonomiques dont la somme dépasse le total", () => {
    const invalide = reponse(5, [
      { field: "KINGDOM_KEY", counts: [{ name: "1", count: 6 }] },
      { field: "YEAR", counts: [{ name: "2020", count: 5 }] },
    ]);
    expect(() => construireResultat(invalide, {
      1: reponse(6, [{ field: "YEAR", counts: [{ name: "2020", count: 6 }] }]),
    })).toThrow(/dépassent le total/);
  });

  it("refuse une variation incohérente du total entre requête globale et requêtes par règne", () => {
    expect(() => construireResultat(global, {
      1: reponse(0, [{ field: "YEAR", counts: [] }]),
      6: reponse(3, [{ field: "YEAR", counts: [{ name: "2020", count: 1 }] }]),
    })).toThrow(/a changé pendant la collecte/);
  });

  it("n'interroge que les occurrences présentes, géolocalisées, sans anomalie, sous CC0 ou CC BY", () => {
    const url = new URL(creerUrlRequete(1));
    expect(url.searchParams.get("country")).toBe("DZ");
    expect(url.searchParams.get("hasCoordinate")).toBe("true");
    expect(url.searchParams.get("hasGeospatialIssue")).toBe("false");
    expect(url.searchParams.get("occurrenceStatus")).toBe("PRESENT");
    expect(url.searchParams.getAll("license")).toEqual(["CC0_1_0", "CC_BY_4_0"]);
    expect(url.searchParams.get("limit")).toBe("0");
    expect(url.searchParams.get("kingdomKey")).toBe("1");
    expect(url.searchParams.getAll("facet")).toEqual(["year"]);
  });
});
