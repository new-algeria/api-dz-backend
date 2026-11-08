// Wilaya et commune de chaque objet OpenStreetMap (testé dans test/osm-localisation.test.ts).
// Les objets OSM ne portent presque jamais leur wilaya ; on la déduit de leur position :
//   - frontières des communes : relations OSM `boundary=administrative` + `admin_level=8`, dans le même extrait
//     Geofabrik que les objets (aucun téléchargement de plus) ;
//   - codes officiels : fichier `algeria` de la donnée GeoAlgeria `divisions-administratives`, qui donne pour chaque
//     commune son `osm_relation_id`, son code et sa wilaya (69 wilayas, découpage de 2026 compris).
// Un point hors de toute commune connue (en mer, frontière manquante) reste sans code.

import { trierProprietes, type Objet } from "./fusion.js";

export interface Lieu {
  wilaya_code: string;
  commune_code: string;
  commune: string;
}

interface Geometrie {
  type: string;
  coordinates: unknown;
}

type Anneau = [number, number][];

interface Zone {
  lieu: Lieu;
  anneaux: Anneau[];
  cadre: { ouest: number; est: number; sud: number; nord: number };
}

export interface IndexLieux {
  cases: Map<string, Zone[]>;
  nbZones: number;
}

const TAILLE_CASE = 0.5;
const cleCase = (lon: number, lat: number) => `${Math.floor(lon / TAILLE_CASE)}:${Math.floor(lat / TAILLE_CASE)}`;
const deux = (valeur: unknown) => String(valeur).padStart(2, "0");
const quatre = (valeur: unknown) => String(valeur).padStart(4, "0");

/**
 * `relation/<id>` → lieu, depuis le fichier `algeria` de GeoAlgeria :
 * `[{ code, communes: [{ wilaya_code, code_commune, name_fr, osm_relation_id }] }]`.
 */
export function correspondancesGeoAlgeria(contenu: unknown): Map<string, Lieu> {
  const correspondances = new Map<string, Lieu>();
  if (!Array.isArray(contenu)) return correspondances;
  for (const wilaya of contenu as { code?: unknown; communes?: unknown }[]) {
    if (!Array.isArray(wilaya?.communes)) continue;
    for (const commune of wilaya.communes as Record<string, unknown>[]) {
      const relation = commune.osm_relation_id;
      const code = commune.code_commune;
      const codeWilaya = commune.wilaya_code ?? wilaya.code;
      if ((typeof relation !== "number" && typeof relation !== "string") || code === undefined || code === null || codeWilaya === undefined) continue;
      correspondances.set(`relation/${relation}`, {
        wilaya_code: deux(codeWilaya),
        commune_code: quatre(code),
        commune: typeof commune.name_fr === "string" ? commune.name_fr : "",
      });
    }
  }
  return correspondances;
}

function anneauxDe(geometrie: Geometrie): Anneau[] {
  if (geometrie.type === "Polygon") return geometrie.coordinates as Anneau[];
  if (geometrie.type === "MultiPolygon") return (geometrie.coordinates as Anneau[][]).flat();
  return [];
}

/** Index spatial (grille de 0,5°) des communes dont on connaît le code. */
export function construireIndex(limites: Iterable<{ id: string; geometry: Geometrie | null }>, correspondances: Map<string, Lieu>): IndexLieux {
  const cases = new Map<string, Zone[]>();
  let nbZones = 0;
  for (const limite of limites) {
    const lieu = correspondances.get(limite.id);
    if (!lieu || !limite.geometry) continue;
    const anneaux = anneauxDe(limite.geometry);
    if (anneaux.length === 0) continue;
    const cadre = { ouest: Infinity, est: -Infinity, sud: Infinity, nord: -Infinity };
    for (const anneau of anneaux) {
      for (const [lon, lat] of anneau) {
        cadre.ouest = Math.min(cadre.ouest, lon);
        cadre.est = Math.max(cadre.est, lon);
        cadre.sud = Math.min(cadre.sud, lat);
        cadre.nord = Math.max(cadre.nord, lat);
      }
    }
    const zone: Zone = { lieu, anneaux, cadre };
    nbZones++;
    for (let x = Math.floor(cadre.ouest / TAILLE_CASE); x <= Math.floor(cadre.est / TAILLE_CASE); x++) {
      for (let y = Math.floor(cadre.sud / TAILLE_CASE); y <= Math.floor(cadre.nord / TAILLE_CASE); y++) {
        const cle = `${x}:${y}`;
        cases.set(cle, [...(cases.get(cle) ?? []), zone]);
      }
    }
  }
  return { cases, nbZones };
}

/** Pair-impair sur tous les anneaux : gère les trous et les multipolygones. */
function contient(zone: Zone, lon: number, lat: number): boolean {
  const { cadre } = zone;
  if (lon < cadre.ouest || lon > cadre.est || lat < cadre.sud || lat > cadre.nord) return false;
  let dedans = false;
  for (const anneau of zone.anneaux) {
    for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
      const [xi, yi] = anneau[i];
      const [xj, yj] = anneau[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dedans = !dedans;
    }
  }
  return dedans;
}

export function localiser(index: IndexLieux, [lon, lat]: [number, number]): Lieu | null {
  for (const zone of index.cases.get(cleCase(lon, lat)) ?? []) {
    if (contient(zone, lon, lat)) return zone.lieu;
  }
  return null;
}

/**
 * Écrit `wilaya_code`, `commune_code` et `commune` sur chaque objet (mêmes noms de colonnes que GeoAlgeria).
 * Un objet hors de toute commune perd d'éventuels anciens codes. Renvoie le nombre d'objets localisés.
 */
export function localiserObjets(objets: Objet[], index: IndexLieux): number {
  let localises = 0;
  for (const objet of objets) {
    const lieu = localiser(index, objet.geometry.coordinates);
    const { wilaya_code: _w, commune_code: _c, commune: _n, ...reste } = objet.properties;
    objet.properties = trierProprietes(lieu ? { ...reste, ...lieu } : reste);
    if (lieu) localises++;
  }
  return localises;
}
