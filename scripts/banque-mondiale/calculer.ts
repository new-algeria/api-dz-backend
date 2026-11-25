/**
 * Extrait une sélection d'indicateurs du développement dans le monde (WDI) de la Banque mondiale pour l'Algérie.
 *
 * Source : API v2 de la Banque mondiale (sans clé), un appel par indicateur, base WDI (source 2), licence CC BY 4.0.
 *
 *   npx tsx scripts/banque-mondiale/calculer.ts [--sortie DOSSIER]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Papa from "papaparse";

const AGENT = "data-dz-banque-mondiale/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;
export const urlIndicateur = (code: string) => `https://api.worldbank.org/v2/country/DZA/indicator/${code}?format=json&per_page=500`;

export type Theme = "Population" | "Santé" | "Éducation" | "Économie" | "Emploi" | "Numérique et infrastructures" | "Environnement";

export interface Indicateur {
  code: string;
  fr: string;
  unite: string;
  theme: Theme;
  /** Diviseur appliqué à la valeur de la Banque mondiale (1e9 pour passer des dollars aux milliards de dollars). */
  diviseur?: number;
  decimales: number;
  /** Plage plausible après conversion : une valeur hors plage arrête le robot. */
  plage: [number, number];
  /** Estimation modélisée (OIT, OMS…) plutôt que relevé national : signalée dans les fichiers. */
  modelise?: boolean;
}

