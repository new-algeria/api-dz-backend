import { describe, expect, it } from "vitest";
import { construireIndex, correspondancesGeoAlgeria, localiser, localiserObjets } from "../scripts/osm/localisation.js";
import type { Objet } from "../scripts/osm/fusion.js";

const carre = (ouest: number, sud: number, cote: number) => [
  [ouest, sud],
  [ouest + cote, sud],
  [ouest + cote, sud + cote],
  [ouest, sud + cote],
  [ouest, sud],
];

const algeria = [
  {
    code: 16,
    communes: [
      { wilaya_code: 16, code_commune: 1601, name_fr: "Alger Centre", osm_relation_id: 1 },
      { wilaya_code: 16, code_commune: 1602, name_fr: "Sidi M'Hamed", osm_relation_id: 2 },
    ],
  },
  { code: 59, communes: [{ wilaya_code: 59, code_commune: 302, name_fr: "Aflou", osm_relation_id: "3" }] },
];

describe("wilaya et commune depuis la position", () => {
  const correspondances = correspondancesGeoAlgeria(algeria);
  const index = construireIndex(
    [
      // Alger Centre avec un trou (où se trouve Sidi M'Hamed)
      { id: "relation/1", geometry: { type: "Polygon", coordinates: [carre(3, 36, 1), carre(3.4, 36.4, 0.2)] } },
      { id: "relation/2", geometry: { type: "Polygon", coordinates: [carre(3.4, 36.4, 0.2)] } },
      { id: "relation/3", geometry: { type: "MultiPolygon", coordinates: [[carre(2, 34, 0.5)], [carre(2.6, 34, 0.5)]] } },
      { id: "relation/99", geometry: { type: "Polygon", coordinates: [carre(0, 0, 1)] } },
    ],
    correspondances
  );

  it("lit les codes GeoAlgeria (wilaya sur 2 chiffres, commune sur 4)", () => {
    expect(correspondances.get("relation/3")).toEqual({ wilaya_code: "59", commune_code: "0302", commune: "Aflou" });
    expect(index.nbZones).toBe(3);
  });

  it("place un point dans sa commune, trous et multipolygones compris", () => {
    expect(localiser(index, [3.1, 36.1])?.commune_code).toBe("1601");
    expect(localiser(index, [3.5, 36.5])?.commune_code).toBe("1602");
    expect(localiser(index, [2.8, 34.2])?.wilaya_code).toBe("59");
    expect(localiser(index, [2.55, 34.2])).toBeNull();
    expect(localiser(index, [0.5, 0.5])).toBeNull();
  });

  it("écrit les codes sur les objets et retire les anciens hors de toute commune", () => {
    const objets: Objet[] = [
      { type: "Feature", geometry: { type: "Point", coordinates: [3.1, 36.1] }, properties: { "@id": "node/1", name: "A" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [10, 10] }, properties: { "@id": "node/2", wilaya_code: "01" } },
    ];
    expect(localiserObjets(objets, index)).toBe(1);
    expect(objets[0].properties).toMatchObject({ wilaya_code: "16", commune_code: "1601", commune: "Alger Centre" });
    expect(objets[1].properties.wilaya_code).toBeUndefined();
  });
});
