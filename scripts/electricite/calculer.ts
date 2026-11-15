/**
 * Extrait les statistiques annuelles d'électricité pour l'Algérie depuis Ember.
 *
 * Source : Yearly Electricity Data, fichier global CSV (CC BY 4.0).
 * Le fichier national conserve les lignes par source énergétique et les agrégats,
 * avec un indicateur explicite pour ne pas les additionner deux fois.
 *
 *   npx tsx scripts/electricite/calculer.ts [--cache DOSSIER] [--sortie DOSSIER] [--sans-cache]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Papa from "papaparse";

export const URL_SOURCE =
  "https://files.ember-energy.org/public-downloads/generation/outputs/release_generation_yearly_global.csv";
const AGENT = "data-dz-electricite/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;

type LigneSource = Record<string, string | undefined>;

export interface LigneElectricite {
  annee: number;
  pays: string;
  code_iso3: string;
  source_electricite: string;
  type_ligne: "demande" | "echanges_nets" | "production_totale" | "agregat" | "production_par_source";
  source_agregee: boolean;
  valeur_twh: number | null;
  variation_twh: number | null;
  variation_pct: number | null;
  part_generation_pct: number | null;
  variation_part_generation_points: number | null;
  capacite_gw: number | null;
  emissions_mtco2e: number | null;
  variation_emissions_mtco2e: number | null;
  variation_emissions_pct: number | null;
  part_emissions_pct: number | null;
  intensite_emissions_gco2e_kwh: number | null;
}

export interface IndicateurAnnuel {
  annee: number;
  production_totale_twh: number | null;
  demande_electricite_twh: number | null;
  importations_nettes_twh: number | null;
  capacite_installee_gw: number | null;
  emissions_mtco2e: number | null;
  intensite_emissions_gco2e_kwh: number | null;
}

export interface Rapport {
  genere_le: string;
  source_url: string;
  source_modifie_le: string | null;
  source_etag: string | null;
  source_sha256: string;
  source_octets: number;
  pays: string;
  code_iso3: string;
  premiere_annee: number;
  derniere_annee: number;
  annees: number[];
  nb_lignes: number;
  nb_series: number;
  nb_sources_electricite: number;
  reference_2024: {
    production_totale_twh: number;
    demande_electricite_twh: number;
    controle: "conforme";
  };
}

export interface ResultatCalcul {
  lignes: LigneElectricite[];
  indicateurs: IndicateurAnnuel[];
  rapport: Omit<Rapport, "genere_le" | "source_modifie_le" | "source_etag" | "source_sha256" | "source_octets">;
}

const COLONNES_REQUISES = [
  "Area",
  "ISO 3 code",
  "Year",
  "Electricity source",
  "Is aggregated source",
  "Generation (TWh)",
] as const;

function nombre(texte: string | undefined, colonne: string): number | null {
  const valeur = (texte ?? "").trim();
  if (!valeur || valeur === "-" || valeur === "—" || valeur.toLowerCase() === "na") return null;
  const resultat = Number(valeur);
  if (!Number.isFinite(resultat)) throw new Error(`Valeur numérique invalide dans « ${colonne} » : ${valeur}`);
  return resultat;
}

function booleen(texte: string | undefined): boolean {
  const valeur = (texte ?? "").trim().toLowerCase();
  if (["true", "1", "yes"].includes(valeur)) return true;
  if (["false", "0", "no"].includes(valeur)) return false;
  throw new Error(`Valeur booléenne invalide pour « Is aggregated source » : ${texte ?? ""}`);
}

function typeLigne(source: string, agregee: boolean): LigneElectricite["type_ligne"] {
  const nom = source.trim().toLowerCase();
  if (nom === "demand") return "demande";
  if (nom === "net imports") return "echanges_nets";
  if (nom === "total generation") return "production_totale";
  if (agregee) return "agregat";
  return "production_par_source";
}

function valeurObligatoire(ligne: LigneElectricite | undefined, champ: keyof LigneElectricite, annee: number): number {
  const valeur = ligne?.[champ];
  if (typeof valeur !== "number" || !Number.isFinite(valeur)) {
    throw new Error(`Valeur absente pour ${String(champ)} en ${annee}.`);
  }
  return valeur;
}

/** Analyse le CSV public Ember et garde exclusivement l'Algérie (ISO 3166-1 alpha-3 : DZA). */
export function analyserCsv(texte: string): ResultatCalcul {
  const parse = Papa.parse<LigneSource>(texte.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (entete) => entete.trim(),
  });
  if (parse.errors.length) {
    const detail = parse.errors.slice(0, 3).map((erreur) => erreur.message).join("; ");
    throw new Error(`CSV Ember illisible : ${detail}`);
  }

  const entetes = parse.meta.fields ?? [];
  const manquantes = COLONNES_REQUISES.filter((colonne) => !entetes.includes(colonne));
  if (manquantes.length) throw new Error(`Colonnes Ember manquantes : ${manquantes.join(", ")}`);

  const algerie = parse.data.filter((ligne) => ligne["ISO 3 code"]?.trim().toUpperCase() === "DZA");
  if (!algerie.length) throw new Error("Aucune ligne algérienne (ISO 3 code = DZA) trouvée dans le fichier Ember.");

  const lignes: LigneElectricite[] = algerie.map((ligne) => {
    const annee = nombre(ligne.Year, "Year");
    if (annee === null || !Number.isInteger(annee) || annee < 1900 || annee > 2100) {
      throw new Error(`Année invalide dans le fichier Ember : ${ligne.Year ?? ""}`);
    }
    const source = ligne["Electricity source"]?.trim();
    if (!source) throw new Error(`Source électrique absente en ${annee}.`);
    const sourceAgregee = booleen(ligne["Is aggregated source"]);
    return {
      annee,
      pays: ligne.Area?.trim() || "Algeria",
      code_iso3: "DZA",
      source_electricite: source,
      type_ligne: typeLigne(source, sourceAgregee),
      source_agregee: sourceAgregee,
      valeur_twh: nombre(ligne["Generation (TWh)"], "Generation (TWh)"),
      variation_twh: nombre(ligne["Generation YoY change (TWh)"], "Generation YoY change (TWh)"),
      variation_pct: nombre(ligne["Generation YoY change (%)"], "Generation YoY change (%)"),
      part_generation_pct: nombre(ligne["Share of generation (%)"], "Share of generation (%)"),
      variation_part_generation_points: nombre(
        ligne["Share of generation YoY change (% points)"],
        "Share of generation YoY change (% points)"
      ),
      capacite_gw: nombre(ligne["Capacity (GW)"], "Capacity (GW)"),
      emissions_mtco2e: nombre(ligne["Emissions (MtCO2e)"], "Emissions (MtCO2e)"),
      variation_emissions_mtco2e: nombre(ligne["Emissions YoY change (MtCO2e)"], "Emissions YoY change (MtCO2e)"),
      variation_emissions_pct: nombre(ligne["Emissions YoY change (%)"], "Emissions YoY change (%)"),
      part_emissions_pct: nombre(ligne["Share of emissions (%)"], "Share of emissions (%)"),
      intensite_emissions_gco2e_kwh: nombre(
        ligne["Emissions intensity (gCO2e/kWh)"],
        "Emissions intensity (gCO2e/kWh)"
      ),
    };
  });

  const cles = new Set<string>();
  for (const ligne of lignes) {
    const cle = `${ligne.annee}|${ligne.source_electricite}`;
    if (cles.has(cle)) throw new Error(`Ligne Ember en double : ${cle}.`);
    cles.add(cle);
  }
  lignes.sort((a, b) => a.annee - b.annee || a.source_electricite.localeCompare(b.source_electricite, "en"));

  const parAnnee = new Map<number, LigneElectricite[]>();
  for (const ligne of lignes) parAnnee.set(ligne.annee, [...(parAnnee.get(ligne.annee) ?? []), ligne]);

  const indicateurs: IndicateurAnnuel[] = [...parAnnee.entries()].sort(([a], [b]) => a - b).map(([annee, donnees]) => {
    const chercher = (source: string) => donnees.find((ligne) => ligne.source_electricite.toLowerCase() === source.toLowerCase());
    const total = chercher("Total generation");
    const demande = chercher("Demand");
    const importations = chercher("Net imports");
    return {
      annee,
      production_totale_twh: total?.valeur_twh ?? null,
      demande_electricite_twh: demande?.valeur_twh ?? null,
      importations_nettes_twh: importations?.valeur_twh ?? null,
      capacite_installee_gw: total?.capacite_gw ?? null,
      emissions_mtco2e: total?.emissions_mtco2e ?? null,
      intensite_emissions_gco2e_kwh: total?.intensite_emissions_gco2e_kwh ?? null,
    };
  });

  const reference = indicateurs.find((ligne) => ligne.annee === 2024);
  const production2024 = valeurObligatoire(
    lignes.find((ligne) => ligne.annee === 2024 && ligne.type_ligne === "production_totale"),
    "valeur_twh",
    2024
  );
  const demande2024 = valeurObligatoire(
    lignes.find((ligne) => ligne.annee === 2024 && ligne.type_ligne === "demande"),
    "valeur_twh",
    2024
  );
  // Contrôle anti-décalage d'unité/pays : références Ember publiées pour 2024, avec tolérance aux révisions.
  if (production2024 < 94 || production2024 > 99 || demande2024 < 92 || demande2024 > 96) {
    throw new Error(
      `Contrôle 2024 inattendu : production ${production2024} TWh, demande ${demande2024} TWh (références ≈ 96,36 et 93,84 TWh).`
    );
  }
  if (!reference) throw new Error("L'année de référence 2024 manque dans le fichier Ember.");
  if (!parAnnee.has(2000)) throw new Error("La première année historique attendue (2000) manque dans le fichier Ember.");
  if (indicateurs.length < 20 || lignes.length < 80) throw new Error("Couverture Ember anormalement faible pour l'Algérie.");

  const annees = indicateurs.map((ligne) => ligne.annee);
  return {
    lignes,
    indicateurs,
    rapport: {
      source_url: URL_SOURCE,
      pays: "Algérie",
      code_iso3: "DZA",
      premiere_annee: Math.min(...annees),
      derniere_annee: Math.max(...annees),
      annees,
      nb_lignes: lignes.length,
      nb_series: indicateurs.length,
      nb_sources_electricite: new Set(lignes.map((ligne) => ligne.source_electricite)).size,
      reference_2024: {
        production_totale_twh: production2024,
        demande_electricite_twh: demande2024,
        controle: "conforme",
      },
    },
  };
}

