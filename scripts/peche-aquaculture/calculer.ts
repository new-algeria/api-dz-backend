/**
 * Extrait la production de la pêche et de l'aquaculture de l'Algérie depuis la FAO (FishStat, « Global production »).
 *
 * Source : fichier groupé GlobalProduction_<édition>.zip (CSV, CC BY 4.0), une ligne par pays, espèce, zone de pêche,
 * mode de production et année, depuis 1950, en tonnes de poids vif. Chaque valeur porte un statut (officielle,
 * estimée par la FAO, négligeable) : il est conservé et résumé en « part officielle ».
 *
 *   npx tsx scripts/peche-aquaculture/calculer.ts [--cache DOSSIER] [--sortie DOSSIER] [--sans-cache] [--edition 2026.1.0]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Papa from "papaparse";

const AGENT = "data-dz-peche/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;
export const CODE_ALGERIE = "012";
export const urlEdition = (edition: string) => `https://www.fao.org/fishery/static/Data/GlobalProduction_${edition}.zip`;

/** Éditions à essayer, de la plus récente à la plus ancienne (la FAO publie une ou deux éditions par an). */
export function editionsCandidates(annee = new Date().getUTCFullYear()): string[] {
  const editions: string[] = [];
  for (let a = annee + 1; a >= annee - 2; a--) for (const mineure of [3, 2, 1]) editions.push(`${a}.${mineure}.0`);
  return editions;
}

export type Mode = "CAPTURE" | "MARINE" | "BRACKISHWATER" | "FRESHWATER";

export interface LigneFao {
  espece: string;
  zone: string;
  mode: Mode;
  annee: number;
  tonnes: number;
  statut: string;
}

export interface Espece {
  code: string;
  fr: string;
  en: string;
  ar: string;
  scientifique: string;
  groupe: string;
}

/** Statuts SDMX de la FAO : seuls « A » (officiel) et « I » (estimé par la FAO) sont fréquents pour l'Algérie. */
export const STATUTS: Record<string, string> = {
  A: "officiel",
  I: "estimation FAO",
  E: "estimation",
  N: "négligeable (moins de 0,5 t)",
  P: "provisoire",
  B: "rupture de série",
  X: "organisation internationale",
};
const statutLisible = (code: string) => STATUTS[code] ?? `autre (${code || "vide"})`;

const MILIEUX: Record<Mode, string> = {
  CAPTURE: "pêche",
  MARINE: "aquaculture marine",
  BRACKISHWATER: "aquaculture en eau saumâtre",
  FRESHWATER: "aquaculture en eau douce",
};

/** Indicateurs du fichier principal : un filtre sur les lignes FAO. */
export const INDICATEURS: { libelle: string; garde: (ligne: LigneFao) => boolean }[] = [
  { libelle: "Pêche et aquaculture (total)", garde: () => true },
  { libelle: "Pêche en mer", garde: (l) => l.mode === "CAPTURE" && l.zone !== "01" },
  { libelle: "Pêche en eaux continentales", garde: (l) => l.mode === "CAPTURE" && l.zone === "01" },
  { libelle: "Aquaculture (total)", garde: (l) => l.mode !== "CAPTURE" },
  { libelle: "Aquaculture marine", garde: (l) => l.mode === "MARINE" },
  { libelle: "Aquaculture en eau saumâtre", garde: (l) => l.mode === "BRACKISHWATER" },
  { libelle: "Aquaculture en eau douce", garde: (l) => l.mode === "FRESHWATER" },
];

export interface LigneProduction {
  annee: number;
  indicateur: string;
  valeur: number;
  unite: "tonnes";
  part_officielle_pct: number | null;
}

export interface LigneEspece {
  annee: number;
  code_fao: string;
  espece: string;
  espece_en: string;
  espece_ar: string | null;
  nom_scientifique: string;
  groupe: string;
  milieu: string;
  zone: string;
  tonnes: number;
  statut: string;
}

