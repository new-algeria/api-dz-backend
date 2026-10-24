import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { decrireTable, enCsv, enGeoJson, enJson, enWkt, enXlsx, estGeographique, lireTable, neutraliserFormule } from "../src/lib/conversion.js";

const metadonnees = { titre: "Test", source: "GeoAlgeria", licence: "ODbL-1.0", urlFiche: "https://data-dz.com/datasets/test" };

const geojson = JSON.stringify({
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [3.05, 36.75] }, properties: { name: "Alger", wilaya_code: "16" } },
    {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: { name: "Zone", wilaya_code: "31" },
    },
  ],
});

describe("lireTable", () => {
  it("lit un tableau JSON", () => {
    const table = lireTable('[{"a":1},{"a":2,"b":"x"}]', "json");
    expect(table.lignes).toHaveLength(2);
    expect(table.geometries).toBeNull();
  });

  it("lit un tableau enveloppé dans un objet", () => {
    expect(lireTable('{"meta":{"v":1},"data":[{"a":1}]}', "json").lignes).toEqual([{ a: 1 }]);
  });

  it("refuse un JSON qui n'est pas un tableau d'objets", () => {
    expect(() => lireTable('{"a":1,"b":2}', "json")).toThrow(/tableau/);
    expect(() => lireTable("[1,2,3]", "json")).toThrow();
  });

  it("refuse un JSON invalide", () => {
    expect(() => lireTable("{oups", "json")).toThrow(/JSON valide/);
  });

  it("lit un GeoJSON (propriétés + géométries)", () => {
    const table = lireTable(geojson, "geojson");
    expect(table.lignes[0]).toEqual({ name: "Alger", wilaya_code: "16" });
    expect(table.geometries?.[1]?.type).toBe("Polygon");
    expect(estGeographique(table)).toBe(true);
  });

  it("lit un CSV avec BOM et guillemets", () => {
    const table = lireTable('﻿nom,ville\n"Dupont, Jean",Oran\n', "csv");
    expect(table.lignes).toEqual([{ nom: "Dupont, Jean", ville: "Oran" }]);
  });
});

describe("enCsv", () => {
  it("échappe virgules, guillemets et retours à la ligne, et commence par un BOM", () => {
    const csv = enCsv({ lignes: [{ a: 'il dit "oui"', b: "x,y", c: "l1\nl2", d: null, e: { k: 1 } }], geometries: null });
    expect(csv.startsWith("﻿a,b,c,d,e\r\n")).toBe(true);
    expect(csv).toContain('"il dit ""oui""","x,y","l1\nl2",,"{""k"":1}"');
  });

  it("convertit les points en longitude / latitude et les autres géométries en WKT", () => {
    const csv = enCsv(lireTable(geojson, "geojson"));
    const [entete, alger, zone] = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(entete).toBe("name,wilaya_code,longitude,latitude,geometry_wkt");
    expect(alger).toBe("Alger,16,3.05,36.75,");
    expect(zone).toContain('"POLYGON ((0 0, 1 0, 1 1, 0 0))"');
  });
});

describe("neutraliserFormule", () => {
  it("neutralise les formules", () => {
    expect(neutraliserFormule("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(neutraliserFormule("@cmd")).toBe("'@cmd");
    expect(neutraliserFormule("-cmd|' /C calc'!A0")).toBe("'-cmd|' /C calc'!A0");
  });

  it("garde intacts téléphones et nombres négatifs", () => {
    expect(neutraliserFormule("+213 21 00 00 00")).toBe("+213 21 00 00 00");
    expect(neutraliserFormule("-0.29")).toBe("-0.29");
    expect(neutraliserFormule("Alger")).toBe("Alger");
  });
});

describe("enGeoJson", () => {
  it("construit des points depuis les colonnes lat / lng", () => {
    const sortie = JSON.parse(enGeoJson({ lignes: [{ nom: "A", lat: "36.7", lng: 3.1 }, { nom: "B", lat: null, lng: null }], geometries: null }));
    expect(sortie.features[0].geometry).toEqual({ type: "Point", coordinates: [3.1, 36.7] });
    expect(sortie.features[1].geometry).toBeNull();
  });

  it("refuse une table sans coordonnées", () => {
    expect(() => enGeoJson({ lignes: [{ nom: "A" }], geometries: null })).toThrow(/GeoJSON indisponible/);
  });

  it("garde les géométries d'origine", () => {
    const sortie = JSON.parse(enGeoJson(lireTable(geojson, "geojson")));
    expect(sortie.features[1].geometry.type).toBe("Polygon");
  });
});

describe("enJson", () => {
  it("aplatit un GeoJSON en enregistrements", () => {
    const lignes = JSON.parse(enJson(lireTable(geojson, "geojson")));
    expect(lignes[0]).toEqual({ name: "Alger", wilaya_code: "16", longitude: 3.05, latitude: 36.75 });
  });
});

describe("enXlsx", () => {
  it("produit un classeur lisible avec une feuille de données et une feuille « about »", () => {
    const classeur = XLSX.read(enXlsx({ lignes: [{ nom: "Alger", tel: "=1+1" }], geometries: null }, metadonnees));
    expect(classeur.SheetNames).toEqual(["data", "about"]);
    const lignes = XLSX.utils.sheet_to_json<Record<string, unknown>>(classeur.Sheets.data);
    expect(lignes).toEqual([{ nom: "Alger", tel: "'=1+1" }]);
  });
});

describe("enWkt", () => {
  it("gère les multipolygones", () => {
    expect(enWkt({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 1], [0, 0]]]] })).toBe("MULTIPOLYGON (((0 0, 1 1, 0 0)))");
  });
});

describe("decrireTable", () => {
  it("type les colonnes avec le vocabulaire des versions synchronisées", () => {
    const description = decrireTable({ lignes: [{ a: null, b: 1, c: 1.5, d: "x", e: true, f: [1], g: {} }, { a: "y" }], geometries: null });
    expect(description.colonnes).toEqual([
      { nom: "a", type: "str" },
      { nom: "b", type: "int" },
      { nom: "c", type: "float" },
      { nom: "d", type: "str" },
      { nom: "e", type: "bool" },
      { nom: "f", type: "list" },
      { nom: "g", type: "dict" },
    ]);
    expect(description.nbLignes).toBe(2);
    expect(description.apercu).toHaveLength(2);
  });
});
