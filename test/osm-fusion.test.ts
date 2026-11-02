import { describe, expect, it } from "vitest";
import { FLUX, NOUVELLES_DONNEES } from "../scripts/osm/categories.js";
import {
  appartientAuFlux,
  baisseAnormale,
  centre,
  fusionner,
  idDepuisOsmium,
  idObjet,
  numeroComplement,
  rapprocher,
  serialiser,
  similarite,
  versObjet,
  type Objet,
} from "../scripts/osm/fusion.js";

const objet = (id: string, proprietes: Record<string, unknown> = {}, point: [number, number] = [3.05, 36.75]): Objet => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: point },
  properties: { "@id": id, ...proprietes, "@geometry": "center" },
});

describe("identifiants OSM", () => {
  it("convertit les identifiants d'osmium, surfaces comprises", () => {
    expect(idDepuisOsmium("n266504916")).toBe("node/266504916");
    expect(idDepuisOsmium("w42")).toBe("way/42");
    expect(idDepuisOsmium("a8069709")).toBe("relation/4034854");
    expect(idDepuisOsmium("a84")).toBe("way/42");
    expect(idDepuisOsmium("x1")).toBeNull();
  });

  it("lit l'identifiant d'un fichier overpass-turbo ou GeoAlgeria", () => {
    expect(idObjet({ properties: { "@id": "way/1" } })).toBe("way/1");
    expect(idObjet({ id: "node/7", properties: {} })).toBe("node/7");
    expect(idObjet({ properties: { id: "01-00001" } })).toBeNull();
  });
});

describe("extraction", () => {
  it("prend le centre du rectangle englobant, refuse ce qui est hors d'Algérie", () => {
    expect(centre({ type: "LineString", coordinates: [[3, 36], [3.2, 36.4]] })).toEqual([3.1, 36.2]);
    const brut = { id: "w5", geometry: { type: "LineString", coordinates: [[3, 36], [3.2, 36.4]] }, properties: { amenity: "fuel", created_by: "JOSM", "name:de": "Tankstelle", "name:ar": "محطة" } };
    expect(versObjet(brut)?.properties).toEqual({ "@id": "way/5", amenity: "fuel", "name:ar": "محطة", "@geometry": "center" });
    expect(versObjet({ id: "n1", geometry: { type: "Point", coordinates: [2.35, 48.85] }, properties: { amenity: "fuel" } })).toBeNull();
  });

  it("vérifie filtres et conditions des flux", () => {
    const terrains = FLUX.find((f) => f.code === "terrains-football")!;
    expect(appartientAuFlux({ leisure: "pitch", sport: "soccer;basketball" }, terrains)).toBe(true);
    expect(appartientAuFlux({ leisure: "pitch", sport: "tennis" }, terrains)).toBe(false);
    const universites = FLUX.find((f) => f.code === "universites")!;
    expect(appartientAuFlux({ amenity: "college" }, universites)).toBe(true);
    expect(appartientAuFlux({ amenity: "school" }, universites)).toBe(false);
  });

  it("chaque nouvelle donnée a ses flux, et les noms de fichiers sont uniques par donnée", () => {
    for (const donnee of NOUVELLES_DONNEES) expect(FLUX.some((f) => f.slug === donnee.slug)).toBe(true);
    const cles = FLUX.map((f) => `${f.slug}/${f.fichier}`);
    expect(new Set(cles).size).toBe(cles.length);
    expect(new Set(FLUX.map((f) => f.code)).size).toBe(FLUX.length);
  });
});