export interface EspecePrincipale {
  annee: number;
  rang: number;
  code_fao: string;
  espece: string;
  espece_en: string;
  espece_ar: string | null;
  groupe: string;
  milieu: string;
  tonnes: number;
  part_pct: number;
  moyenne_10_ans_tonnes: number;
  statut: string;
}

export interface Rapport {
  genere_le: string;
  edition: string;
  source_url: string;
  source_modifie_le: string | null;
  source_sha256: string;
  source_octets: number;
  premiere_annee: number;
  derniere_annee: number;
  nb_indicateurs: number;
  nb_lignes_production: number;
  nb_lignes_especes: number;
  nb_especes: number;
  derniere_annee_chiffres: {
    annee: number;
    total_tonnes: number;
    peche_tonnes: number;
    aquaculture_tonnes: number;
    part_officielle_pct: number | null;
    premiere_espece: string;
    premiere_espece_part_pct: number;
  };
  annees_majoritairement_estimees: number[];
}

export interface ResultatCalcul {
  production: LigneProduction[];
  especes: LigneEspece[];
  principales: EspecePrincipale[];
  rapport: Omit<Rapport, "genere_le" | "edition" | "source_url" | "source_modifie_le" | "source_sha256" | "source_octets">;
}

const arrondi = (valeur: number, decimales = 0) => Math.round(valeur * 10 ** decimales) / 10 ** decimales;
const MODES = new Set<Mode>(["CAPTURE", "MARINE", "BRACKISHWATER", "FRESHWATER"]);

/** Une ligne du CSV FAO (déjà découpée), ou null si elle ne concerne pas l'Algérie ou n'est pas en tonnes. */
export function lireLigne(champs: string[]): LigneFao | null {
  const [pays, espece, zone, mode, mesure, periode, valeur, statut] = champs;
  if (pays !== CODE_ALGERIE || mesure !== "Q_tlw") return null;
  if (!MODES.has(mode as Mode)) throw new Error(`Mode de production inconnu : ${mode}.`);
  const annee = Number(periode);
  const tonnes = valeur === "" || valeur === undefined ? 0 : Number(valeur);
  if (!Number.isInteger(annee) || !Number.isFinite(tonnes) || tonnes < 0) throw new Error(`Ligne FAO invalide : ${champs.join(",")}.`);
  return { espece, zone, mode: mode as Mode, annee, tonnes, statut: statut ?? "" };
}

/** Production totale plausible pour l'Algérie (tonnes) : hors plage, erreur d'unité ou de pays. */
const PLAGE_TOTAL: [number, number] = [5_000, 1_000_000];

