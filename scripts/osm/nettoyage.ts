// Nettoyage des objets OpenStreetMap avant publication (fonctions pures, testées dans test/osm-nettoyage.test.ts).
//
// 1. Wilaya : chaque objet reçoit `code_wilaya`, `wilaya`, `wilaya_ar` d'après les contours des 69 wilayas
//    (donnée `divisions-administratives`, fichier `wilaya-boundaries`). Ces contours sont simplifiés : un objet juste
//    à l'extérieur est rattaché à la wilaya la plus proche s'il en est à moins de `MARGE_KM` (≈ 120 m), ou, sur la côte
//    méditerranéenne, à moins de `MARGE_COTE_KM` (ports, plages, îles Habibas). Sinon il est hors d'Algérie (l'extrait
//    Geofabrik déborde de quelques kilomètres sur le Maroc, la Tunisie, la Libye…) et il n'est pas publié.
// 2. Doublons : un même lieu saisi deux fois (un point et un bâtiment, ou deux points à quelques mètres) porte
//    `doublon_probable` = identifiant de l'objet gardé comme référence (le plus complet). Rien n'est supprimé.
//
// Mesuré sur les 33 fichiers publiés (61 588 objets, novembre 2026) : 207 objets rattachés par la marge, 95 par la côte,
// 63 hors d'Algérie (Ich, Figuig, Hazoua, Sakiet Sidi Youssef…), 284 paires de doublons.

import { trierProprietes, type Objet } from "./fusion.js";

type Position = number[];
type Anneau = Position[];
type Polygone = Anneau[];

export interface GeometrieWilaya {
  type: "Polygon" | "MultiPolygon";
  coordinates: Polygone | Polygone[];
}

export interface Wilaya {
  code: string;
  nom_fr: string;
  nom_ar: string;
  polygones: Polygone[];
  limites: { ouest: number; sud: number; est: number; nord: number };
}

/** Marge pour les contours simplifiés (toute frontière). */
export const MARGE_KM = 0.12;
/** Marge sur la côte méditerranéenne (îles Habibas à 11 km de la côte d'Oran). */
export const MARGE_COTE_KM = 15;

/**
 * Côte méditerranéenne de l'Algérie, sans frontière terrestre : au nord de 35° N entre l'oued Kiss (frontière
 * marocaine, 2,21° O) et 8,10° E, puis au nord de 36,85° N jusqu'à El Kala (8,65° E), le long de la frontière tunisienne.
 */
export const surLaCote = (lon: number, lat: number) => (lat >= 35 && lon >= -2.21 && lon <= 8.1) || (lat >= 36.85 && lon > 8.1 && lon <= 8.65);

/** Wilayas prêtes pour la localisation : contours GeoJSON (propriété `code`) et noms (`wilayas` : code, name_fr, name_ar). */
export function preparerWilayas(
  contours: { features?: { properties?: Record<string, unknown> | null; geometry?: GeometrieWilaya | null }[] },
  noms: { wilayas?: { code: string | number; name_fr?: string; name_ar?: string }[] }
): Wilaya[] {
  const parCode = new Map((noms.wilayas ?? []).map((w) => [String(Number(w.code)).padStart(2, "0"), w]));
  const wilayas: Wilaya[] = [];
  for (const entite of contours.features ?? []) {
    const code = String(Number(entite.properties?.code)).padStart(2, "0");
    const nom = parCode.get(code);
    if (!entite.geometry || !nom) continue;
    const polygones = entite.geometry.type === "Polygon" ? [entite.geometry.coordinates as Polygone] : (entite.geometry.coordinates as Polygone[]);
    const sommets = polygones.flat(2);
    wilayas.push({
      code,
      nom_fr: nom.name_fr ?? "",
      nom_ar: nom.name_ar ?? "",
      polygones,
      limites: {
        ouest: Math.min(...sommets.map((p) => p[0])),
        sud: Math.min(...sommets.map((p) => p[1])),
        est: Math.max(...sommets.map((p) => p[0])),
        nord: Math.max(...sommets.map((p) => p[1])),
      },
    });
  }
  if (wilayas.length !== 69) throw new Error(`Contours des wilayas incomplets : ${wilayas.length} sur 69.`);
  return wilayas;
}

