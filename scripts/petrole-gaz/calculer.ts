/**
 * Extrait les séries annuelles du pétrole et du gaz naturel de l'Algérie depuis les statistiques
 * internationales de l'EIA (U.S. Energy Information Administration).
 *
 * Source : fichier « International » en téléchargement groupé (INTL.zip, une série JSON par ligne), sans clé.
 * Les données de l'EIA sont des travaux du gouvernement fédéral américain : domaine public.
 *
 *   npx tsx scripts/petrole-gaz/calculer.ts [--cache DOSSIER] [--sortie DOSSIER] [--sans-cache]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Papa from "papaparse";

export const URL_SOURCE = "https://api.eia.gov/bulk/INTL.zip";
const AGENT = "data-dz-petrole-gaz/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;

/** Séries retenues : identifiant EIA, libellés et unité. L'ordre est celui des colonnes du bilan annuel. */
export const INDICATEURS = [
  { id: "INTL.57-1-DZA-TBPD.A", cle: "petrole_brut_production_kbj", fr: "Pétrole brut : production", unite: "milliers de barils par jour" },
  { id: "INTL.53-1-DZA-TBPD.A", cle: "liquides_production_kbj", fr: "Pétrole et autres liquides : production", unite: "milliers de barils par jour" },
  { id: "INTL.58-1-DZA-TBPD.A", cle: "lgn_production_kbj", fr: "Liquides de gaz naturel : production", unite: "milliers de barils par jour" },
  { id: "INTL.5-2-DZA-TBPD.A", cle: "liquides_consommation_kbj", fr: "Pétrole et autres liquides : consommation", unite: "milliers de barils par jour" },
  { id: "INTL.57-4-DZA-TBPD.A", cle: "petrole_brut_exportations_kbj", fr: "Pétrole brut : exportations", unite: "milliers de barils par jour" },
  { id: "INTL.26-1-DZA-BCM.A", cle: "gaz_production_gm3", fr: "Gaz naturel : production", unite: "milliards de m³" },
  { id: "INTL.26-2-DZA-BCM.A", cle: "gaz_consommation_gm3", fr: "Gaz naturel : consommation", unite: "milliards de m³" },
  { id: "INTL.26-4-DZA-BCM.A", cle: "gaz_exportations_gm3", fr: "Gaz naturel : exportations", unite: "milliards de m³" },
] as const;

export type CleIndicateur = (typeof INDICATEURS)[number]["cle"];

/** Une série telle qu'elle figure dans INTL.txt (une ligne JSON). */
export interface SerieEia {
  series_id: string;
  name?: string;
  units?: string;
  f?: string;
  last_updated?: string;
  data?: [string, number | string | null][];
}

export interface LigneSerie {
  annee: number;
  indicateur: string;
  valeur: number;
  unite: string;
  serie_eia: string;
}

export type LigneBilan = { annee: number } & Record<CleIndicateur, number | null> & { part_gaz_exportee_pct: number | null };

export interface Rapport {
  genere_le: string;
  source_url: string;
  source_modifie_le: string | null;
  source_sha256: string;
  source_octets: number;
  series_mises_a_jour_le: string | null;
  premiere_annee: number;
  derniere_annee: number;
  nb_lignes: number;
  nb_annees: number;
  nb_indicateurs: number;
  periodes: Record<CleIndicateur, [number, number]>;
  derniere_annee_chiffres: Record<string, number | null>;
}

export interface ResultatCalcul {
  series: LigneSerie[];
  bilan: LigneBilan[];
  rapport: Omit<Rapport, "genere_le" | "source_url" | "source_modifie_le" | "source_sha256" | "source_octets">;
}

const arrondi = (valeur: number, decimales: number) => Math.round(valeur * 10 ** decimales) / 10 ** decimales;

/** Valeur EIA : nombre, sinon null (« NA », « -- », « (s) », « W »…). Jamais remplacée par zéro. */
export function valeurEia(brute: unknown): number | null {
  if (typeof brute === "number") return Number.isFinite(brute) ? brute : null;
  if (typeof brute !== "string") return null;
  const texte = brute.trim();
  if (!/^-?\d+(\.\d+)?([eE]-?\d+)?$/.test(texte)) return null;
  return Number(texte);
}

/** Plages plausibles pour l'Algérie : une valeur hors plage signale une erreur d'unité ou de série. */
const PLAGES: Record<CleIndicateur, [number, number]> = {
  petrole_brut_production_kbj: [300, 3000],
  liquides_production_kbj: [300, 3500],
  lgn_production_kbj: [0, 1000],
  liquides_consommation_kbj: [20, 2000],
  petrole_brut_exportations_kbj: [0, 3000],
  gaz_production_gm3: [0, 400],
  gaz_consommation_gm3: [0, 300],
  gaz_exportations_gm3: [0, 300],
};

