/**
 * Extrait la production agricole et le cheptel de l'Algérie depuis FAOSTAT (domaine « Production : cultures et
 * produits animaux », QCL).
 *
 * Source : fichier groupé « Africa » de FAOSTAT (CSV, une ligne par pays, produit et mesure, une colonne par année
 * depuis 1961, avec un code de statut par valeur), sans clé, licence CC BY 4.0.
 *
 *   npx tsx scripts/agriculture/calculer.ts [--cache DOSSIER] [--sortie DOSSIER] [--sans-cache]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Papa from "papaparse";

export const URL_SOURCE = "https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_Africa.zip";
const FICHIER_CSV = "Production_Crops_Livestock_E_Africa.csv";
const AGENT = "data-dz-agriculture/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;
/** Code FAOSTAT de l'Algérie (code M49 : 012). */
export const CODE_ALGERIE = "4";

/** Séries du fichier principal : produit FAOSTAT, mesure, libellé français et unité affichée. */
export const SELECTION = [
  { code: "1717", mesure: "Production", fr: "Céréales (total)" },
  { code: "15", mesure: "Production", fr: "Blé" },
  { code: "44", mesure: "Production", fr: "Orge" },
  { code: "1735", mesure: "Production", fr: "Légumes (total)" },
  { code: "116", mesure: "Production", fr: "Pommes de terre" },
  { code: "388", mesure: "Production", fr: "Tomates" },
  { code: "403", mesure: "Production", fr: "Oignons" },
  { code: "567", mesure: "Production", fr: "Pastèques" },
  { code: "426", mesure: "Production", fr: "Carottes et navets" },
  { code: "1738", mesure: "Production", fr: "Fruits (total)" },
  { code: "577", mesure: "Production", fr: "Dattes" },
  { code: "260", mesure: "Production", fr: "Olives" },
  { code: "1804", mesure: "Production", fr: "Agrumes (total)" },
  { code: "490", mesure: "Production", fr: "Oranges" },
  { code: "495", mesure: "Production", fr: "Mandarines et clémentines" },
  { code: "560", mesure: "Production", fr: "Raisins" },
  { code: "515", mesure: "Production", fr: "Pommes" },
  { code: "526", mesure: "Production", fr: "Abricots" },
  { code: "569", mesure: "Production", fr: "Figues" },
  { code: "221", mesure: "Production", fr: "Amandes" },
  { code: "1780", mesure: "Production", fr: "Lait (total)" },
  { code: "1765", mesure: "Production", fr: "Viandes (total)" },
  { code: "1808", mesure: "Production", fr: "Viande de volaille" },
  { code: "1807", mesure: "Production", fr: "Viande ovine et caprine" },
  { code: "1062", mesure: "Production", unite: "t", fr: "Œufs" },
  { code: "976", mesure: "Stocks", fr: "Moutons (cheptel)" },
  { code: "1016", mesure: "Stocks", fr: "Chèvres (cheptel)" },
  { code: "866", mesure: "Stocks", fr: "Bovins (cheptel)" },
  { code: "1126", mesure: "Stocks", fr: "Dromadaires (cheptel)" },
  { code: "1057", mesure: "Stocks", fr: "Poulets (cheptel)" },
] as const;

export const MESURES: Record<string, string> = {
  Production: "production",
  "Area harvested": "surface récoltée",
  Yield: "rendement",
  Stocks: "cheptel",
  "Producing Animals/Slaughtered": "animaux en production ou abattus",
  "Milk Animals": "animaux laitiers",
  Laying: "poules pondeuses",
  "Yield/Carcass Weight": "rendement en carcasse",
  "Prod Popultn": "population productive",
  "Extraction Rate": "taux d'extraction",
};

export const UNITES: Record<string, string> = {
  t: "tonnes",
  ha: "hectares",
  "kg/ha": "kg par hectare",
  An: "têtes",
  "1000 An": "milliers de têtes",
  "kg/An": "kg par animal",
  "g/An": "g par animal",
  No: "unités",
  "1000 No": "milliers d'unités",
  "No/An": "unités par animal",
  "%": "%",
};

/** Statuts FAOSTAT. Un statut vide est une valeur officielle dans les anciens fichiers. */
export const STATUTS: Record<string, string> = {
  A: "officiel",
  "": "officiel",
  E: "estimation FAO",
  I: "imputation FAO",
  X: "autre organisme international",
  B: "rupture de série",
  P: "provisoire",
};
const statutLisible = (code: string) => STATUTS[code] ?? `autre (${code})`;

