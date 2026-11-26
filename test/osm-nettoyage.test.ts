import { describe, expect, it } from "vitest";
import type { Objet } from "../scripts/osm/fusion.js";
import { localiser, localiserObjets, marquerDoublons, nomComparable, preparerWilayas, surLaCote } from "../scripts/osm/nettoyage.js";

/** 69 wilayas fictives : la 16 « Alger » couvre [2.9, 3.4] × [36.5, 36.8] (côte au nord), la 46 « Aïn Témouchent »
 * [-1.5, -1.0] × [35.0, 35.4], la 12 « Tébessa » [7.6, 8.3] × [35.0, 35.6] (frontière tunisienne à l'est) ;
 * les autres sont de petits carrés au Sahara. */
function wilayasFictives() {
  const carre = (o: number, s: number, e: number, n: number) => [[[o, s], [e, s], [e, n], [o, n], [o, s]]];
  const particulieres: Record<number, number[]> = { 16: [2.9, 36.5, 3.4, 36.8], 46: [-1.5, 35.0, -1.0, 35.4], 12: [7.6, 35.0, 8.3, 35.6] };
  const features = Array.from({ length: 69 }, (_, i) => {
    const code = i + 1;
    const [o, s, e, n] = particulieres[code] ?? [0 + (i % 10) * 0.2, 25 + Math.floor(i / 10) * 0.2, 0.1 + (i % 10) * 0.2, 25.1 + Math.floor(i / 10) * 0.2];
    return { properties: { code }, geometry: { type: "Polygon" as const, coordinates: carre(o, s, e, n) } };
  });
  const noms = { wilayas: Array.from({ length: 69 }, (_, i) => ({ code: i + 1, name_fr: i + 1 === 16 ? "Alger" : `W${i + 1}`, name_ar: i + 1 === 16 ? "الجزائر" : `و${i + 1}` })) };
  return preparerWilayas({ features }, noms);
}

const objet = (id: string, lon: number, lat: number, proprietes: Record<string, unknown> = {}): Objet => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { "@id": id, ...proprietes },
});

describe("wilaya des objets", () => {
  const wilayas = wilayasFictives();

  it("dans les contours, par la marge de 120 m, par la côte, ou hors d'Algérie", () => {
    expect(localiser([3.0, 36.6], wilayas)).toMatchObject({ wilaya: { code: "16" }, methode: "contours" });
    // 0,1 km au nord de la côte d'Alger : marge ; 5 km au large : côte ; île à 11 km au large de la wilaya 46 : côte.
    expect(localiser([3.0, 36.8009], wilayas)).toMatchObject({ wilaya: { code: "16" }, methode: "marge" });
    expect(localiser([3.0, 36.845], wilayas)).toMatchObject({ wilaya: { code: "16" }, methode: "cote" });
    expect(localiser([-1.13, 35.5], wilayas)).toMatchObject({ wilaya: { code: "46" }, methode: "cote" });
    // 300 m à l'est de la frontière tunisienne (pas sur la côte) : hors d'Algérie ; 50 m : marge.
    expect(localiser([8.3035, 35.3], wilayas)).toBeNull();
    expect(localiser([8.3005, 35.3], wilayas)).toMatchObject({ wilaya: { code: "12" }, methode: "marge" });
  });

  it("côte méditerranéenne sans frontière terrestre", () => {
    expect(surLaCote(3, 36.8)).toBe(true);
    expect(surLaCote(8.35, 36.22)).toBe(false); // Sakiet Sidi Youssef (Tunisie)
    expect(surLaCote(8.5, 36.9)).toBe(true); // El Kala
    expect(surLaCote(-2.3, 35.1)).toBe(false); // Saïdia (Maroc)
  });

  it("pose la wilaya, écarte les objets OSM hors d'Algérie, garde les objets saisis à la main", () => {
    const { objets, rapport, horsAlgerie } = localiserObjets(
      [objet("node/1", 3.0, 36.6, { code_wilaya: "99" }), objet("node/2", 8.36, 35.3), objet("saisi-1", 8.36, 35.3)],
      wilayas
    );
    expect(objets.map((o) => o.properties["@id"])).toEqual(["node/1", "saisi-1"]);
    expect(objets[0].properties).toMatchObject({ code_wilaya: "16", wilaya: "Alger", wilaya_ar: "الجزائر" });
    expect(objets[1].properties.code_wilaya).toBeUndefined();
    expect(rapport).toEqual({ contours: 1, marge: 0, cote: 0, hors_algerie: 1 });
    expect(horsAlgerie).toEqual(["node/2"]);
  });

  it("refuse des contours incomplets", () => {
    expect(() => preparerWilayas({ features: [] }, { wilayas: [] })).toThrow(/0 sur 69/);
  });
});

