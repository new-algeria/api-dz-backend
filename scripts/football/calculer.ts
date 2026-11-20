/**
 * Tous les matchs de l'équipe d'Algérie masculine de football, depuis 1963, et leurs synthèses.
 *
 * Source : « International football results from 1872 », de Mart Jürisoo (github.com/martj42/international_results),
 * domaine public (CC0 1.0). Trois CSV : résultats, buteurs (partiels), séances de tirs au but.
 *
 *   npx tsx scripts/football/calculer.ts [--cache DOSSIER] [--sortie DOSSIER] [--sans-cache]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Papa from "papaparse";

export const DEPOT_SOURCE = "https://github.com/martj42/international_results";
const BASE_BRUTE = "https://raw.githubusercontent.com/martj42/international_results/master";
export const FICHIERS_SOURCE = ["results", "goalscorers", "shootouts"] as const;
type FichierSource = (typeof FICHIERS_SOURCE)[number];
const AGENT = "data-dz-football/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;
/** Nom de l'équipe dans la source (l'Algérie n'a jamais changé de nom dans `former_names.csv`). */
export const EQUIPE = "Algeria";

type LigneSource = Record<string, string | undefined>;
export type Resultat = "victoire" | "nul" | "defaite";
export type Lieu = "domicile" | "exterieur" | "neutre";

export interface Match {
  date: string;
  annee: number;
  competition: string;
  competition_fr: string;
  adversaire: string;
  lieu: Lieu;
  ville: string;
  pays: string;
  buts_algerie: number;
  buts_adversaire: number;
  resultat: Resultat;
  /** Vainqueur de la séance de tirs au but, s'il y en a eu une (`null` sinon). */
  tirs_au_but_vainqueur: string | null;
}

export interface Bilan {
  matchs: number;
  victoires: number;
  nuls: number;
  defaites: number;
  buts_marques: number;
  buts_encaisses: number;
  difference: number;
}
export type BilanAnnuel = { annee: number } & Bilan;
export type BilanAdversaire = { adversaire: string; premier_match: string; dernier_match: string } & Bilan;
export type BilanCompetition = { competition: string; competition_fr: string; premier_match: string; dernier_match: string } & Bilan;

export interface TirsAuBut {
  date: string;
  competition: string;
  competition_fr: string;
  adversaire: string;
  vainqueur: string;
  algerie_qualifiee: boolean;
}

export interface But {
  date: string;
  adversaire: string;
  buteur: string;
  minute: number | null;
  penalty: boolean;
  /** But contre son camp d'un adversaire, compté pour l'Algérie. */
  contre_son_camp: boolean;
}

export interface ResultatCalcul {
  matchs: Match[];
  bilanAnnuel: BilanAnnuel[];
  adversaires: BilanAdversaire[];
  competitions: BilanCompetition[];
  tirsAuBut: TirsAuBut[];
  buteurs: But[];
  rapport: {
    depot_source: string;
    equipe: string;
    premier_match: string;
    dernier_match: string;
    premiere_annee: number;
    derniere_annee: number;
    nb_matchs: number;
    nb_matchs_a_venir_ecartes: number;
    bilan: Bilan;
    nb_adversaires: number;
    nb_competitions: number;
    nb_tirs_au_but: number;
    nb_buts_avec_buteur: number;
    couverture_buteurs_pct: number;
  };
}

/** Noms français des compétitions les plus fréquentes ; les autres gardent le nom de la source. */
export const COMPETITIONS_FR: Record<string, string> = {
  Friendly: "Match amical",
  "African Cup of Nations": "Coupe d'Afrique des nations",
  "African Cup of Nations qualification": "Éliminatoires de la Coupe d'Afrique des nations",
  "FIFA World Cup": "Coupe du monde",
  "FIFA World Cup qualification": "Éliminatoires de la Coupe du monde",
  "Arab Cup": "Coupe arabe",
  "Arab Cup qualification": "Éliminatoires de la Coupe arabe",
  "FIFA Arab Cup": "Coupe arabe de la FIFA",
  "All-African Games": "Jeux africains",
  "African Nations Championship": "Championnat d'Afrique des nations",
  "African Nations Championship qualification": "Éliminatoires du Championnat d'Afrique des nations",
  "Mediterranean Games": "Jeux méditerranéens",
  "Palestine Cup": "Coupe de Palestine",
  "Olympic Games": "Jeux olympiques",
  "Islamic Solidarity Games": "Jeux de la solidarité islamique",
  "Amílcar Cabral Cup": "Coupe Amílcar Cabral",
  "Pan Arab Games": "Jeux panarabes",
  "UNCAF Cup": "Coupe UNCAF",
};
export const competitionFr = (nom: string) => COMPETITIONS_FR[nom] ?? nom;