/** Une valeur FAOSTAT de l'Algérie, normalisée. */
export interface ValeurFao {
  code_produit: string;
  produit: string;
  mesure: string;
  unite: string;
  annee: number;
  valeur: number;
  statut: string;
}

export interface LigneSelection {
  annee: number;
  indicateur: string;
  valeur: number;
  unite: string;
  /** Code FAOSTAT du statut (A officiel, E estimation, I imputation, X autre organisme) : ignoré par le graphique. */
  code_statut: string;
}

export interface LigneDetail {
  annee: number;
  code_produit: string;
  produit: string;
  produit_fr: string | null;
  mesure: string;
  unite: string;
  valeur: number;
  statut: string;
}

export interface LigneClassement {
  annee: number;
  rang: number;
  code_produit: string;
  produit: string;
  produit_fr: string | null;
  tonnes: number;
  statut: string;
}

export interface Rapport {
  genere_le: string;
  source_url: string;
  source_modifie_le: string | null;
  source_sha256: string;
  source_octets: number;
  premiere_annee: number;
  derniere_annee: number;
  derniere_annee_officielle: number;
  nb_indicateurs: number;
  nb_lignes_selection: number;
  nb_lignes_detail: number;
  nb_produits: number;
  part_officielle_par_annee: Record<string, number>;
  chiffres: Record<string, { annee: number; valeur: number; unite: string; statut: string }>;
}

export interface ResultatCalcul {
  selection: LigneSelection[];
  detail: LigneDetail[];
  classement: LigneClassement[];
  rapport: Omit<Rapport, "genere_le" | "source_url" | "source_modifie_le" | "source_sha256" | "source_octets">;
}

/** Les agrégats FAOSTAT (« Cereals, primary », « Fruit Primary »…) ont un code à partir de 1700. */
const estAgregat = (code: string) => Number(code) >= 1700;
const arrondi = (valeur: number) => Math.round(valeur * 100) / 100;

/** Lignes CSV de l'Algérie (format large) → une valeur par produit, mesure et année. */
export function lireLignes(lignes: Record<string, string>[]): ValeurFao[] {
  const valeurs: ValeurFao[] = [];
  for (const ligne of lignes) {
    if (ligne["Area Code"] !== CODE_ALGERIE) continue;
    const mesure = ligne.Element;
    const unite = ligne.Unit;
    for (const [colonne, brute] of Object.entries(ligne)) {
      const annee = /^Y(\d{4})$/.exec(colonne)?.[1];
      if (!annee || brute === undefined || brute.trim() === "") continue;
      const statut = (ligne[`${colonne}F`] ?? "").trim();
      if (statut === "M") continue;
      const valeur = Number(brute);
      if (!Number.isFinite(valeur) || valeur < 0) throw new Error(`Valeur FAOSTAT invalide : ${ligne.Item} ${annee} = ${brute}.`);
      valeurs.push({ code_produit: ligne["Item Code"], produit: ligne.Item, mesure, unite, annee: Number(annee), valeur, statut });
    }
  }
  return valeurs;
}

/** Plages plausibles (tonnes) des grands agrégats : hors plage, erreur d'unité ou de pays. */
const PLAGES: Record<string, [number, number]> = {
  "1717": [100_000, 30_000_000],
  "1735": [50_000, 50_000_000],
  "1738": [100_000, 50_000_000],
};

