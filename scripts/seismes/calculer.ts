/**
 * Catalogue sismique algérien : USGS NEIC/PDE, événements M >= 2,5.
 * Seuls catalog=us et contributor=us sont demandés à ComCat.
 * Les épicentres sont testés contre les 69 contours GeoAlgeria.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Papa from "papaparse";
import { ClientApi } from "../osm/api.js";

const DOSSIER = import.meta.dirname;
const URL_USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const URL_API = (process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, "");
const USER_AGENT = "data-dz-seismes/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const SLUG_CONTOURS = "divisions-administratives";
const FICHIER_CONTOURS = "wilaya-boundaries";
const FICHIER_NOMS = "wilayas";
const PREMIERE_DATE = "1973-01-01T00:00:00.000Z";
const MAGNITUDE_MINIMALE = 2.5;
const LIMITE_API = 20_000;

type Position = [number, number] | [number, number, number];
type Anneau = Position[];
type Polygone = Anneau[];
type GeometrieWilaya =
  | { type: "Polygon"; coordinates: Polygone }
  | { type: "MultiPolygon"; coordinates: Polygone[] };

interface FeatureWilaya {
  type: "Feature";
  properties: { code: number | string };
  geometry: GeometrieWilaya;
}
interface Wilaya {
  code: number;
  nom_fr: string;
  nom_ar: string;
  geometrie: GeometrieWilaya;
  limites: { ouest: number; sud: number; est: number; nord: number };
}
interface Nomenclature {
  wilayas?: { code: number | string; name_fr: string; name_ar: string }[];
}
interface ProprietesUSGS {
  time?: number | null;
  mag?: number | null;
  place?: string | null;
  magType?: string | null;
  net?: string | null;
  sig?: number | null;
  felt?: number | null;
  cdi?: number | null;
  mmi?: number | null;
  alert?: string | null;
  tsunami?: number | null;
  url?: string | null;
  status?: string | null;
  updated?: number | null;
}
interface FeatureUSGS {
  type: "Feature";
  id?: string;
  properties?: ProprietesUSGS;
  geometry?: { type: "Point"; coordinates: number[] } | null;
}
interface CollectionUSGS {
  type?: string;
  metadata?: { count?: number };
  features?: FeatureUSGS[];
}
interface SeismeUSGS {
  id_seisme: string;
  date_utc: string;
  annee: number;
  latitude: number;
  longitude: number;
  profondeur_km: number | null;
  magnitude: number;
  type_magnitude: string | null;
  lieu: string | null;
  reseau: string | null;
  significativite: number | null;
  ressenti_nb: number | null;
  intensite_cdi: number | null;
  intensite_mmi: number | null;
  alerte: string | null;
  tsunami: boolean;
  statut: string | null;
  mis_a_jour_utc: string | null;
  url_usgs: string;
}
interface SeismeEnrichi extends SeismeUSGS {
  code_wilaya: string;
  wilaya: string;
  wilaya_ar: string;
}
interface SerieAnnuelle {
  annee: number;
  valeur: number;
  unite: string;
}
interface SerieWilaya extends SerieAnnuelle {
  code_wilaya: string;
  wilaya: string;
  wilaya_ar: string;
}
interface Options {
  cache: string;
  sortie: string;
  sans_cache: boolean;
}

function option(nom: string, defaut: string): string {
  const index = process.argv.indexOf(nom);
  return index >= 0 ? process.argv[index + 1] || defaut : defaut;
}
function options(): Options {
  return {
    cache: option("--cache", join(DOSSIER, "cache")),
    sortie: option("--sortie", join(DOSSIER, "sortie")),
    sans_cache: process.argv.includes("--sans-cache"),
  };
}
function iso(date: Date): string {
  return date.toISOString();
}
function nombre(valeur: unknown): number | null {
  return typeof valeur === "number" && Number.isFinite(valeur) ? valeur : null;
}
function texte(valeur: unknown): string | null {
  return typeof valeur === "string" && valeur.trim() ? valeur.trim() : null;
}
function anneaux(geometrie: GeometrieWilaya): Polygone[] {
  return geometrie.type === "Polygon" ? [geometrie.coordinates] : geometrie.coordinates;
}
function pointsGeometrie(geometrie: GeometrieWilaya): Position[] {
  return anneaux(geometrie).flat(2);
}
function limitesGeometrie(geometrie: GeometrieWilaya): Wilaya["limites"] {
  const points = pointsGeometrie(geometrie);
  if (!points.length) throw new Error("Un contour de wilaya ne contient aucun sommet.");
  return {
    ouest: Math.min(...points.map((point) => point[0])),
    sud: Math.min(...points.map((point) => point[1])),
    est: Math.max(...points.map((point) => point[0])),
    nord: Math.max(...points.map((point) => point[1])),
  };
}
function dansAnneau(longitude: number, latitude: number, anneau: Anneau): boolean {
  let dedans = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const [xi, yi] = anneau[i];
    const [xj, yj] = anneau[j];
    const produit = (longitude - xi) * (yj - yi) - (latitude - yi) * (xj - xi);
    const surSegment =
      Math.abs(produit) < 1e-10 &&
      longitude >= Math.min(xi, xj) - 1e-10 &&
      longitude <= Math.max(xi, xj) + 1e-10 &&
      latitude >= Math.min(yi, yj) - 1e-10 &&
      latitude <= Math.max(yi, yj) + 1e-10;
    if (surSegment) return true;
    const coupe = (yi > latitude) !== (yj > latitude);
    if (coupe && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}
function dansGeometrie(longitude: number, latitude: number, geometrie: GeometrieWilaya): boolean {
  for (const polygone of anneaux(geometrie)) {
    if (!polygone[0] || !dansAnneau(longitude, latitude, polygone[0])) continue;
    if (polygone.slice(1).some((trou) => dansAnneau(longitude, latitude, trou))) continue;
    return true;
  }
  return false;
}
function trouverWilaya(longitude: number, latitude: number, wilayas: Wilaya[]): Wilaya | null {
  for (const wilaya of wilayas) {
    const boite = wilaya.limites;
    if (longitude < boite.ouest || longitude > boite.est || latitude < boite.sud || latitude > boite.nord) continue;
    if (dansGeometrie(longitude, latitude, wilaya.geometrie)) return wilaya;
  }
  return null;
}

async function chargerWilayas(): Promise<Wilaya[]> {
  const api = new ClientApi(URL_API, null);
  const [texteContours, texteNoms] = await Promise.all([
    api.lireFichier(SLUG_CONTOURS, FICHIER_CONTOURS, "geojson"),
    api.lireFichier(SLUG_CONTOURS, FICHIER_NOMS, "json"),
  ]);
  if (!texteContours || !texteNoms) throw new Error("Impossible de lire les contours et la nomenclature des wilayas sur data-dz.");
  const collection = JSON.parse(texteContours) as { type?: string; features?: FeatureWilaya[] };
  const nomenclature = JSON.parse(texteNoms) as Nomenclature;
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features) || !Array.isArray(nomenclature.wilayas)) {
    throw new Error("Les fichiers GeoAlgeria reçus ne respectent pas le format attendu.");
  }
  const noms = new Map<number, { name_fr: string; name_ar: string }>();
  for (const ligne of nomenclature.wilayas) {
    const code = Number(ligne.code);
    if (!Number.isInteger(code) || noms.has(code) || !ligne.name_fr || !ligne.name_ar) {
      throw new Error("Code ou nom de wilaya invalide dans la nomenclature.");
    }
    noms.set(code, { name_fr: ligne.name_fr, name_ar: ligne.name_ar });
  }
  const wilayas = collection.features.map((feature) => {
    const code = Number(feature.properties?.code);
    const nom = noms.get(code);
    if (!Number.isInteger(code) || !nom || !feature.geometry) throw new Error("Contour ou nom absent pour une wilaya.");
    return {
      code,
      nom_fr: nom.name_fr,
      nom_ar: nom.name_ar,
      geometrie: feature.geometry,
      limites: limitesGeometrie(feature.geometry),
    };
  });
  const codes = [...new Set(wilayas.map((wilaya) => wilaya.code))].sort((a, b) => a - b);
  if (wilayas.length !== 69 || codes.length !== 69 || codes.some((code, index) => code !== index + 1) || noms.size !== 69) {
    throw new Error("Le référentiel doit contenir exactement les 69 wilayas, codes 01 à 69.");
  }
  return wilayas;
}
function boiteAlgerie(wilayas: Wilaya[]) {
  return {
    minlongitude: Math.min(...wilayas.map((wilaya) => wilaya.limites.ouest)),
    minlatitude: Math.min(...wilayas.map((wilaya) => wilaya.limites.sud)),
    maxlongitude: Math.max(...wilayas.map((wilaya) => wilaya.limites.est)),
    maxlatitude: Math.max(...wilayas.map((wilaya) => wilaya.limites.nord)),
  };
}
function urlRequete(debut: string, fin: string, boite: ReturnType<typeof boiteAlgerie>): string {
  const parametres = new URLSearchParams({
    format: "geojson",
    starttime: debut,
    endtime: fin,
    minmagnitude: String(MAGNITUDE_MINIMALE),
    minlatitude: boite.minlatitude.toFixed(5),
    maxlatitude: boite.maxlatitude.toFixed(5),
    minlongitude: boite.minlongitude.toFixed(5),
    maxlongitude: boite.maxlongitude.toFixed(5),
    catalog: "us",
    contributor: "us",
    orderby: "time-asc",
    limit: String(LIMITE_API),
  });
  return URL_USGS + "?" + parametres.toString();
}
async function lireCacheOuTelecharger(url: string, cache: string, sansCache: boolean): Promise<CollectionUSGS> {
  const nom = createHash("sha256").update(url).digest("hex").slice(0, 32) + ".geojson";
  const chemin = join(cache, nom);
  if (!sansCache) {
    try {
      return JSON.parse(await readFile(chemin, "utf8")) as CollectionUSGS;
    } catch {
      // Cache absent ou illisible : téléchargement.
    }
  }
  let reponseTexte: string | null = null;
  for (let tentative = 0; tentative < 5; tentative++) {
    const reponse = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/geo+json,application/json" },
      signal: AbortSignal.timeout(120_000),
    });
    if (reponse.ok) {
      reponseTexte = await reponse.text();
      break;
    }
    if (reponse.status !== 429 && reponse.status < 500) {
      const detail = (await reponse.text()).slice(0, 500);
      throw new Error("USGS FDSN répond HTTP " + reponse.status + " : " + detail);
    }
    const pause = Number(reponse.headers.get("retry-after")) || 2 ** tentative * 3;
    console.warn("USGS FDSN HTTP " + reponse.status + " ; nouvelle tentative dans " + pause + " s.");
    await new Promise((resoudre) => setTimeout(resoudre, Math.min(pause, 60) * 1000));
  }
  if (reponseTexte === null) throw new Error("USGS FDSN reste indisponible après cinq tentatives.");
  let resultat: CollectionUSGS;
  try {
    resultat = JSON.parse(reponseTexte) as CollectionUSGS;
  } catch {
    throw new Error("USGS FDSN a renvoyé une réponse qui n'est pas un GeoJSON valide.");
  }
  if (resultat.type !== "FeatureCollection" || !Array.isArray(resultat.features)) {
    throw new Error("La réponse USGS ne contient pas de FeatureCollection GeoJSON.");
  }
  const temporaire = chemin + ".part";
  await writeFile(temporaire, reponseTexte, "utf8");
  await rename(temporaire, chemin);
  return resultat;
}

/** Découpe automatiquement les périodes qui atteignent la limite FDSN, sans troncature silencieuse. */
async function collecterPeriode(
  debut: string,
  fin: string,
  boite: ReturnType<typeof boiteAlgerie>,
  cache: string,
  sansCache: boolean,
  profondeur = 0
): Promise<FeatureUSGS[]> {
  if (profondeur > 32) throw new Error("Découpage temporel USGS trop profond : vérifier la limite de résultats.");
  const resultat = await lireCacheOuTelecharger(urlRequete(debut, fin, boite), cache, sansCache);
  const evenements = resultat.features ?? [];
  if (evenements.length < LIMITE_API) return evenements;
  const debutMs = Date.parse(debut);
  const finMs = Date.parse(fin);
  if (!Number.isFinite(debutMs) || !Number.isFinite(finMs) || finMs - debutMs <= 1000) {
    throw new Error("Une période atteint encore la limite de 20 000 séismes après découpage.");
  }
  const milieu = Math.floor((debutMs + finMs) / 2);
  const finGauche = iso(new Date(milieu - 1));
  const debutDroite = iso(new Date(milieu));
  console.log("Limite USGS atteinte : découpage de " + debut + " → " + fin + ".");
  const [gauche, droite] = await Promise.all([
    collecterPeriode(debut, finGauche, boite, cache, sansCache, profondeur + 1),
    collecterPeriode(debutDroite, fin, boite, cache, sansCache, profondeur + 1),
  ]);
  return [...gauche, ...droite];
}

