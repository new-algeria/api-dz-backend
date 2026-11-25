/**
 * Températures et chaleur par wilaya : séries quotidiennes depuis 1981 au chef-lieu de chacune des 69 wilayas,
 * puis synthèses mensuelles et annuelles (moyennes, records, jours ≥ 35 °C et ≥ 40 °C, nuits ≥ 20 °C, écart à la
 * normale 1991–2020).
 *
 * Source : NASA POWER (Prediction Of Worldwide Energy Resources), API « daily point », réanalyse MERRA-2 et
 * GEOS-IT pour les jours récents. Données ouvertes de la NASA, sans clé ; remerciement demandé.
 * Points de mesure : bureau de poste principal de la commune chef-lieu (fichiers `wilayas` et `postoffices` de la
 * donnée data-dz `divisions-administratives`), sinon médiane des bureaux de cette commune.
 *
 *   npx tsx scripts/temperatures/calculer.ts [--cache DOSSIER] [--sortie DOSSIER] [--sans-cache]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Papa from "papaparse";

export const URL_POWER = "https://power.larc.nasa.gov/api/temporal/daily/point";
export const PAGE_POWER = "https://power.larc.nasa.gov/";
const BASE_DIVISIONS = "https://api.data-dz.com/v1/datasets/divisions-administratives/download";
const AGENT = "data-dz-temperatures/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;
export const PREMIERE_ANNEE = 1981;
export const NORMALE = [1991, 2020] as const;
/** Valeur de remplissage de NASA POWER (donnée absente). */
export const VALEUR_ABSENTE = -999;

// ---------------------------------------------------------------------------------------------------------------
// Points de mesure
// ---------------------------------------------------------------------------------------------------------------

export interface WilayaSource {
  code: number;
  name_fr: string;
  name_ar: string;
  capital_commune_code: number;
}
export interface BureauPoste {
  name: string;
  commune_code: string;
  commune: string;
  lat: number | null;
  lng: number | null;
  postal_code?: string | null;
}
export interface Point {
  code_wilaya: string;
  wilaya: string;
  wilaya_ar: string;
  chef_lieu: string;
  code_commune: string;
  lat: number;
  lng: number;
  methode: "bureau_principal" | "mediane_bureaux";
}

const mediane = (valeurs: number[]) => {
  const tri = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tri.length / 2);
  return tri.length % 2 ? tri[milieu] : (tri[milieu - 1] + tri[milieu]) / 2;
};
const titre = (texte: string) => texte.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (lettre) => lettre.toUpperCase());

/**
 * Un point par wilaya, au chef-lieu : le bureau de poste principal de la commune chef-lieu (nom en « RP » ou code
 * postal en « 000 »), sinon la médiane des bureaux géolocalisés de cette commune.
 */
export function choisirPoints(wilayas: WilayaSource[], bureaux: BureauPoste[]): Point[] {
  return wilayas
    .map((wilaya) => {
      const codeCommune = String(wilaya.capital_commune_code).padStart(4, "0");
      const commune = bureaux.filter((bureau) => bureau.commune_code === codeCommune && Number.isFinite(bureau.lat) && Number.isFinite(bureau.lng));
      if (!commune.length) throw new Error(`Aucun bureau de poste géolocalisé pour le chef-lieu de la wilaya ${wilaya.code} (${codeCommune}).`);
      const principal = commune.find((bureau) => /\sRP$/.test(bureau.name.trim()) || /000$/.test(bureau.postal_code ?? ""));
      const lat = principal ? principal.lat! : mediane(commune.map((bureau) => bureau.lat!));
      const lng = principal ? principal.lng! : mediane(commune.map((bureau) => bureau.lng!));
      return {
        code_wilaya: String(wilaya.code).padStart(2, "0"),
        wilaya: wilaya.name_fr,
        wilaya_ar: wilaya.name_ar,
        chef_lieu: titre(commune[0].commune),
        code_commune: codeCommune,
        lat: Math.round(lat * 1e4) / 1e4,
        lng: Math.round(lng * 1e4) / 1e4,
        methode: principal ? ("bureau_principal" as const) : ("mediane_bureaux" as const),
      };
    })
    .sort((a, b) => a.code_wilaya.localeCompare(b.code_wilaya));
}

