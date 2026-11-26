import { describe, expect, it } from "vitest";
import { codeWilaya, compterParWilaya, indexerContours, populationParWilaya, positionDe, rangDe, wilayaDuPoint } from "../src/lib/wilayas.js";

// Deux wilayas carrées côte à côte : 01 sur [0,1]×[0,1], 02 sur [1,2]×[0,1] (avec un trou en [1.4,1.6]²).
const carre = (x0: number, x1: number) => [[x0, 0], [x1, 0], [x1, 1], [x0, 1], [x0, 0]];
const contours = indexerContours({
  lignes: [{ code: 1 }, { code: "02" }, { code: 99 }],
  geometries: [
    { type: "Polygon", coordinates: [carre(0, 1)] },
    { type: "MultiPolygon", coordinates: [[carre(1, 2), [[1.4, 0.4], [1.6, 0.4], [1.6, 0.6], [1.4, 0.6], [1.4, 0.4]]]] },
    { type: "Polygon", coordinates: [carre(5, 6)] },
  ],
});

describe("chiffres par wilaya", () => {
  it("normalise les codes de wilaya", () => {
    expect(codeWilaya(1)).toBe("01");
    expect(codeWilaya(" 16 ")).toBe("16");
    expect(codeWilaya("69")).toBe("69");
    expect(codeWilaya("70")).toBeNull();
    expect(codeWilaya("0")).toBeNull();
    expect(codeWilaya("alger")).toBeNull();
    expect(codeWilaya(null)).toBeNull();
  });

  it("ignore les contours sans code valide", () => {
    expect(contours.map((contour) => contour.code)).toEqual(["01", "02"]);
  });

  it("place un point dans sa wilaya, en tenant compte des trous", () => {
    expect(wilayaDuPoint(contours, 0.5, 0.5)).toBe("01");
    expect(wilayaDuPoint(contours, 1.2, 0.5)).toBe("02");
    expect(wilayaDuPoint(contours, 1.5, 0.5)).toBeNull();
    expect(wilayaDuPoint(contours, 3, 3)).toBeNull();
  });

  it("lit la position d'une géométrie ou des colonnes de coordonnées", () => {
    expect(positionDe({}, { type: "Point", coordinates: [3, 36] })).toEqual([3, 36]);
    expect(positionDe({}, { type: "Polygon", coordinates: [[[1, 2], [3, 4]]] })).toEqual([1, 2]);
    expect(positionDe({ lat: "36.7", lng: "3.05" })).toEqual([3.05, 36.7]);
    expect(positionDe({ Latitude: 36, Longitude: 3 })).toEqual([3, 36]);
    expect(positionDe({ lat: 200, lng: 3 })).toBeNull();
    expect(positionDe({ nom: "x" })).toBeNull();
  });

  it("compte par code de wilaya quand il existe, sinon par les contours", () => {
    const parCode = compterParWilaya(
      { lignes: [{ wilaya_code: "02", lat: 0.5, lng: 0.5 }, { wilaya_code: "02", lat: 0.5, lng: 0.5 }, { wilaya_code: null, lat: 0.5, lng: 0.5 }], geometries: null },
      contours
    );
    expect(parCode).toEqual({ comptes: { "02": 2, "01": 1 }, sans_wilaya: 0 });

    const parContours = compterParWilaya(
      { lignes: [{}, {}, {}], geometries: [{ type: "Point", coordinates: [0.5, 0.5] }, { type: "Point", coordinates: [1.2, 0.2] }, { type: "Point", coordinates: [9, 9] }] },
      contours
    );
    expect(parContours).toEqual({ comptes: { "01": 1, "02": 1 }, sans_wilaya: 1 });
  });

  it("ne compte ni les doublons probables ni les lieux disparus d'OpenStreetMap", () => {
    const lignes = [
      { code_wilaya: "01", lat: 0.5, lng: 0.5 },
      { code_wilaya: "01", lat: 0.5, lng: 0.5, doublon_probable: "way/1" },
      { code_wilaya: "02", lat: 0.5, lng: 1.5, osm_absent_depuis: "2026-11-01" },
      { code_wilaya: "02", lat: 0.5, lng: 1.2 },
    ];
    expect(compterParWilaya({ lignes, geometries: null }, contours)).toEqual({ comptes: { "01": 1, "02": 1 }, sans_wilaya: 0 });
  });

  it("compte par code les lieux sans coordonnées d'un inventaire", () => {
    const lignes = [{ wilaya_code: "01", lat: null, lng: null }, { wilaya_code: "01", lat: null, lng: null }, { wilaya_code: "02", lat: null, lng: null }];
    expect(compterParWilaya({ lignes, geometries: null }, contours)).toEqual({ comptes: { "01": 2, "02": 1 }, sans_wilaya: 0 });
  });

  it("refuse une table qui ne recense pas des lieux", () => {
    expect(compterParWilaya({ lignes: [{ annee: 2020, valeur: 3, code_wilaya: "16" }], geometries: null }, contours)).toBeNull();
    expect(compterParWilaya({ lignes: [], geometries: null }, contours)).toBeNull();
    expect(compterParWilaya({ lignes: [{ code_wilaya: "16", date_observation: "2026-11-11", prix: 3 }], geometries: null }, contours)).toBeNull();
  });

  it("garde la dernière population estimée, sans les projections", () => {
    const population = populationParWilaya([
      { code_wilaya: "16", annee: 2024, valeur: 100, type: "estimation" },
      { code_wilaya: "16", annee: 2025, valeur: 110, type: "estimation" },
      { code_wilaya: "16", annee: 2030, valeur: 150, type: "projection" },
      { code_wilaya: "99", annee: 2025, valeur: 1, type: "estimation" },
    ]);
    expect(population).toEqual({ "16": { valeur: 110, annee: 2025 } });
  });

  it("classe les wilayas, ex æquo compris", () => {
    const comptes = { "01": 10, "02": 30, "03": 30, "04": 5 };
    expect(rangDe(comptes, "02")).toBe(1);
    expect(rangDe(comptes, "03")).toBe(1);
    expect(rangDe(comptes, "01")).toBe(3);
    expect(rangDe(comptes, "05")).toBe(5);
  });
});