function convertirFeature(feature: FeatureUSGS): SeismeUSGS {
  const proprietes = feature.properties ?? {};
  const coordonnees = feature.geometry?.coordinates;
  if (!feature.id || !Array.isArray(coordonnees) || coordonnees.length < 2) {
    throw new Error("Un événement USGS ne possède pas d'identifiant ou de coordonnées.");
  }
  const longitude = Number(coordonnees[0]);
  const latitude = Number(coordonnees[1]);
  const profondeur = coordonnees.length >= 3 ? nombre(coordonnees[2]) : null;
  const magnitude = nombre(proprietes.mag);
  const temps = nombre(proprietes.time);
  if (
    !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
    Math.abs(longitude) > 180 || Math.abs(latitude) > 90 ||
    magnitude === null || magnitude < MAGNITUDE_MINIMALE || temps === null
  ) {
    throw new Error("Événement USGS invalide : coordonnées, date ou magnitude manquante.");
  }
  const date = new Date(temps);
  if (!Number.isFinite(date.getTime())) throw new Error("Date d'événement USGS invalide.");
  const maj = nombre(proprietes.updated);
  return {
    id_seisme: feature.id,
    date_utc: iso(date),
    annee: date.getUTCFullYear(),
    latitude,
    longitude,
    profondeur_km: profondeur,
    magnitude,
    type_magnitude: texte(proprietes.magType),
    lieu: texte(proprietes.place),
    reseau: texte(proprietes.net),
    significativite: nombre(proprietes.sig),
    ressenti_nb: nombre(proprietes.felt),
    intensite_cdi: nombre(proprietes.cdi),
    intensite_mmi: nombre(proprietes.mmi),
    alerte: texte(proprietes.alert),
    tsunami: proprietes.tsunami === 1,
    statut: texte(proprietes.status),
    mis_a_jour_utc: maj === null ? null : iso(new Date(maj)),
    url_usgs: texte(proprietes.url) || "https://earthquake.usgs.gov/earthquakes/eventpage/" + feature.id,
  };
}
async function ecrireAtomiquement(chemin: string, contenu: string): Promise<void> {
  const temporaire = chemin + ".part";
  await writeFile(temporaire, contenu, "utf8");
  await rename(temporaire, chemin);
}
function csv<T extends Record<string, unknown>>(lignes: T[]): string {
  return Papa.unparse(lignes, { newline: "\n" }) + "\n";
}

