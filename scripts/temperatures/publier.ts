// Publication du dataset « Températures et chaleur par wilaya » sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// Une version n'est ajoutée que si les fichiers calculés ont changé.
//
//   npx tsx scripts/temperatures/publier.ts --verifier
//   npx tsx scripts/temperatures/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/temperatures/publier.ts --sortie DOSSIER
//   npx tsx scripts/temperatures/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";
import { PAGE_POWER, type Rapport } from "./calculer.js";

export const CODE = "temperatures";
export const SLUG = "temperatures-wilayas";
/** Le premier fichier est le principal : la synthèse annuelle par wilaya (carte colorée et courbe sur la fiche). */
export const FICHIERS_JSON = ["temperatures-annuelles", "temperatures-mensuelles", "synthese-nationale", "points-de-mesure"] as const;
/** Plus d'un million de lignes : publié en CSV seulement. */
export const FICHIER_QUOTIDIEN = "temperatures-journalieres";

const arguments_ = process.argv.slice(2);
const valeurDe = (option: string) => (arguments_.includes(option) ? arguments_[arguments_.indexOf(option) + 1] : undefined);
const sortie = valeurDe("--sortie") ?? join(import.meta.dirname, "sortie");
const essai = arguments_.includes("--essai") || process.env.SYNCHRO_ESSAI === "true";
const forcer = process.env.SYNCHRO_FORCER === "true";
const declencheur = forcer ? "forcer" : process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manuel" : "planifie";
const debut = process.env.SYNCHRO_DEBUT?.trim() || new Date().toISOString();
const cle = process.env.CLE_SYNCHRO?.trim() || null;
const api = new ClientApi((process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, ""), cle);

async function rapporter(statut: "reussie" | "echec" | "essai", resume: string, donnees: Record<string, unknown> = {}) {
  console.log(`[${statut}] ${resume}`);
  if (cle) await api.rapporter(CODE, { statut, declencheur, debut, fin: new Date().toISOString(), resume, rapport: donnees });
}

