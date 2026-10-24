import Papa from "papaparse";
import * as XLSX from "xlsx";
import { ErreurApi } from "./erreurs.js";

export const FORMATS_SORTIE = ["csv", "xlsx", "json", "geojson"] as const;
export type FormatSortie = (typeof FORMATS_SORTIE)[number];
export type FormatSource = "json" | "geojson" | "csv";

type Ligne = Record<string, unknown>;
interface Geometrie {
  type: string;
  coordinates?: unknown;
  geometries?: Geometrie[];
}

/** Données tabulaires communes à tous les formats : une ligne par enregistrement, sa géométrie éventuelle. */
export interface Table {
  lignes: Ligne[];
  geometries: (Geometrie | null)[] | null;
}

export const TYPES_CONTENU: Record<FormatSortie, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json; charset=utf-8",
  geojson: "application/geo+json; charset=utf-8",
};

const nonTabulaire = () =>
  new ErreurApi(422, "not_tabular", "Ce fichier n'est pas un tableau d'enregistrements : seul son format d'origine est disponible.");

const estObjet = (valeur: unknown): valeur is Ligne =>
  typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);

/** Lit un fichier source en table. Lève `not_tabular` si le contenu n'est pas une liste d'objets. */
export function lireTable(texte: string, format: FormatSource): Table {
  if (format === "csv") {
    const resultat = Papa.parse<Ligne>(texte.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
    return { lignes: resultat.data, geometries: null };
  }

  let contenu: unknown;
  try {
    contenu = JSON.parse(texte);
  } catch {
    throw new ErreurApi(422, "invalid_source", "Le fichier source n'est pas un JSON valide.");
  }

  if (estObjet(contenu) && contenu.type === "FeatureCollection" && Array.isArray(contenu.features)) {
    const entites = contenu.features.filter(estObjet);
    return {
      lignes: entites.map((entite) => (estObjet(entite.properties) ? entite.properties : {})),
      geometries: entites.map((entite) => (estObjet(entite.geometry) ? (entite.geometry as unknown as Geometrie) : null)),
    };
  }

  if (Array.isArray(contenu) && contenu.length > 0 && contenu.every(estObjet)) {
    return { lignes: contenu, geometries: null };
  }
  // Objet qui enveloppe un seul tableau d'enregistrements (ex. { "data": [...] }).
  if (estObjet(contenu)) {
    const tableaux = Object.values(contenu).filter(
      (valeur): valeur is Ligne[] => Array.isArray(valeur) && valeur.length > 0 && valeur.every(estObjet)
    );
    if (tableaux.length === 1) return { lignes: tableaux[0], geometries: null };
  }
  throw nonTabulaire();
}

/** Colonnes dans l'ordre d'apparition (union de toutes les lignes). */
export function colonnesDe(lignes: Ligne[]): string[] {
  const colonnes = new Set<string>();
  for (const ligne of lignes) for (const cle of Object.keys(ligne)) colonnes.add(cle);
  return [...colonnes];
}

const NOMS_LATITUDE = ["lat", "latitude", "y"];
const NOMS_LONGITUDE = ["lng", "lon", "long", "longitude", "x"];

function colonnesCoordonnees(colonnes: string[]): { lat: string; lng: string } | null {
  const trouver = (noms: string[]) => colonnes.find((colonne) => noms.includes(colonne.toLowerCase()));
  const lat = trouver(NOMS_LATITUDE);
  const lng = trouver(NOMS_LONGITUDE);
  return lat && lng ? { lat, lng } : null;
}

/** Vrai si la table peut produire un GeoJSON (géométries, ou colonnes latitude / longitude). */
export function estGeographique(table: Table): boolean {
  return Boolean(table.geometries?.some(Boolean)) || colonnesCoordonnees(colonnesDe(table.lignes)) !== null;
}

function nombre(valeur: unknown): number | null {
  const n = typeof valeur === "number" ? valeur : typeof valeur === "string" && valeur.trim() ? Number(valeur) : NaN;
  return Number.isFinite(n) ? n : null;
}

function wktPositions(positions: unknown): string {
  return (positions as number[][]).map((position) => position.slice(0, 2).join(" ")).join(", ");
}

/** Géométrie GeoJSON en WKT (Well-Known Text), lisible par QGIS, PostGIS, Excel + extensions… */
export function enWkt(geometrie: Geometrie): string {
  const c = geometrie.coordinates as unknown;
  switch (geometrie.type) {
    case "Point":
      return `POINT (${(c as number[]).slice(0, 2).join(" ")})`;
    case "MultiPoint":
      return `MULTIPOINT (${(c as number[][]).map((p) => `(${p.slice(0, 2).join(" ")})`).join(", ")})`;
    case "LineString":
      return `LINESTRING (${wktPositions(c)})`;
    case "MultiLineString":
      return `MULTILINESTRING (${(c as number[][][]).map((l) => `(${wktPositions(l)})`).join(", ")})`;
    case "Polygon":
      return `POLYGON (${(c as number[][][]).map((a) => `(${wktPositions(a)})`).join(", ")})`;
    case "MultiPolygon":
      return `MULTIPOLYGON (${(c as number[][][][])
        .map((p) => `(${p.map((a) => `(${wktPositions(a)})`).join(", ")})`)
        .join(", ")})`;
    case "GeometryCollection":
      return `GEOMETRYCOLLECTION (${(geometrie.geometries ?? []).map(enWkt).join(", ")})`;
    default:
      return "";
  }
}

/**
 * Lignes « à plat » pour CSV / XLSX / JSON : la géométrie devient `longitude` / `latitude` pour les points
 * (si la table n'a pas déjà ces colonnes), sinon une colonne `geometry_wkt`.
 */
export function lignesAPlat(table: Table, longueurMaxWkt = Infinity): Ligne[] {
  if (!table.geometries?.some(Boolean)) return table.lignes;
  const dejaCoordonnees = colonnesCoordonnees(colonnesDe(table.lignes)) !== null;
  return table.lignes.map((ligne, indice) => {
    const geometrie = table.geometries?.[indice];
    if (!geometrie) return ligne;
    if (geometrie.type === "Point") {
      if (dejaCoordonnees) return ligne;
      const [longitude, latitude] = geometrie.coordinates as number[];
      return { ...ligne, longitude, latitude };
    }
    const wkt = enWkt(geometrie);
    return { ...ligne, geometry_wkt: wkt.length <= longueurMaxWkt ? wkt : null };
  });
}

function valeurCellule(valeur: unknown): string | number | boolean | null {
  if (valeur === null || valeur === undefined) return null;
  if (typeof valeur === "object") return JSON.stringify(valeur);
  return valeur as string | number | boolean;
}

/**
 * Neutralise l'injection de formules (OWASP « CSV injection ») sans abîmer les numéros de téléphone :
 * tout texte qui commence par `=`, `+`, `-`, `@`, tabulation ou retour chariot est préfixé d'une apostrophe,
 * sauf un nombre ou un téléphone « pur » (chiffres, espaces, points, parenthèses : `+213 21 00 00 00`, `-0.29`).
 */
export function neutraliserFormule(texte: string): string {
  if (!/^[=+\-@\t\r]/.test(texte)) return texte;
  if (/^[+-][\d\s().]+$/.test(texte)) return texte;
  return `'${texte}`;
}

export function enCsv(table: Table): string {
  const lignes = lignesAPlat(table);
  const colonnes = colonnesDe(lignes);
  const echapper = (valeur: unknown): string => {
    const cellule = valeurCellule(valeur);
    if (cellule === null) return "";
    const texte = typeof cellule === "string" ? neutraliserFormule(cellule) : String(cellule);
    return /[",\n\r]/.test(texte) ? `"${texte.replace(/"/g, '""')}"` : texte;
  };
  const corps = [colonnes.map(echapper).join(","), ...lignes.map((ligne) => colonnes.map((c) => echapper(ligne[c])).join(","))];
  // BOM : Excel ouvre alors correctement l'UTF-8 (noms en arabe).
  return `﻿${corps.join("\r\n")}\r\n`;
}

export interface MetadonneesExport {
  titre: string;
  source: string | null;
  licence: string | null;
  urlFiche: string;
}

const LIMITE_CELLULE_EXCEL = 32767;

export function enXlsx(table: Table, metadonnees: MetadonneesExport): Uint8Array {
  const lignes = lignesAPlat(table, LIMITE_CELLULE_EXCEL);
  const colonnes = colonnesDe(lignes);
  const donnees = lignes.map((ligne) =>
    Object.fromEntries(
      colonnes.map((colonne) => {
        const cellule = valeurCellule(ligne[colonne]);
        return [colonne, typeof cellule === "string" ? neutraliserFormule(cellule).slice(0, LIMITE_CELLULE_EXCEL) : cellule];
      })
    )
  );
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, XLSX.utils.json_to_sheet(donnees, { header: colonnes }), "data");
  XLSX.utils.book_append_sheet(
    classeur,
    XLSX.utils.aoa_to_sheet([
      ["Titre", metadonnees.titre],
      ["Source", metadonnees.source ?? ""],
      ["Licence", metadonnees.licence ?? ""],
      ["Fiche", metadonnees.urlFiche],
      ["Lignes", lignes.length],
      ["Exporté par", "data-dz (https://data-dz.com)"],
    ]),
    "about"
  );
  return XLSX.write(classeur, { type: "buffer", bookType: "xlsx", compression: true }) as Uint8Array;
}

export function enJson(table: Table): string {
  return JSON.stringify(lignesAPlat(table));
}

export function enGeoJson(table: Table): string {
  let geometries = table.geometries;
  if (!geometries?.some(Boolean)) {
    const coordonnees = colonnesCoordonnees(colonnesDe(table.lignes));
    if (!coordonnees) {
      throw new ErreurApi(422, "not_geographic", "Ce fichier n'a ni géométrie ni colonnes latitude / longitude : GeoJSON indisponible.");
    }
    geometries = table.lignes.map((ligne) => {
      const lat = nombre(ligne[coordonnees.lat]);
      const lng = nombre(ligne[coordonnees.lng]);
      return lat === null || lng === null ? null : { type: "Point", coordinates: [lng, lat] };
    });
  }
  return JSON.stringify({
    type: "FeatureCollection",
    features: table.lignes.map((ligne, indice) => ({ type: "Feature", geometry: geometries?.[indice] ?? null, properties: ligne })),
  });
}

export function convertir(table: Table, format: FormatSortie, metadonnees: MetadonneesExport): string | Uint8Array {
  switch (format) {
    case "csv":
      return enCsv(table);
    case "xlsx":
      return enXlsx(table, metadonnees);
    case "json":
      return enJson(table);
    case "geojson":
      return enGeoJson(table);
  }
}

/** Type d'une valeur avec le même vocabulaire que les versions synchronisées (`str`, `int`, `float`…). */
function typeValeur(valeur: unknown): string {
  if (valeur === null || valeur === undefined) return "NoneType";
  if (typeof valeur === "boolean") return "bool";
  if (typeof valeur === "number") return Number.isInteger(valeur) ? "int" : "float";
  if (Array.isArray(valeur)) return "list";
  if (typeof valeur === "object") return "dict";
  return "str";
}

/** Colonnes typées et aperçu (3 lignes) d'une table, pour remplir `versions.colonnes` et `versions.apercu`. */
export function decrireTable(table: Table): { colonnes: { nom: string; type: string }[]; apercu: Ligne[]; nbLignes: number } {
  const colonnes = colonnesDe(table.lignes).map((nom) => {
    const premiere = table.lignes.find((ligne) => ligne[nom] !== null && ligne[nom] !== undefined && ligne[nom] !== "");
    return { nom, type: typeValeur(premiere?.[nom]) };
  });
  return { colonnes, apercu: table.lignes.slice(0, 3), nbLignes: table.lignes.length };
}