async function telecharger(cache: string, sansCache: boolean): Promise<{
  texte: string;
  modifieLe: string | null;
  etag: string | null;
}> {
  const chemin = join(cache, "ember-yearly.csv");
  const metaPath = join(cache, "ember-yearly.meta.json");
  if (!sansCache) {
    try {
      const [texte, meta] = await Promise.all([
        readFile(chemin, "utf8"),
        readFile(metaPath, "utf8").catch(() => "{}"),
      ]);
      const metadata = JSON.parse(meta) as { modifie_le?: string | null; etag?: string | null };
      if (texte.trim()) return { texte, modifieLe: metadata.modifie_le ?? null, etag: metadata.etag ?? null };
    } catch {
      // Cache absent ou incomplet : téléchargement réseau.
    }
  }

  await mkdir(cache, { recursive: true });
  console.log(`Téléchargement du CSV Ember : ${URL_SOURCE}`);
  const reponse = await fetch(URL_SOURCE, {
    headers: { "user-agent": AGENT, accept: "text/csv" },
    signal: AbortSignal.timeout(180_000),
  });
  if (!reponse.ok) throw new Error(`Téléchargement Ember impossible : HTTP ${reponse.status}.`);
  const texte = await reponse.text();
  if (texte.length < 10_000 || !texte.includes("ISO 3 code") || !texte.includes("Electricity source")) {
    throw new Error("La réponse Ember ne ressemble pas au CSV mondial attendu.");
  }
  const temporaire = `${chemin}.part`;
  const metaTemporaire = `${metaPath}.part`;
  const modifieLe = reponse.headers.get("last-modified");
  const etag = reponse.headers.get("etag");
  await writeFile(temporaire, texte, "utf8");
  await writeFile(metaTemporaire, JSON.stringify({ modifie_le: modifieLe, etag }, null, 2) + "\n", "utf8");
  await rename(temporaire, chemin);
  await rename(metaTemporaire, metaPath);
  return { texte, modifieLe, etag };
}