export function calculer(lignes: LigneFao[], especes: Map<string, Espece>): ResultatCalcul {
  if (!lignes.length) throw new Error("Aucune ligne pour l'Algérie dans le fichier FAO.");
  const annees = [...new Set(lignes.map((l) => l.annee))].sort((a, b) => a - b);

  const production: LigneProduction[] = [];
  for (const indicateur of INDICATEURS) {
    const parAnnee = new Map<number, { total: number; officiel: number }>();
    for (const ligne of lignes) {
      if (!indicateur.garde(ligne)) continue;
      const cumul = parAnnee.get(ligne.annee) ?? { total: 0, officiel: 0 };
      cumul.total += ligne.tonnes;
      if (ligne.statut === "A") cumul.officiel += ligne.tonnes;
      parAnnee.set(ligne.annee, cumul);
    }
    for (const annee of [...parAnnee.keys()].sort((a, b) => a - b)) {
      const { total, officiel } = parAnnee.get(annee)!;
      production.push({
        annee,
        indicateur: indicateur.libelle,
        valeur: arrondi(total),
        unite: "tonnes",
        part_officielle_pct: total > 0 ? arrondi((officiel / total) * 100, 1) : null,
      });
    }
  }
  for (const ligne of production.filter((l) => l.indicateur === INDICATEURS[0].libelle)) {
    if (ligne.valeur < PLAGE_TOTAL[0] || ligne.valeur > PLAGE_TOTAL[1]) {
      throw new Error(`Production totale invraisemblable en ${ligne.annee} : ${ligne.valeur} t.`);
    }
  }

  const detail: LigneEspece[] = lignes
    .map((ligne) => {
      const espece = especes.get(ligne.espece);
      if (!espece) throw new Error(`Espèce absente de la liste FAO : ${ligne.espece}.`);
      return {
        annee: ligne.annee,
        code_fao: espece.code,
        espece: espece.fr || espece.en,
        espece_en: espece.en,
        espece_ar: espece.ar || null,
        nom_scientifique: espece.scientifique,
        groupe: espece.groupe,
        milieu: MILIEUX[ligne.mode],
        zone: ligne.zone === "01" ? "eaux continentales" : ligne.zone === "37" ? "Méditerranée et mer Noire" : `zone FAO ${ligne.zone}`,
        tonnes: arrondi(ligne.tonnes, 1),
        statut: statutLisible(ligne.statut),
      };
    })
    .sort((a, b) => a.annee - b.annee || b.tonnes - a.tonnes || a.code_fao.localeCompare(b.code_fao));

  // Espèces principales de la dernière année (pêche et aquaculture d'une même espèce restent séparées).
  const derniere = annees.at(-1)!;
  const cle = (l: LigneFao) => `${l.espece}|${l.mode}`;
  const derniereAnnee = new Map<string, { tonnes: number; statuts: Map<string, number> }>();
  const decennie = new Map<string, number>();
  for (const ligne of lignes) {
    if (ligne.annee === derniere) {
      const cumul = derniereAnnee.get(cle(ligne)) ?? { tonnes: 0, statuts: new Map() };
      cumul.tonnes += ligne.tonnes;
      cumul.statuts.set(ligne.statut, (cumul.statuts.get(ligne.statut) ?? 0) + ligne.tonnes);
      derniereAnnee.set(cle(ligne), cumul);
    }
    if (ligne.annee > derniere - 10) decennie.set(cle(ligne), (decennie.get(cle(ligne)) ?? 0) + ligne.tonnes);
  }
  const totalDerniere = [...derniereAnnee.values()].reduce((somme, v) => somme + v.tonnes, 0);
  const principales: EspecePrincipale[] = [...derniereAnnee.entries()]
    .filter(([, v]) => v.tonnes > 0)
    .sort((a, b) => b[1].tonnes - a[1].tonnes)
    .slice(0, 30)
    .map(([code, v], index) => {
      const [codeEspece, mode] = code.split("|") as [string, Mode];
      const espece = especes.get(codeEspece)!;
      const statut = [...v.statuts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return {
        annee: derniere,
        rang: index + 1,
        code_fao: codeEspece,
        espece: espece.fr || espece.en,
        espece_en: espece.en,
        espece_ar: espece.ar || null,
        groupe: espece.groupe,
        milieu: MILIEUX[mode],
        tonnes: arrondi(v.tonnes),
        part_pct: arrondi((v.tonnes / totalDerniere) * 100, 1),
        moyenne_10_ans_tonnes: arrondi((decennie.get(code) ?? 0) / 10),
        statut: statutLisible(statut),
      };
    });

  const valeurDe = (indicateur: string, annee: number) => production.find((l) => l.indicateur === indicateur && l.annee === annee);
  const total = valeurDe(INDICATEURS[0].libelle, derniere)!;
  const estimees = production
    .filter((l) => l.indicateur === INDICATEURS[0].libelle && l.part_officielle_pct !== null && l.part_officielle_pct < 50)
    .map((l) => l.annee);

  return {
    production,
    especes: detail,
    principales,
    rapport: {
      premiere_annee: annees[0],
      derniere_annee: derniere,
      nb_indicateurs: new Set(production.map((l) => l.indicateur)).size,
      nb_lignes_production: production.length,
      nb_lignes_especes: detail.length,
      nb_especes: new Set(lignes.filter((l) => l.tonnes > 0).map((l) => l.espece)).size,
      derniere_annee_chiffres: {
        annee: derniere,
        total_tonnes: total.valeur,
        peche_tonnes: (valeurDe("Pêche en mer", derniere)?.valeur ?? 0) + (valeurDe("Pêche en eaux continentales", derniere)?.valeur ?? 0),
        aquaculture_tonnes: valeurDe("Aquaculture (total)", derniere)?.valeur ?? 0,
        part_officielle_pct: total.part_officielle_pct,
        premiere_espece: principales[0]?.espece ?? "",
        premiere_espece_part_pct: principales[0]?.part_pct ?? 0,
      },
      annees_majoritairement_estimees: estimees,
    },
  };
}

/** Contrôles avant publication : série depuis 1950 et année récente. */
export function verifier(resultat: ResultatCalcul, anneeCourante = new Date().getUTCFullYear()): void {
  const { rapport } = resultat;
  if (rapport.premiere_annee > 1950) throw new Error(`Série trop courte : début en ${rapport.premiere_annee}.`);
  if (rapport.derniere_annee < anneeCourante - 3) throw new Error(`Dernière année trop ancienne : ${rapport.derniere_annee}.`);
  if (rapport.nb_indicateurs !== INDICATEURS.length) throw new Error(`${rapport.nb_indicateurs} indicateurs au lieu de ${INDICATEURS.length}.`);
  if (rapport.nb_especes < 30) throw new Error(`Seulement ${rapport.nb_especes} espèces.`);
}

/** Liste des espèces (CL_FI_SPECIES_GROUPS.csv). */
export function lireEspeces(texte: string): Map<string, Espece> {
  const { data } = Papa.parse<Record<string, string>>(texte.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  const especes = new Map<string, Espece>();
  for (const ligne of data) {
    const code = ligne["3A_Code"]?.trim();
    if (!code) continue;
    especes.set(code, {
      code,
      fr: ligne.Name_Fr?.trim() ?? "",
      en: ligne.Name_En?.trim() ?? "",
      ar: ligne.Name_Ar?.trim() ?? "",
      scientifique: ligne.Scientific_Name?.trim() ?? "",
      groupe: ligne.ISSCAAP_Group_Fr?.trim() || ligne.ISSCAAP_Group_En?.trim() || "",
    });
  }
  if (especes.size < 1000) throw new Error(`Liste des espèces FAO incomplète (${especes.size}).`);
  return especes;
}

/** Ne garde que les lignes de l'Algérie : le CSV complet fait plus de 50 Mo. */
export async function lireProduction(lignes: AsyncIterable<string>): Promise<LigneFao[]> {
  const resultat: LigneFao[] = [];
  let entete = true;
  for await (const brute of lignes) {
    if (entete) {
      entete = false;
      if (!brute.includes("COUNTRY.UN_CODE")) throw new Error("En-tête inattendu du CSV de production FAO.");
      continue;
    }
    if (!brute.startsWith(`"${CODE_ALGERIE}"`)) continue;
    const champs = Papa.parse<string[]>(brute).data[0];
    const ligne = champs && lireLigne(champs.map((champ) => String(champ)));
    if (ligne) resultat.push(ligne);
  }
  return resultat;
}

function unzip(chemin: string, fichier: string) {
  const processus = spawn("unzip", ["-p", chemin, fichier], { stdio: ["ignore", "pipe", "inherit"] });
  const fin = new Promise<void>((resoudre, rejeter) => {
    processus.on("error", rejeter);
    processus.on("close", (code) => (code === 0 ? resoudre() : rejeter(new Error(`unzip ${fichier} a échoué (code ${code}).`))));
  });
  return { flux: processus.stdout, fin };
}

async function lireTexte(chemin: string, fichier: string): Promise<string> {
  const { flux, fin } = unzip(chemin, fichier);
  const morceaux: Buffer[] = [];
  for await (const morceau of flux) morceaux.push(morceau as Buffer);
  await fin;
  return Buffer.concat(morceaux).toString("utf8");
}

/** Dernière édition publiée : la première URL candidate qui répond 200. */
async function trouverEdition(): Promise<string> {
  for (const edition of editionsCandidates()) {
    const reponse = await fetch(urlEdition(edition), { method: "HEAD", headers: { "user-agent": AGENT } });
    if (reponse.ok) return edition;
  }
  throw new Error("Aucune édition GlobalProduction trouvée sur le site de la FAO.");
}

async function telecharger(cache: string, sansCache: boolean, editionImposee?: string) {
  const edition = editionImposee ?? (await trouverEdition());
  const chemin = join(cache, `GlobalProduction_${edition}.zip`);
  const meta = join(cache, `GlobalProduction_${edition}.meta.json`);
  if (!sansCache) {
    try {
      await stat(chemin);
      const { modifie_le } = JSON.parse(await readFile(meta, "utf8")) as { modifie_le: string | null };
      return { edition, chemin, modifieLe: modifie_le };
    } catch {
      // Pas encore en cache.
    }
  }
  await mkdir(cache, { recursive: true });
  const reponse = await fetch(urlEdition(edition), { headers: { "user-agent": AGENT } });
  if (!reponse.ok) throw new Error(`FAO : HTTP ${reponse.status} pour l'édition ${edition}.`);
  const contenu = Buffer.from(await reponse.arrayBuffer());
  if (contenu.length < 1_000_000) throw new Error(`Fichier FAO anormalement petit (${contenu.length} octets).`);
  await writeFile(`${chemin}.tmp`, contenu);
  await rename(`${chemin}.tmp`, chemin);
  const modifieLe = reponse.headers.get("last-modified");
  await writeFile(meta, JSON.stringify({ modifie_le: modifieLe }, null, 2) + "\n", "utf8");
  return { edition, chemin, modifieLe };
}

async function principal() {
  const option = (nom: string) => {
    const index = process.argv.indexOf(nom);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const cache = option("--cache") ?? join(DOSSIER, "cache");
  const sortie = option("--sortie") ?? join(DOSSIER, "sortie");
  const { edition, chemin, modifieLe } = await telecharger(cache, process.argv.includes("--sans-cache"), option("--edition"));
  const especes = lireEspeces(await lireTexte(chemin, "CL_FI_SPECIES_GROUPS.csv"));
  const { flux, fin } = unzip(chemin, "Global_production_quantity.csv");
  const lignes = await lireProduction(createInterface({ input: flux, crlfDelay: Infinity }));
  await fin;
  const resultat = calculer(lignes, especes);
  verifier(resultat);

  await mkdir(sortie, { recursive: true });
  const csv = (donnees: object[]) => Papa.unparse(donnees, { newline: "\n" }) + "\n";
  const fichiers: [string, object[]][] = [
    ["production-annuelle", resultat.production],
    ["production-par-espece", resultat.especes],
    ["especes-principales", resultat.principales],
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
    edition,
    source_url: urlEdition(edition),
    source_modifie_le: modifieLe,
    source_sha256: createHash("sha256").update(archive).digest("hex"),
    source_octets: archive.length,
    ...resultat.rapport,
  };
  await writeFile(join(sortie, "rapport.json"), JSON.stringify(rapport, null, 2) + "\n", "utf8");
  const c = rapport.derniere_annee_chiffres;
  console.log(
    `Édition ${edition} : ${rapport.premiere_annee}–${rapport.derniere_annee}, ${rapport.nb_especes} espèces. ` +
      `${c.annee} : ${c.total_tonnes} t (pêche ${c.peche_tonnes} t, aquaculture ${c.aquaculture_tonnes} t), ` +
      `${c.part_officielle_pct} % officiel ; 1re espèce ${c.premiere_espece} (${c.premiere_espece_part_pct} %).`
  );
}

if (process.argv[1]?.endsWith("/peche-aquaculture/calculer.ts") || process.argv[1]?.endsWith("\\peche-aquaculture\\calculer.ts")) {
  await principal();
}
