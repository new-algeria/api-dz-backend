import { createHash } from "node:crypto";
import { avecColonnesRecentes, estRestreinte, nomFichier, type FichierInterne } from "./catalogue.js";
import { lireTable, type FormatSource, type Table } from "./conversion.js";
import { ErreurApi } from "./erreurs.js";
import { ecrireObjet, lireObjet } from "./r2.js";
import { supabasePublic } from "./supabase.js";

/**
 * Chiffres par wilaya : pour chaque donnée publiée dont le fichier retenu contient des lieux (points GeoJSON ou
 * colonnes latitude / longitude), le nombre d'enregistrements dans chacune des 69 wilayas. Le code de wilaya du
 * fichier (`wilaya_code`, `code_wilaya`) sert s'il existe ; sinon le point est placé dans les contours GeoAlgeria.
 *
 * Les décomptes d'un fichier sont rangés dans R2 (`exports/wilayas/…`), avec l'empreinte du fichier et des contours
 * dans la clé : un fichier n'est relu que s'il change. Les données non redistribuables sont ignorées.
 */

export const NB_WILAYAS = 69;
export const CODES_WILAYAS = Array.from({ length: NB_WILAYAS }, (_, indice) => String(indice + 1).padStart(2, "0"));

/** Donnée des référentiels : noms des wilayas (`wilayas`) et contours (`wilaya-boundaries`). */
const REFERENTIEL = "divisions-administratives";
const DONNEE_POPULATION = "population-wilayas";

/** Fichiers comptés quand le fichier principal ne décrit pas (ou pas seul) les lieux de la donnée ; ils s'additionnent. */
const FICHIERS_PAR_DONNEE: Record<string, string[]> = {
  // Son fichier principal est celui des bureaux de poste : on compte les communes.
  [REFERENTIEL]: ["communes"],
  // Le principal est la série annuelle ; les épicentres sont dans ce fichier.
  "seismes-algerie": ["seismes-algerie"],
  // Le principal décrit les lignes aériennes.
  aviation: ["airports"],
  // Hébergements, sites, monuments, parcs et sources thermales.
  tourisme: ["lodging", "attractions", "historic", "parks", "thermal-springs"],
};

/** Au-delà, le fichier n'est pas lu (mémoire et durée de la fonction). */
const TAILLE_MAX_LECTURE = 40 * 1024 * 1024;
/** Lectures en parallèle et durée maximale d'un calcul : au-delà, la réponse est marquée incomplète. */
const PARALLELE = 4;
const BUDGET_MS = 45_000;
/** Version du format des décomptes rangés dans R2 : la changer force un recalcul. */
const VERSION_DECOMPTE = "v1";

// ---------------------------------------------------------------- Fonctions pures (testées)

type Ligne = Record<string, unknown>;
interface Geometrie {
  type: string;
  coordinates?: unknown;
  geometries?: Geometrie[];
}
type Anneau = number[][];
type Polygone = Anneau[];

/** Code de wilaya sur deux chiffres (« 1 », 1, « 01 » → « 01 »), ou `null` s'il n'est pas entre 01 et 69. */
export function codeWilaya(valeur: unknown): string | null {
  const texte = typeof valeur === "number" ? String(valeur) : typeof valeur === "string" ? valeur.trim() : "";
  if (!/^\d{1,2}$/.test(texte)) return null;
  const n = Number(texte);
  return n >= 1 && n <= NB_WILAYAS ? String(n).padStart(2, "0") : null;
}

const NOMS_CODE = ["wilaya_code", "code_wilaya"];
/** Colonnes de temps : une table qui en a une est une série (par wilaya), pas un inventaire. */
const NOMS_TEMPS = ["annee", "year", "date", "mois", "month", "date_observation", "periode"];
const NOMS_LATITUDE = ["lat", "latitude", "y"];
const NOMS_LONGITUDE = ["lng", "lon", "long", "longitude", "x"];