async function ecrireSorties(sortie: string, resultat: ResultatCalcul, source: {
  modifieLe: string | null;
  etag: string | null;
  sha256: string;
  octets: number;
}): Promise<void> {
  await mkdir(sortie, { recursive: true });
  const json = JSON.stringify(resultat.lignes, null, 1) + "\n";
  const csv = Papa.unparse(resultat.lignes, { newline: "\n" }) + "\n";
  const indicateursJson = JSON.stringify(resultat.indicateurs, null, 1) + "\n";
  const indicateursCsv = Papa.unparse(resultat.indicateurs, { newline: "\n" }) + "\n";
  await Promise.all([
    writeFile(join(sortie, "electricite-algerie.json"), json, "utf8"),
    writeFile(join(sortie, "electricite-algerie.csv"), csv, "utf8"),
    writeFile(join(sortie, "electricite-algerie-indicateurs.json"), indicateursJson, "utf8"),
    writeFile(join(sortie, "electricite-algerie-indicateurs.csv"), indicateursCsv, "utf8"),
  ]);
  const rapport: Rapport = {
    genere_le: new Date().toISOString(),
    ...resultat.rapport,
    source_modifie_le: source.modifieLe,
    source_etag: source.etag,
    source_sha256: source.sha256,
    source_octets: source.octets,
  };
  await writeFile(join(sortie, "rapport.json"), JSON.stringify(rapport, null, 2) + "\n", "utf8");
  console.log(
    `${rapport.nb_lignes} observations, ${rapport.nb_series} années, ${rapport.premiere_annee}–${rapport.derniere_annee} ; ` +
      `2024 : ${rapport.reference_2024.production_totale_twh} TWh produits / ${rapport.reference_2024.demande_electricite_twh} TWh de demande.`
  );
}

async function main(): Promise<void> {
  const option = (nom: string, defaut: string) => {
    const index = process.argv.indexOf(nom);
    return index >= 0 ? process.argv[index + 1] || defaut : defaut;
  };
  const cache = option("--cache", join(DOSSIER, "cache"));
  const sortie = option("--sortie", join(DOSSIER, "sortie"));
  const sansCache = process.argv.includes("--sans-cache");
  const telechargement = await telecharger(cache, sansCache);
  const resultat = analyserCsv(telechargement.texte);
  const empreinte = createHash("sha256").update(telechargement.texte).digest("hex");
  await ecrireSorties(sortie, resultat, {
    modifieLe: telechargement.modifieLe,
    etag: telechargement.etag,
    sha256: empreinte,
    octets: Buffer.byteLength(telechargement.texte, "utf8"),
  });
}

if (process.argv[1]?.endsWith("/electricite/calculer.ts") || process.argv[1]?.endsWith("\\electricite\\calculer.ts")) {
  main().catch((erreur: unknown) => {
    console.error(erreur instanceof Error ? erreur.message : erreur);
    process.exitCode = 1;
  });
}
