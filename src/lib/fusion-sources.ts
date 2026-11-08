// Vue fusionnée d'une donnée (`file=all` sur /data, /sample et /download) : les fichiers de toutes ses sources
// en une seule table, sans doublon. Fonction pure, testée dans test/fusion-sources.test.ts.
//
// Règles :
// - Donnée qui reçoit des fichiers d'une autre source (ex. GeoAlgeria « pharmacies » + `pharmacies-osm`) : le fichier
//   de référence de la source de la donnée (celui qui a le plus de points, le principal à égalité : même règle que le
//   robot OpenStreetMap, `fichierReference`) plus les fichiers des autres sources. Un objet OSM rapproché d'un objet
//   GeoAlgeria (`geoalgeria_id`) n'est pas répété : l'objet GeoAlgeria reçoit son `osm_id`.
// - Donnée d'une seule source dont la source est OpenStreetMap : tous ses fichiers (un par tag), un objet OSM une fois.
// - Autre donnée d'une seule source : son fichier principal (ses autres fichiers sont d'une autre nature).
// Chaque ligne porte `provider` (slug de la source), `provider_file` (fichier d'origine), et `latitude` / `longitude`
// quand l'objet a une position. (`source` est déjà une colonne de GeoAlgeria : l'organisme d'origine.)

import type { Table } from "./conversion.js";

export const FICHIER_FUSION = "all";

type Ligne = Record<string, unknown>;
type Geometrie = NonNullable<Table["geometries"]>[number];

export interface TableSource {
  nom: string;
  principal: boolean;
  /** Slug de la source du fichier (celle de la donnée s'il n'en précise pas). */
  source: string;
  /** Vrai si le fichier vient d'une autre source que la donnée. */
  autreSource: boolean;
  table: Table;
}

const nombre = (valeur: unknown): number | null => {
  const n = typeof valeur === "string" && valeur.trim() !== "" ? Number(valeur) : valeur;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** Position d'une ligne : géométrie ponctuelle, sinon colonnes lat/lng (GeoAlgeria) ou latitude/longitude. */
function position(ligne: Ligne, geometrie: Geometrie | null | undefined): [number, number] | null {
  if (geometrie?.type === "Point" && Array.isArray(geometrie.coordinates)) {
    const [lng, lat] = geometrie.coordinates as unknown[];
    if (nombre(lng) !== null && nombre(lat) !== null) return [nombre(lng)!, nombre(lat)!];
  }
  const lat = nombre(ligne.latitude ?? ligne.lat);
  const lng = nombre(ligne.longitude ?? ligne.lng ?? ligne.lon);
  return lat !== null && lng !== null ? [lng, lat] : null;
}

const nbPoints = (table: Table) => table.lignes.filter((ligne, indice) => position(ligne, table.geometries?.[indice]) !== null).length;

/** Fichiers qui entrent dans la vue fusionnée, référence en premier. */
export function fichiersFusionnes(fichiers: TableSource[], sourceDonnee: string | null): TableSource[] {
  const propres = fichiers.filter((fichier) => !fichier.autreSource);
  const autres = fichiers.filter((fichier) => fichier.autreSource);
  if (autres.length > 0) {
    const reference = [...propres]
      .map((fichier) => ({ fichier, points: nbPoints(fichier.table) }))
      .sort((a, b) => b.points - a.points || Number(b.fichier.principal) - Number(a.fichier.principal))[0]?.fichier;
    return reference ? [reference, ...autres] : autres;
  }
  if (sourceDonnee === "openstreetmap") return [...propres].sort((a, b) => Number(b.principal) - Number(a.principal));
  const principal = propres.find((fichier) => fichier.principal) ?? propres[0];
  return principal ? [principal] : [];
}

export function fusionnerSources(fichiers: TableSource[], sourceDonnee: string | null): Table & { fichiers: string[]; sources: string[] } {
  const retenus = fichiersFusionnes(fichiers, sourceDonnee);
  const reference = retenus[0];
  const avecAutreSource = retenus.some((fichier) => fichier.autreSource);

  // Objets OSM déjà présents chez la source de référence : identifiant OSM rangé sous l'objet de référence.
  const osmParReference = new Map<string, string>();
  if (avecAutreSource) {
    for (const fichier of retenus.filter((f) => f.autreSource)) {
      for (const ligne of fichier.table.lignes) {
        const lien = ligne.geoalgeria_id;
        const osm = ligne["@id"];
        if ((typeof lien === "string" || typeof lien === "number") && typeof osm === "string" && !osmParReference.has(String(lien))) {
          osmParReference.set(String(lien), osm);
        }
      }
    }
  }

  const lignes: Ligne[] = [];
  const geometries: (Geometrie | null)[] = [];
  const dejaVus = new Set<string>();
  for (const fichier of retenus) {
    fichier.table.lignes.forEach((ligne, indice) => {
      const geometrie = fichier.table.geometries?.[indice] ?? null;
      if (fichier.autreSource && ligne.geoalgeria_id !== undefined && ligne.geoalgeria_id !== null && ligne.geoalgeria_id !== "") return;
      const osm = typeof ligne["@id"] === "string" ? ligne["@id"] : null;
      if (osm) {
        if (dejaVus.has(osm)) return;
        dejaVus.add(osm);
      }
      const point = position(ligne, geometrie);
      const lien = fichier === reference && avecAutreSource ? osmParReference.get(String(ligne.id ?? "")) : undefined;
      const sortie: Ligne = { provider: fichier.source, provider_file: fichier.nom };
      Object.assign(sortie, ligne, { provider: fichier.source, provider_file: fichier.nom });
      if (lien) sortie.osm_id = lien;
      if (point) Object.assign(sortie, { longitude: point[0], latitude: point[1] });
      lignes.push(sortie);
      geometries.push(geometrie ?? (point ? { type: "Point", coordinates: point } : null));
    });
  }
  return {
    lignes,
    geometries: geometries.some(Boolean) ? geometries : null,
    fichiers: retenus.map((fichier) => fichier.nom),
    sources: [...new Set(retenus.map((fichier) => fichier.source))],
  };
}