function lireCsv(texte: string, colonnes: string[], nom: string): LigneSource[] {
  const resultat = Papa.parse<LigneSource>(texte.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  const entetes = resultat.meta.fields ?? [];
  const manquantes = colonnes.filter((colonne) => !entetes.includes(colonne));
  if (manquantes.length) throw new Error(`Colonnes manquantes dans ${nom}.csv : ${manquantes.join(", ")}.`);
  return resultat.data;
}

const score = (texte: string | undefined): number | null => {
  const valeur = (texte ?? "").trim();
  return /^\d+$/.test(valeur) ? Number(valeur) : null;
};
const vrai = (texte: string | undefined) => (texte ?? "").trim().toUpperCase() === "TRUE";
const cleMatch = (date: string, domicile: string, exterieur: string) => `${date}|${domicile}|${exterieur}`;

const bilanVide = (): Bilan => ({ matchs: 0, victoires: 0, nuls: 0, defaites: 0, buts_marques: 0, buts_encaisses: 0, difference: 0 });
function ajouter(bilan: Bilan, match: Match) {
  bilan.matchs++;
  if (match.resultat === "victoire") bilan.victoires++;
  else if (match.resultat === "nul") bilan.nuls++;
  else bilan.defaites++;
  bilan.buts_marques += match.buts_algerie;
  bilan.buts_encaisses += match.buts_adversaire;
  bilan.difference = bilan.buts_marques - bilan.buts_encaisses;
}

/** Calcule tous les fichiers à partir des trois CSV de la source (fonction pure, testée). */
export function analyser(sources: Record<FichierSource, string>): ResultatCalcul {
  const resultats = lireCsv(sources.results, ["date", "home_team", "away_team", "home_score", "away_score", "tournament", "city", "country", "neutral"], "results");
  const buteursSource = lireCsv(sources.goalscorers, ["date", "home_team", "away_team", "team", "scorer", "minute", "own_goal", "penalty"], "goalscorers");
  const tirsSource = lireCsv(sources.shootouts, ["date", "home_team", "away_team", "winner"], "shootouts");

  const vainqueurs = new Map(tirsSource.map((ligne) => [cleMatch(ligne.date!, ligne.home_team!, ligne.away_team!), ligne.winner!.trim()]));
  const matchs: Match[] = [];
  let aVenir = 0;
  for (const ligne of resultats) {
    const domicile = ligne.home_team!.trim();
    const exterieur = ligne.away_team!.trim();
    if (domicile !== EQUIPE && exterieur !== EQUIPE) continue;
    const scoreDomicile = score(ligne.home_score);
    const scoreExterieur = score(ligne.away_score);
    // Match pas encore joué (score « NA ») : écarté, il entrera au passage suivant.
    if (scoreDomicile === null || scoreExterieur === null) {
      aVenir++;
      continue;
    }
    const aDomicile = domicile === EQUIPE;
    const butsAlgerie = aDomicile ? scoreDomicile : scoreExterieur;
    const butsAdversaire = aDomicile ? scoreExterieur : scoreDomicile;
    const date = ligne.date!.trim();
    const competition = ligne.tournament!.trim();
    matchs.push({
      date,
      annee: Number(date.slice(0, 4)),
      competition,
      competition_fr: competitionFr(competition),
      adversaire: aDomicile ? exterieur : domicile,
      lieu: vrai(ligne.neutral) ? "neutre" : aDomicile ? "domicile" : "exterieur",
      ville: ligne.city!.trim(),
      pays: ligne.country!.trim(),
      buts_algerie: butsAlgerie,
      buts_adversaire: butsAdversaire,
      resultat: butsAlgerie > butsAdversaire ? "victoire" : butsAlgerie === butsAdversaire ? "nul" : "defaite",
      tirs_au_but_vainqueur: vainqueurs.get(cleMatch(date, domicile, exterieur)) ?? null,
    });
  }
  matchs.sort((a, b) => a.date.localeCompare(b.date));
  if (matchs.length === 0) throw new Error(`Aucun match de « ${EQUIPE} » dans results.csv.`);

  const parAnnee = new Map<number, Bilan>();
  const parAdversaire = new Map<string, Bilan & { premier_match: string; dernier_match: string }>();
  const parCompetition = new Map<string, Bilan & { premier_match: string; dernier_match: string }>();
  const total = bilanVide();
  for (const match of matchs) {
    ajouter(total, match);
    if (!parAnnee.has(match.annee)) parAnnee.set(match.annee, bilanVide());
    ajouter(parAnnee.get(match.annee)!, match);
    for (const [table, cle] of [[parAdversaire, match.adversaire], [parCompetition, match.competition]] as const) {
      if (!table.has(cle)) table.set(cle, { ...bilanVide(), premier_match: match.date, dernier_match: match.date });
      const entree = table.get(cle)!;
      ajouter(entree, match);
      entree.dernier_match = match.date;
    }
  }
  const parMatchs = <T extends Bilan>(a: T & { cle: string }, b: T & { cle: string }) => b.matchs - a.matchs || a.cle.localeCompare(b.cle);

  const matchsParCle = new Map(matchs.map((match) => [match.date + "|" + match.adversaire, match]));
  const tirsAuBut: TirsAuBut[] = matchs
    .filter((match) => match.tirs_au_but_vainqueur)
    .map((match) => ({
      date: match.date,
      competition: match.competition,
      competition_fr: match.competition_fr,
      adversaire: match.adversaire,
      vainqueur: match.tirs_au_but_vainqueur!,
      algerie_qualifiee: match.tirs_au_but_vainqueur === EQUIPE,
    }));

  const buteurs: But[] = buteursSource
    .filter((ligne) => ligne.team?.trim() === EQUIPE)
    .map((ligne) => {
      const domicile = ligne.home_team!.trim();
      const minute = score(ligne.minute);
      return {
        date: ligne.date!.trim(),
        adversaire: domicile === EQUIPE ? ligne.away_team!.trim() : domicile,
        buteur: ligne.scorer!.trim(),
        minute,
        penalty: vrai(ligne.penalty),
        contre_son_camp: vrai(ligne.own_goal),
      };
    })
    .filter((but) => matchsParCle.has(but.date + "|" + but.adversaire))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.minute ?? 999) - (b.minute ?? 999));

  const premier = matchs[0];
  const dernier = matchs[matchs.length - 1];
  return {
    matchs,
    bilanAnnuel: [...parAnnee.entries()].sort((a, b) => a[0] - b[0]).map(([annee, bilan]) => ({ annee, ...bilan })),
    adversaires: [...parAdversaire.entries()]
      .map(([cle, bilan]) => ({ cle, ...bilan }))
      .sort(parMatchs)
      .map(({ cle, premier_match, dernier_match, ...bilan }) => ({ adversaire: cle, ...bilan, premier_match, dernier_match })),
    competitions: [...parCompetition.entries()]
      .map(([cle, bilan]) => ({ cle, ...bilan }))
      .sort(parMatchs)
      .map(({ cle, premier_match, dernier_match, ...bilan }) => ({ competition: cle, competition_fr: competitionFr(cle), ...bilan, premier_match, dernier_match })),
    tirsAuBut,
    buteurs,
    rapport: {
      depot_source: DEPOT_SOURCE,
      equipe: EQUIPE,
      premier_match: premier.date,
      dernier_match: dernier.date,
      premiere_annee: premier.annee,
      derniere_annee: dernier.annee,
      nb_matchs: matchs.length,
      nb_matchs_a_venir_ecartes: aVenir,
      bilan: total,
      nb_adversaires: parAdversaire.size,
      nb_competitions: parCompetition.size,
      nb_tirs_au_but: tirsAuBut.length,
      nb_buts_avec_buteur: buteurs.length,
      couverture_buteurs_pct: total.buts_marques ? Math.round((buteurs.length / total.buts_marques) * 1000) / 10 : 0,
    },
  };
}