/** Transforme les séries EIA de l'Algérie en format long (graphique) et en bilan annuel (une ligne par année). */
export function calculer(series: SerieEia[]): ResultatCalcul {
  const parId = new Map(series.map((serie) => [serie.series_id, serie]));
  const lignes: LigneSerie[] = [];
  const valeurs = new Map<number, Partial<Record<CleIndicateur, number>>>();
  const periodes = {} as Record<CleIndicateur, [number, number]>;
  const misesAJour: string[] = [];

  for (const indicateur of INDICATEURS) {
    const serie = parId.get(indicateur.id);
    if (!serie?.data?.length) throw new Error(`Série EIA absente : ${indicateur.id} (${indicateur.fr}).`);
    if (serie.last_updated) misesAJour.push(serie.last_updated);
    const annees: number[] = [];
    for (const [periode, brute] of serie.data) {
      const annee = Number(periode);
      const valeur = valeurEia(brute);
      if (!Number.isInteger(annee) || valeur === null) continue;
      const [min, max] = PLAGES[indicateur.cle];
      if (valeur < min || valeur > max) {
        throw new Error(`Valeur invraisemblable pour ${indicateur.fr} en ${annee} : ${valeur} ${indicateur.unite}.`);
      }
      const arrondie = arrondi(valeur, indicateur.unite.startsWith("milliers") ? 1 : 2);
      lignes.push({ annee, indicateur: indicateur.fr, valeur: arrondie, unite: indicateur.unite, serie_eia: indicateur.id });
      valeurs.set(annee, { ...valeurs.get(annee), [indicateur.cle]: arrondie });
      annees.push(annee);
    }
    if (!annees.length) throw new Error(`Série EIA vide : ${indicateur.id}.`);
    periodes[indicateur.cle] = [Math.min(...annees), Math.max(...annees)];
  }

  lignes.sort((a, b) => a.indicateur.localeCompare(b.indicateur, "fr") || a.annee - b.annee);
  const bilan: LigneBilan[] = [...valeurs.keys()]
    .sort((a, b) => a - b)
    .map((annee) => {
      const ligne = { annee } as LigneBilan;
      const annuel = valeurs.get(annee)!;
      for (const { cle } of INDICATEURS) ligne[cle] = annuel[cle] ?? null;
      const { gaz_production_gm3: production, gaz_exportations_gm3: exportations } = ligne;
      ligne.part_gaz_exportee_pct = production && exportations !== null ? arrondi((exportations / production) * 100, 1) : null;
      return ligne;
    });

  const annees = bilan.map((ligne) => ligne.annee);
  const derniere = bilan.filter((ligne) => ligne.petrole_brut_production_kbj !== null && ligne.gaz_production_gm3 !== null).at(-1);
  if (!derniere) throw new Error("Aucune année avec à la fois le pétrole brut et le gaz.");
  return {
    series: lignes,
    bilan,
    rapport: {
      series_mises_a_jour_le: misesAJour.sort().at(-1) ?? null,
      premiere_annee: Math.min(...annees),
      derniere_annee: Math.max(...annees),
      nb_lignes: lignes.length,
      nb_annees: bilan.length,
      nb_indicateurs: INDICATEURS.length,
      periodes,
      derniere_annee_chiffres: {
        annee: derniere.annee,
        petrole_brut_production_kbj: derniere.petrole_brut_production_kbj,
        gaz_production_gm3: derniere.gaz_production_gm3,
        gaz_exportations_gm3: derniere.gaz_exportations_gm3,
        part_gaz_exportee_pct: derniere.part_gaz_exportee_pct,
      },
    },
  };
}

/** Contrôles avant publication : couverture longue et toutes les séries jusqu'à une année récente. */
export function verifier(resultat: ResultatCalcul, anneeCourante = new Date().getUTCFullYear()): void {
  const { rapport } = resultat;
  if (rapport.premiere_annee > 1980) throw new Error(`Série trop courte : début en ${rapport.premiere_annee}.`);
  if (rapport.nb_annees < 40) throw new Error(`Seulement ${rapport.nb_annees} années.`);
  const recente = anneeCourante - 3;
  for (const cle of ["petrole_brut_production_kbj", "gaz_production_gm3", "gaz_exportations_gm3", "liquides_consommation_kbj"] as const) {
    const fin = rapport.periodes[cle][1];
    if (fin < recente) throw new Error(`La série ${cle} s'arrête en ${fin} (attendu ${recente} ou après).`);
  }
}

/** Ne garde, ligne par ligne, que les séries annuelles de l'Algérie : le fichier complet fait plus de 100 Mo. */
export async function lireSeriesAlgerie(lignes: AsyncIterable<string>): Promise<SerieEia[]> {
  const voulues = new Set<string>(INDICATEURS.map((indicateur) => indicateur.id));
  const series: SerieEia[] = [];
  for await (const ligne of lignes) {
    if (!ligne.includes("-DZA-")) continue;
    const id = /"series_id":"([^"]+)"/.exec(ligne)?.[1];
    if (!id || !voulues.has(id)) continue;
    series.push(JSON.parse(ligne) as SerieEia);
  }
  return series;
}

