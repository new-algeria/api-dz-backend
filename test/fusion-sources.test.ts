import { describe, expect, it } from "vitest";
import { fichiersFusionnes, fusionnerSources, type TableSource } from "../src/lib/fusion-sources.js";

const point = (lng: number, lat: number) => ({ type: "Point", coordinates: [lng, lat] });

const geoalgeria = (nom: string, principal: boolean, lignes: Record<string, unknown>[], geometries: unknown[] | null = null): TableSource => ({
  nom,
  principal,
  source: "geoalgeria",
  autreSource: false,
  table: { lignes, geometries: geometries as never },
});
const osm = (nom: string, lignes: Record<string, unknown>[]): TableSource => ({
  nom,
  principal: false,
  source: "openstreetmap",
  autreSource: true,
  table: { lignes, geometries: lignes.map(() => point(3, 36)) as never },
});

describe("vue fusionnée (file=all)", () => {
  it("GeoAlgeria + OSM : les objets OSM déjà connus ne sont pas répétés, l'objet GeoAlgeria reçoit leur osm_id", () => {
    const table = fusionnerSources(
      [
        geoalgeria("pharmacies", true, [
          { id: "16-1", name: "Pharmacie A", source: "cnop", lat: 36.7, lng: 3.05 },
          { id: "16-2", name: "Pharmacie B", lat: 36.8, lng: 3.1 },
        ]),
        osm("pharmacies-osm", [
          { "@id": "node/1", name: "Pharmacie A", geoalgeria_id: "16-1", wilaya_code: "16" },
          { "@id": "node/2", name: "Pharmacie C", wilaya_code: "16" },
        ]),
      ],
      "geoalgeria"
    );
    expect(table.lignes.map((l) => l.name)).toEqual(["Pharmacie A", "Pharmacie B", "Pharmacie C"]);
    expect(table.lignes[0]).toMatchObject({ provider: "geoalgeria", provider_file: "pharmacies", source: "cnop", osm_id: "node/1", latitude: 36.7, longitude: 3.05 });
    expect(table.lignes[2]).toMatchObject({ provider: "openstreetmap", provider_file: "pharmacies-osm", latitude: 36, longitude: 3 });
    expect(table.sources).toEqual(["geoalgeria", "openstreetmap"]);
  });

  it("prend comme référence le fichier GeoAlgeria qui a le plus de points (aéroports plutôt que lignes aériennes)", () => {
    const routes = geoalgeria("routes", true, [{ id: "r1" }], [{ type: "LineString", coordinates: [[0, 0], [1, 1]] }]);
    const aeroports = geoalgeria("airports", false, [{ id: "daag", lat: 36.69, lng: 3.21 }]);
    expect(fichiersFusionnes([routes, aeroports, osm("aerodromes-osm", [])], "geoalgeria").map((f) => f.nom)).toEqual(["airports", "aerodromes-osm"]);
  });

  it("une seule source : tous les fichiers si elle est OpenStreetMap, sinon le principal seulement", () => {
    const docteurs = { ...osm("doctors", [{ "@id": "node/1" }]), autreSource: false, principal: true };
    const dentistes = { ...osm("dentists", [{ "@id": "node/2" }, { "@id": "node/1" }]), autreSource: false };
    const table = fusionnerSources([docteurs, dentistes], "openstreetmap");
    expect(table.lignes.map((l) => l["@id"])).toEqual(["node/1", "node/2"]);
    expect(fichiersFusionnes([geoalgeria("postoffices", true, []), geoalgeria("communes", false, [])], "geoalgeria").map((f) => f.nom)).toEqual(["postoffices"]);
  });
});
