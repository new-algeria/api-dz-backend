/**
 * Publication de « Sécheresse, précipitations et humidité des sols en Algérie ».
 * Le JSON `secheresse-wilayas` (60 derniers mois) est la source du visuel choroplèthe;
 * `secheresse-historique` conserve toute la série depuis 1981 et sert de base aux recalculs futurs.
 *
 *   npx tsx scripts/secheresse/publier.ts --verifier
 *   npx tsx scripts/secheresse/publier.ts --essai --sortie /tmp/secheresse/sortie
 *   npx tsx scripts/secheresse/publier.ts --sortie /tmp/secheresse/sortie
 *   npx tsx scripts/secheresse/publier.ts --echec "message"
 *
 * Variables : API_URL, CLE_SYNCHRO, SYNCHRO_ESSAI, SYNCHRO_FORCER, SYNCHRO_DEBUT.
 */
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "secheresse";
const SLUG = "secheresse";
const FICHIER_VISUEL = "secheresse-wilayas";
const FICHIER_HISTORIQUE = "secheresse-historique";
const DOSSIER_DEFAUT = join(import.meta.dirname, "sortie");
const TAILLE_MAX_VISUEL = 4_500_000;
const TAILLE_MAX_FICHIER = 100 * 1024 * 1024;

interface Ligne {
  code_wilaya: string;
  wilaya: string;
  date: string;
  precipitation_mm: number;
  humidite_sol_0_7_cm: number;
  humidite_sol_7_28_cm: number;
  humidite_sol_28_100_cm: number;
  humidite_sol_100_289_cm: number;
  humidite_sol_0_100_cm: number;
  humidite_sol_0_289_cm: number;
  temperature_moyenne_c: number;
  precipitation_normale_mm: number | null;
  anomalie_precipitation_pct: number | null;
  spi_3: number | null;
  spi_12: number | null;
  percentile_humidite_sol: number | null;
}
interface RapportCalcul {
  periode: { debut: string; fin: string };
  reference_spi_et_anomalies: { debut: string; fin: string };
  resolution_grille: string;
  doi: string;
  licence_source: string;
  controle: {
    nb_wilayas: number;
    nb_mois: number;
    premier_mois: string;
    dernier_mois: string;
    nb_lignes: number;
    couverture_spi_3: number;
    couverture_spi_12: number;
    couverture_percentile_sol: number;
  };
  fichiers: {
    visuel: { nb_lignes: number; debut: string; fin: string };
    historique: { nb_lignes: number; debut: string; fin: string };
  };
}

const arguments_ = process.argv.slice(2);
const valeurDe = (option: string) => (arguments_.includes(option) ? arguments_[arguments_.indexOf(option) + 1] : undefined);
const sortie = valeurDe("--sortie") ?? DOSSIER_DEFAUT;
const essai = arguments_.includes("--essai") || process.env.SYNCHRO_ESSAI === "true";
const forcer = process.env.SYNCHRO_FORCER === "true";
const declencheur = forcer ? "forcer" : process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manuel" : "planifie";
const debut = process.env.SYNCHRO_DEBUT?.trim() || new Date().toISOString();
const cle = process.env.CLE_SYNCHRO?.trim() || null;
const api = new ClientApi((process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\\/+$/, ""), cle);

function rapportExecution(statut: string, resume: string, details: Record<string, unknown> = {}) {
  return {
    statut,
    declencheur,
    debut,
    fin: new Date().toISOString(),
    resume,
    rapport: details,
  };
}

async function rapporter(statut: "reussie" | "echec" | "essai", resume: string, details: Record<string, unknown> = {}) {
  console.log(`[${statut}] ${resume}`);
  if (!cle) return;
  await api.rapporter(CODE, rapportExecution(statut, resume, details));
}

function moisIndex(date: string): number {
  const [annee, mois] = date.slice(0, 7).split("-").map(Number);
  return annee * 12 + mois - 1;
}

function moisDepuis(index: number): string {
  const annee = Math.floor(index / 12);
  const mois = index % 12 + 1;
  return `${annee}-${String(mois).padStart(2, "0")}`;
}