async function telecharger(cache: string, sansCache: boolean): Promise<{ chemin: string; modifieLe: string | null }> {
  const chemin = join(cache, "INTL.zip");
  const meta = join(cache, "INTL.meta.json");
  if (!sansCache) {
    try {
      const { modifie_le } = JSON.parse(await readFile(meta, "utf8")) as { modifie_le: string | null };
      const infos = await stat(chemin);
      if (Date.now() - infos.mtimeMs < 12 * 3600 * 1000) return { chemin, modifieLe: modifie_le };
    } catch {
      // Pas de cache : on télécharge.
    }
  }
  await mkdir(cache, { recursive: true });
  const reponse = await fetch(URL_SOURCE, { headers: { "user-agent": AGENT }, redirect: "follow" });
  if (!reponse.ok) throw new Error(`EIA : HTTP ${reponse.status} pour ${URL_SOURCE}.`);
  const contenu = Buffer.from(await reponse.arrayBuffer());
  if (contenu.length < 1_000_000) throw new Error(`Fichier EIA anormalement petit (${contenu.length} octets).`);
  await writeFile(`${chemin}.tmp`, contenu);
  await rename(`${chemin}.tmp`, chemin);
  const modifieLe = reponse.headers.get("last-modified");
  await writeFile(meta, JSON.stringify({ modifie_le: modifieLe }, null, 2) + "\n", "utf8");
  return { chemin, modifieLe };
}

/** Lit INTL.txt dans l'archive sans la décompresser sur le disque (`unzip -p`, présent sur les runners Ubuntu). */
async function lireArchive(chemin: string): Promise<SerieEia[]> {
  const processus = spawn("unzip", ["-p", chemin, "INTL.txt"], { stdio: ["ignore", "pipe", "inherit"] });
  const fin = new Promise<void>((resoudre, rejeter) => {
    processus.on("error", rejeter);
    processus.on("close", (code) => (code === 0 ? resoudre() : rejeter(new Error(`unzip a échoué (code ${code}).`))));
  });
  const series = await lireSeriesAlgerie(createInterface({ input: processus.stdout, crlfDelay: Infinity }));
  await fin;
  return series;
}

async function principal() {
  const option = (nom: string, defaut: string) => {
    const index = process.argv.indexOf(nom);
    return index >= 0 ? process.argv[index + 1] || defaut : defaut;
  };
  const cache = option("--cache", join(DOSSIER, "cache"));
  const sortie = option("--sortie", join(DOSSIER, "sortie"));
  const { chemin, modifieLe } = await telecharger(cache, process.argv.includes("--sans-cache"));
  const archive = await readFile(chemin);
  const resultat = calculer(await lireArchive(chemin));
  verifier(resultat);

  await mkdir(sortie, { recursive: true });
  const csv = (lignes: object[]) => Papa.unparse(lignes, { newline: "\n" }) + "\n";
  await Promise.all([
    writeFile(join(sortie, "series-annuelles.json"), JSON.stringify(resultat.series) + "\n", "utf8"),
    writeFile(join(sortie, "series-annuelles.csv"), csv(resultat.series), "utf8"),
    writeFile(join(sortie, "bilan-annuel.json"), JSON.stringify(resultat.bilan) + "\n", "utf8"),
    writeFile(join(sortie, "bilan-annuel.csv"), csv(resultat.bilan), "utf8"),
  ]);
  const rapport: Rapport = {
    genere_le: new Date().toISOString(),
    source_url: URL_SOURCE,
    source_modifie_le: modifieLe,
    source_sha256: createHash("sha256").update(archive).digest("hex"),
    source_octets: archive.length,
    ...resultat.rapport,
  };
  await writeFile(join(sortie, "rapport.json"), JSON.stringify(rapport, null, 2) + "\n", "utf8");
  const chiffres = rapport.derniere_annee_chiffres;
  console.log(
    `${rapport.nb_lignes} valeurs, ${rapport.nb_indicateurs} indicateurs, ${rapport.premiere_annee}–${rapport.derniere_annee}. ` +
      `${chiffres.annee} : ${chiffres.petrole_brut_production_kbj} kb/j de brut, ${chiffres.gaz_production_gm3} Gm³ de gaz, ` +
      `${chiffres.part_gaz_exportee_pct} % exportés.`
  );
}

if (process.argv[1]?.endsWith("/petrole-gaz/calculer.ts") || process.argv[1]?.endsWith("\\petrole-gaz\\calculer.ts")) {
  await principal();
}
