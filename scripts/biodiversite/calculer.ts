/**
 * Agrège les occurrences GBIF de l'Algérie sans télécharger les fiches individuelles.
 * L'API est utilisée avec limit=0 et ses facettes statistiques.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Papa from "papaparse";

export const URL_API = "https://api.gbif.org/v1/occurrence/search";
export const URL_SOURCE = "https://www.gbif.org/occurrence/search?country=DZ";
const AGENT = "data-dz-biodiversite/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;
const LICENCES = ["CC0_1_0", "CC_BY_4_0"] as const;
const REGNES: Record<string, string> = {
  "1": "Animaux (Animalia)", "2": "Archées (Archaea)", "3": "Bactéries (Bacteria)",
  "4": "Chromistes (Chromista)", "5": "Champignons (Fungi)", "6": "Plantes (Plantae)",
  "7": "Protozoaires (Protozoa)", "8": "Virus (Viruses)",
};

export interface Facette { field: string; counts: { name: string; count: number }[] }
export interface ReponseGbif { count: number; facets?: Facette[] }
export interface LigneGraphique { annee: number; filiere: string; valeur: number; unite: "occurrences" }
export interface LigneDetail {
  dimension: "regne" | "annee" | "region_declaree" | "type_enregistrement";
  modalite: string; libelle: string; regne_key: number | null; valeur: number; part_pct: number; unite: "occurrences";
}
export interface Indicateur { indicateur: string; valeur: number | string; unite: string }
export interface Rapport {
  genere_le: string; source_url: string; api_url: string; source_etag: string | null; source_modifie_le: string | null;
  empreinte_sha256: string; pays: string; code_pays: string; filtres: Record<string, string | string[]>;
  occurrences_total: number; occurrences_geolocalisees_sans_anomalie: number; licences_incluses: string[];
  premiere_annee: number | null; derniere_annee: number | null; nb_regnes: number; nb_regions_declarees: number;
  nb_lignes_graphique: number; nb_lignes_details: number; nb_indicateurs: number;
}
export interface ResultatCalcul {
  graphique: LigneGraphique[]; details: LigneDetail[]; indicateurs: Indicateur[];
  rapport: Omit<Rapport, "genere_le" | "source_etag" | "source_modifie_le" | "empreinte_sha256">;
}

const FACETTES_GLOBAL = ["kingdomKey", "year", "stateProvince", "basisOfRecord"];

export function creerUrlRequete(kingdomKey?: number): string {
  const params = new URLSearchParams();
  params.set("country", "DZ");
  params.set("hasCoordinate", "true");
  params.set("hasGeospatialIssue", "false");
  params.set("occurrenceStatus", "PRESENT");
  params.set("limit", "0");
  params.set("facetMincount", "1");
  for (const licence of LICENCES) params.append("license", licence);
  for (const facette of kingdomKey === undefined ? FACETTES_GLOBAL : ["year"]) params.append("facet", facette);
  params.set("year.facetLimit", "1000");
  params.set("kingdomKey.facetLimit", "50");
  params.set("stateProvince.facetLimit", "200");
  params.set("basisOfRecord.facetLimit", "50");
  if (kingdomKey !== undefined) params.set("kingdomKey", String(kingdomKey));
  return URL_API + "?" + params.toString();
}

const attendre = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function appelerGbif(url: string, fetcher: typeof fetch = fetch): Promise<{ donnees: ReponseGbif; etag: string | null; modifieLe: string | null }> {
  let derniereErreur: unknown;
  for (let tentative = 0; tentative < 4; tentative++) {
    try {
      const reponse = await fetcher(url, {
        headers: { "user-agent": AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (reponse.status === 429 || reponse.status >= 500) {
        const retry = Number(reponse.headers.get("retry-after"));
        await attendre(Math.min(retry > 0 ? retry * 1000 : 1000 * (tentative + 1), 15_000));
        continue;
      }
      if (!reponse.ok) throw new Error("API GBIF : HTTP " + reponse.status + " — " + url);
      const donnees = await reponse.json() as ReponseGbif;
      if (!Number.isSafeInteger(donnees.count) || donnees.count < 0 || !Array.isArray(donnees.facets)) {
        throw new Error("Réponse GBIF inattendue : count ou facets absent.");
      }
      return { donnees, etag: reponse.headers.get("etag"), modifieLe: reponse.headers.get("last-modified") };
    } catch (erreur) {
      derniereErreur = erreur;
      if (tentative < 3) await attendre(500 * (tentative + 1));
    }
  }
  throw new Error("Échec de la requête GBIF après 4 tentatives : " + String(derniereErreur));
}

function normaliserNomFacette(nom: string): string {
  return nom.replace(/[^a-z]/gi, "").toLowerCase();
}
function valeursFacette(reponse: ReponseGbif, champ: string): { name: string; count: number }[] {
  const attendue = normaliserNomFacette(champ);
  const facette = (reponse.facets ?? []).find((item) => normaliserNomFacette(item.field) === attendue);
  return (facette?.counts ?? [])
    .filter((item) => typeof item.name === "string" && Number.isSafeInteger(item.count) && item.count >= 0)
    .map((item) => ({ name: item.name, count: item.count }));
}
function libelleRegne(key: string): string { return REGNES[key] ?? ("Règne GBIF " + key); }
function pourcentage(valeur: number, total: number): number {
  return total === 0 ? 0 : Number(((valeur / total) * 100).toFixed(4));
}
function reste(total: number, compte: number, contexte: string): number {
  if (compte > total) throw new Error("Les facettes GBIF dépassent le total pour " + contexte + ".");
  return total - compte;
}
function anneesValides(facettes: { name: string; count: number }[]): { annee: number; count: number }[] {
  const anneeMax = new Date().getUTCFullYear() + 1;
  return facettes.map((item) => ({ annee: Number(item.name), count: item.count }))
    .filter((item) => Number.isInteger(item.annee) && item.annee >= 1000 && item.annee <= anneeMax)
    .sort((a, b) => a.annee - b.annee);
}
function ajouterDetails(
  cible: LigneDetail[],
  dimension: LigneDetail["dimension"],
  lignes: { modalite: string; libelle: string; valeur: number; regne_key?: number | null }[],
  total: number
): void {
  for (const ligne of lignes) {
    cible.push({
      dimension, modalite: ligne.modalite, libelle: ligne.libelle, regne_key: ligne.regne_key ?? null,
      valeur: ligne.valeur, part_pct: pourcentage(ligne.valeur, total), unite: "occurrences",
    });
  }
  cible.push({
    dimension, modalite: "__total__", libelle: "Total des occurrences filtrées",
    regne_key: null, valeur: total, part_pct: 100, unite: "occurrences",
  });
}

export function construireResultat(global: ReponseGbif, parRegne: Record<number, ReponseGbif>): ResultatCalcul {
  if (!Number.isSafeInteger(global.count) || global.count <= 0) {
    throw new Error("GBIF ne retourne aucune occurrence pour le périmètre sélectionné.");
  }
  const total = global.count;
  const facettesRegnes = valeursFacette(global, "kingdomKey")
    .map((item) => ({ key: Number(item.name), count: item.count }))
    .filter((item) => Number.isInteger(item.key) && item.key > 0 && item.count > 0)
    .sort((a, b) => a.key - b.key);
  if (facettesRegnes.length === 0) throw new Error("La facette kingdomKey est absente ou vide.");
  const sommeRegnes = facettesRegnes.reduce((somme, item) => somme + item.count, 0);
  const nonClasses = reste(total, sommeRegnes, "les règnes");
  const anneesGlobales = anneesValides(valeursFacette(global, "year"));
  if (anneesGlobales.length === 0) throw new Error("La facette year est absente ou vide.");

  const anneesParRegne = new Map<number, Map<number, number>>();
  for (const regne of facettesRegnes) {
    const reponse = parRegne[regne.key];
    if (!reponse || !Number.isSafeInteger(reponse.count)) throw new Error("La réponse annuelle manque pour le règne " + regne.key + ".");
    if (Math.abs(reponse.count - regne.count) > Math.max(5, regne.count * 0.001)) {
      throw new Error("Le total GBIF a changé pendant la collecte pour le règne " + regne.key + ".");
    }
    const annees = anneesValides(valeursFacette(reponse, "year"));
    const totalAnnees = annees.reduce((somme, item) => somme + item.count, 0);
    if (totalAnnees > reponse.count) throw new Error("Les facettes annuelles dépassent le total du règne " + regne.key + ".");
    anneesParRegne.set(regne.key, new Map(annees.map((item) => [item.annee, item.count])));
  }

  const graphique: LigneGraphique[] = [];
  for (const item of anneesGlobales) {
    graphique.push({ annee: item.annee, filiere: "Toutes les occurrences", valeur: item.count, unite: "occurrences" });
    let sommeAnneeRegnes = 0;
    for (const regne of facettesRegnes) {
      const valeur = anneesParRegne.get(regne.key)?.get(item.annee) ?? 0;
      sommeAnneeRegnes += valeur;
      graphique.push({ annee: item.annee, filiere: libelleRegne(String(regne.key)), valeur, unite: "occurrences" });
    }
    const autres = reste(item.count, sommeAnneeRegnes, "l'année " + item.annee);
    if (autres > 0) graphique.push({ annee: item.annee, filiere: "Non classé / autre", valeur: autres, unite: "occurrences" });
  }

  const details: LigneDetail[] = [];
  const lignesRegnes: { modalite: string; libelle: string; valeur: number; regne_key?: number | null }[] =
    facettesRegnes.map((item) => ({
      modalite: String(item.key), libelle: libelleRegne(String(item.key)), regne_key: item.key, valeur: item.count,
    }));
  if (nonClasses > 0) lignesRegnes.push({ modalite: "non_classe", libelle: "Non classé / autre", regne_key: null, valeur: nonClasses });
  ajouterDetails(details, "regne", lignesRegnes, total);

  const sommesAnnees = anneesGlobales.reduce((somme, item) => somme + item.count, 0);
  const lignesAnnees = anneesGlobales.map((item) => ({ modalite: String(item.annee), libelle: String(item.annee), valeur: item.count }));
  const sansAnnee = reste(total, sommesAnnees, "les années");
  if (sansAnnee > 0) lignesAnnees.push({ modalite: "non_renseignee", libelle: "Année non renseignée ou hors facettes", valeur: sansAnnee });
  ajouterDetails(details, "annee", lignesAnnees, total);

  const facettesRegions = valeursFacette(global, "stateProvince").sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fr"));
  const sommeRegions = facettesRegions.reduce((somme, item) => somme + item.count, 0);
  const regions = facettesRegions.map((item) => ({ modalite: item.name, libelle: item.name, valeur: item.count }));
  const regionsNonRenseignees = reste(total, sommeRegions, "les régions déclarées");
  if (regionsNonRenseignees > 0) regions.push({
    modalite: "non_renseignee_ou_hors_facettes",
    libelle: "Région non renseignée ou hors des 200 premières valeurs",
    valeur: regionsNonRenseignees,
  });
  ajouterDetails(details, "region_declaree", regions, total);

  const bases = valeursFacette(global, "basisOfRecord").sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const sommeBases = bases.reduce((somme, item) => somme + item.count, 0);
  const lignesBases = bases.map((item) => ({ modalite: item.name, libelle: item.name, valeur: item.count }));
  const basesNonRenseignees = reste(total, sommeBases, "les types d'enregistrement");
  if (basesNonRenseignees > 0) lignesBases.push({
    modalite: "non_renseigne", libelle: "Type d'enregistrement non renseigné ou hors facettes", valeur: basesNonRenseignees,
  });
  ajouterDetails(details, "type_enregistrement", lignesBases, total);

  const premiereAnnee = anneesGlobales[0]?.annee ?? null;
  const derniereAnnee = anneesGlobales.at(-1)?.annee ?? null;
  const indicateurs: Indicateur[] = [
    { indicateur: "Occurrences GBIF filtrées", valeur: total, unite: "occurrences" },
    { indicateur: "Occurrences géolocalisées sans anomalie spatiale", valeur: total, unite: "occurrences" },
    { indicateur: "Règnes taxonomiques représentés", valeur: facettesRegnes.length, unite: "règnes" },
    { indicateur: "Régions déclarées distinctes (facettes affichées)", valeur: facettesRegions.length, unite: "valeurs de région" },
    { indicateur: "Première année renseignée", valeur: premiereAnnee ?? "Non renseignée", unite: "année" },
    { indicateur: "Dernière année renseignée", valeur: derniereAnnee ?? "Non renseignée", unite: "année" },
    { indicateur: "Occurrences sans année renseignée ou hors facettes", valeur: sansAnnee, unite: "occurrences" },
    { indicateur: "Occurrences sans région renseignée ou hors facettes", valeur: regionsNonRenseignees, unite: "occurrences" },
  ];

  return {
    graphique, details, indicateurs,
    rapport: {
      source_url: URL_SOURCE, api_url: URL_API, pays: "Algérie", code_pays: "DZ",
      filtres: {
        country: "DZ", hasCoordinate: "true", hasGeospatialIssue: "false",
        occurrenceStatus: "PRESENT", license: [...LICENCES], limit: "0 (comptage et facettes uniquement)",
      },
      occurrences_total: total, occurrences_geolocalisees_sans_anomalie: total,
      licences_incluses: [...LICENCES], premiere_annee: premiereAnnee, derniere_annee: derniereAnnee,
      nb_regnes: facettesRegnes.length, nb_regions_declarees: facettesRegions.length,
      nb_lignes_graphique: graphique.length, nb_lignes_details: details.length, nb_indicateurs: indicateurs.length,
    },
  };
}

export async function calculerDepuisApi(fetcher: typeof fetch = fetch): Promise<{
  resultat: ResultatCalcul; etag: string | null; modifieLe: string | null; empreinte: string;
}> {
  const global = await appelerGbif(creerUrlRequete(), fetcher);
  const keys = valeursFacette(global.donnees, "kingdomKey")
    .map((item) => Number(item.name)).filter((key) => Number.isInteger(key) && key > 0);
  if (keys.length === 0) throw new Error("Aucun identifiant de règne exploitable dans les facettes GBIF.");
  const parRegne: Record<number, ReponseGbif> = {};
  for (const [index, key] of keys.entries()) {
    if (index > 0) await attendre(300);
    const reponse = await appelerGbif(creerUrlRequete(key), fetcher);
    parRegne[key] = reponse.donnees;
  }
  const resultat = construireResultat(global.donnees, parRegne);
  const empreinte = createHash("sha256").update(JSON.stringify({ global: global.donnees, parRegne })).digest("hex");
  return { resultat, etag: global.etag, modifieLe: global.modifieLe, empreinte };
}

async function ecrireSorties(
  sortie: string, resultat: ResultatCalcul,
  source: { etag: string | null; modifieLe: string | null; empreinte: string }
): Promise<void> {
  await mkdir(sortie, { recursive: true });
  const rapport: Rapport = {
    genere_le: new Date().toISOString(), ...resultat.rapport,
    source_etag: source.etag, source_modifie_le: source.modifieLe, empreinte_sha256: source.empreinte,
  };
  const fichiers: [string, unknown][] = [
    ["biodiversite-algerie.json", resultat.graphique],
    ["biodiversite-algerie.csv", Papa.unparse(resultat.graphique, { newline: "\n" }) + "\n"],
    ["biodiversite-algerie-details.json", resultat.details],
    ["biodiversite-algerie-details.csv", Papa.unparse(resultat.details, { newline: "\n" }) + "\n"],
    ["biodiversite-algerie-indicateurs.json", resultat.indicateurs],
    ["biodiversite-algerie-indicateurs.csv", Papa.unparse(resultat.indicateurs, { newline: "\n" }) + "\n"],
    ["rapport.json", rapport],
  ];
  await Promise.all(fichiers.map(([nom, contenu]) =>
    writeFile(join(sortie, nom), typeof contenu === "string" ? contenu : JSON.stringify(contenu, null, 2) + "\n", "utf8")
  ));
  console.log(
    rapport.occurrences_total.toLocaleString("fr-FR") + " occurrences filtrées, " +
    rapport.nb_regnes + " règnes, " + rapport.nb_regions_declarees +
    " valeurs de région ; période " + (rapport.premiere_annee ?? "—") + "–" + (rapport.derniere_annee ?? "—") + "."
  );
}

async function main(): Promise<void> {
  const index = process.argv.indexOf("--sortie");
  const sortie = index >= 0 ? process.argv[index + 1] || join(DOSSIER, "sortie") : join(DOSSIER, "sortie");
  const { resultat, etag, modifieLe, empreinte } = await calculerDepuisApi();
  await ecrireSorties(sortie, resultat, { etag, modifieLe, empreinte });
}

if (process.argv[1]?.endsWith("/biodiversite/calculer.ts") || process.argv[1]?.endsWith("\\biodiversite\\calculer.ts")) {
  main().catch((erreur: unknown) => {
    console.error(erreur instanceof Error ? erreur.message : erreur);
    process.exitCode = 1;
  });
}