/** Contrôles de vraisemblance avant publication : une source tronquée ou modifiée ne doit pas écraser la donnée. */
export function verifier(resultat: ResultatCalcul): void {
  const { rapport } = resultat;
  if (rapport.nb_matchs < 500) throw new Error(`Seulement ${rapport.nb_matchs} matchs pour l'Algérie (plus de 600 attendus).`);
  if (rapport.premiere_annee !== 1963) throw new Error(`Premier match en ${rapport.premiere_annee}, 1963 attendu.`);
  if (rapport.bilan.victoires + rapport.bilan.nuls + rapport.bilan.defaites !== rapport.nb_matchs) throw new Error("Bilan incohérent.");
  if (resultat.bilanAnnuel.reduce((somme, ligne) => somme + ligne.matchs, 0) !== rapport.nb_matchs) throw new Error("Bilan annuel incohérent.");
}

export interface Telechargement {
  textes: Record<FichierSource, string>;
  empreintes: Record<FichierSource, string>;
}

async function telecharger(cache: string, sansCache: boolean): Promise<Telechargement> {
  await mkdir(cache, { recursive: true });
  const textes = {} as Record<FichierSource, string>;
  for (const nom of FICHIERS_SOURCE) {
    const chemin = join(cache, `${nom}.csv`);
    if (!sansCache) {
      const enCache = await readFile(chemin, "utf8").catch(() => "");
      if (enCache.trim()) {
        textes[nom] = enCache;
        continue;
      }
    }
    const url = `${BASE_BRUTE}/${nom}.csv`;
    console.log(`Téléchargement : ${url}`);
    const reponse = await fetch(url, { headers: { "user-agent": AGENT, accept: "text/csv" }, signal: AbortSignal.timeout(120_000) });
    if (!reponse.ok) throw new Error(`Téléchargement de ${nom}.csv impossible : HTTP ${reponse.status}.`);
    const texte = await reponse.text();
    if (texte.length < 1000 || !texte.startsWith("date,")) throw new Error(`${nom}.csv ne ressemble pas au fichier attendu.`);
    await writeFile(`${chemin}.part`, texte, "utf8");
    await rename(`${chemin}.part`, chemin);
    textes[nom] = texte;
  }
  const empreintes = Object.fromEntries(
    FICHIERS_SOURCE.map((nom) => [nom, createHash("sha256").update(textes[nom]).digest("hex")])
  ) as Record<FichierSource, string>;
  return { textes, empreintes };
}