function dansAnneau(lon: number, lat: number, anneau: Anneau): boolean {
  let dedans = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const [xi, yi] = anneau[i];
    const [xj, yj] = anneau[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

function dansWilaya(lon: number, lat: number, wilaya: Wilaya): boolean {
  const { ouest, est, sud, nord } = wilaya.limites;
  if (lon < ouest || lon > est || lat < sud || lat > nord) return false;
  return wilaya.polygones.some((polygone) => polygone[0] && dansAnneau(lon, lat, polygone[0]) && !polygone.slice(1).some((trou) => dansAnneau(lon, lat, trou)));
}

/** Distance (km) d'un point au bord d'une wilaya, en projection locale (suffisant à quelques kilomètres). */
function distanceKm(lon: number, lat: number, wilaya: Wilaya): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  let minimum = Infinity;
  for (const polygone of wilaya.polygones) {
    for (const anneau of polygone) {
      for (let i = 1; i < anneau.length; i++) {
        const ax = (anneau[i - 1][0] - lon) * kx;
        const ay = (anneau[i - 1][1] - lat) * ky;
        const bx = (anneau[i][0] - lon) * kx;
        const by = (anneau[i][1] - lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const longueur = dx * dx + dy * dy;
        const t = longueur === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / longueur));
        minimum = Math.min(minimum, Math.hypot(ax + t * dx, ay + t * dy));
      }
    }
  }
  return minimum;
}

export type Methode = "contours" | "marge" | "cote";

/** Wilaya d'un point (`null` = hors d'Algérie), avec la façon dont elle a été trouvée. */
export function localiser([lon, lat]: [number, number], wilayas: Wilaya[]): { wilaya: Wilaya; methode: Methode } | null {
  const dedans = wilayas.find((wilaya) => dansWilaya(lon, lat, wilaya));
  if (dedans) return { wilaya: dedans, methode: "contours" };
  const cote = surLaCote(lon, lat);
  const rayon = cote ? MARGE_COTE_KM : MARGE_KM;
  const degres = rayon / 100 + 0.01;
  let meilleure: Wilaya | null = null;
  let distance = Infinity;
  for (const wilaya of wilayas) {
    const { ouest, est, sud, nord } = wilaya.limites;
    if (lon < ouest - degres || lon > est + degres || lat < sud - degres || lat > nord + degres) continue;
    const d = distanceKm(lon, lat, wilaya);
    if (d < distance) [meilleure, distance] = [wilaya, d];
  }
  if (!meilleure) return null;
  if (distance <= MARGE_KM) return { wilaya: meilleure, methode: "marge" };
  if (cote && distance <= MARGE_COTE_KM) return { wilaya: meilleure, methode: "cote" };
  return null;
}

export interface RapportLocalisation {
  contours: number;
  marge: number;
  cote: number;
  hors_algerie: number;
}

const PROPRIETES_WILAYA = ["code_wilaya", "wilaya", "wilaya_ar"] as const;

/**
 * Pose `code_wilaya`, `wilaya`, `wilaya_ar` sur chaque objet et écarte ceux qui sont hors d'Algérie.
 * Un objet saisi à la main (sans identifiant OSM) n'est jamais écarté : il garde seulement sa wilaya s'il en a une.
 */
export function localiserObjets(objets: Objet[], wilayas: Wilaya[]): { objets: Objet[]; rapport: RapportLocalisation; horsAlgerie: string[] } {
  const rapport: RapportLocalisation = { contours: 0, marge: 0, cote: 0, hors_algerie: 0 };
  const gardes: Objet[] = [];
  const horsAlgerie: string[] = [];
  for (const objet of objets) {
    const trouve = localiser(objet.geometry.coordinates, wilayas);
    const proprietes: Record<string, unknown> = { ...objet.properties };
    for (const cle of PROPRIETES_WILAYA) delete proprietes[cle];
    if (!trouve) {
      const id = objet.properties["@id"];
      if (typeof id === "string" && /^(node|way|relation)\/\d+$/.test(id)) {
        rapport.hors_algerie++;
        horsAlgerie.push(id);
        continue;
      }
      gardes.push({ ...objet, properties: trierProprietes(proprietes) });
      continue;
    }
    rapport[trouve.methode]++;
    gardes.push({ ...objet, properties: trierProprietes({ ...proprietes, code_wilaya: trouve.wilaya.code, wilaya: trouve.wilaya.nom_fr, wilaya_ar: trouve.wilaya.nom_ar }) });
  }
  return { objets: gardes, rapport, horsAlgerie };
}

// ---------------------------------------------------------------- Doublons

