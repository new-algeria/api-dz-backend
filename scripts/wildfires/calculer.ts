/**
 * Détections de points chauds NASA FIRMS sur l'Algérie (fenêtre glissante de 7 jours).
 *
 * Prérequis : FIRMS_MAP_KEY (clé gratuite NASA FIRMS).
 * Sorties : JSON/CSV NASA filtrés sur les 69 wilayas, JSON/CSV enrichis, GeoJSON et rapport.
 *
 *   npx tsx scripts/wildfires/calculer.ts
 *   npx tsx scripts/wildfires/calculer.ts --cache "$RUNNER_TEMP/wildfires/cache" --sortie "$RUNNER_TEMP/wildfires/sortie"
 *   npx tsx scripts/wildfires/calculer.ts --sans-cache
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Papa from "papaparse";
import { ClientApi } from "../osm/api.js";

const DOSSIER = import.meta.dirname;
const URL_FIRMS = "https://firms.modaps.eosdis.nasa.gov/api";
const URL_API = (process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, "");
const USER_AGENT = "data-dz-wildfires/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const SLUG_CONTOURS = "divisions-administratives";
const FICHIER_CONTOURS = "wilaya-boundaries";
const FICHIER_NOMS = "wilayas";
const JOURS_FENETRE = 7;
const PRODUITS = [
  { code: "MODIS_NRT", instrument: "MODIS" },
  { code: "VIIRS_SNPP_NRT", instrument: "VIIRS" },
  { code: "VIIRS_NOAA20_NRT", instrument: "VIIRS" },
  { code: "VIIRS_NOAA21_NRT", instrument: "VIIRS" },
] as const;

type Position = [number, number] | [number, number, number];
type Anneau = Position[];
type Polygone = Anneau[];
type Geometrie =
  | { type: "Polygon"; coordinates: Polygone }
  | { type: "MultiPolygon"; coordinates: Polygone[] };

interface FeatureWilaya {
  type: "Feature";
  properties: { code: number | string };
  geometry: Geometrie;
}

interface Wilaya {
  code: number;
  nomFr: string;
  nomAr: string;
  geometrie: Geometrie;
  limites: { ouest: number; sud: number; est: number; nord: number };
}

interface LigneBrute extends Record<string, string> {
  produit_firms: string;
}

interface LigneEnrichie {
  id_detection: string;
  date_utc: string;
  latitude: number;
  longitude: number;
  code_wilaya: string;
  wilaya: string;
  wilaya_ar: string;
  instrument: "MODIS" | "VIIRS";
  satellite: string | null;
  produit_firms: string;
  version_produit: string | null;
  confiance_viirs: string | null;
  confiance_modis: number | null;
  frp_mw: number | null;
  scan: number | null;
  track: number | null;
  bright_ti4_k: number | null;
  bright_ti5_k: number | null;
  brightness_modis_k: number | null;
  bright_t31_modis_k: number | null;
  jour_nuit: string | null;
}

interface Options {
  cache: string;
  sortie: string;
  sansCache: boolean;
}

function valeurOption(nom: string, defaut: string): string {
  const index = process.argv.indexOf(nom);
  return index >= 0 ? process.argv[index + 1] || defaut : defaut;
}

function options(): Options {
  return {
    cache: valeurOption("--cache", join(DOSSIER, "cache")),
    sortie: valeurOption("--sortie", join(DOSSIER, "sortie")),
    sansCache: process.argv.includes("--sans-cache"),
  };
}

function dateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function ajouterJours(date: string, jours: number): string {
  const [annee, mois, jour] = date.split("-").map(Number);
  return dateUTC(new Date(Date.UTC(annee, mois - 1, jour + jours)));
}

function nombre(valeur: string | null | undefined): number | null {
  if (valeur === undefined || valeur === null || valeur.trim() === "") return null;
  const resultat = Number(valeur);
  return Number.isFinite(resultat) ? resultat : null;
}

function parseCSV(texte: string, champsRequis: string[], contexte: string): Record<string, string>[] {
  if (!texte.trim()) return [];
  if (/^\s*(?:ERROR|Exception|Invalid MAP_KEY|Unauthorized)\b/i.test(texte)) {
    throw new Error(contexte + " : " + texte.trim().slice(0, 300));
  }
  const resultat = Papa.parse<Record<string, string>>(texte.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (champ) => champ.trim(),
  });
  if (resultat.errors.length > 0) {
    throw new Error(contexte + " : CSV invalide (" + resultat.errors[0].message + ").");
  }
  const champs = resultat.meta.fields ?? [];
  const manquants = champsRequis.filter((champ) => !champs.includes(champ));
  if (manquants.length > 0) {
    throw new Error(contexte + " : colonnes absentes : " + manquants.join(", ") + ".");
  }
  return resultat.data;
}

async function requeteNASA(url: string, contexte: string): Promise<string> {
  for (let tentative = 0; tentative < 5; tentative++) {
    const reponse = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/csv,text/plain;q=0.9,*/*;q=0.8" },
      signal: AbortSignal.timeout(120_000),
    });
    if (reponse.ok) {
      const texte = await reponse.text();
      if (/^\s*(?:ERROR|Exception|Invalid MAP_KEY|Unauthorized)\b/i.test(texte)) {
        throw new Error(contexte + " : " + texte.trim().slice(0, 300));
      }
      return texte;
    }
    if (reponse.status !== 429 && reponse.status < 500) {
      throw new Error(contexte + " : NASA FIRMS répond HTTP " + reponse.status + ".");
    }
    const secondes = Number(reponse.headers.get("retry-after")) || (2 ** tentative) * 3;
    console.warn(contexte + " : HTTP " + reponse.status + ", nouvelle tentative dans " + secondes + " s.");
    await new Promise((resoudre) => setTimeout(resoudre, Math.min(secondes, 60) * 1000));
  }
  throw new Error(contexte + " : échec après 5 tentatives.");
}