// ---------------------------------------------------------------------------------------------------------------
// Séries quotidiennes
// ---------------------------------------------------------------------------------------------------------------

export interface Jour {
  code_wilaya: string;
  date: string;
  tmax: number | null;
  tmin: number | null;
  tmoy: number | null;
}

interface ReponsePower {
  properties?: { parameter?: Record<string, Record<string, number>> };
}

const valeur = (brute: number | undefined) => (brute === undefined || brute === VALEUR_ABSENTE || !Number.isFinite(brute) ? null : Math.round(brute * 100) / 100);

/** Réponse NASA POWER (JSON) → jours, sans les jours entièrement absents à la fin de la série (pas encore calculés). */
export function lirePower(codeWilaya: string, reponse: ReponsePower): Jour[] {
  const parametres = reponse.properties?.parameter;
  if (!parametres?.T2M_MAX || !parametres.T2M_MIN || !parametres.T2M) throw new Error(`Réponse NASA POWER incomplète pour la wilaya ${codeWilaya}.`);
  const jours = Object.keys(parametres.T2M_MAX)
    .sort()
    .map((cle) => ({
      code_wilaya: codeWilaya,
      date: `${cle.slice(0, 4)}-${cle.slice(4, 6)}-${cle.slice(6, 8)}`,
      tmax: valeur(parametres.T2M_MAX[cle]),
      tmin: valeur(parametres.T2M_MIN[cle]),
      tmoy: valeur(parametres.T2M[cle]),
    }));
  while (jours.length && jours[jours.length - 1].tmax === null && jours[jours.length - 1].tmin === null) jours.pop();
  for (const jour of jours) {
    for (const mesure of [jour.tmax, jour.tmin, jour.tmoy]) {
      if (mesure !== null && (mesure < -30 || mesure > 60)) throw new Error(`Température invraisemblable (${mesure} °C) le ${jour.date}, wilaya ${codeWilaya}.`);
    }
  }
  return jours;
}

// ---------------------------------------------------------------------------------------------------------------
// Synthèses
// ---------------------------------------------------------------------------------------------------------------

export interface Synthese {
  tmoy: number | null;
  tmax_moy: number | null;
  tmin_moy: number | null;
  tmax_record: number | null;
  jours_35: number;
  jours_40: number;
  nuits_20: number;
}
export type LigneMensuelle = { code_wilaya: string; wilaya: string; annee: number; mois: number } & Synthese;
export type LigneAnnuelle = { code_wilaya: string; wilaya: string; annee: number } & Synthese & { ecart_normale: number | null };
export interface LigneNationale {
  annee: number;
  tmoy_moyenne_wilayas: number | null;
  ecart_normale_moyen: number | null;
  jours_40_cumules: number;
  wilayas_au_moins_un_jour_40: number;
  tmax_record: number | null;
  wilaya_record: string | null;
}

const arrondi = (nombre: number) => Math.round(nombre * 100) / 100;
const moyenne = (valeurs: (number | null)[]) => {
  const presentes = valeurs.filter((valeur): valeur is number => valeur !== null);
  return presentes.length ? arrondi(presentes.reduce((somme, valeur) => somme + valeur, 0) / presentes.length) : null;
};
const joursDansMois = (annee: number, mois: number) => new Date(Date.UTC(annee, mois, 0)).getUTCDate();
const joursDansAnnee = (annee: number) => (annee % 4 === 0 && (annee % 100 !== 0 || annee % 400 === 0) ? 366 : 365);

function synthese(jours: Jour[]): Synthese {
  const tmax = jours.map((jour) => jour.tmax).filter((valeur): valeur is number => valeur !== null);
  return {
    tmoy: moyenne(jours.map((jour) => jour.tmoy)),
    tmax_moy: moyenne(jours.map((jour) => jour.tmax)),
    tmin_moy: moyenne(jours.map((jour) => jour.tmin)),
    tmax_record: tmax.length ? Math.max(...tmax) : null,
    jours_35: jours.filter((jour) => jour.tmax !== null && jour.tmax >= 35).length,
    jours_40: jours.filter((jour) => jour.tmax !== null && jour.tmax >= 40).length,
    nuits_20: jours.filter((jour) => jour.tmin !== null && jour.tmin >= 20).length,
  };
}

