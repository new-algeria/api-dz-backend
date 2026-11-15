/**
 * Publication de la donnée sismique algérienne dans data-dz.
 * Une donnée nouvelle reste en brouillon.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "seismes";
const SLUG = "seismes-algerie";
const FICHIER_USGS = "seismes-usgs";
const FICHIER_ANNUEL = "seismes-annuels";
const FICHIER_ENRICHI = "seismes-algerie";
const FICHIER_WILAYAS = "seismes-wilayas";

interface Seisme {
  id_seisme: string;
  date_utc: string;
  annee: number;
  latitude: number;
  longitude: number;
  profondeur_km: number | null;
  magnitude: number;
  code_wilaya?: string;
  wilaya?: string;
  wilaya_ar?: string;
}
interface RapportCalcul {
  requete: {
    catalogue: string;
    contributeur: string;
    magnitude_minimale: number;
    debut_utc: string;
    fin_utc: string;
  };
  nb_seismes_algerie: number;
  nb_wilayas: number;
  premiere_date_observee_utc: string | null;
  derniere_date_observee_utc: string | null;
  premiere_annee_observee: number | null;
  derniere_annee_observee: number | null;
  magnitude_minimale_observee: number | null;
  magnitude_maximale_observee: number | null;
  nb_lignes_par_fichier: Record<string, number>;
}
interface Serie {
  annee: number;
  valeur: number;
  unite: string;
}

const arguments_ = process.argv.slice(2);
const valeurDe = (option: string) => (arguments_.includes(option) ? arguments_[arguments_.indexOf(option) + 1] : undefined);
const sortie = valeurDe("--sortie") ?? join(import.meta.dirname, "sortie");
const essai = arguments_.includes("--essai") || process.env.SYNCHRO_ESSAI === "true";
const forcer = process.env.SYNCHRO_FORCER === "true";
const declencheur = forcer ? "forcer" : process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manuel" : "planifie";
const debut = process.env.SYNCHRO_DEBUT?.trim() || new Date().toISOString();
const cle = process.env.CLE_SYNCHRO?.trim() || null;
const api = new ClientApi((process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, ""), cle);

async function rapporter(statut: "reussie" | "echec" | "essai", resume: string, details: Record<string, unknown> = {}) {
  console.log("[" + statut + "] " + resume);
  if (!cle) return;
  await api.rapporter(CODE, { statut, declencheur, debut, fin: new Date().toISOString(), resume, rapport: details });
}

if (arguments_.includes("--verifier")) {
  let aFaire = true;
  let raison = "aucune clé : vérification locale";
  if (cle && !forcer) {
    try {
      const synchro = await api.lireSynchro(CODE);
      aFaire = synchro.a_faire;
      raison = aFaire
        ? "échéance atteinte"
        : synchro.actif
          ? "prochain passage le " + synchro.prochaine_execution
          : "synchronisation désactivée";
    } catch (erreur) {
      if (!(erreur instanceof ErreurAppel) || (erreur.statut !== 404 && erreur.statut !== 503)) throw erreur;
      aFaire = false;
      raison = "synchronisation absente de l'API : appliquer la migration 20261115000026 de data-dz";
    }
  } else if (forcer) raison = "forcée";
  console.log((aFaire ? "À faire" : "Rien à faire") + " : " + raison + ".");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "a_faire=" + aFaire + "\n");
  process.exit(0);
}
if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "La synchronisation des séismes a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const [brutsTexte, brutsCsv, annuelsTexte, annuelsCsv, enrichisTexte, enrichisCsv, geojsonTexte, wilayasTexte, wilayasCsv, rapportTexte] =
  await Promise.all([
    readFile(join(sortie, FICHIER_USGS + ".json"), "utf8"),
    readFile(join(sortie, FICHIER_USGS + ".csv"), "utf8"),
    readFile(join(sortie, FICHIER_ANNUEL + ".json"), "utf8"),
    readFile(join(sortie, FICHIER_ANNUEL + ".csv"), "utf8"),
    readFile(join(sortie, FICHIER_ENRICHI + ".json"), "utf8"),
    readFile(join(sortie, FICHIER_ENRICHI + ".csv"), "utf8"),
    readFile(join(sortie, FICHIER_ENRICHI + ".geojson"), "utf8"),
    readFile(join(sortie, FICHIER_WILAYAS + ".json"), "utf8"),
    readFile(join(sortie, FICHIER_WILAYAS + ".csv"), "utf8"),
    readFile(join(sortie, "rapport.json"), "utf8"),
  ]);

const bruts = JSON.parse(brutsTexte) as Seisme[];
const annuels = JSON.parse(annuelsTexte) as Serie[];
const enrichis = JSON.parse(enrichisTexte) as Seisme[];
const geojson = JSON.parse(geojsonTexte) as { type: string; features: unknown[] };
const wilayas = JSON.parse(wilayasTexte) as (Serie & { code_wilaya: string })[];
const rapport = JSON.parse(rapportTexte) as RapportCalcul;

if (rapport.nb_wilayas !== 69 || bruts.length !== rapport.nb_seismes_algerie || enrichis.length !== bruts.length) {
  throw new Error("Nombre d'événements ou de wilayas incohérent dans les fichiers calculés.");
}
if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features) || geojson.features.length !== enrichis.length) {
  throw new Error("Le GeoJSON ne correspond pas aux événements enrichis.");
}
if (annuels.reduce((somme, ligne) => somme + ligne.valeur, 0) !== enrichis.length) {
  throw new Error("La série annuelle ne correspond pas au nombre d'événements.");
}
if (wilayas.length !== annuels.length * 69 || wilayas.some((ligne) => !Number.isInteger(ligne.valeur) || ligne.valeur < 0)) {
  throw new Error("La série par wilaya doit contenir 69 lignes par année, sans valeur négative.");
}
if (
  enrichis.some((ligne) =>
    !ligne.id_seisme ||
    !Number.isFinite(ligne.magnitude) ||
    ligne.magnitude < rapport.requete.magnitude_minimale ||
    !Number.isFinite(ligne.latitude) ||
    !Number.isFinite(ligne.longitude) ||
    !/^\d{2}$/.test(ligne.code_wilaya ?? "")
  )
) {
  throw new Error("Un événement sismique enrichi contient une valeur invalide.");
}

const datePremiere = rapport.premiere_date_observee_utc ?? "aucune";
const dateDerniere = rapport.derniere_date_observee_utc ?? "aucune";
const resumeChiffres =
  new Intl.NumberFormat("fr-FR").format(enrichis.length) +
  " séismes M ≥ " +
  rapport.requete.magnitude_minimale.toLocaleString("fr-FR") +
  " dans les 69 wilayas ; période observée : " +
  datePremiere +
  " → " +
  dateDerniere +
  ".";

const champs = {
  titre: {
    fr: "Séismes en Algérie (catalogue USGS NEIC/PDE)",
    en: "Earthquakes in Algeria (USGS NEIC/PDE catalogue)",
    ar: "الزلازل في الجزائر (فهرس USGS NEIC/PDE)",
  },
  description: {
    fr:
      "Événements sismiques de magnitude au moins 2,5 dont l’épicentre est situé à l’intérieur des 69 wilayas, issus du catalogue USGS NEIC/PDE (catalogue us, contributeur us) depuis 1973 (dernier événement observé : " + dateDerniere + "). Carte des épicentres, profondeur et magnitude, série annuelle et décompte par wilaya. Sous-ensemble du catalogue mondial, non exhaustif par rapport au CRAAG.",
    en:
      "Earthquakes of magnitude 2.5 or greater with epicentres inside Algeria’s 69 wilayas, from the USGS NEIC/PDE catalogue (catalog us, contributor us) since 1973 (latest event observed: " + dateDerniere + "). Epicentre map, depth and magnitude, annual time series and counts by wilaya. A subset of the global catalogue, not a complete CRAAG inventory.",
    ar:
      "أحداث زلزالية بقوة 2.5 أو أكثر تقع مراكزها داخل الولايات الجزائرية الـ69، من فهرس USGS NEIC/PDE (catalog us, contributor us) منذ 1973. خريطة المراكز والأعماق والقوة وسلسلة سنوية وعدد حسب الولاية. مجموعة فرعية من الفهرس العالمي وليست فهرسًا كاملًا لبيانات CRAAG.",
  },
  readme: [
    "## Séismes en Algérie — catalogue USGS NEIC/PDE",
    "",
    "Cette donnée rassemble les événements sismiques du catalogue mondial du USGS National Earthquake Information Center (NEIC), bulletin Preliminary Determination of Epicenters (PDE), dont l’épicentre se trouve dans l’une des 69 wilayas algériennes.",
    "",
    "### Périmètre de collecte",
    "",
    "- Catalogue FDSN : catalog=us ; contributeur : contributor=us (USGS National Earthquake Information Center / PDE). Le catalogue ComCat global agrège plusieurs réseaux ; cette extraction n’interroge pas les contributions d’autres organismes.",
    "- Période demandée : du 1er janvier 1973 à la date du dernier calcul UTC. Événements réellement observés dans cette extraction : " + datePremiere + " à " + dateDerniere + ". La dernière date d’événement peut être sensiblement antérieure à la collecte.",
    "- Seuil : magnitude supérieure ou égale à 2,5. Les événements plus faibles ne sont pas collectés.",
    "- L’emprise rectangulaire est calculée depuis les contours des 69 wilayas ; chaque point est ensuite vérifié par un test point-dans-polygone. Les épicentres en mer ou hors des contours terrestres sont écartés.",
    "- Un événement est identifié par son identifiant USGS. Les réponses des périodes éventuellement découpées sont dédupliquées.",
    "",
    "### Fichiers",
    "",
    "- seismes-usgs (JSON et CSV) : paramètres d’événements NEIC/PDE, sans affectation administrative, CC0-1.0.",
    "- seismes-annuels (JSON et CSV) : nombre annuel de séismes retenus, avec annee, valeur et unite ; l’année en cours est partielle, les années sans événement sont représentées par zéro.",
    "- seismes-algerie (JSON, CSV et GeoJSON) : événements enrichis avec code_wilaya, wilaya et wilaya_ar, et carte ponctuelle des épicentres. Fichiers calculés à partir des contours GeoAlgeria, ODbL-1.0.",
    "- seismes-wilayas (JSON et CSV) : nombre annuel par wilaya, 69 lignes par année, avec code_wilaya, wilaya, wilaya_ar, annee, valeur et unite ; GeoAlgeria, ODbL-1.0.",
    "",
    "### À savoir — limites importantes",
    "",
    "- Ce jeu est le sous-ensemble du catalogue USGS NEIC/PDE répondant aux filtres ci-dessus. Il ne remplace pas le catalogue national du CRAAG et ne contient pas nécessairement tous les séismes détectés par les réseaux locaux.",
    "- L’absence d’événement dans ce fichier ne signifie pas qu’aucun séisme n’a eu lieu : les événements sous M 2,5, non détectés, non localisés ou absents du bulletin NEIC/PDE ne sont pas présents.",
    "- La complétude du catalogue, les seuils de détection, la précision de la magnitude et la qualité de la profondeur varient selon les périodes, les zones et les réseaux. Une profondeur absente reste null ; elle n’est jamais remplacée par zéro.",
    "- Les événements sont classés selon l’épicentre, pas selon la zone où les secousses ont été ressenties. Les séismes en mer proches de l’Algérie sont exclus du décompte par wilaya.",
    "- La série annuelle de l’année courante est incomplète à la date du calcul. Les zéros signifient « aucun événement correspondant aux filtres trouvé dans cette extraction », pas une absence certaine de sismicité.",
    "- La magnitude n’est pas une mesure directe des dégâts ou de l’intensité ressentie.",
    "",
    "### Source nationale complémentaire",
    "",
    "Le CRAAG publie une carte des séismes et référence plusieurs catalogues historiques, notamment 1365–1992 et 1992–2001. Sa page consultée ne donne pas de licence ouverte autorisant la redistribution des catalogues ; ceux-ci ne sont donc pas copiés dans cette donnée. Consulter : https://www.craag.dz/index.php/seisme_g/ et https://www.craag.dz/index.php/catalogues-de-sismicite/.",
    "",
    "### Sources et licences",
    "",
    "- USGS, ANSS Comprehensive Earthquake Catalog (ComCat) : https://earthquake.usgs.gov/data/comcat/",
    "- USGS NEIC/PDE, catalogue US : https://earthquake.usgs.gov/data/comcat/catalog/us/",
    "- API FDSN Event Web Service : https://earthquake.usgs.gov/fdsnws/event/1/",
    "- Politique USGS de licence des données : https://www.usgs.gov/data-management/data-licensing. Les fichiers d’événements bruts sélectionnent le contributeur USGS NEIC/PDE et sont diffusés sous CC0-1.0 ; cette licence ne doit pas être étendue aux contributions d’autres réseaux ComCat.",
    "- Contours et nomenclature des wilayas : GeoAlgeria, https://geoalgeria.com (ODbL-1.0).",
    "",
    "### Mise à jour",
    "",
    "Fréquence cible : quotidienne. À chaque passage, l’intégralité de la période est relue depuis l’API NEIC/PDE pour intégrer les révisions de paramètres ; aucun total historique n’est extrapolé. Dernier calcul : " +
      rapport.requete.fin_utc +
      ". Nombre d’événements retenus : " +
      enrichis.length +
      ".",
    "",
    "Champs des événements enrichis : id_seisme, date_utc, annee, latitude, longitude, profondeur_km, magnitude, type_magnitude, lieu, reseau, significativite, ressenti_nb, intensite_cdi, intensite_mmi, alerte, tsunami, statut, mis_a_jour_utc, url_usgs, code_wilaya, wilaya, wilaya_ar.",
  ].join("\n"),
  categorie_slug: "environnement",
  source_slug: "usgs-comcat",
  licence_code: "CC0-1.0",
  licence_details:
    "Événements NEIC/PDE demandés au contributeur USGS : CC0-1.0. Fichiers enrichis et agrégés par wilaya à partir des contours GeoAlgeria : ODbL-1.0 (source et licence précisées au niveau des fichiers).",
  url_source: "https://earthquake.usgs.gov/fdsnws/event/1/",
  mots_cles: [
    "séismes", "sismicité", "tremblements de terre", "épicentres", "magnitude",
    "profondeur", "risques naturels", "CRAAG", "USGS", "NEIC", "PDE", "Algérie",
    "wilaya", "earthquakes", "seismicity", "زلزال", "زلازل", "هزات أرضية",
  ],
  frequence_maj: "quotidienne",
  infos_source: {
    premiere_annee_observee: rapport.premiere_annee_observee,
    derniere_annee_observee: rapport.derniere_annee_observee,
    premiere_date_observee_utc: rapport.premiere_date_observee_utc,
    derniere_date_observee_utc: rapport.derniere_date_observee_utc,
    nb_series: 69,
    nb_wilayas: 69,
    nb_seismes: rapport.nb_seismes_algerie,
    magnitude_minimale: rapport.requete.magnitude_minimale,
    magnitude_maximale_observee: rapport.magnitude_maximale_observee,
    derniere_maj_utc: rapport.requete.fin_utc,
    catalogue: rapport.requete.catalogue,
    contributeur: rapport.requete.contributeur,
    methode: "USGS NEIC/PDE FDSN + test point-dans-polygone sur les 69 contours GeoAlgeria",
  },
};

const rapportDonnee = (resultat: Record<string, unknown>) => ({
  source: "USGS NEIC/PDE + GeoAlgeria",
  periode_utc: [rapport.requete.debut_utc, rapport.requete.fin_utc],
  nb_seismes: enrichis.length,
  magnitude_minimale: rapport.requete.magnitude_minimale,
  nb_wilayas: 69,
  donnees: {
    [SLUG]: {
      fichiers: {
        [FICHIER_USGS]: { total: bruts.length },
        [FICHIER_ANNUEL]: { total: annuels.length },
        [FICHIER_ENRICHI]: { total: enrichis.length },
        [FICHIER_WILAYAS]: { total: wilayas.length },
      },
      ...resultat,
    },
  },
});

if (enrichis.length === 0) {
  await rapporter("essai", "Aucun séisme correspondant aux filtres ; aucun fichier vide publié.", rapportDonnee({ creee: false, publiee: false }));
  process.exit(0);
}

async function lire(nom: string, format: string) {
  return api.lireFichier(SLUG, nom, format);
}
function jsonIdentique(actuel: string | null, nouveau: string): boolean {
  if (!actuel) return false;
  try {
    return JSON.stringify(JSON.parse(actuel)) === JSON.stringify(JSON.parse(nouveau));
  } catch {
    return false;
  }
}
const [actuelBrut, actuelBrutCsv, actuelAnnuel, actuelAnnuelCsv, actuelEnrichi, actuelEnrichiCsv, actuelGeojson, actuelWilayas, actuelWilayasCsv] =
  await Promise.all([
    lire(FICHIER_USGS, "json"),
    lire(FICHIER_USGS, "csv"),
    lire(FICHIER_ANNUEL, "json"),
    lire(FICHIER_ANNUEL, "csv"),
    lire(FICHIER_ENRICHI, "json"),
    lire(FICHIER_ENRICHI, "csv"),
    lire(FICHIER_ENRICHI, "geojson"),
    lire(FICHIER_WILAYAS, "json"),
    lire(FICHIER_WILAYAS, "csv"),
  ]);

const brutInchange =
  jsonIdentique(actuelBrut, brutsTexte) &&
  jsonIdentique(actuelAnnuel, annuelsTexte) &&
  actuelBrutCsv === brutsCsv &&
  actuelAnnuelCsv === annuelsCsv;
const geoInchange =
  jsonIdentique(actuelEnrichi, enrichisTexte) &&
  jsonIdentique(actuelGeojson, geojsonTexte) &&
  jsonIdentique(actuelWilayas, wilayasTexte) &&
  actuelEnrichiCsv === enrichisCsv &&
  actuelWilayasCsv === wilayasCsv;

console.log(resumeChiffres);
console.log("Fichiers NEIC/PDE : " + (brutInchange ? "inchangés" : "à mettre à jour") + ".");
console.log("Fichiers enrichis GeoAlgeria : " + (geoInchange ? "inchangés" : "à mettre à jour") + ".");

if (essai || !cle) {
  console.log("Essai : aucune métadonnée ni aucun fichier ne sera publié.");
  await rapporter("essai", "Essai : " + resumeChiffres, rapportDonnee({ publiee: false }));
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Métadonnées mises à jour ; statut existant conservé.");

const versions: string[] = [];
let publiee = false;
if (!brutInchange) {
  const [cleBrutJson, cleBrutCsv, cleAnnuelJson, cleAnnuelCsv] = await Promise.all([
    api.envoyerFichier(SLUG, FICHIER_USGS, brutsTexte, "json"),
    api.envoyerFichier(SLUG, FICHIER_USGS, brutsCsv, "csv"),
    api.envoyerFichier(SLUG, FICHIER_ANNUEL, annuelsTexte, "json"),
    api.envoyerFichier(SLUG, FICHIER_ANNUEL, annuelsCsv, "csv"),
  ]);
  const version = await api.publierVersion(SLUG, {
    notes:
      "Catalogue USGS NEIC/PDE, contributeur us, M ≥ " +
      rapport.requete.magnitude_minimale +
      " ; période " +
      datePremiere +
      " → " +
      dateDerniere +
      ". Fichiers source CC0-1.0.",
    fichiers: [
      { cle: cleAnnuelJson, nom: FICHIER_ANNUEL, format: "json", principal: true },
      { cle: cleAnnuelCsv, nom: FICHIER_ANNUEL, format: "csv", principal: false },
      { cle: cleBrutJson, nom: FICHIER_USGS, format: "json", principal: false },
      { cle: cleBrutCsv, nom: FICHIER_USGS, format: "csv", principal: false },
    ],
  });
  versions.push(version.numero);
  publiee = true;
  console.log("Version NEIC/PDE " + version.numero + " publiée (" + version.nb_lignes + " lignes principales).");
}

if (!geoInchange) {
  const [cleEnrichiJson, cleEnrichiCsv, cleGeo, cleWilayasJson, cleWilayasCsv] = await Promise.all([
    api.envoyerFichier(SLUG, FICHIER_ENRICHI, enrichisTexte, "json"),
    api.envoyerFichier(SLUG, FICHIER_ENRICHI, enrichisCsv, "csv"),
    api.envoyerFichier(SLUG, FICHIER_ENRICHI, geojsonTexte, "geojson"),
    api.envoyerFichier(SLUG, FICHIER_WILAYAS, wilayasTexte, "json"),
    api.envoyerFichier(SLUG, FICHIER_WILAYAS, wilayasCsv, "csv"),
  ]);
  const version = await api.publierVersion(SLUG, {
    source_slug: "geoalgeria",
    licence_code: "ODbL-1.0",
    notes: "Rattachement des épicentres et agrégats par wilaya à partir des contours GeoAlgeria, ODbL-1.0.",
    fichiers: [
      { cle: cleEnrichiJson, nom: FICHIER_ENRICHI, format: "json" },
      { cle: cleEnrichiCsv, nom: FICHIER_ENRICHI, format: "csv" },
      { cle: cleGeo, nom: FICHIER_ENRICHI, format: "geojson" },
      { cle: cleWilayasJson, nom: FICHIER_WILAYAS, format: "json" },
      { cle: cleWilayasCsv, nom: FICHIER_WILAYAS, format: "csv" },
    ],
  });
  versions.push(version.numero);
  publiee = true;
  console.log("Fichiers GeoAlgeria ajoutés à la version " + version.numero + ".");
}

const resumeFinal = (publiee ? "Publication terminée. " : "Fichiers inchangés. ") + resumeChiffres;
await rapporter("reussie", resumeFinal, rapportDonnee({ creee, publiee, version: versions.join(", ") || null }));