async function telechargerAvecCache(url: string, chemin: string, sansCache: boolean, contexte: string): Promise<string> {
  if (!sansCache) {
    try {
      return await readFile(chemin, "utf8");
    } catch {
      // Première lecture : le fichier sera téléchargé puis mis en cache.
    }
  }
  await mkdir(join(chemin, ".."), { recursive: true });
  const texte = await requeteNASA(url, contexte);
  const temporaire = chemin + ".part";
  await writeFile(temporaire, texte, "utf8");
  await rename(temporaire, chemin);
  return texte;
}

function polygones(geometrie: Geometrie): Polygone[] {
  return geometrie.type === "Polygon" ? [geometrie.coordinates] : geometrie.coordinates;
}

function pointsGeometrie(geometrie: Geometrie): Position[] {
  return polygones(geometrie).flat(2);
}

function limitesGeometrie(geometrie: Geometrie): Wilaya["limites"] {
  const points = pointsGeometrie(geometrie);
  if (points.length === 0) throw new Error("Un contour de wilaya ne contient aucun point.");
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

function dansGeometrie(longitude: number, latitude: number, geometrie: Geometrie): boolean {
  for (const polygone of polygones(geometrie)) {
    if (!polygone[0] || !dansAnneau(longitude, latitude, polygone[0])) continue;
    // Les anneaux suivants sont des trous : leurs points ne font pas partie de la wilaya.
    if (polygone.slice(1).some((trou) => dansAnneau(longitude, latitude, trou))) continue;
    return true;
  }
  return false;
}

function trouverWilaya(longitude: number, latitude: number, wilayas: Wilaya[]): Wilaya | null {
  for (const wilaya of wilayas) {
    const b = wilaya.limites;
    if (longitude < b.ouest || longitude > b.est || latitude < b.sud || latitude > b.nord) continue;
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
  if (!texteContours || !texteNoms) throw new Error("Impossible de lire les contours et les noms des 69 wilayas sur data-dz.");
  const collection = JSON.parse(texteContours) as { type?: string; features?: FeatureWilaya[] };
  const nomenclature = JSON.parse(texteNoms) as { wilayas?: { code: number | string; name_fr: string; name_ar: string }[] };
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features) || !Array.isArray(nomenclature.wilayas)) {
    throw new Error("Les fichiers GeoAlgeria reçus ne respectent pas le format attendu.");
  }
  const noms = new Map(nomenclature.wilayas.map((wilaya) => [Number(wilaya.code), wilaya]));
  const wilayas = collection.features.map((feature) => {
    const code = Number(feature.properties?.code);
    const nom = noms.get(code);
    if (!Number.isInteger(code) || !nom || !nom.name_fr || !nom.name_ar) {
      throw new Error("Code ou nom manquant pour un contour GeoAlgeria.");
    }
    return { code, nomFr: nom.name_fr, nomAr: nom.name_ar, geometrie: feature.geometry, limites: limitesGeometrie(feature.geometry) };
  });
  const codes = [...new Set(wilayas.map((wilaya) => wilaya.code))].sort((a, b) => a - b);
  if (wilayas.length !== 69 || codes.length !== 69 || codes.some((code, index) => code !== index + 1) || noms.size !== 69) {
    throw new Error("Le référentiel doit contenir exactement les 69 wilayas (codes 01 à 69).");
  }
  return wilayas;
}