/** Une période n'entre dans les synthèses que si au moins 95 % de ses jours ont une température maximale. */
const complete = (jours: Jour[], attendus: number) => jours.filter((jour) => jour.tmax !== null).length >= Math.ceil(attendus * 0.95);

export interface Calcul {
  mensuel: LigneMensuelle[];
  annuel: LigneAnnuelle[];
  national: LigneNationale[];
}

/** Synthèses mensuelles et annuelles par wilaya (périodes complètes seulement), écart à la normale 1991–2020. */
export function agreger(points: Point[], jours: Jour[]): Calcul {
  const noms = new Map(points.map((point) => [point.code_wilaya, point.wilaya]));
  const parMois = new Map<string, Jour[]>();
  const parAnnee = new Map<string, Jour[]>();
  for (const jour of jours) {
    const cleMois = `${jour.code_wilaya}|${jour.date.slice(0, 7)}`;
    const cleAnnee = `${jour.code_wilaya}|${jour.date.slice(0, 4)}`;
    (parMois.get(cleMois) ?? parMois.set(cleMois, []).get(cleMois)!).push(jour);
    (parAnnee.get(cleAnnee) ?? parAnnee.set(cleAnnee, []).get(cleAnnee)!).push(jour);
  }

  const mensuel: LigneMensuelle[] = [];
  for (const [cle, liste] of parMois) {
    const [code, periode] = cle.split("|");
    const annee = Number(periode.slice(0, 4));
    const mois = Number(periode.slice(5, 7));
    if (!complete(liste, joursDansMois(annee, mois))) continue;
    mensuel.push({ code_wilaya: code, wilaya: noms.get(code) ?? code, annee, mois, ...synthese(liste) });
  }

  const brut: (Omit<LigneAnnuelle, "ecart_normale">)[] = [];
  for (const [cle, liste] of parAnnee) {
    const [code, texteAnnee] = cle.split("|");
    const annee = Number(texteAnnee);
    if (!complete(liste, joursDansAnnee(annee))) continue;
    brut.push({ code_wilaya: code, wilaya: noms.get(code) ?? code, annee, ...synthese(liste) });
  }
  const normales = new Map<string, number | null>();
  for (const code of noms.keys()) {
    const periode = brut.filter((ligne) => ligne.code_wilaya === code && ligne.annee >= NORMALE[0] && ligne.annee <= NORMALE[1]);
    // Normale calculée seulement si au moins 27 des 30 années sont complètes.
    normales.set(code, periode.length >= 27 ? moyenne(periode.map((ligne) => ligne.tmoy)) : null);
  }
  const annuel: LigneAnnuelle[] = brut.map((ligne) => {
    const normale = normales.get(ligne.code_wilaya) ?? null;
    return { ...ligne, ecart_normale: normale !== null && ligne.tmoy !== null ? arrondi(ligne.tmoy - normale) : null };
  });

  const tri = <T extends { code_wilaya: string; annee: number; mois?: number }>(a: T, b: T) =>
    a.code_wilaya.localeCompare(b.code_wilaya) || a.annee - b.annee || (a.mois ?? 0) - (b.mois ?? 0);
  mensuel.sort(tri);
  annuel.sort(tri);

  const national: LigneNationale[] = [];
  const annees = [...new Set(annuel.map((ligne) => ligne.annee))].sort((a, b) => a - b);
  for (const annee of annees) {
    const lignes = annuel.filter((ligne) => ligne.annee === annee);
    // Une année nationale n'est retenue que si les 69 wilayas sont complètes.
    if (lignes.length !== noms.size) continue;
    const record = lignes.reduce<LigneAnnuelle | null>((meilleure, ligne) => (ligne.tmax_record !== null && (meilleure?.tmax_record ?? -Infinity) < ligne.tmax_record ? ligne : meilleure), null);
    national.push({
      annee,
      tmoy_moyenne_wilayas: moyenne(lignes.map((ligne) => ligne.tmoy)),
      ecart_normale_moyen: moyenne(lignes.map((ligne) => ligne.ecart_normale)),
      jours_40_cumules: lignes.reduce((somme, ligne) => somme + ligne.jours_40, 0),
      wilayas_au_moins_un_jour_40: lignes.filter((ligne) => ligne.jours_40 > 0).length,
      tmax_record: record?.tmax_record ?? null,
      wilaya_record: record?.wilaya ?? null,
    });
  }
  return { mensuel, annuel, national };
}