describe("fusion", () => {
  it("ajoute, met à jour, garde les absents sans jamais rien retirer", () => {
    const precedents = [
      objet("node/1", { name: "A", osm_ajoute_le: "2026-10-01" }),
      objet("node/2", { name: "B", osm_ajoute_le: "2026-10-01" }),
      objet("node/3", { name: "C", osm_ajoute_le: "2026-10-01" }),
      objet("node/4", { name: "D", osm_absent_depuis: "2026-10-01" }),
    ];
    const extraits = [objet("node/1", { name: "A" }), objet("node/2", { name: "B modifié" }), objet("node/4", { name: "D" }), objet("node/5", { name: "E" })];
    const { objets, rapport } = fusionner(precedents, extraits, "2026-11-01");
    expect(rapport).toEqual({ ajoutes: 1, mis_a_jour: 1, inchanges: 1, absents: 1, nouveaux_absents: 1, revenus: 1, total: 5 });
    const parId = Object.fromEntries(objets.map((o) => [o.properties["@id"], o.properties]));
    expect(parId["node/1"].osm_ajoute_le).toBe("2026-10-01");
    expect(parId["node/2"]).toMatchObject({ name: "B modifié", osm_ajoute_le: "2026-10-01" });
    expect(parId["node/3"]).toMatchObject({ name: "C", osm_absent_depuis: "2026-11-01" });
    expect(parId["node/4"].osm_absent_depuis).toBeUndefined();
    expect(parId["node/5"].osm_ajoute_le).toBe("2026-11-01");
  });

  it("un absent garde sa première date d'absence, et un passage identique donne le même texte", () => {
    const premier = fusionner([], [objet("node/1", { name: "A" }), objet("node/2", { name: "B" })], "2026-10-01").objets;
    const deuxieme = fusionner(premier, [objet("node/1", { name: "A" })], "2026-11-01").objets;
    const troisieme = fusionner(deuxieme, [objet("node/1", { name: "A" })], "2026-12-01").objets;
    expect(troisieme.find((o) => o.properties["@id"] === "node/2")?.properties.osm_absent_depuis).toBe("2026-11-01");
    expect(serialiser(troisieme)).toBe(serialiser(deuxieme));
    expect(JSON.parse(serialiser(troisieme)).features).toHaveLength(2);
  });

  it("garde les objets publiés sans identifiant OSM", () => {
    const manuel = { ...objet("node/9"), properties: { name: "saisi à la main" } } as unknown as Objet;
    expect(fusionner([manuel], [], "2026-11-01").objets).toHaveLength(1);
  });

  it("signale une baisse anormale", () => {
    const precedents = Array.from({ length: 30 }, (_, i) => objet(`node/${i}`));
    expect(baisseAnormale(precedents, precedents.slice(0, 26))).toBe(true);
    expect(baisseAnormale(precedents, precedents.slice(0, 28))).toBe(false);
    expect(baisseAnormale(precedents.slice(0, 10), [])).toBe(false);
  });
});

describe("numéro de version d'un complément", () => {
  it("correctif daté, jamais un numéro que GeoAlgeria pourrait publier", () => {
    expect(numeroComplement("2.3.0", "2026-11-02")).toBe("2.3.20261102");
    expect(numeroComplement("2.3.20261102", "2026-11-02")).toBe("2.3.20261103");
    expect(numeroComplement("2.3.20261102", "2026-12-01")).toBe("2.3.20261201");
    expect(numeroComplement(null, "2026-11-02")).toBe("1.0.20261102");
  });
});

describe("rapprochement GeoAlgeria", () => {
  it("par identifiant OSM, sinon par distance et nom proche", () => {
    const objets = [
      objet("node/1", { name: "Pharmacie Benali" }, [3.05, 36.75]),
      objet("node/2", { name: "Hôpital Mustapha Pacha" }, [3.0503, 36.7603]),
      objet("node/3", { name: "Pharmacie du Centre" }, [5, 35]),
    ];
    const geoalgeria = [
      { properties: { id: "16-001", name: "Autre nom", refs: { osm: "node/1" } }, geometry: { type: "Point", coordinates: [3.06, 36.76] } },
      { properties: { id: "16-eph-02", name: "CHU Mustapha Pacha" }, geometry: { type: "Point", coordinates: [3.0505, 36.7605] } },
      { properties: { id: "31-003", name: "Pharmacie du Centre" }, geometry: { type: "Point", coordinates: [0.6, 35.7] } },
    ];
    expect(rapprocher(objets, geoalgeria, 300)).toBe(2);
    expect(objets.map((o) => o.properties.geoalgeria_id)).toEqual(["16-001", "16-eph-02", undefined]);
  });

  it("compare les noms sans accents ni mots génériques", () => {
    expect(similarite("Hôpital Mustapha Pacha", "CHU Mustapha-Pacha")).toBe(1);
    expect(similarite("Pharmacie Benali", "Pharmacie Bouzid")).toBeLessThan(0.8);
  });
});