function boiteAlgerie(wilayas: Wilaya[]): string {
  const west = Math.min(...wilayas.map((wilaya) => wilaya.limites.ouest));
  const south = Math.min(...wilayas.map((wilaya) => wilaya.limites.sud));
  const east = Math.max(...wilayas.map((wilaya) => wilaya.limites.est));
  const north = Math.max(...wilayas.map((wilaya) => wilaya.limites.nord));
  return [west, south, east, north].map((valeur) => valeur.toFixed(6)).join(",");
}

function dateObservation(ligne: Record<string, string>): string {
  const date = ligne.acq_date?.trim();
  const heure = ligne.acq_time?.trim();
  if (!date || !heure) throw new Error("Détection NASA sans acq_date ou acq_time.");
  const hhmm = heure.padStart(4, "0");
  if (!/^\d{4}$/.test(hhmm) || Number(hhmm.slice(0, 2)) > 23 || Number(hhmm.slice(2, 4)) > 59) {
    throw new Error("Heure d'acquisition NASA invalide : " + heure + ".");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date d'acquisition NASA invalide : " + date + ".");
  return date + "T" + hhmm.slice(0, 2) + ":" + hhmm.slice(2, 4) + ":00Z";
}

function convertirLigne(
  ligne: Record<string, string>,
  produit: (typeof PRODUITS)[number],
  wilaya: Wilaya,
  latitude: number,
  longitude: number
): LigneEnrichie {
  const date = dateObservation(ligne);
  const cle = [
    produit.code,
    date,
    latitude.toFixed(5),
    longitude.toFixed(5),
    ligne.scan ?? "",
    ligne.track ?? "",
  ].join("|");
  const confiance = ligne.confidence?.trim() || null;
  return {
    id_detection: createHash("sha256").update(cle).digest("hex"),
    date_utc: date,
    latitude,
    longitude,
    code_wilaya: String(wilaya.code).padStart(2, "0"),
    wilaya: wilaya.nomFr,
    wilaya_ar: wilaya.nomAr,
    instrument: produit.instrument,
    satellite: ligne.satellite?.trim() || null,
    produit_firms: produit.code,
    version_produit: ligne.version?.trim() || null,
    confiance_viirs: produit.instrument === "VIIRS" ? confiance : null,
    confiance_modis: produit.instrument === "MODIS" ? nombre(confiance) : null,
    frp_mw: nombre(ligne.frp),
    scan: nombre(ligne.scan),
    track: nombre(ligne.track),
    bright_ti4_k: nombre(ligne.bright_ti4),
    bright_ti5_k: nombre(ligne.bright_ti5),
    brightness_modis_k: nombre(ligne.brightness),
    bright_t31_modis_k: nombre(ligne.bright_t31),
    jour_nuit: ligne.daynight?.trim() || null,
  };
}

async function main(): Promise<void> {
  const configuration = options();
  const mapKey = process.env.FIRMS_MAP_KEY?.trim();
  if (!mapKey) throw new Error("FIRMS_MAP_KEY est obligatoire. Crée une MAP_KEY gratuite dans NASA FIRMS et fournis-la comme secret d'environnement.");
  await mkdir(configuration.cache, { recursive: true });
  await mkdir(configuration.sortie, { recursive: true });

  const wilayas = await chargerWilayas();
  const boite = boiteAlgerie(wilayas);
  const fin = dateUTC(new Date());
  const debut = ajouterJours(fin, -(JOURS_FENETRE - 1));
  const disponibiliteTexte = await requeteNASA(URL_FIRMS + "/data_availability/csv/" + encodeURIComponent(mapKey) + "/ALL", "Disponibilité des produits FIRMS");
  const disponibilites = parseCSV(disponibiliteTexte, ["data_id", "min_date", "max_date"], "Disponibilité FIRMS");
  const parProduit = new Map(disponibilites.map((ligne) => [ligne.data_id, ligne]));
  const lignesBrutes: LigneBrute[] = [];
  const lignesEnrichies: LigneEnrichie[] = [];
  const bilansProduits: Record<string, unknown>[] = [];
  let horsWilayas = 0;

  console.log("Fenêtre UTC : " + debut + " → " + fin + " ; emprise issue des 69 contours GeoAlgeria.");
  for (const produit of PRODUITS) {
    const statut = parProduit.get(produit.code);
    if (!statut || !statut.max_date || statut.max_date < debut || statut.min_date > fin) {
      bilansProduits.push({
        produit: produit.code,
        statut: "indisponible_sur_la_fenetre",
        derniere_date_disponible: statut?.max_date || null,
        detections_nasa: 0,
        detections_algerie: 0,
      });
      console.log(produit.code + " : données récentes indisponibles, ignoré.");
      continue;
    }

    const dates = [
      { jours: 5, debut: debut },
      { jours: 2, debut: ajouterJours(debut, 5) },
    ];
    const toutesLesLignes: Record<string, string>[] = [];
    for (const tranche of dates) {
      const nomCache = produit.code.toLowerCase() + "-" + tranche.debut + "-" + tranche.jours + ".csv";
      const cheminCache = join(configuration.cache, nomCache);
      const url =
        URL_FIRMS +
        "/area/csv/" +
        encodeURIComponent(mapKey) +
        "/" +
        produit.code +
        "/" +
        boite +
        "/" +
        tranche.jours +
        "/" +
        tranche.debut;
      const csv = await telechargerAvecCache(
        url,
        cheminCache,
        configuration.sansCache,
        produit.code + " " + tranche.debut + " (" + tranche.jours + " jours)"
      );
      toutesLesLignes.push(...parseCSV(csv, ["latitude", "longitude", "acq_date", "acq_time"], produit.code));
    }

    let algerie = 0;
    for (const ligne of toutesLesLignes) {
      const latitude = nombre(ligne.latitude);
      const longitude = nombre(ligne.longitude);
      if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        throw new Error(produit.code + " : coordonnées invalides dans la réponse NASA.");
      }
      dateObservation(ligne);
      const wilaya = trouverWilaya(longitude, latitude, wilayas);
      if (!wilaya) {
        horsWilayas++;
        continue;
      }
      const brute: LigneBrute = { ...ligne, produit_firms: produit.code };
      lignesBrutes.push(brute);
      lignesEnrichies.push(convertirLigne(ligne, produit, wilaya, latitude, longitude));
      algerie++;
    }
    bilansProduits.push({
      produit: produit.code,
      statut: "disponible",
      premiere_date_disponible: statut.min_date,
      derniere_date_disponible: statut.max_date,
      detections_nasa_dans_emprise: toutesLesLignes.length,
      detections_algerie: algerie,
    });
    console.log(produit.code + " : " + toutesLesLignes.length + " lignes dans l'emprise, " + algerie + " dans les wilayas.");
  }

  if (bilansProduits.every((bilan) => bilan.statut !== "disponible")) {
    throw new Error("Aucun produit FIRMS ne dispose de données sur la fenêtre des 7 derniers jours.");
  }

  lignesEnrichies.sort((a, b) => a.date_utc.localeCompare(b.date_utc) || a.id_detection.localeCompare(b.id_detection));
  lignesBrutes.sort((a, b) =>
    ((a.acq_date || "") + (a.acq_time || "") + a.produit_firms).localeCompare(
      (b.acq_date || "") + (b.acq_time || "") + b.produit_firms
    )
  );
  const champsBruts = [...new Set(["produit_firms", ...lignesBrutes.flatMap((ligne) => Object.keys(ligne))])];
  const csvBrut = Papa.unparse(lignesBrutes, { columns: champsBruts });
  const csvEnrichi = Papa.unparse(lignesEnrichies);
  const geojson = {
    type: "FeatureCollection",
    name: "wildfires",
    features: lignesEnrichies.map((ligne) => ({
      type: "Feature",
      id: ligne.id_detection,
      geometry: { type: "Point", coordinates: [ligne.longitude, ligne.latitude] },
      properties: ligne,
    })),
  };

  const comptesWilayas: Record<string, number> = {};
  for (const wilaya of wilayas) comptesWilayas[String(wilaya.code).padStart(2, "0")] = 0;
  for (const ligne of lignesEnrichies) comptesWilayas[ligne.code_wilaya]++;

  const rapport = {
    fenetre_utc: { debut, fin, jours: JOURS_FENETRE },
    calcule_le_utc: new Date().toISOString(),
    emprise_api: boite,
    nb_detections_nasa_dans_wilayas: lignesBrutes.length,
    nb_detections_enrichies: lignesEnrichies.length,
    nb_detections_hors_wilayas_dans_emprise: horsWilayas,
    nb_wilayas_couvertes: Object.values(comptesWilayas).filter((nombre_) => nombre_ > 0).length,
    par_wilaya: comptesWilayas,
    par_produit: bilansProduits,
    dates_observees: {
      premiere: lignesEnrichies[0]?.date_utc ?? null,
      derniere: lignesEnrichies[lignesEnrichies.length - 1]?.date_utc ?? null,
    },
    fichiers: {
      nasa_json: lignesBrutes.length,
      nasa_csv: lignesBrutes.length,
      enrichi_json: lignesEnrichies.length,
      enrichi_csv: lignesEnrichies.length,
      geojson: lignesEnrichies.length,
    },
  };

  await writeFile(join(configuration.sortie, "wildfires-raw.json"), JSON.stringify(lignesBrutes, null, 2) + "\n", "utf8");
  await writeFile(join(configuration.sortie, "wildfires-raw.csv"), csvBrut + "\n", "utf8");
  await writeFile(join(configuration.sortie, "wildfires-enriched.json"), JSON.stringify(lignesEnrichies, null, 2) + "\n", "utf8");
  await writeFile(join(configuration.sortie, "wildfires-enriched.csv"), csvEnrichi + "\n", "utf8");
  await writeFile(join(configuration.sortie, "wildfires.geojson"), JSON.stringify(geojson) + "\n", "utf8");
  await writeFile(join(configuration.sortie, "rapport.json"), JSON.stringify(rapport, null, 2) + "\n", "utf8");

  console.log(
    lignesEnrichies.length +
      " détections dans les wilayas, " +
      rapport.nb_wilayas_couvertes +
      " wilayas concernées ; " +
      horsWilayas +
      " points de l'emprise rejetés hors des contours."
  );
  console.log("Fichiers écrits dans " + configuration.sortie + ".");
}

await main().catch((erreur: unknown) => {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exitCode = 1;
});