function moisEntre(debutMois: string, finMois: string): string[] {
  const debutIndex = moisIndex(debutMois);
  const finIndex = moisIndex(finMois);
  return Array.from({ length: finIndex - debutIndex + 1 }, (_, i) => moisDepuis(debutIndex + i));
}

function verifierLignes(lignes: Ligne[], premiere: string, derniere: string, label: string): void {
  if (!Array.isArray(lignes) || lignes.length === 0) throw new Error(`${label} : tableau vide ou invalide.`);
  const codes = new Set(Array.from({ length: 69 }, (_, i) => String(i + 1).padStart(2, "0")));
  const parMois = new Map<string, Set<string>>();
  for (const ligne of lignes) {
    if (!codes.has(ligne.code_wilaya)) throw new Error(`${label} : code de wilaya invalide ${ligne.code_wilaya}.`);
    if (!/^\\d{4}-\\d{2}-01$/.test(ligne.date)) throw new Error(`${label} : date mensuelle invalide ${ligne.date}.`);
    if (!ligne.wilaya?.trim()) throw new Error(`${label} : nom manquant pour ${ligne.code_wilaya}.`);
    if (!Number.isFinite(ligne.precipitation_mm) || ligne.precipitation_mm < 0) throw new Error(`${label} : précipitation invalide (${ligne.code_wilaya}, ${ligne.date}).`);
    for (const cle of [
      "humidite_sol_0_7_cm", "humidite_sol_7_28_cm", "humidite_sol_28_100_cm", "humidite_sol_100_289_cm",
      "humidite_sol_0_100_cm", "humidite_sol_0_289_cm",
    ] as const) {
      if (!Number.isFinite(ligne[cle]) || ligne[cle] < 0 || ligne[cle] > 1) {
        throw new Error(`${label} : ${cle} hors de [0, 1] (${ligne.code_wilaya}, ${ligne.date}).`);
      }
    }
    if (!Number.isFinite(ligne.temperature_moyenne_c) || ligne.temperature_moyenne_c < -80 || ligne.temperature_moyenne_c > 65) {
      throw new Error(`${label} : température hors plage physique (${ligne.code_wilaya}, ${ligne.date}).`);
    }
    for (const cle of ["precipitation_normale_mm", "anomalie_precipitation_pct", "spi_3", "spi_12", "percentile_humidite_sol"] as const) {
      const valeur = ligne[cle];
      if (valeur !== null && !Number.isFinite(valeur)) throw new Error(`${label} : ${cle} non fini (${ligne.code_wilaya}, ${ligne.date}).`);
    }
    if (ligne.percentile_humidite_sol !== null && (ligne.percentile_humidite_sol < 0 || ligne.percentile_humidite_sol > 100)) {
      throw new Error(`${label} : percentile d'humidité hors de [0, 100].`);
    }
    const mois = ligne.date.slice(0, 7);
    const presents = parMois.get(mois) ?? new Set<string>();
    if (presents.has(ligne.code_wilaya)) throw new Error(`${label} : doublon ${ligne.code_wilaya}, ${mois}.`);
    presents.add(ligne.code_wilaya);
    parMois.set(mois, presents);
  }
  const attendus = moisEntre(premiere, derniere);
  const observes = [...parMois.keys()].sort();
  if (JSON.stringify(observes) !== JSON.stringify(attendus)) {
    throw new Error(`${label} : période mensuelle discontinue. Attendu ${premiere}–${derniere}, reçu ${observes[0] ?? "vide"}–${observes.at(-1) ?? "vide"}.`);
  }
  for (const mois of attendus) {
    if (parMois.get(mois)?.size !== 69) throw new Error(`${label} : ${mois} ne contient pas exactement les 69 wilayas.`);
  }
}

