/**
 * Collecte les relevés publics de prix des Directions du commerce de wilaya.
 *
 * Périmètre initial vérifié : Direction du commerce de Jijel. Les sources nationales
 * non ventilées par wilaya et les plateformes intranet ne sont jamais utilisées.
 *
 * Sorties JSON/CSV au format long. Une observation = un produit, une wilaya,
 * une date et un couple de prix (gros/détail). Les "-" restent null.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Observation {
  date_observation: string;
  code_wilaya: string;
  wilaya: string;
  wilaya_ar: string | null;
  produit: string;
  categorie: string | null;
  unite: string | null;
  prix_gros_da: number | null;
  prix_detail_da: number | null;
  source: string;
  source_url: string;
  collecte_le: string;
}

export interface Source {
  code_wilaya: string;
  wilaya: string;
  wilaya_ar?: string;
  source: string;
  url: string;
}

export const SOURCES: Source[] = [
  {
    code_wilaya: "18",
    wilaya: "Jijel",
    wilaya_ar: "جيجل",
    source: "Direction du commerce de la wilaya de Jijel",
    url: "https://dcwjijel.dz/index.php/moy-prix/prix-journ",
  },
];

function decodeHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&eacute;/gi, "é").replace(/&egrave;/gi, "è")
    .replace(/&ecirc;/gi, "ê").replace(/&agrave;/gi, "à")
    .replace(/&ccedil;/gi, "ç").replace(/&ocirc;/gi, "ô")
    .replace(/&uuml;/gi, "ü").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ").trim();
}

export function extraireDate(html: string): string {
  const texte = decodeHtml(html);
  const match = texte.match(/(?:Journée|Journee|Date)\s+du\s+(\d{1,2})[-/](\d{1,2})[-/](\d{4})/i);
  if (!match) throw new Error("Date du relevé introuvable : refus d'attribuer une date de collecte à la place.");
  const [, jour, mois, annee] = match;
  const date = `${annee}-${mois.padStart(2, "0")}-${jour.padStart(2, "0")}`;
  if (Number(mois) < 1 || Number(mois) > 12 || Number(jour) < 1 || Number(jour) > 31) throw new Error("Date du relevé invalide.");
  return date;
}

function prix(cellule: string): number | null {
  const texte = decodeHtml(cellule).replace(/[\s\u202f]/g, "").replace(",", ".");
  if (!texte || texte === "-" || texte === "—") return null;
  const valeur = Number(texte);
  return Number.isFinite(valeur) && valeur >= 0 ? valeur : null;
}

function uniteEtProduit(label: string): { produit: string; unite: string | null } {
  const texte = decodeHtml(label);
  const unite = texte.match(/\b(\d+(?:[.,]\d+)?\s*(?:kg|Kg|KG|g|grs?|L|l|litre|litres|unité|Unite|unite|p\s*\*\s*\d+\s*g))\b/i)?.[1] ?? null;
  return { produit: texte.replace(/\s+/g, " ").trim(), unite };
}

export function parserReleve(html: string, source: Source, collecteLe = new Date().toISOString()): Observation[] {
  const date = extraireDate(html);
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]);
  const lignes: Observation[] = [];
  let categorie: string | null = null;
  for (const table of tables) {
    for (const ligne of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cellules = [...ligne[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => decodeHtml(m[1]));
      if (cellules.length === 1 && cellules[0] && !/^(?:prix|produits|produit)$/i.test(cellules[0])) {
        categorie = cellules[0];
        continue;
      }
      if (cellules.length < 3) continue;
      const [label, gros, detail] = cellules;
      if (!label || /produit|prix de gros|prix de détail/i.test(label)) continue;
      const pg = prix(gros), pd = prix(detail);
      // Écarte les en-têtes et les lignes sans aucune valeur publiée.
      if (pg === null && pd === null) continue;
      const info = uniteEtProduit(label);
      lignes.push({
        date_observation: date,
        code_wilaya: source.code_wilaya,
        wilaya: source.wilaya,
        wilaya_ar: source.wilaya_ar ?? null,
        produit: info.produit,
        categorie,
        unite: info.unite,
        prix_gros_da: pg,
        prix_detail_da: pd,
        source: source.source,
        source_url: source.url,
        collecte_le: collecteLe,
      });
    }
  }
  if (lignes.length < 5) throw new Error(`Relevé non reconnu ou incomplet : seulement ${lignes.length} lignes exploitables.`);
  return lignes;
}

async function main() {
  const sortieArg = process.argv.indexOf("--sortie");
  const sortie = sortieArg >= 0 ? process.argv[sortieArg + 1] : join(import.meta.dirname, "sortie");
  const collecteLe = new Date().toISOString();
  const observations: Observation[] = [];
  const erreurs: { source: string; url: string; erreur: string }[] = [];
  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url, {
        headers: { "user-agent": "data-dz-prix-alimentaires/1.0 (+https://github.com/new-algeria/api-dz-backend)", accept: "text/html" },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      observations.push(...parserReleve(await response.text(), source, collecteLe));
    } catch (error) {
      erreurs.push({ source: source.source, url: source.url, erreur: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!observations.length) throw new Error("Aucun relevé public exploitable. " + JSON.stringify(erreurs));
  // Clé naturelle : pas de doublon produit/date/wilaya/source.
  const uniques = new Map<string, Observation>();
  for (const o of observations) uniques.set([o.date_observation,o.code_wilaya,o.produit,o.unite,o.source].join("|"), o);
  const lignes = [...uniques.values()].sort((a,b) => a.date_observation.localeCompare(b.date_observation) || a.code_wilaya.localeCompare(b.code_wilaya) || a.produit.localeCompare(b.produit));
  await mkdir(sortie, { recursive: true });
  await writeFile(join(sortie,"prix-alimentaires-wilayas.json"), JSON.stringify(lignes,null,1)+"\n");
  const champs = Object.keys(lignes[0]) as (keyof Observation)[];
  const csv = [champs.join(","), ...lignes.map(o => champs.map(k => {
    const v = o[k] === null ? "" : String(o[k]);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v;
  }).join(","))].join("\n") + "\n";
  await writeFile(join(sortie,"prix-alimentaires-wilayas.csv"), csv);
  await writeFile(join(sortie,"rapport.json"), JSON.stringify({
    genere_le: collecteLe, nb_observations: lignes.length,
    wilayas: [...new Set(lignes.map(o=>o.code_wilaya))],
    dates: [...new Set(lignes.map(o=>o.date_observation))].sort(),
    erreurs, sources_configurees: SOURCES.length,
    couverture: "Partielle : seules les wilayas disposant d'un relevé public vérifié sont incluses."
  },null,2)+"\n");
  console.log(`${lignes.length} observations, ${new Set(lignes.map(o=>o.code_wilaya)).size} wilaya(s), ${erreurs.length} source(s) en erreur.`);
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