export interface Rapport {
  source_url: string;
  premiere_date: string;
  derniere_date: string;
  premiere_annee: number;
  derniere_annee_complete: number;
  nb_points: number;
  nb_jours: number;
  nb_lignes_mensuelles: number;
  nb_lignes_annuelles: number;
  normale: readonly [number, number];
  record: { tmax: number; wilaya: string; date: string } | null;
  points_mediane: string[];
}

/** Contrôles avant publication : une source tronquée ou un point manquant ne doit pas écraser la donnée. */
export function verifier(points: Point[], jours: Jour[], calcul: Calcul): Rapport {
  if (points.length !== 69) throw new Error(`${points.length} points de mesure au lieu de 69.`);
  const parWilaya = new Map<string, Jour[]>();
  for (const jour of jours) (parWilaya.get(jour.code_wilaya) ?? parWilaya.set(jour.code_wilaya, []).get(jour.code_wilaya)!).push(jour);
  for (const point of points) {
    const serie = parWilaya.get(point.code_wilaya) ?? [];
    if (!serie.length || serie[0].date !== `${PREMIERE_ANNEE}-01-01`) throw new Error(`Série incomplète pour la wilaya ${point.code_wilaya} (début ${serie[0]?.date ?? "absent"}).`);
  }
  const derniere = jours.reduce((max, jour) => (jour.tmax !== null && jour.date > max ? jour.date : max), "");
  const annees = calcul.national.map((ligne) => ligne.annee);
  if (!annees.length || annees[0] !== PREMIERE_ANNEE) throw new Error("Synthèse nationale vide ou ne commençant pas en 1981.");
  if (annees.length < 40) throw new Error(`Seulement ${annees.length} années complètes pour les 69 wilayas.`);
  const record = jours.reduce<Jour | null>((meilleur, jour) => (jour.tmax !== null && (meilleur?.tmax ?? -Infinity) < jour.tmax ? jour : meilleur), null);
  const noms = new Map(points.map((point) => [point.code_wilaya, point.wilaya]));
  return {
    source_url: URL_POWER,
    premiere_date: `${PREMIERE_ANNEE}-01-01`,
    derniere_date: derniere,
    premiere_annee: PREMIERE_ANNEE,
    derniere_annee_complete: annees[annees.length - 1],
    nb_points: points.length,
    nb_jours: jours.length,
    nb_lignes_mensuelles: calcul.mensuel.length,
    nb_lignes_annuelles: calcul.annuel.length,
    normale: NORMALE,
    record: record && record.tmax !== null ? { tmax: record.tmax, wilaya: noms.get(record.code_wilaya) ?? record.code_wilaya, date: record.date } : null,
    points_mediane: points.filter((point) => point.methode === "mediane_bureaux").map((point) => point.code_wilaya),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Téléchargements
// ---------------------------------------------------------------------------------------------------------------

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lireJson<T>(url: string, chemin: string, sansCache: boolean): Promise<{ donnees: T; texte: string }> {
  if (!sansCache) {
    const enCache = await readFile(chemin, "utf8").catch(() => "");
    if (enCache.trim()) return { donnees: JSON.parse(enCache) as T, texte: enCache };
  }
  let derniere: unknown;
  for (let essai = 1; essai <= 4; essai++) {
    try {
      const reponse = await fetch(url, { headers: { "user-agent": AGENT, accept: "application/json" }, signal: AbortSignal.timeout(180_000) });
      if (reponse.status === 429 || reponse.status >= 500) throw new Error(`HTTP ${reponse.status}`);
      if (!reponse.ok) throw new Error(`HTTP ${reponse.status} pour ${url}`);
      const texte = await reponse.text();
      const donnees = JSON.parse(texte) as T;
      await writeFile(`${chemin}.part`, texte, "utf8");
      await rename(`${chemin}.part`, chemin);
      return { donnees, texte };
    } catch (erreur) {
      derniere = erreur;
      if (essai < 4) await pause(2000 * 2 ** essai);
    }
  }
  throw new Error(`Téléchargement impossible (${url}) : ${derniere instanceof Error ? derniere.message : derniere}`);
}

const dateCompacte = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");

async function main(): Promise<void> {
  const option = (nom: string, defaut: string) => {
    const index = process.argv.indexOf(nom);
    return index >= 0 ? process.argv[index + 1] || defaut : defaut;
  };
  const cache = option("--cache", join(DOSSIER, "cache"));
  const sortie = option("--sortie", join(DOSSIER, "sortie"));
  const sansCache = process.argv.includes("--sans-cache");
  await mkdir(cache, { recursive: true });

  const { donnees: divisions } = await lireJson<{ wilayas: WilayaSource[] }>(`${BASE_DIVISIONS}?format=json&file=wilayas&inline=1`, join(cache, "wilayas.json"), sansCache);
  const { donnees: bureaux } = await lireJson<BureauPoste[]>(`${BASE_DIVISIONS}?format=json&file=postoffices&inline=1`, join(cache, "postoffices.json"), sansCache);
  const points = choisirPoints(divisions.wilayas, bureaux);

  const fin = dateCompacte(new Date());
  const empreinte = createHash("sha256");
  const jours: Jour[] = [];
  for (const point of points) {
    const url = `${URL_POWER}?parameters=T2M_MAX,T2M_MIN,T2M&community=RE&longitude=${point.lng}&latitude=${point.lat}&start=${PREMIERE_ANNEE}0101&end=${fin}&format=JSON`;
    console.log(`NASA POWER : ${point.code_wilaya} ${point.chef_lieu} (${point.lat}, ${point.lng})`);
    const { donnees, texte } = await lireJson<ReponsePower>(url, join(cache, `power-${point.code_wilaya}.json`), sansCache);
    empreinte.update(texte);
    jours.push(...lirePower(point.code_wilaya, donnees));
    await pause(500);
  }

  const calcul = agreger(points, jours);
  const rapport = verifier(points, jours, calcul);
  await mkdir(sortie, { recursive: true });
  const ecrire = async (nom: string, lignes: object[], json = true) => {
    if (json) await writeFile(join(sortie, `${nom}.json`), JSON.stringify(lignes) + "\n", "utf8");
    await writeFile(join(sortie, `${nom}.csv`), Papa.unparse(lignes, { newline: "\n" }) + "\n", "utf8");
  };
  await ecrire("temperatures-annuelles", calcul.annuel);
  await ecrire("temperatures-mensuelles", calcul.mensuel);
  await ecrire("synthese-nationale", calcul.national);
  await ecrire("points-de-mesure", points);
  // Le fichier quotidien (plus d'un million de lignes) n'est publié qu'en CSV.
  await ecrire("temperatures-journalieres", jours, false);
  await writeFile(join(sortie, "rapport.json"), JSON.stringify({ genere_le: new Date().toISOString(), ...rapport, empreinte_sha256: empreinte.digest("hex") }, null, 2) + "\n", "utf8");
  console.log(
    `${rapport.nb_points} wilayas, ${rapport.nb_jours} jours (${rapport.premiere_date} → ${rapport.derniere_date}), ` +
      `années complètes ${rapport.premiere_annee}–${rapport.derniere_annee_complete}. Record : ${rapport.record?.tmax} °C à ${rapport.record?.wilaya} le ${rapport.record?.date}.`
  );
}

if (process.argv[1]?.endsWith("/temperatures/calculer.ts") || process.argv[1]?.endsWith("\\temperatures\\calculer.ts")) {
  main().catch((erreur: unknown) => {
    console.error(erreur instanceof Error ? erreur.message : erreur);
    process.exitCode = 1;
  });
}
