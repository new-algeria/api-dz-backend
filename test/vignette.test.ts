import { describe, expect, it } from "vitest";
import type { Table } from "../src/lib/conversion.js";
import { lireTemps, MAX_POINTS, planVignette, svgVignette } from "../src/lib/vignette.js";
import { fichiersVignette } from "../src/lib/vignette-image.js";
import type { ContourWilaya } from "../src/lib/wilayas.js";
import type { FichierInterne } from "../src/lib/catalogue.js";

const table = (lignes: Record<string, unknown>[], geometries: Table["geometries"] = null): Table => ({ lignes, geometries });
const carre = (code: string, x: number, y: number): ContourWilaya => ({
  code,
  polygones: [[[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]],
  emprise: [x, y, x + 1, y + 1],
});
const contours = [carre("01", 0, 30), carre("16", 1, 30), carre("31", 0, 31)];

describe("vignette : choix du visuel", () => {
  it("dessine les points d'un GeoJSON", () => {
    const plan = planVignette(table([{ nom: "a" }, { nom: "b" }], [{ type: "Point", coordinates: [3, 36] }, { type: "Point", coordinates: [5, 35] }]));
    expect(plan).toEqual({ genre: "points", points: [[3, 36], [5, 35]] });
  });

  it("échantillonne les très gros semis de points", () => {
    const n = MAX_POINTS * 3;
    const plan = planVignette(table(Array.from({ length: n }, () => ({})), Array.from({ length: n }, (_, i) => ({ type: "Point", coordinates: [i / n, 30] }))));
    expect(plan?.genre === "points" && plan.points.length).toBe(MAX_POINTS);
  });

  it("dessine les formes d'un GeoJSON de polygones et de lignes", () => {
    const plan = planVignette(
      table([{}, {}], [
        { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
        { type: "LineString", coordinates: [[0, 0], [2, 2]] },
      ])
    );
    expect(plan?.genre).toBe("formes");
    expect(plan?.genre === "formes" && [plan.surfaces.length, plan.lignes.length]).toEqual([1, 1]);
  });

  it("lit les coordonnées dans les colonnes", () => {
    const lignes = Array.from({ length: 12 }, (_, i) => ({ nom: `P${i}`, latitude: 36 - i / 10, longitude: "3.1" }));
    expect(planVignette(table(lignes))?.genre).toBe("points");
  });

  it("colore les wilayas au dernier temps disponible", () => {
    const lignes = ["01", "02", "03", "04", "05", "16"].flatMap((code, i) => [
      { annee: 2020, code_wilaya: code, wilaya: `W${code}`, valeur: 1 },
      { annee: 2025, code_wilaya: code, wilaya: `W${code}`, valeur: 10 + i },
    ]);
    const plan = planVignette(table(lignes));
    expect(plan?.genre).toBe("wilayas");
    expect(plan?.genre === "wilayas" && plan.valeurs["16"]).toBe(15);
  });

  it("trace la première série d'un format long, projection comprise", () => {
    const lignes = [
      { annee: 2020, indicateur: "PIB", valeur: 1, type: "observé" },
      { annee: 2021, indicateur: "PIB", valeur: 2, type: "observé" },
      { annee: 2022, indicateur: "PIB", valeur: 3, type: "projection" },
      { annee: 2020, indicateur: "Inflation", valeur: 9, type: "observé" },
      { annee: 2021, indicateur: "Inflation", valeur: 8, type: "observé" },
    ];
    const plan = planVignette(table(lignes));
    expect(plan?.genre).toBe("courbe");
    if (plan?.genre !== "courbe") return;
    // « Inflation » (9 + 8) pèse plus que « PIB » (1 + 2 + 3).
    expect(plan.points.map((p) => p.valeur)).toEqual([9, 8]);
    expect([plan.debut, plan.fin]).toEqual(["2020", "2021"]);
  });

  it("ignore l'unité et suit une combinaison de séries qui existe (format FMI)", () => {
    const lignes = [
      { indicateur: "PIB", unite: "milliards", annee: 2020, valeur: 1 },
      { indicateur: "PIB", unite: "milliards", annee: 2021, valeur: 2 },
      { indicateur: "Chômage", unite: "%", annee: 2020, valeur: 12 },
      { indicateur: "Chômage", unite: "%", annee: 2021, valeur: 11 },
    ];
    const plan = planVignette(table(lignes));
    expect(plan?.genre === "courbe" && plan.points.map((p) => p.valeur)).toEqual([12, 11]);
  });

  it("écarte une série presque nulle et lisse les longues séries mensuelles par année", () => {
    const lignes = Array.from({ length: 10 * 12 }, (_, i) => {
      const date = `${2010 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
      return [{ date, filiere: "A-bio", valeur: 0 }, { date, filiere: "Total", valeur: 100 + (i % 12) }];
    }).flat();
    const plan = planVignette(table(lignes));
    expect(plan?.genre).toBe("courbe");
    if (plan?.genre !== "courbe") return;
    expect(plan.points).toHaveLength(10);
    expect(plan.points[0].valeur).toBeCloseTo(105.5);
  });

  it("repère la partie projetée d'une courbe", () => {
    const plan = planVignette(table([
      { annee: 2024, valeur: 1, type: "observé" },
      { annee: 2025, valeur: 2, type: "projection" },
    ]));
    expect(plan?.genre === "courbe" && plan.points.map((p) => p.projection)).toEqual([false, true]);
  });

  it("garde les plus grandes catégories en barres", () => {
    const lignes = Array.from({ length: 12 }, (_, i) => ({ filiere: `F${i}`, production: (i + 1) * 10 }));
    const plan = planVignette(table(lignes));
    expect(plan?.genre).toBe("barres");
    expect(plan?.genre === "barres" && plan.valeurs).toEqual([120, 110, 100, 90, 80, 70, 60, 50]);
  });

  it("ne dessine rien sans mesure ni lieu", () => {
    expect(planVignette(table([{ nom: "a", description: "x" }, { nom: "b", description: "y" }]))).toBeNull();
    expect(planVignette(table([]))).toBeNull();
  });

  it("lit années et dates", () => {
    expect(lireTemps(2024)?.etiquette).toBe("2024");
    expect(lireTemps("2024-03")?.etiquette).toBe("2024");
    expect(lireTemps("2024-03")!.tri).toBeGreaterThan(lireTemps(2024)!.tri);
    expect(lireTemps("abc")).toBeNull();
  });
});

describe("vignette : dessin", () => {
  it("produit un SVG transparent, sans texte", () => {
    const plans = [
      planVignette(table([{}], [{ type: "Point", coordinates: [0.5, 30.5] }]))!,
      planVignette(table([{ annee: 2020, valeur: 1 }, { annee: 2021, valeur: 3 }]))!,
      planVignette(table([{ c: "a", v: 3 }, { c: "b", v: 1 }]))!,
    ];
    for (const plan of plans) {
      const svg = svgVignette(plan, contours);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('viewBox="0 0 720 300"');
      expect(svg).not.toContain("<text");
      expect(svg).not.toMatch(/<rect[^>]*width="720"/);
    }
  });

  it("place les points sur le fond des wilayas", () => {
    const svg = svgVignette({ genre: "points", points: [[0.5, 30.5], [50, 50]] }, contours);
    expect(svg.match(/<circle/g)).toHaveLength(1);
    expect(svg.match(/<path/g)).toHaveLength(3);
  });
});

describe("vignette : fichier dessiné", () => {
  const fichier = (nom: string, format: string, principal = false, taille = 1000) =>
    ({ nom, format, principal, taille_octets: taille, cle_stockage: `x/${nom}.${format}` }) as unknown as FichierInterne;

  const noms = (liste: FichierInterne[]) => fichiersVignette(liste).map((f) => `${f.nom}.${f.format}`);

  it("essaie les GeoJSON (principal d'abord), puis les JSON (principal, puis du plus léger), puis les CSV", () => {
    expect(noms([fichier("a", "json", true), fichier("b", "geojson"), fichier("c", "geojson", true), fichier("d", "csv")])).toEqual(["c.geojson", "b.geojson", "a.json", "d.csv"]);
    expect(noms([fichier("a", "json", false, 900), fichier("b", "json", false, 100), fichier("c", "json", true, 5000)])).toEqual(["c.json", "b.json", "a.json"]);
  });

  it("garde un fichier de taille inconnue (0) et écarte les fichiers trop lourds ou illisibles", () => {
    expect(noms([fichier("a", "geojson", false, 0)])).toEqual(["a.geojson"]);
    expect(noms([fichier("a", "geojson", true, 90 * 1024 * 1024), fichier("b", "pdf")])).toEqual([]);
  });
});