const nombre = (valeur: unknown): number | null => {
  const n = typeof valeur === "number" ? valeur : typeof valeur === "string" && valeur.trim() ? Number(valeur) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Première position d'une géométrie (le point lui-même, ou le premier sommet d'une ligne ou d'un polygone). */
function premierePosition(geometrie: Geometrie | null | undefined): [number, number] | null {
  if (!geometrie) return null;
  if (geometrie.type === "GeometryCollection") {
    for (const enfant of geometrie.geometries ?? []) {
      const position = premierePosition(enfant);
      if (position) return position;
    }
    return null;
  }
  let c: unknown = geometrie.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  if (!Array.isArray(c)) return null;
  const lon = nombre(c[0]);
  const lat = nombre(c[1]);
  return lon !== null && lat !== null ? [lon, lat] : null;
}

/** Position (longitude, latitude) d'un enregistrement : sa géométrie, sinon ses colonnes de coordonnées. */
export function positionDe(ligne: Ligne, geometrie?: Geometrie | null): [number, number] | null {
  const depuisGeometrie = premierePosition(geometrie);
  if (depuisGeometrie) return depuisGeometrie;
  const cles = Object.keys(ligne);
  const lat = cles.find((cle) => NOMS_LATITUDE.includes(cle.toLowerCase()));
  const lng = cles.find((cle) => NOMS_LONGITUDE.includes(cle.toLowerCase()));
  if (!lat || !lng) return null;
  const y = nombre(ligne[lat]);
  const x = nombre(ligne[lng]);
  return x !== null && y !== null && Math.abs(y) <= 90 && Math.abs(x) <= 180 ? [x, y] : null;
}

function dansAnneau(x: number, y: number, anneau: Anneau): boolean {
  let dedans = false;
  for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
    const [xi, yi] = anneau[i];
    const [xj, yj] = anneau[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

const dansPolygone = (x: number, y: number, polygone: Polygone) =>
  dansAnneau(x, y, polygone[0]) && !polygone.slice(1).some((trou) => dansAnneau(x, y, trou));

export interface ContourWilaya {
  code: string;
  polygones: Polygone[];
  /** Emprise [ouest, sud, est, nord], pour écarter vite les wilayas lointaines. */
  emprise: [number, number, number, number];
}

/** Contours des wilayas à partir d'une table GeoJSON (propriété `code`, `wilaya_code` ou `code_wilaya`). */
export function indexerContours(table: Table): ContourWilaya[] {
  const contours: ContourWilaya[] = [];
  table.lignes.forEach((ligne, indice) => {
    const code = codeWilaya(ligne.code ?? ligne.wilaya_code ?? ligne.code_wilaya);
    const geometrie = table.geometries?.[indice];
    if (!code || !geometrie) return;
    const polygones: Polygone[] =
      geometrie.type === "Polygon" ? [geometrie.coordinates as Polygone] : geometrie.type === "MultiPolygon" ? (geometrie.coordinates as Polygone[]) : [];
    if (polygones.length === 0) return;
    const emprise: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygone of polygones)
      for (const [x, y] of polygone[0]) {
        emprise[0] = Math.min(emprise[0], x);
        emprise[1] = Math.min(emprise[1], y);
        emprise[2] = Math.max(emprise[2], x);
        emprise[3] = Math.max(emprise[3], y);
      }
    contours.push({ code, polygones, emprise });
  });
  return contours;
}

/** Wilaya qui contient le point, ou `null` (en mer, hors d'Algérie). */
export function wilayaDuPoint(contours: ContourWilaya[], x: number, y: number): string | null {
  for (const contour of contours) {
    const [ouest, sud, est, nord] = contour.emprise;
    if (x < ouest || x > est || y < sud || y > nord) continue;
    if (contour.polygones.some((polygone) => dansPolygone(x, y, polygone))) return contour.code;
  }
  return null;
}

export interface Decompte {
  /** Nombre d'enregistrements par code de wilaya (les wilayas sans enregistrement sont absentes). */
  comptes: Record<string, number>;
  /** Enregistrements de lieux qui n'ont pu être placés dans aucune wilaya. */
  sans_wilaya: number;
}

/**
 * Compte les enregistrements d'une table par wilaya, ou renvoie `null` si la table n'est pas un inventaire de lieux.
 * Un enregistrement compte s'il a une position (point, coordonnées) ou, dans une table sans colonne de temps,
 * un code de wilaya (ex. points de vente sans coordonnées). Une série temporelle par wilaya n'est jamais comptée.
 */
export function compterParWilaya(table: Table, contours: ContourWilaya[]): Decompte | null {
  const premiere = table.lignes.find(Boolean) ?? {};
  const colonnes = Object.keys(premiere).map((cle) => cle.toLowerCase());
  const colonneCode = Object.keys(premiere).find((cle) => NOMS_CODE.includes(cle.toLowerCase()));
  const serie = colonnes.some((colonne) => NOMS_TEMPS.includes(colonne));
  const comptes: Record<string, number> = {};
  let lieux = 0;
  let sansWilaya = 0;
  table.lignes.forEach((ligne, indice) => {
    const position = positionDe(ligne ?? {}, table.geometries?.[indice]);
    const codeFichier = colonneCode ? codeWilaya(ligne?.[colonneCode]) : null;
    if (!position && (serie || !codeFichier)) return;
    lieux++;
    const code = codeFichier ?? (position ? wilayaDuPoint(contours, position[0], position[1]) : null);
    if (code) comptes[code] = (comptes[code] ?? 0) + 1;
    else sansWilaya++;
  });
  // Moins de la moitié des lignes sont des lieux : ce n'est pas un inventaire de lieux.
  if (lieux === 0 || lieux < table.lignes.length / 2) return null;
  return { comptes, sans_wilaya: sansWilaya };
}

export interface Population {
  valeur: number;
  annee: number;
}

/** Dernière estimation (hors projection) de la population de chaque wilaya. */
export function populationParWilaya(lignes: Ligne[]): Record<string, Population> {
  const resultat: Record<string, Population> = {};
  for (const ligne of lignes) {
    if (String(ligne.type ?? "estimation") !== "estimation") continue;
    const code = codeWilaya(ligne.code_wilaya ?? ligne.wilaya_code);
    const annee = nombre(ligne.annee);
    const valeur = nombre(ligne.valeur);
    if (!code || annee === null || valeur === null) continue;
    if (!resultat[code] || annee > resultat[code].annee) resultat[code] = { valeur, annee };
  }
  return resultat;
}

/** Rang d'une valeur parmi les 69 wilayas (1 = la plus grande ; ex æquo = même rang ; 0 compte). */
export function rangDe(comptes: Record<string, number>, code: string): number {
  const valeur = comptes[code] ?? 0;
  return 1 + CODES_WILAYAS.filter((autre) => (comptes[autre] ?? 0) > valeur).length;
}

// ---------------------------------------------------------------- Lecture du catalogue et de R2

interface LigneDonnee {
  slug: string;
  titre: Record<string, string> | null;
  categorie_slug: string | null;
  diffusion_restreinte?: boolean;
  sources: { slug: string; nom: string } | null;
  versions: { fichiers: FichierInterne[] | null } | null;
}

const FORMATS_LISIBLES: FormatSource[] = ["geojson", "json", "csv"];

const empreinteFichier = (fichier: FichierInterne) =>
  createHash("sha256")
    .update(fichier.sha256 ?? `${fichier.cle_stockage}:${fichier.taille_octets ?? ""}`)
    .digest("hex")
    .slice(0, 20);

/** Version lisible d'un fichier logique (GeoJSON d'abord, puis JSON, puis CSV). */
function versionLisible(fichiers: FichierInterne[], nom: string) {
  const versions = fichiers.filter((fichier) => nomFichier(fichier) === nom);
  for (const format of FORMATS_LISIBLES) {
    const fichier = versions.find((version) => version.format === format);
    if (fichier) return fichier as FichierInterne & { format: FormatSource };
  }
  return null;
}

/** Fichiers comptés pour une donnée : ceux de `FICHIERS_PAR_DONNEE`, sinon le principal. */
function fichiersComptes(slug: string, fichiers: FichierInterne[]) {
  const principal = fichiers.find((fichier) => fichier.principal) ?? fichiers[0];
  const noms = FICHIERS_PAR_DONNEE[slug] ?? (principal ? [nomFichier(principal)] : []);
  return noms.map((nom) => versionLisible(fichiers, nom)).filter((fichier): fichier is FichierInterne & { format: FormatSource } => fichier !== null);
}

async function lireFichier(fichier: FichierInterne & { format: FormatSource }): Promise<Table | null> {
  if ((fichier.taille_octets ?? 0) > TAILLE_MAX_LECTURE) return null;
  const reponse = await lireObjet(fichier.cle_stockage);
  if (!reponse) return null;
  try {
    return lireTable(await reponse.text(), fichier.format);
  } catch {
    return null;
  }
}

async function listerDonneesPubliees(): Promise<LigneDonnee[]> {
  return avecColonnesRecentes(
    `slug, titre, categorie_slug, sources ( slug, nom ),
     versions!datasets_version_courante_fk ( fichiers ( nom, format, cle_stockage, principal, taille_octets, sha256 ) )`,
    async (select) => {
      const { data, error } = await supabasePublic().from("datasets").select(select).eq("statut", "publie").order("slug");
      return { data: (data ?? []) as unknown as LigneDonnee[], error };
    }
  );
}

export interface DonneeWilayas {
  slug: string;
  titre: Record<string, string>;
  categorie_slug: string | null;
  source: { slug: string; nom: string } | null;
  fichier: string;
  /** Somme des enregistrements placés dans une wilaya. */
  total: number;
  sans_wilaya: number;
  comptes: Record<string, number>;
}

export interface WilayaRef {
  code: string;
  nom: { fr: string; ar: string | null };
  population: Population | null;
}

export interface ChiffresWilayas {
  genere_le: string;
  /** Faux si le budget de temps a été atteint : certaines données manquent, un prochain appel les ajoutera. */
  complet: boolean;
  population_source: { slug: string; annee: number | null } | null;
  wilayas: WilayaRef[];
  donnees: DonneeWilayas[];
}

/** Décompte d'un fichier, lu dans R2 s'il existe déjà, sinon calculé puis rangé. `null` = pas un inventaire de lieux. */
async function decompteFichier(slug: string, fichier: FichierInterne & { format: FormatSource }, contours: ContourWilaya[], empreinteContours: string) {
  const cle = `exports/wilayas/${VERSION_DECOMPTE}/${slug}/${empreinteFichier(fichier)}-${empreinteContours}.json`;
  const existant = await lireObjet(cle).catch(() => null);
  if (existant) {
    const contenu = (await existant.json().catch(() => undefined)) as { decompte: Decompte | null } | undefined;
    if (contenu) return contenu.decompte;
  }
  const table = await lireFichier(fichier);
  if (!table) return null;
  const decompte = compterParWilaya(table, contours);
  await ecrireObjet(cle, JSON.stringify({ decompte }), "application/json", "private, max-age=31536000, immutable").catch((erreur) =>
    console.error("wilayas: décompte non rangé", slug, erreur)
  );
  return decompte;
}

/** Exécute les tâches avec au plus `parallele` en cours, et s'arrête d'en lancer après l'échéance. */
async function enParallele<T>(taches: (() => Promise<T>)[], parallele: number, echeance: number): Promise<{ resultats: (T | undefined)[]; complet: boolean }> {
  const resultats: (T | undefined)[] = new Array(taches.length);
  let suivante = 0;
  let complet = true;
  const ouvrier = async () => {
    while (suivante < taches.length) {
      if (Date.now() > echeance) {
        complet = false;
        return;
      }
      const indice = suivante++;
      resultats[indice] = await taches[indice]();
    }
  };
  await Promise.all(Array.from({ length: parallele }, ouvrier));
  return { resultats, complet };
}

/** Résultat gardé en mémoire de l'instance (Fluid compute) : complet 30 min, incomplet 1 min. */
let enMemoire: { valeur: ChiffresWilayas; expire: number } | null = null;
let calculEnCours: Promise<ChiffresWilayas> | null = null;

export async function chargerChiffresWilayas(): Promise<ChiffresWilayas> {
  if (enMemoire && enMemoire.expire > Date.now()) return enMemoire.valeur;
  calculEnCours ??= calculerChiffresWilayas().finally(() => {
    calculEnCours = null;
  });
  const valeur = await calculEnCours;
  enMemoire = { valeur, expire: Date.now() + (valeur.complet ? 30 * 60_000 : 60_000) };
  return valeur;
}

async function calculerChiffresWilayas(): Promise<ChiffresWilayas> {
  const echeance = Date.now() + BUDGET_MS;
  const donnees = await listerDonneesPubliees();
  const parSlug = new Map(donnees.map((donnee) => [donnee.slug, donnee]));

  // Référentiels : contours et noms des wilayas, population.
  const referentiel = parSlug.get(REFERENTIEL);
  const fichiersRef = referentiel?.versions?.fichiers ?? [];
  const fichierContours = versionLisible(fichiersRef, "wilaya-boundaries");
  const fichierNoms = versionLisible(fichiersRef, "wilayas");
  const [tableContours, tableNoms] = await Promise.all([
    fichierContours ? lireFichier(fichierContours) : null,
    fichierNoms ? lireFichier(fichierNoms) : null,
  ]);
  if (!tableContours) throw new ErreurApi(503, "boundaries_unavailable", "Les contours des wilayas sont indisponibles. Réessayez plus tard.");
  const contours = indexerContours(tableContours);
  const empreinteContours = empreinteFichier(fichierContours!).slice(0, 8);

  const fichierPopulation = (() => {
    const fichiers = parSlug.get(DONNEE_POPULATION)?.versions?.fichiers ?? [];
    return fichiersComptes(DONNEE_POPULATION, fichiers)[0] ?? null;
  })();
  const tablePopulation = fichierPopulation ? await lireFichier(fichierPopulation) : null;
  const populations = tablePopulation ? populationParWilaya(tablePopulation.lignes) : {};
  const anneePopulation = Object.values(populations).reduce<number | null>((max, p) => (max === null || p.annee > max ? p.annee : max), null);

  const noms = new Map<string, { fr: string; ar: string | null }>();
  for (const ligne of tableNoms?.lignes ?? []) {
    const code = codeWilaya(ligne.code ?? ligne.wilaya_code);
    if (code) noms.set(code, { fr: String(ligne.name_fr ?? ligne.name ?? code), ar: typeof ligne.name_ar === "string" ? ligne.name_ar : null });
  }

  // Décomptes, donnée par donnée (non redistribuables et population exclues).
  const candidates = donnees.filter((donnee) => !estRestreinte(donnee) && donnee.slug !== DONNEE_POPULATION);
  const taches = candidates.map((donnee) => async (): Promise<DonneeWilayas | null> => {
    const fichiers = fichiersComptes(donnee.slug, donnee.versions?.fichiers ?? []);
    if (fichiers.length === 0) return null;
    try {
      const decomptes: Decompte[] = [];
      for (const fichier of fichiers) {
        const decompte = await decompteFichier(donnee.slug, fichier, contours, empreinteContours);
        if (decompte) decomptes.push(decompte);
      }
      if (decomptes.length === 0) return null;
      const comptes: Record<string, number> = {};
      for (const decompte of decomptes) for (const [code, n] of Object.entries(decompte.comptes)) comptes[code] = (comptes[code] ?? 0) + n;
      return {
        slug: donnee.slug,
        titre: donnee.titre ?? {},
        categorie_slug: donnee.categorie_slug,
        source: donnee.sources,
        fichier: fichiers.map(nomFichier).join(", "),
        total: Object.values(comptes).reduce((somme, n) => somme + n, 0),
        sans_wilaya: decomptes.reduce((somme, decompte) => somme + decompte.sans_wilaya, 0),
        comptes,
      };
    } catch (erreur) {
      console.error("wilayas: décompte impossible", donnee.slug, erreur);
      return null;
    }
  });
  const { resultats, complet } = await enParallele(taches, PARALLELE, echeance);

  return {
    genere_le: new Date().toISOString(),
    complet,
    population_source: tablePopulation ? { slug: DONNEE_POPULATION, annee: anneePopulation } : null,
    wilayas: CODES_WILAYAS.map((code) => ({ code, nom: noms.get(code) ?? { fr: code, ar: null }, population: populations[code] ?? null })),
    donnees: resultats.filter((resultat): resultat is DonneeWilayas => Boolean(resultat && resultat.total > 0)),
  };
}