/** Rayon de recherche des doublons (un point et le bâtiment dessiné autour). */
export const RAYON_DOUBLON_M = 50;
/** Deux points (même type OSM) ne sont des doublons qu'à moins de cette distance. */
export const RAYON_DOUBLON_POINTS_M = 10;
/** Fichiers où plusieurs objets de même nom côte à côte sont normaux (plusieurs distributeurs au même guichet). */
export const SANS_DOUBLONS_POINTS = new Set(["atms-osm"]);

/** Nom comparable : minuscules, sans accents ni ponctuation. Les chiffres comptent (« LS 1 » ≠ « LS 2 »). */
export function nomComparable(nom: unknown): string {
  if (typeof nom !== "string") return "";
  return nom
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function distanceM([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

const typeOsm = (objet: Objet) => objet.properties["@id"].split("/")[0];
/** Le plus complet (le plus d'étiquettes), puis le bâtiment plutôt que le point, puis le plus petit identifiant. */
function meilleur(a: Objet, b: Objet): Objet {
  const etiquettes = (o: Objet) => Object.keys(o.properties).filter((cle) => !cle.startsWith("@") && !cle.startsWith("osm_") && cle !== "doublon_probable").length;
  if (etiquettes(a) !== etiquettes(b)) return etiquettes(a) > etiquettes(b) ? a : b;
  if ((typeOsm(a) === "node") !== (typeOsm(b) === "node")) return typeOsm(a) === "node" ? b : a;
  return a.properties["@id"] <= b.properties["@id"] ? a : b;
}

/**
 * Repère les doublons d'un fichier : même nom (comparable), à moins de `RAYON_DOUBLON_M`, et soit de types OSM différents
 * (point + bâtiment), soit deux points à moins de `RAYON_DOUBLON_POINTS_M` (sauf `SANS_DOUBLONS_POINTS`). Les objets
 * absents d'OSM et sans nom sont ignorés. Chaque groupe garde son meilleur objet ; les autres portent
 * `doublon_probable` = son identifiant. Renvoie le nombre d'objets marqués.
 */
export function marquerDoublons(objets: Objet[], fichier: string): number {
  const actifs = objets.filter((objet) => typeof objet.properties.osm_absent_depuis !== "string" && nomComparable(objet.properties.name));
  for (const objet of objets) {
    if (objet.properties.doublon_probable !== undefined) {
      const { doublon_probable: _ancien, ...reste } = objet.properties;
      objet.properties = reste as Objet["properties"];
    }
  }
  // Grille d'environ 100 m pour ne comparer que des voisins.
  const cle = (lon: number, lat: number) => `${Math.floor(lon / 0.001)}:${Math.floor(lat / 0.001)}`;
  const grille = new Map<string, number[]>();
  actifs.forEach((objet, indice) => {
    const [lon, lat] = objet.geometry.coordinates;
    const k = cle(lon, lat);
    grille.set(k, [...(grille.get(k) ?? []), indice]);
  });
  const parent = actifs.map((_, indice) => indice);
  const racine = (i: number): number => (parent[i] === i ? i : (parent[i] = racine(parent[i])));
  actifs.forEach((objet, i) => {
    const [lon, lat] = objet.geometry.coordinates;
    const nom = nomComparable(objet.properties.name);
    const x = Math.floor(lon / 0.001);
    const y = Math.floor(lat / 0.001);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grille.get(`${x + dx}:${y + dy}`) ?? []) {
          if (j <= i) continue;
          const autre = actifs[j];
          if (nomComparable(autre.properties.name) !== nom) continue;
          const d = distanceM(objet.geometry.coordinates, autre.geometry.coordinates);
          const typesDifferents = typeOsm(objet) !== typeOsm(autre);
          if (d <= RAYON_DOUBLON_M && (typesDifferents || (d <= RAYON_DOUBLON_POINTS_M && !SANS_DOUBLONS_POINTS.has(fichier)))) {
            parent[racine(j)] = racine(i);
          }
        }
      }
    }
  });
  const groupes = new Map<number, Objet[]>();
  actifs.forEach((objet, i) => groupes.set(racine(i), [...(groupes.get(racine(i)) ?? []), objet]));
  let marques = 0;
  for (const groupe of groupes.values()) {
    if (groupe.length < 2) continue;
    const reference = groupe.reduce(meilleur);
    for (const objet of groupe) {
      if (objet === reference) continue;
      objet.properties = trierProprietes({ ...objet.properties, doublon_probable: reference.properties["@id"] });
      marques++;
    }
  }
  return marques;
}