export const INDICATEURS: Indicateur[] = [
  { code: "SP.POP.TOTL", fr: "Population totale", unite: "habitants", theme: "Population", decimales: 0, plage: [5e6, 1e8] },
  { code: "SP.URB.TOTL.IN.ZS", fr: "Population urbaine", unite: "% de la population", theme: "Population", decimales: 1, plage: [10, 100] },
  { code: "SP.POP.0014.TO.ZS", fr: "Moins de 15 ans", unite: "% de la population", theme: "Population", decimales: 1, plage: [5, 60] },
  { code: "SP.POP.65UP.TO.ZS", fr: "65 ans et plus", unite: "% de la population", theme: "Population", decimales: 1, plage: [1, 40] },
  { code: "SP.DYN.TFRT.IN", fr: "Fécondité", unite: "enfants par femme", theme: "Population", decimales: 2, plage: [1, 10] },
  { code: "SP.DYN.LE00.IN", fr: "Espérance de vie à la naissance", unite: "années", theme: "Santé", decimales: 1, plage: [30, 90] },
  { code: "SP.DYN.IMRT.IN", fr: "Mortalité infantile", unite: "pour 1 000 naissances vivantes", theme: "Santé", decimales: 1, plage: [1, 300] },
  { code: "SH.DYN.MORT", fr: "Mortalité des moins de 5 ans", unite: "pour 1 000 naissances vivantes", theme: "Santé", decimales: 1, plage: [1, 400] },
  { code: "SH.STA.MMRT", fr: "Mortalité maternelle", unite: "pour 100 000 naissances vivantes", theme: "Santé", decimales: 0, plage: [1, 2000], modelise: true },
  { code: "SH.XPD.CHEX.GD.ZS", fr: "Dépenses de santé", unite: "% du PIB", theme: "Santé", decimales: 2, plage: [0.5, 20] },
  { code: "SH.MED.PHYS.ZS", fr: "Médecins", unite: "pour 1 000 habitants", theme: "Santé", decimales: 2, plage: [0, 10] },
  { code: "SH.H2O.SMDW.ZS", fr: "Accès à une eau potable gérée en toute sécurité", unite: "% de la population", theme: "Santé", decimales: 1, plage: [10, 100], modelise: true },
  { code: "SE.PRM.ENRR", fr: "Scolarisation dans le primaire (taux brut)", unite: "%", theme: "Éducation", decimales: 1, plage: [10, 160] },
  { code: "SE.SEC.ENRR", fr: "Scolarisation dans le secondaire (taux brut)", unite: "%", theme: "Éducation", decimales: 1, plage: [1, 160] },
  { code: "SE.TER.ENRR", fr: "Scolarisation dans le supérieur (taux brut)", unite: "%", theme: "Éducation", decimales: 1, plage: [0, 120] },
  { code: "SE.PRM.CMPT.ZS", fr: "Achèvement du primaire", unite: "% du groupe d'âge", theme: "Éducation", decimales: 1, plage: [10, 130] },
  { code: "SE.XPD.TOTL.GD.ZS", fr: "Dépenses publiques d'éducation", unite: "% du PIB", theme: "Éducation", decimales: 2, plage: [0.5, 20] },
  { code: "NY.GDP.MKTP.CD", fr: "PIB", unite: "milliards de dollars US courants", theme: "Économie", diviseur: 1e9, decimales: 2, plage: [1, 2000] },
  { code: "NY.GDP.PCAP.CD", fr: "PIB par habitant", unite: "dollars US courants", theme: "Économie", decimales: 0, plage: [100, 50000] },
  { code: "NY.GDP.MKTP.KD.ZG", fr: "Croissance du PIB", unite: "% par an", theme: "Économie", decimales: 2, plage: [-40, 40] },
  { code: "FP.CPI.TOTL.ZG", fr: "Inflation (prix à la consommation)", unite: "% par an", theme: "Économie", decimales: 2, plage: [-20, 100] },
  { code: "NE.EXP.GNFS.ZS", fr: "Exportations de biens et services", unite: "% du PIB", theme: "Économie", decimales: 1, plage: [1, 100] },
  { code: "NE.IMP.GNFS.ZS", fr: "Importations de biens et services", unite: "% du PIB", theme: "Économie", decimales: 1, plage: [1, 100] },
  { code: "NY.GDP.PETR.RT.ZS", fr: "Rente pétrolière", unite: "% du PIB", theme: "Économie", decimales: 1, plage: [0, 80] },
  { code: "BX.KLT.DINV.WD.GD.ZS", fr: "Investissements directs étrangers (entrées nettes)", unite: "% du PIB", theme: "Économie", decimales: 2, plage: [-20, 30] },
  { code: "FI.RES.TOTL.CD", fr: "Réserves de change (or compris)", unite: "milliards de dollars US courants", theme: "Économie", diviseur: 1e9, decimales: 2, plage: [0, 1000] },
  { code: "PA.NUS.FCRF", fr: "Taux de change officiel", unite: "dinars pour 1 dollar US (moyenne annuelle)", theme: "Économie", decimales: 2, plage: [1, 1000] },
  { code: "SL.UEM.TOTL.ZS", fr: "Chômage", unite: "% de la population active", theme: "Emploi", decimales: 1, plage: [0, 60], modelise: true },
  { code: "SL.UEM.1524.ZS", fr: "Chômage des 15–24 ans", unite: "% des actifs de 15 à 24 ans", theme: "Emploi", decimales: 1, plage: [0, 90], modelise: true },
  { code: "SL.TLF.CACT.FE.ZS", fr: "Taux d'activité des femmes", unite: "% des femmes de 15 ans et plus", theme: "Emploi", decimales: 1, plage: [0, 100], modelise: true },
  { code: "IT.NET.USER.ZS", fr: "Internautes", unite: "% de la population", theme: "Numérique et infrastructures", decimales: 1, plage: [0, 100] },
  { code: "IT.CEL.SETS.P2", fr: "Abonnements au mobile", unite: "pour 100 habitants", theme: "Numérique et infrastructures", decimales: 1, plage: [0, 300] },
  { code: "EG.ELC.ACCS.ZS", fr: "Accès à l'électricité", unite: "% de la population", theme: "Numérique et infrastructures", decimales: 1, plage: [10, 100] },
  { code: "EN.GHG.CO2.PC.CE.AR5", fr: "Émissions de CO₂ par habitant", unite: "tonnes de CO₂ par habitant", theme: "Environnement", decimales: 2, plage: [0, 30] },
  { code: "AG.LND.FRST.ZS", fr: "Surface forestière", unite: "% du territoire", theme: "Environnement", decimales: 2, plage: [0, 10] },
  { code: "EG.FEC.RNEW.ZS", fr: "Énergies renouvelables", unite: "% de la consommation finale d'énergie", theme: "Environnement", decimales: 2, plage: [0, 100] },
];

/** Réponse de l'API v2 : [métadonnées, observations]. */
export type ReponseBm = [{ lastupdated?: string; message?: { value?: string }[] }, { date: string; value: number | null }[] | null];