if (arguments_.includes("--verifier")) {
  let aFaire = true;
  let raison = "aucune clé : calcul local";
  if (cle && !forcer) {
    try {
      const synchro = await api.lireSynchro(CODE);
      aFaire = synchro.a_faire;
      raison = aFaire ? "échéance atteinte" : synchro.actif ? `prochain passage le ${synchro.prochaine_execution}` : "synchronisation désactivée";
    } catch (erreur) {
      if (!(erreur instanceof ErreurAppel) || (erreur.statut !== 404 && erreur.statut !== 503)) throw erreur;
      aFaire = false;
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration ${CODE} à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul des températures a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport & { empreinte_sha256: string };
const contenus = Object.fromEntries(
  await Promise.all(
    FICHIERS_JSON.map(async (nom) => [nom, { json: await readFile(join(sortie, `${nom}.json`), "utf8"), csv: await readFile(join(sortie, `${nom}.csv`), "utf8") }] as const)
  )
) as Record<(typeof FICHIERS_JSON)[number], { json: string; csv: string }>;
const quotidien = await readFile(join(sortie, `${FICHIER_QUOTIDIEN}.csv`), "utf8");
const lignes = (nom: (typeof FICHIERS_JSON)[number]) => JSON.parse(contenus[nom].json) as Record<string, unknown>[];
if (lignes("temperatures-annuelles").length !== rapport.nb_lignes_annuelles || lignes("temperatures-mensuelles").length !== rapport.nb_lignes_mensuelles) {
  throw new Error("Sorties incohérentes avec rapport.json.");
}
if (lignes("points-de-mesure").length !== 69 || rapport.nb_points !== 69) throw new Error("Il faut un point de mesure par wilaya (69).");
if (quotidien.split("\n").filter(Boolean).length - 1 !== rapport.nb_jours) throw new Error("Fichier quotidien incohérent avec rapport.json.");

const nationale = lignes("synthese-nationale");
const derniere = nationale[nationale.length - 1] as { annee: number; ecart_normale_moyen: number | null };
const chiffres = `69 wilayas, ${rapport.premiere_annee}–${rapport.derniere_annee_complete} (données jusqu'au ${rapport.derniere_date})`;
const rapportDonnee = (resultat: Record<string, unknown>) => ({
  source_url: rapport.source_url,
  empreinte_sha256: rapport.empreinte_sha256,
  periode: [rapport.premiere_date, rapport.derniere_date],
  record: rapport.record,
  donnees: {
    [SLUG]: {
      fichiers: {
        ...Object.fromEntries(FICHIERS_JSON.map((nom) => [nom, { total: lignes(nom).length }])),
        [FICHIER_QUOTIDIEN]: { total: rapport.nb_jours },
      },
      ...resultat,
    },
  },
});

const record = rapport.record ? `${rapport.record.tmax} °C (${rapport.record.wilaya}, ${rapport.record.date})` : "non disponible";
const champs = {
  titre: {
    fr: "Températures et chaleur par wilaya (depuis 1981)",
    en: "Temperatures and heat by wilaya (since 1981)",
    ar: "درجات الحرارة والحر حسب الولاية (منذ 1981)",
  },
  description: {
    fr: `Températures quotidiennes estimées au chef-lieu des 69 wilayas depuis ${rapport.premiere_annee}, et leurs synthèses mensuelles et annuelles : moyennes, records, jours à 35 °C et 40 °C ou plus, nuits à 20 °C ou plus et écart à la normale ${rapport.normale[0]}–${rapport.normale[1]} (réanalyse NASA POWER).`,
    en: `Estimated daily temperatures at the capital of each of Algeria's 69 wilayas since ${rapport.premiere_annee}, with monthly and yearly summaries: averages, records, days at 35 °C and 40 °C or more, nights at 20 °C or more and anomaly versus the ${rapport.normale[0]}–${rapport.normale[1]} normal (NASA POWER reanalysis).`,
    ar: `درجات الحرارة اليومية المقدّرة في عاصمة كل ولاية من الولايات الـ 69 منذ ${rapport.premiere_annee}، مع ملخصات شهرية وسنوية: المعدلات والأرقام القياسية وعدد الأيام التي تبلغ 35 و40 درجة أو أكثر والليالي التي تبلغ 20 درجة أو أكثر والفرق عن المعدل ${rapport.normale[0]}–${rapport.normale[1]} (إعادة تحليل NASA POWER).`,
  },
  readme: [
    "## Températures et chaleur par wilaya",
    "",
    `Séries quotidiennes de ${rapport.premiere_date} à ${rapport.derniere_date} pour les 69 wilayas (${rapport.nb_jours} jours au total), synthèses annuelles de ${rapport.premiere_annee} à ${rapport.derniere_annee_complete}. Température maximale la plus élevée de la série : ${record}.`,
    derniere.ecart_normale_moyen !== null ? `En ${derniere.annee}, la température moyenne des 69 chefs-lieux a été supérieure de ${derniere.ecart_normale_moyen} °C à la normale ${rapport.normale[0]}–${rapport.normale[1]}.` : "",
    "",
    "### Fichiers",
    "- `temperatures-annuelles` (principal) : par wilaya et par année complète, température moyenne, moyennes des maximales et des minimales, maximale record, jours à 35 °C et à 40 °C ou plus, nuits à 20 °C ou plus, écart à la normale.",
    "- `temperatures-mensuelles` : les mêmes mesures par mois.",
    "- `synthese-nationale` : par année, moyenne des 69 chefs-lieux, écart moyen à la normale, jours à 40 °C cumulés sur les wilayas, nombre de wilayas ayant connu au moins un jour à 40 °C, record de l'année.",
    "- `points-de-mesure` : le point retenu pour chaque wilaya (chef-lieu, latitude, longitude, méthode).",
    "- `temperatures-journalieres` (CSV seulement, plus d'un million de lignes) : maximale, minimale et moyenne de chaque jour.",
    "",
    "### Méthode",
    "- Un point par wilaya, au chef-lieu : la position du bureau de poste principal de la commune chef-lieu (fichier `postoffices` de la donnée « Divisions administratives »), sinon la médiane des bureaux de poste de cette commune.",
    "- Pour chaque point, l'API « daily point » de NASA POWER fournit la température à 2 mètres (maximale `T2M_MAX`, minimale `T2M_MIN`, moyenne `T2M`) depuis 1981.",
    "- Un mois ou une année n'est synthétisé que si au moins 95 % de ses jours sont disponibles ; la normale d'une wilaya n'est calculée que si au moins 27 des 30 années 1991–2020 sont complètes. La synthèse nationale ne retient que les années complètes dans les 69 wilayas.",
    "",
    "### À savoir",
    "- **Ce sont des estimations, pas des relevés de stations météo.** NASA POWER s'appuie sur la réanalyse MERRA-2 (puis GEOS-IT pour les jours récents), une maille d'environ 50 km sur laquelle la température est lissée : les extrêmes locaux peuvent être sous-estimés, en particulier sur la côte, où la maille mêle terre et mer.",
    "- Les valeurs décrivent le point du chef-lieu, pas toute la wilaya : dans les grandes wilayas du Sud, d'autres communes peuvent être nettement plus chaudes ou plus fraîches.",
    "- Les derniers jours de la série peuvent être révisés par la NASA ; les jours non encore calculés sont absents.",
    "",
    "### Source et licence",
    "- NASA Langley Research Center (LaRC), POWER Project, https://power.larc.nasa.gov/ — données ouvertes de la NASA, réutilisables librement ; la NASA demande de citer : « These data were obtained from the NASA Langley Research Center (LaRC) POWER Project funded through the NASA Earth Science/Applied Science Program. »",
    "- Points de mesure : GeoAlgeria par Yasser's studio (bureaux de poste, donnée « Divisions administratives »).",
    "- Modifications : un point par chef-lieu, synthèses mensuelles, annuelles et nationales, indicateurs de chaleur et écart à la normale calculés par data-dz.",
  ]
    .filter((ligne, index, liste) => ligne !== "" || liste[index - 1] !== "")
    .join("\n"),
  categorie_slug: "environnement",
  source_slug: "nasa-power",
  licence_code: "CC0-1.0",
  licence_details: "Données ouvertes de la NASA (POWER Project, NASA Langley Research Center), sans restriction de réutilisation ; citation de la NASA demandée. Points de mesure tirés des bureaux de poste de GeoAlgeria. Synthèses calculées par data-dz.",
  url_source: PAGE_POWER,
  mots_cles: ["température", "chaleur", "canicule", "climat", "réchauffement", "météo", "40 °C", "NASA", "حرارة", "موجة حر", "مناخ"],
  frequence_maj: "hebdomadaire",
  infos_source: {
    // Chiffre de la carte du catalogue : « 8 indicateurs, 1981 → année complète la plus récente ».
    nb_indicateurs: 8,
    premiere_annee_observee: rapport.premiere_annee,
    derniere_annee_observee: rapport.derniere_annee_complete,
    derniere_date: rapport.derniere_date,
    nb_points: rapport.nb_points,
    normale: `${rapport.normale[0]}–${rapport.normale[1]}`,
    record_tmax: rapport.record,
    methode: "Température à 2 m de NASA POWER (MERRA-2, GEOS-IT) au bureau de poste principal du chef-lieu de chaque wilaya ; synthèses mensuelles et annuelles calculées par data-dz.",
  },
};

if (essai || !cle) {
  console.log(`Essai : aucune publication. ${chiffres}.`);
  console.log(JSON.stringify(champs.infos_source));
  await rapporter("essai", `Essai : ${chiffres}.`, rapportDonnee({ creee: false, publiee: false }));
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
if (!creee) {
  // Le fichier mensuel suffit à repérer un changement : il contient chaque nouveau mois complet.
  const [annuel, mensuel] = await Promise.all([api.lireFichier(SLUG, "temperatures-annuelles", "json"), api.lireFichier(SLUG, "temperatures-mensuelles", "json")]);
  const identique = (texte: string | null, nom: (typeof FICHIERS_JSON)[number]) => texte !== null && JSON.stringify(JSON.parse(texte)) === JSON.stringify(lignes(nom));
  if (identique(annuel, "temperatures-annuelles") && identique(mensuel, "temperatures-mensuelles")) {
    await rapporter("reussie", `Inchangée : ${chiffres}.`, rapportDonnee({ creee, publiee: false }));
    process.exit(0);
  }
}

const fichiers = [];
for (const [i, nom] of FICHIERS_JSON.entries()) {
  const [cleJson, cleCsv] = await Promise.all([api.envoyerFichier(SLUG, nom, contenus[nom].json, "json"), api.envoyerFichier(SLUG, nom, contenus[nom].csv, "csv")]);
  fichiers.push({ cle: cleJson, nom, format: "json", principal: i === 0 }, { cle: cleCsv, nom, format: "csv", principal: false });
}
fichiers.push({ cle: await api.envoyerFichier(SLUG, FICHIER_QUOTIDIEN, quotidien, "csv"), nom: FICHIER_QUOTIDIEN, format: "csv", principal: false });
const version = await api.publierVersion(SLUG, {
  notes: `NASA POWER, ${rapport.premiere_date} → ${rapport.derniere_date} ; ${chiffres}.`,
  fichiers,
});
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee({ creee, publiee: true, version: version.numero }));