describe("doublons", () => {
  it("nom comparable : casse, accents et ponctuation ignorés, chiffres gardés", () => {
    expect(nomComparable("Hôpital  d'Arassa")).toBe("hopital d arassa");
    expect(nomComparable("DJANET LS 1")).not.toBe(nomComparable("DJANET LS 2"));
    expect(nomComparable(undefined)).toBe("");
  });

  it("point + bâtiment de même nom : le plus complet sert de référence", () => {
    const objets = [
      objet("node/10", 3.0, 36.6, { name: "Hôpital Arassa", amenity: "hospital" }),
      objet("way/20", 3.0003, 36.6, { name: "hopital arassa", amenity: "hospital", "addr:street": "Rue A" }),
      objet("node/30", 3.1, 36.6, { name: "Hôpital Arassa", amenity: "hospital" }), // à 9 km : pas un doublon
    ];
    expect(marquerDoublons(objets, "hospitals-osm")).toBe(1);
    expect(objets[0].properties.doublon_probable).toBe("way/20");
    expect(objets[1].properties.doublon_probable).toBeUndefined();
    expect(objets[2].properties.doublon_probable).toBeUndefined();
  });

  it("deux points : seulement à moins de 10 m, jamais pour les distributeurs", () => {
    const proches = () => [objet("node/1", 3.0, 36.6, { name: "Pharmacie Ouklil" }), objet("node/2", 3.00002, 36.6, { name: "PHARMACIE OUKLIL" })];
    const loin = [objet("node/1", 3.0, 36.6, { name: "Mosquée El Fath" }), objet("node/2", 3.0003, 36.6, { name: "Mosquée El Fath" })];
    expect(marquerDoublons(proches(), "pharmacies-osm")).toBe(1);
    expect(marquerDoublons(proches(), "atms-osm")).toBe(0);
    expect(marquerDoublons(loin, "mosques-osm")).toBe(0);
  });

  it("noms différents, objets sans nom ou disparus : jamais doublons ; une ancienne marque est retirée", () => {
    const objets = [
      objet("node/1", 3.0, 36.6, { name: "DJANET LS 1" }),
      objet("way/2", 3.0, 36.6, { name: "DJANET LS 2" }),
      objet("node/3", 3.0, 36.6, {}),
      objet("way/4", 3.0, 36.6, {}),
      objet("node/5", 3.0, 36.6, { name: "Poste", osm_absent_depuis: "2026-11-01" }),
      objet("way/6", 3.0, 36.6, { name: "Poste", doublon_probable: "node/999" }),
    ];
    expect(marquerDoublons(objets, "x")).toBe(0);
    expect(objets[5].properties.doublon_probable).toBeUndefined();
  });

  it("trois objets du même lieu : un seul gardé comme référence", () => {
    const objets = [
      objet("node/1", 3.0, 36.6, { name: "Mairie", phone: "1" }),
      objet("way/2", 3.0001, 36.6, { name: "Mairie" }),
      objet("relation/3", 3.0002, 36.6, { name: "Mairie" }),
    ];
    expect(marquerDoublons(objets, "town_halls")).toBe(2);
    expect(objets.map((o) => o.properties.doublon_probable)).toEqual([undefined, "node/1", "node/1"]);
  });
});