export function calculer(valeurs: ValeurFao[]): ResultatCalcul {
  if (!valeurs.length) throw new Error("Aucune valeur pour l'Algérie dans le fichier FAOSTAT.");
  const francais = new Map<string, string>(SELECTION.map((s) => [s.code, s.fr.replace(/ \((total|cheptel)\)$/, "")]));

  const selection: LigneSelection[] = [];
  const chiffres: Rapport["chiffres"] = {};
  for (const serie of SELECTION) {
    const uniteVoulue = "unite" in serie ? serie.unite : undefined;
    const points = valeurs
      .filter((v) => v.code_produit === serie.code && v.mesure === serie.mesure && (!uniteVoulue || v.unite === uniteVoulue))
      .sort((a, b) => a.annee - b.annee);
    if (!points.length) throw new Error(`Série FAOSTAT absente : ${serie.fr} (${serie.code}, ${serie.mesure}).`);
    for (const point of points) {
      const plage = serie.mesure === "Production" ? PLAGES[serie.code] : undefined;
      if (plage && (point.valeur < plage[0] || point.valeur > plage[1])) {
        throw new Error(`Valeur invraisemblable pour ${serie.fr} en ${point.annee} : ${point.valeur} t.`);
      }
      selection.push({ annee: point.annee, indicateur: serie.fr, valeur: arrondi(point.valeur), unite: UNITES[point.unite] ?? point.unite, code_statut: point.statut || "A" });
    }
    const dernier = points.at(-1)!;
    chiffres[serie.code] = { annee: dernier.annee, valeur: arrondi(dernier.valeur), unite: UNITES[dernier.unite] ?? dernier.unite, statut: statutLisible(dernier.statut) };
  }
  selection.sort((a, b) => a.indicateur.localeCompare(b.indicateur, "fr") || a.annee - b.annee);

  const detail: LigneDetail[] = valeurs
    .map((v) => ({
      annee: v.annee,
      code_produit: v.code_produit,
      produit: v.produit,
      produit_fr: francais.get(v.code_produit) ?? null,
      mesure: MESURES[v.mesure] ?? v.mesure,
      unite: UNITES[v.unite] ?? v.unite,
      valeur: arrondi(v.valeur),
      statut: statutLisible(v.statut),
    }))
    .sort((a, b) => a.annee - b.annee || a.produit.localeCompare(b.produit) || a.mesure.localeCompare(b.mesure));

  // Part officielle de chaque année : tonnage des productions élémentaires (hors agrégats) déclaré officiellement.
  const production = valeurs.filter((v) => v.mesure === "Production" && v.unite === "t" && !estAgregat(v.code_produit));
  const parAnnee = new Map<number, { total: number; officiel: number }>();
  for (const v of production) {
    const cumul = parAnnee.get(v.annee) ?? { total: 0, officiel: 0 };
    cumul.total += v.valeur;
    if (v.statut === "A" || v.statut === "") cumul.officiel += v.valeur;
    parAnnee.set(v.annee, cumul);
  }
  const annees = [...parAnnee.keys()].sort((a, b) => a - b);
  const part = Object.fromEntries(annees.map((a) => [String(a), parAnnee.get(a)!.total ? Math.round((parAnnee.get(a)!.officiel / parAnnee.get(a)!.total) * 1000) / 10 : 0]));
  const officielles = annees.filter((a) => part[String(a)] >= 50);
  if (!officielles.length) throw new Error("Aucune année majoritairement officielle.");
  const derniereOfficielle = officielles.at(-1)!;
  const derniere = annees.at(-1)!;

  // Classement des productions élémentaires : dernière année officielle et dernière année publiée.
  const classement: LigneClassement[] = [...new Set([derniereOfficielle, derniere])].flatMap((annee) =>
    production
      .filter((v) => v.annee === annee && v.valeur > 0)
      .sort((a, b) => b.valeur - a.valeur)
      .slice(0, 30)
      .map((v, index) => ({
        annee,
        rang: index + 1,
        code_produit: v.code_produit,
        produit: v.produit,
        produit_fr: francais.get(v.code_produit) ?? null,
        tonnes: Math.round(v.valeur),
        statut: statutLisible(v.statut),
      }))
  );

  return {
    selection,
    detail,
    classement,
    rapport: {
      premiere_annee: Math.min(...valeurs.map((v) => v.annee)),
      derniere_annee: derniere,
      derniere_annee_officielle: derniereOfficielle,
      nb_indicateurs: SELECTION.length,
      nb_lignes_selection: selection.length,
      nb_lignes_detail: detail.length,
      nb_produits: new Set(valeurs.map((v) => v.code_produit)).size,
      part_officielle_par_annee: part,
      chiffres,
    },
  };
}

/** Contrôles avant publication. */
export function verifier(resultat: ResultatCalcul, anneeCourante = new Date().getUTCFullYear()): void {
  const { rapport } = resultat;
  if (rapport.premiere_annee > 1961) throw new Error(`Série trop courte : début en ${rapport.premiere_annee}.`);
  if (rapport.derniere_annee < anneeCourante - 4) throw new Error(`Dernière année trop ancienne : ${rapport.derniere_annee}.`);
  if (rapport.nb_produits < 50) throw new Error(`Seulement ${rapport.nb_produits} produits.`);
}

/** Lit l'en-tête puis seulement les lignes de l'Algérie (le CSV de l'Afrique fait plus de 15 Mo). */
export async function lireCsvAlgerie(lignes: AsyncIterable<string>): Promise<Record<string, string>[]> {
  let entete: string[] | null = null;
  const resultat: Record<string, string>[] = [];
  for await (const brute of lignes) {
    if (!entete) {
      entete = Papa.parse<string[]>(brute.replace(/^﻿/, "")).data[0];
      if (!entete?.includes("Area Code") || !entete.includes("Element")) throw new Error("En-tête inattendu du CSV FAOSTAT.");
      continue;
    }
    if (!brute.startsWith(`"${CODE_ALGERIE}",`)) continue;
    const champs = Papa.parse<string[]>(brute).data[0] ?? [];
    resultat.push(Object.fromEntries(entete.map((nom, index) => [nom, champs[index] ?? ""])));
  }
  return resultat;
}