/** Fichiers publiés : nom logique → lignes. Le premier est le fichier principal. */
export const fichiersPublies = (resultat: ResultatCalcul) =>
  ({
    "matchs": resultat.matchs,
    "bilan-annuel": resultat.bilanAnnuel,
    "bilan-adversaires": resultat.adversaires,
    "bilan-competitions": resultat.competitions,
    "tirs-au-but": resultat.tirsAuBut,
    "buteurs": resultat.buteurs,
  }) as const;

async function ecrireSorties(sortie: string, resultat: ResultatCalcul, telechargement: Telechargement): Promise<void> {
  await mkdir(sortie, { recursive: true });
  for (const [nom, lignes] of Object.entries(fichiersPublies(resultat))) {
    await writeFile(join(sortie, `${nom}.json`), JSON.stringify(lignes, null, 1) + "\n", "utf8");
    await writeFile(join(sortie, `${nom}.csv`), Papa.unparse(lignes as object[], { newline: "\n" }) + "\n", "utf8");
  }
  const rapport = { genere_le: new Date().toISOString(), ...resultat.rapport, empreintes_sha256: telechargement.empreintes };
  await writeFile(join(sortie, "rapport.json"), JSON.stringify(rapport, null, 2) + "\n", "utf8");
  const { bilan } = resultat.rapport;
  console.log(
    `${resultat.rapport.nb_matchs} matchs (${resultat.rapport.premier_match} → ${resultat.rapport.dernier_match}) : ` +
      `${bilan.victoires} V, ${bilan.nuls} N, ${bilan.defaites} D ; buteurs connus pour ${resultat.rapport.couverture_buteurs_pct} % des buts.`
  );
}

async function main(): Promise<void> {
  const option = (nom: string, defaut: string) => {
    const index = process.argv.indexOf(nom);
    return index >= 0 ? process.argv[index + 1] || defaut : defaut;
  };
  const telechargement = await telecharger(option("--cache", join(DOSSIER, "cache")), process.argv.includes("--sans-cache"));
  const resultat = analyser(telechargement.textes);
  verifier(resultat);
  await ecrireSorties(option("--sortie", join(DOSSIER, "sortie")), resultat, telechargement);
}

if (process.argv[1]?.endsWith("/football/calculer.ts") || process.argv[1]?.endsWith("\\football\\calculer.ts")) {
  main().catch((erreur: unknown) => {
    console.error(erreur instanceof Error ? erreur.message : erreur);
    process.exitCode = 1;
  });
}