export interface Observation {
  annee: number;
  valeur: number;
}

/** Fichier principal : seulement année, indicateur, valeur et unité (la fiche fait une série par valeur de chaque colonne texte). */
export interface LigneIndicateur {
  annee: number;
  indicateur: string;
  valeur: number;
  unite: string;
}

export type LigneBilan = { annee: number } & Record<string, number | null>;

export interface Rapport {
  genere_le: string;
  base_mise_a_jour_le: string | null;
  premiere_annee: number;
  derniere_annee: number;
  nb_indicateurs: number;
  nb_lignes: number;
  nb_annees: number;
  periodes: Record<string, [number, number]>;
  derniers_chiffres: Record<string, { annee: number; valeur: number }>;
}

const arrondi = (valeur: number, decimales: number) => Math.round(valeur * 10 ** decimales) / 10 ** decimales;

/** Observations non nulles d'une réponse de l'API, converties et contrôlées. */
export function lireReponse(indicateur: Indicateur, reponse: ReponseBm): Observation[] {
  const [meta, donnees] = reponse;
  if (!Array.isArray(donnees)) {
    throw new Error(`Banque mondiale : aucune donnée pour ${indicateur.code}${meta?.message?.[0]?.value ? ` (${meta.message[0].value})` : ""}.`);
  }
  const observations: Observation[] = [];
  for (const point of donnees) {
    const annee = Number(point.date);
    if (!Number.isInteger(annee) || point.value === null || !Number.isFinite(point.value)) continue;
    const valeur = arrondi(point.value / (indicateur.diviseur ?? 1), indicateur.decimales);
    const [min, max] = indicateur.plage;
    if (valeur < min || valeur > max) throw new Error(`Valeur invraisemblable pour ${indicateur.fr} en ${annee} : ${valeur} ${indicateur.unite}.`);
    observations.push({ annee, valeur });
  }
  if (!observations.length) throw new Error(`Série vide : ${indicateur.code}.`);
  return observations.sort((a, b) => a.annee - b.annee);
}

export function calculer(series: Map<string, Observation[]>, miseAJour: string | null = null) {
  const lignes: LigneIndicateur[] = [];
  const parAnnee = new Map<number, LigneBilan>();
  const periodes: Rapport["periodes"] = {};
  const derniers: Rapport["derniers_chiffres"] = {};
  for (const indicateur of INDICATEURS) {
    const observations = series.get(indicateur.code);
    if (!observations?.length) throw new Error(`Indicateur absent : ${indicateur.code} (${indicateur.fr}).`);
    for (const { annee, valeur } of observations) {
      lignes.push({ annee, indicateur: indicateur.fr, valeur, unite: indicateur.unite });
      const ligne = parAnnee.get(annee) ?? ({ annee } as LigneBilan);
      ligne[indicateur.code] = valeur;
      parAnnee.set(annee, ligne);
    }
    periodes[indicateur.code] = [observations[0].annee, observations.at(-1)!.annee];
    derniers[indicateur.code] = observations.at(-1)!;
  }
  lignes.sort((a, b) => a.indicateur.localeCompare(b.indicateur, "fr") || a.annee - b.annee);
  const annees = [...parAnnee.keys()].sort((a, b) => a - b);
  // Bilan large : une colonne par code (même ordre que INDICATEURS), vide si l'année manque.
  const bilan = annees.map((annee) => {
    const source = parAnnee.get(annee)!;
    const ligne = { annee } as LigneBilan;
    for (const { code } of INDICATEURS) ligne[code] = source[code] ?? null;
    return ligne;
  });
  const rapport: Omit<Rapport, "genere_le"> = {
    base_mise_a_jour_le: miseAJour,
    premiere_annee: annees[0],
    derniere_annee: annees.at(-1)!,
    nb_indicateurs: INDICATEURS.length,
    nb_lignes: lignes.length,
    nb_annees: annees.length,
    periodes,
    derniers_chiffres: derniers,
  };
  return { lignes, bilan, rapport };
}