async function telecharger(cache: string, sansCache: boolean) {
  const chemin = join(cache, "faostat-qcl-afrique.zip");
  const meta = join(cache, "faostat-qcl-afrique.meta.json");
  if (!sansCache) {
    try {
      const infos = await stat(chemin);
      if (Date.now() - infos.mtimeMs < 12 * 3600 * 1000) {
        const { modifie_le } = JSON.parse(await readFile(meta, "utf8")) as { modifie_le: string | null };
        return { chemin, modifieLe: modifie_le };
      }
    } catch {
      // Pas de cache.
    }
  }
  await mkdir(cache, { recursive: true });
  const reponse = await fetch(URL_SOURCE, { headers: { "user-agent": AGENT } });
  if (!reponse.ok) throw new Error(`FAOSTAT : HTTP ${reponse.status}.`);
  const contenu = Buffer.from(await reponse.arrayBuffer());
  if (contenu.length < 500_000) throw new Error(`Fichier FAOSTAT anormalement petit (${contenu.length} octets).`);
  await writeFile(`${chemin}.tmp`, contenu);
  await rename(`${chemin}.tmp`, chemin);
  const modifieLe = reponse.headers.get("last-modified");
  await writeFile(meta, JSON.stringify({ modifie_le: modifieLe }, null, 2) + "\n", "utf8");
  return { chemin, modifieLe };
}

async function lireArchive(chemin: string) {
  const processus = spawn("unzip", ["-p", chemin, FICHIER_CSV], { stdio: ["ignore", "pipe", "inherit"] });
  const fin = new Promise<void>((resoudre, rejeter) => {
    processus.on("error", rejeter);
    processus.on("close", (code) => (code === 0 ? resoudre() : rejeter(new Error(`unzip a échoué (code ${code}).`))));
  });
  const lignes = await lireCsvAlgerie(createInterface({ input: processus.stdout, crlfDelay: Infinity }));
  await fin;
  return lignes;
}

async function principal() {
  const option = (nom: string, defaut: string) => {
    const index = process.argv.indexOf(nom);
    return index >= 0 ? process.argv[index + 1] || defaut : defaut;
  };
  const cache = option("--cache", join(DOSSIER, "cache"));
  const sortie = option("--sortie", join(DOSSIER, "sortie"));
  const { chemin, modifieLe } = await telecharger(cache, process.argv.includes("--sans-cache"));
  const resultat = calculer(lireLignes(await lireArchive(chemin)));
  verifier(resultat);

  await mkdir(sortie, { recursive: true });
  const csv = (donnees: object[]) => Papa.unparse(donnees, { newline: "\n" }) + "\n";
  const fichiers: [string, object[]][] = [
    ["principales-productions", resultat.selection],
    ["production-detaillee", resultat.detail],
    ["classement-produits", resultat.classement],
  ];
  await Promise.all(
    fichiers.flatMap(([nom, donnees]) => [
      writeFile(join(sortie, `${nom}.json`), JSON.stringify(donnees) + "\n", "utf8"),
      writeFile(join(sortie, `${nom}.csv`), csv(donnees), "utf8"),
    ])
  );
  const archive = await readFile(chemin);
  const rapport: Rapport = {
    genere_le: new Date().toISOString(),
    source_url: URL_SOURCE,
    source_modifie_le: modifieLe,
    source_sha256: createHash("sha256").update(archive).digest("hex"),
    source_octets: archive.length,
    ...resultat.rapport,
  };
  await writeFile(join(sortie, "rapport.json"), JSON.stringify(rapport, null, 2) + "\n", "utf8");
  const c = rapport.chiffres;
  console.log(
    `${rapport.nb_lignes_detail} valeurs, ${rapport.nb_produits} produits, ${rapport.premiere_annee}–${rapport.derniere_annee} ` +
      `(dernière année officielle : ${rapport.derniere_annee_officielle}). Dattes ${c["577"].annee} : ${c["577"].valeur} t (${c["577"].statut}) ; ` +
      `blé ${c["15"].annee} : ${c["15"].valeur} t (${c["15"].statut}) ; moutons ${c["976"].annee} : ${c["976"].valeur} têtes.`
  );
}

if (process.argv[1]?.endsWith("/agriculture/calculer.ts") || process.argv[1]?.endsWith("\\agriculture\\calculer.ts")) {
  await principal();
}