if (arguments_.includes("--verifier")) {
  let aFaire = true;
  let raison = "aucune clé : contrôle local";
  if (cle && !forcer) {
    try {
      const synchro = await api.lireSynchro(CODE);
      aFaire = synchro.a_faire;
      raison = aFaire ? "échéance atteinte" : synchro.actif ? `prochain passage le ${synchro.prochaine_execution}` : "synchronisation désactivée";
    } catch (erreur) {
      if (!(erreur instanceof ErreurAppel) || (erreur.statut !== 404 && erreur.statut !== 503)) throw erreur;
      aFaire = false;
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : appliquer la migration data-dz`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul de la sécheresse a échoué (voir les journaux de la GitHub Action).", {});
  process.exit(0);
}

const historique = JSON.parse(await readFile(join(sortie, `${FICHIER_HISTORIQUE}.json`), "utf8")) as Ligne[];
const visuelles = JSON.parse(await readFile(join(sortie, `${FICHIER_VISUEL}.json`), "utf8")) as Ligne[];
const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as RapportCalcul;

verifierLignes(historique, rapport.periode.debut, rapport.periode.fin, "Archive historique");
verifierLignes(visuelles, rapport.fichiers.visuel.debut, rapport.fichiers.visuel.fin, "Visuel cartographique");
if (rapport.controle.nb_wilayas !== 69 || rapport.controle.nb_lignes !== historique.length) {
  throw new Error("Le rapport de calcul ne correspond pas aux 69 wilayas ou au nombre de lignes historique.");
}
if (historique.length !== rapport.fichiers.historique.nb_lignes || visuelles.length !== rapport.fichiers.visuel.nb_lignes) {
  throw new Error("Le rapport de fichiers ne correspond pas aux tableaux JSON générés.");
}
const derniere = rapport.periode.fin;
const resumeChiffres = `69 wilayas, ${rapport.periode.debut}–${derniere} ; ${historique.length.toLocaleString("fr-FR")} lignes mensuelles, SPI-3/SPI-12 et humidité du sol.`;

const champs = {
  titre: {
    fr: "Sécheresse, précipitations et humidité des sols en Algérie",
    en: "Drought, precipitation and soil moisture in Algeria",
    ar: "الجفاف والتساقطات ورطوبة التربة في الجزائر",
  },
  description: {
    fr: `Suivi mensuel des précipitations, des anomalies de pluie, des indices SPI-3 et SPI-12, de l'humidité des sols et de la température moyenne dans les 69 wilayas. Réanalyse ERA5-Land de Copernicus, environ 9 km, de ${rapport.periode.debut} à ${derniere}. Les données sont modélisées et publiées avec environ trois mois de recul : elles ne remplacent pas les mesures des stations météo.`,
    en: `Monthly monitoring of precipitation, rainfall anomalies, SPI-3 and SPI-12, soil moisture and mean temperature across Algeria's 69 wilayas. Copernicus ERA5-Land reanalysis, around 9 km, from ${rapport.periode.debut} to ${derniere}. These are modelled data published with an approximately three-month delay, not a substitute for weather-station measurements.`,
    ar: `متابعة شهرية للتساقطات وشذوذ الأمطار ومؤشري SPI-3 وSPI-12 ورطوبة التربة ومتوسط الحرارة في الولايات الجزائرية الـ69. إعادة تحليل ERA5-Land من كوبرنيكوس بدقة تقارب 9 كم، من ${rapport.periode.debut} إلى ${derniere}. هذه بيانات نمذجة تنشر بتأخر يقارب ثلاثة أشهر ولا تعوض قياسات محطات الأرصاد.`,
  },
  readme: [
    "## Sécheresse, précipitations et humidité des sols en Algérie",
    "",
    `Série mensuelle par wilaya, de ${rapport.periode.debut} à ${derniere}, issue de la réanalyse ERA5-Land du Copernicus Climate Change Service (C3S). Les valeurs sont des moyennes spatiales à l'échelle de chaque wilaya ; elles ne décrivent pas les écarts locaux à l'intérieur de celle-ci.`,
    "",
    "### Indicateurs disponibles",
    "- **Précipitations mensuelles (mm)** : total de pluie et d'équivalent en eau de la neige, reconstruit à partir du taux quotidien moyen ERA5-Land et du nombre de jours du mois.",
    "- **Normale de précipitations (mm)** : moyenne du même mois calendaire sur 1991–2020.",
    "- **Anomalie de précipitations (%)** : écart relatif entre le mois et sa normale 1991–2020. Une valeur négative indique moins de précipitations que la normale.",
    "- **SPI-3 / SPI-12** : indice standardisé des cumuls de précipitations sur trois ou douze mois. L'ajustement Gamma avec probabilité de précipitation nulle est effectué par wilaya et mois de fin, sur la période 1991–2020. Des valeurs négatives indiquent un déficit pluviométrique ; plus elles sont basses, plus le déficit est marqué.",
    "- **Humidité volumique du sol (m³/m³)** : couches ERA5-Land 0–7 cm, 7–28 cm, 28–100 cm et 100–289 cm ; deux composites pondérés par l'épaisseur sont fournis pour 0–100 cm et 0–289 cm.",
    "- **Percentile d'humidité du sol (0–100 cm)** : position du mois par rapport au même mois de la normale 1991–2020, calculée par wilaya. Un percentile bas indique un sol plus sec que la normale saisonnière.",
    "- **Température moyenne à 2 m (°C)** : moyenne mensuelle ERA5-Land.",
    "",
    "### Méthode spatiale et temporelle",
    `La grille ERA5-Land mensuelle (résolution native 0,1° × 0,1°, environ 9 km) est agrégée dans les 69 contours GeoAlgeria. Une cellule est affectée à la wilaya qui contient son centre ; les moyennes sont pondérées par cos(latitude), approximation de la surface des cellules de la grille latitude/longitude. La période de référence des normales et percentiles est 1991–2020.`,
    "Les cumuls glissants SPI-3 et SPI-12 ne sont calculés que lorsque tous les mois de la fenêtre sont présents. Si l'échantillon de référence est insuffisant pour un ajustement stable, la valeur est `null` et n'est jamais remplacée par zéro.",
    "",
    "### Fichiers",
    `- \\`${FICHIER_VISUEL}.json\\` : 60 derniers mois, fichier léger utilisé pour la carte choroplèthe et les graphiques interactifs de data-dz.`,
    `- \\`${FICHIER_VISUEL}.csv\\` : mêmes 60 mois au format CSV.`,
    `- \\`${FICHIER_HISTORIQUE}.json\\` et \\`${FICHIER_HISTORIQUE}.csv\\` : archive complète depuis janvier 1981, utilisée aussi comme historique de référence lors des mises à jour.`,
    "",
    "### Limites et interprétation",
    "- ERA5-Land est une **réanalyse atmosphérique et terrestre modélisée**, pas un relevé de pluviomètre ou de sonde d'humidité. Les biais locaux et les incertitudes du modèle restent présents.",
    "- La résolution d'environ 9 km et l'agrégation par wilaya lissent les contrastes entre communes, reliefs, vallées et zones agricoles.",
    "- SPI décrit le déficit ou l'excédent de précipitations ; il ne mesure pas à lui seul l'état de l'eau disponible pour les cultures, les barrages ou les nappes.",
    "- Le percentile d'humidité du sol est une comparaison historique saisonnière propre à chaque wilaya, pas un seuil agronomique universel.",
    "- Le produit mensuel a un retard de publication de plusieurs semaines à quelques mois ; la série s'arrête volontairement trois mois avant le mois courant pour éviter de présenter une période incomplète comme définitive.",
    "- Ces indicateurs sont informatifs et ne constituent ni une alerte officielle ni une déclaration administrative de sécheresse.",
    "",
    "### Sources et licences",
    "- Copernicus Climate Change Service (C3S), ERA5-Land monthly averaged data from 1950 to present, DOI https://doi.org/10.24381/cds.68d2bb30, licence CC BY 4.0 : https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-monthly-means",
    "- Contours et noms des wilayas : GeoAlgeria, jeu « Divisions administratives », contours `wilaya-boundaries`, ODbL-1.0 : https://geoalgeria.com. Les géométries ne sont pas redistribuées dans ces fichiers ; elles servent à affecter les statistiques aux wilayas.",
    "- Indices SPI : calculés par data-dz à partir des précipitations ERA5-Land, avec une distribution Gamma et une masse en zéro, selon la méthode décrite ci-dessus.",
  ].join("\\n"),
  categorie_slug: "environnement",
  source_slug: "copernicus-era5-land",
  licence_code: "CC-BY-4.0",
  licence_details: "Données climatiques Copernicus C3S / ECMWF issues d'ERA5-Land, licence CC BY 4.0 (attribution Copernicus requise). Les contours des 69 wilayas utilisés pour l'agrégation proviennent de GeoAlgeria (ODbL-1.0) ; leurs géométries ne sont pas redistribuées dans ce jeu.",
  url_source: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-monthly-means",
  mots_cles: [
    "sécheresse", "precipitations", "pluie", "pluviometrie", "SPI", "SPI-3", "SPI-12", "humidite des sols",
    "soil moisture", "drought", "rainfall", "ERA5-Land", "Copernicus", "climat", "temperature", "wilaya", "الامطار", "الجفاف", "رطوبة التربة",
  ],
  frequence_maj: "mensuelle",
  infos_source: {
    premiere_annee_observee: Number(rapport.periode.debut.slice(0, 4)),
    derniere_annee_observee: Number(derniere.slice(0, 4)),
    periode: `${rapport.periode.debut} → ${derniere}`,
    nb_wilayas: 69,
    nb_mois: rapport.controle.nb_mois,
    nb_enregistrements: historique.length,
    resolution_grille: rapport.resolution_grille,
    reference_climatologique: "1991–2020",
    indicateurs: ["precipitation_mm", "anomalie_precipitation_pct", "spi_3", "spi_12", "humidite_sol_0_100_cm", "percentile_humidite_sol", "temperature_moyenne_c"],
    methode: "Moyenne surfacique de la grille ERA5-Land par contour de wilaya, pondération cos(latitude)",
  },
};

const rapportDetails = {
  periode: rapport.periode,
  reference: rapport.reference_spi_et_anomalies,
  nb_lignes: historique.length,
  nb_lignes_visuel: visuelles.length,
  controle: rapport.controle,
  resolution_grille: rapport.resolution_grille,
  doi: rapport.doi,
  licence_source: rapport.licence_source,
};

if (essai || !cle) {
  console.log("Essai : aucune métadonnée ni aucun fichier ne sera publié.");
  await rapporter("essai", `Essai : ${resumeChiffres}.`, rapportDetails);
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Fiche créée en brouillon." : "Métadonnées mises à jour ; statut existant conservé.");
const actuel = creee ? null : await api.lireFichier(SLUG, FICHIER_HISTORIQUE, "json");
const historiqueInchange = actuel !== null && JSON.stringify(JSON.parse(actuel)) === JSON.stringify(historique);
if (historiqueInchange) {
  await rapporter("reussie", `Inchangée : ${resumeChiffres}.`, { ...rapportDetails, publiee: false });
  process.exit(0);
}

const fichiersEntree: { nom: string; format: "json" | "csv"; principal: boolean; chemin: string }[] = [
  { nom: FICHIER_VISUEL, format: "json", principal: true, chemin: join(sortie, `${FICHIER_VISUEL}.json`) },
  { nom: FICHIER_VISUEL, format: "csv", principal: false, chemin: join(sortie, `${FICHIER_VISUEL}.csv`) },
  { nom: FICHIER_HISTORIQUE, format: "json", principal: false, chemin: join(sortie, `${FICHIER_HISTORIQUE}.json`) },
  { nom: FICHIER_HISTORIQUE, format: "csv", principal: false, chemin: join(sortie, `${FICHIER_HISTORIQUE}.csv`) },
];
const envoyes = await Promise.all(fichiersEntree.map(async (fichier) => {
  const infos = await stat(fichier.chemin);
  if (infos.size > TAILLE_MAX_FICHIER) throw new Error(`${fichier.nom}.${fichier.format} dépasse 100 Mo.`);
  const contenu = await readFile(fichier.chemin, "utf8");
  return { ...fichier, cle: await api.envoyerFichier(SLUG, fichier.nom, contenu, fichier.format) };
}));
const version = await api.publierVersion(SLUG, {
  notes: `Copernicus ERA5-Land monthly means, ${rapport.periode.debut}–${derniere}, SPI-3/SPI-12 et humidité des sols ; archive complète depuis 1981.`,
  fichiers: envoyes.map(({ cle: cleFichier, nom, format, principal }) => ({ cle: cleFichier, nom, format, principal })),
});
const resume = `Version ${version.numero} publiée : ${resumeChiffres}.`;
console.log(resume);
await rapporter("reussie", resume, { ...rapportDetails, creee, publiee: true, version: version.numero });