/** Contrôles avant publication : série longue et indicateurs phares récents. */
export function verifier(rapport: Omit<Rapport, "genere_le">, anneeCourante = new Date().getUTCFullYear()): void {
  if (rapport.premiere_annee > 1960) throw new Error(`Série trop courte : début en ${rapport.premiere_annee}.`);
  for (const code of ["SP.POP.TOTL", "NY.GDP.MKTP.CD", "SP.DYN.LE00.IN", "SL.UEM.TOTL.ZS"]) {
    const fin = rapport.periodes[code]?.[1] ?? 0;
    if (fin < anneeCourante - 3) throw new Error(`La série ${code} s'arrête en ${fin}.`);
  }
}

/** Dictionnaire des colonnes du bilan (code → libellé, unité, thème). */
export const dictionnaire = (periodes: Rapport["periodes"]) =>
  INDICATEURS.map(({ code, fr, unite, theme, modelise }) => ({
    code_bm: code,
    indicateur: fr,
    unite,
    theme,
    estimation_modelisee: Boolean(modelise),
    premiere_annee: periodes[code]?.[0] ?? null,
    derniere_annee: periodes[code]?.[1] ?? null,
  }));

async function telecharger(indicateur: Indicateur): Promise<{ observations: Observation[]; miseAJour: string | null }> {
  let derniereErreur: unknown;
  for (let essai = 1; essai <= 4; essai++) {
    try {
      const reponse = await fetch(urlIndicateur(indicateur.code), { headers: { "user-agent": AGENT }, signal: AbortSignal.timeout(60_000) });
      if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
      const corps = (await reponse.json()) as ReponseBm;
      return { observations: lireReponse(indicateur, corps), miseAJour: corps[0]?.lastupdated ?? null };
    } catch (erreur) {
      derniereErreur = erreur;
      if (erreur instanceof Error && /invraisemblable|vide|aucune donnée/.test(erreur.message)) throw erreur;
      await new Promise((resoudre) => setTimeout(resoudre, 2000 * essai));
    }
  }
  throw new Error(`Banque mondiale injoignable pour ${indicateur.code} : ${String(derniereErreur)}`);
}

async function principal() {
  const index = process.argv.indexOf("--sortie");
  const sortie = index >= 0 ? process.argv[index + 1] : join(DOSSIER, "sortie");
  const series = new Map<string, Observation[]>();
  const misesAJour: string[] = [];
  for (const indicateur of INDICATEURS) {
    const { observations, miseAJour } = await telecharger(indicateur);
    series.set(indicateur.code, observations);
    if (miseAJour) misesAJour.push(miseAJour);
  }
  const { lignes, bilan, rapport } = calculer(series, misesAJour.sort().at(-1) ?? null);
  verifier(rapport);
  await mkdir(sortie, { recursive: true });
  const csv = (donnees: object[]) => Papa.unparse(donnees, { newline: "\n" }) + "\n";
  const fichiers: [string, object[]][] = [
    ["indicateurs-annuels", lignes],
    ["bilan-annuel", bilan],
    ["dictionnaire", dictionnaire(rapport.periodes)],
  ];
  await Promise.all(
    fichiers.flatMap(([nom, donnees]) => [
      writeFile(join(sortie, `${nom}.json`), JSON.stringify(donnees) + "\n", "utf8"),
      writeFile(join(sortie, `${nom}.csv`), csv(donnees), "utf8"),
    ])
  );
  const complet: Rapport = { genere_le: new Date().toISOString(), ...rapport };
  await writeFile(join(sortie, "rapport.json"), JSON.stringify(complet, null, 2) + "\n", "utf8");
  const d = rapport.derniers_chiffres;
  console.log(
    `${rapport.nb_lignes} valeurs, ${rapport.nb_indicateurs} indicateurs, ${rapport.premiere_annee}–${rapport.derniere_annee} (base du ${rapport.base_mise_a_jour_le}). ` +
      `Population ${d["SP.POP.TOTL"].annee} : ${d["SP.POP.TOTL"].valeur} ; espérance de vie ${d["SP.DYN.LE00.IN"].annee} : ${d["SP.DYN.LE00.IN"].valeur} ans ; ` +
      `internautes ${d["IT.NET.USER.ZS"].annee} : ${d["IT.NET.USER.ZS"].valeur} %.`
  );
}

if (process.argv[1]?.endsWith("/banque-mondiale/calculer.ts") || process.argv[1]?.endsWith("\\banque-mondiale\\calculer.ts")) {
  await principal();
}