async function main(): Promise<void> {
  const config = options();
  await mkdir(config.cache, { recursive: true });
  await mkdir(config.sortie, { recursive: true });

  const wilayas = await chargerWilayas();
  const boite = boiteAlgerie(wilayas);
  const finDate = new Date();
  const fin = iso(finDate);
  const debut = PREMIERE_DATE;
  console.log("USGS NEIC/PDE : " + debut + " → " + fin + ", magnitude ≥ " + MAGNITUDE_MINIMALE + ".");
  console.log("Catalogue us, contributeur us ; emprise construite depuis les 69 wilayas.");

  const features = await collecterPeriode(debut, fin, boite, config.cache, config.sans_cache);
  const uniques = new Map<string, FeatureUSGS>();
  for (const feature of features) {
    const id = feature.id;
    if (!id) throw new Error("Un événement USGS ne possède pas d'identifiant stable.");
    const existant = uniques.get(id);
    const maj = nombre(feature.properties?.updated) ?? 0;
    const majExistante = nombre(existant?.properties?.updated) ?? 0;
    if (!existant || maj > majExistante) uniques.set(id, feature);
  }

  const bruts: SeismeUSGS[] = [];
  const enrichis: SeismeEnrichi[] = [];
  let horsWilayas = 0;
  for (const feature of uniques.values()) {
    const seisme = convertirFeature(feature);
    const wilaya = trouverWilaya(seisme.longitude, seisme.latitude, wilayas);
    if (!wilaya) {
      horsWilayas++;
      continue;
    }
    bruts.push(seisme);
    enrichis.push({
      ...seisme,
      code_wilaya: String(wilaya.code).padStart(2, "0"),
      wilaya: wilaya.nom_fr,
      wilaya_ar: wilaya.nom_ar,
    });
  }
  enrichis.sort((a, b) => a.date_utc.localeCompare(b.date_utc) || a.id_seisme.localeCompare(b.id_seisme));
  bruts.sort((a, b) => a.date_utc.localeCompare(b.date_utc) || a.id_seisme.localeCompare(b.id_seisme));

  const anneeFin = finDate.getUTCFullYear();
  const annees = Array.from({ length: anneeFin - 1973 + 1 }, (_, index) => 1973 + index);
  const comptesNationaux = new Map(annees.map((annee) => [annee, 0]));
  const comptesWilayas = new Map<string, number>();
  for (const annee of annees) {
    for (const wilaya of wilayas) comptesWilayas.set(String(wilaya.code).padStart(2, "0") + "|" + annee, 0);
  }
  for (const seisme of enrichis) {
    comptesNationaux.set(seisme.annee, (comptesNationaux.get(seisme.annee) ?? 0) + 1);
    const cle = seisme.code_wilaya + "|" + seisme.annee;
    comptesWilayas.set(cle, (comptesWilayas.get(cle) ?? 0) + 1);
  }

  const unite = "séismes de magnitude ≥ 2,5";
  const annuels: SerieAnnuelle[] = annees.map((annee) => ({
    annee,
    valeur: comptesNationaux.get(annee) ?? 0,
    unite,
  }));
  const wilayasAnnuelles: SerieWilaya[] = [];
  for (const annee of annees) {
    for (const wilaya of wilayas) {
      const code = String(wilaya.code).padStart(2, "0");
      wilayasAnnuelles.push({
        code_wilaya: code,
        wilaya: wilaya.nom_fr,
        wilaya_ar: wilaya.nom_ar,
        annee,
        valeur: comptesWilayas.get(code + "|" + annee) ?? 0,
        unite,
      });
    }
  }

  if (bruts.length !== enrichis.length || enrichis.length !== annuels.reduce((somme, ligne) => somme + ligne.valeur, 0)) {
    throw new Error("Les totaux des événements et de la série annuelle ne concordent pas.");
  }
  if (wilayasAnnuelles.length !== annees.length * 69 || wilayasAnnuelles.some((ligne) => !Number.isInteger(ligne.valeur) || ligne.valeur < 0)) {
    throw new Error("La série par wilaya doit contenir 69 valeurs par année, sans compte négatif.");
  }

  const geojson = {
    type: "FeatureCollection",
    name: "seismes-algerie",
    features: enrichis.map((seisme) => ({
      type: "Feature",
      id: seisme.id_seisme,
      geometry: {
        type: "Point",
        coordinates: seisme.profondeur_km === null
          ? [seisme.longitude, seisme.latitude]
          : [seisme.longitude, seisme.latitude, seisme.profondeur_km],
      },
      properties: seisme,
    })),
  };

  const magnitudes = enrichis.map((ligne) => ligne.magnitude);
  const dates = enrichis.map((ligne) => ligne.date_utc);
  const rapport = {
    source: "USGS NEIC/PDE via FDSN Event Web Service",
    requete: {
      catalogue: "us",
      contributeur: "us",
      magnitude_minimale: MAGNITUDE_MINIMALE,
      debut_utc: debut,
      fin_utc: fin,
      emprise: boite,
      filtre_spatial: "point dans les 69 polygones GeoAlgeria",
      limite_par_requete: LIMITE_API,
    },
    nb_evenements_recus_emprise: uniques.size,
    nb_evenements_hors_wilayas: horsWilayas,
    nb_seismes_algerie: enrichis.length,
    nb_wilayas: 69,
    premiere_date_observee_utc: dates[0] ?? null,
    derniere_date_observee_utc: dates.at(-1) ?? null,
    premiere_annee_observee: enrichis.length ? enrichis[0].annee : null,
    derniere_annee_observee: enrichis.length ? enrichis.at(-1)!.annee : null,
    magnitude_minimale_observee: magnitudes.length ? Math.min(...magnitudes) : null,
    magnitude_maximale_observee: magnitudes.length ? Math.max(...magnitudes) : null,
    nb_lignes_par_fichier: {
      "seismes-usgs": bruts.length,
      "seismes-annuels": annuels.length,
      "seismes-algerie": enrichis.length,
      "seismes-wilayas": wilayasAnnuelles.length,
    },
    seismes_par_annee: annuels.map(({ annee, valeur }) => ({ annee, valeur })),
    seismes_par_wilaya: wilayas.map((wilaya) => ({
      code_wilaya: String(wilaya.code).padStart(2, "0"),
      wilaya: wilaya.nom_fr,
      total: enrichis.filter((ligne) => ligne.code_wilaya === String(wilaya.code).padStart(2, "0")).length,
    })),
    precision: {
      annee_courante_incomplete: true,
      magnitude_minimale: MAGNITUDE_MINIMALE,
      limites: "Catalogue NEIC/PDE uniquement ; événements sous le seuil et événements hors des 69 contours exclus.",
    },
  };

  await Promise.all([
    ecrireAtomiquement(join(config.sortie, "seismes-usgs.json"), JSON.stringify(bruts, null, 2) + "\n"),
    ecrireAtomiquement(join(config.sortie, "seismes-usgs.csv"), csv(bruts)),
    ecrireAtomiquement(join(config.sortie, "seismes-annuels.json"), JSON.stringify(annuels, null, 2) + "\n"),
    ecrireAtomiquement(join(config.sortie, "seismes-annuels.csv"), csv(annuels)),
    ecrireAtomiquement(join(config.sortie, "seismes-algerie.json"), JSON.stringify(enrichis, null, 2) + "\n"),
    ecrireAtomiquement(join(config.sortie, "seismes-algerie.csv"), csv(enrichis)),
    ecrireAtomiquement(join(config.sortie, "seismes-algerie.geojson"), JSON.stringify(geojson, null, 2) + "\n"),
    ecrireAtomiquement(join(config.sortie, "seismes-wilayas.json"), JSON.stringify(wilayasAnnuelles, null, 2) + "\n"),
    ecrireAtomiquement(join(config.sortie, "seismes-wilayas.csv"), csv(wilayasAnnuelles)),
    ecrireAtomiquement(join(config.sortie, "rapport.json"), JSON.stringify(rapport, null, 2) + "\n"),
  ]);

  console.log(enrichis.length + " séismes retenus dans les 69 wilayas ; " + horsWilayas + " événements de l'emprise hors wilayas.");
  console.log(wilayasAnnuelles.length + " lignes dans la série par wilaya (" + annees.length + " années × 69).");
  console.log("Sorties écrites dans " + config.sortie + ".");
}

main().catch((erreur: unknown) => {
  console.error(erreur instanceof Error ? erreur.message : erreur);
  process.exitCode = 1;
});
