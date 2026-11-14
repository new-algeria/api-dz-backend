/**
 * Publication des détections NASA FIRMS et de leur enrichissement par les contours GeoAlgeria.
 * Les fichiers NASA héritent de CC0-1.0 ; les fichiers enrichis sont des compléments ODbL-1.0.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "wildfires";
const SLUG = "wildfires";
const DOSSIER_DEFAUT = join(import.meta.dirname, "sortie");

interface LigneEnrichie extends Record<string, unknown> {
  id_detection: string;
  date_utc: string;
  latitude: number;
  longitude: number;
  code_wilaya: string;
  wilaya: string;
  wilaya_ar: string;
}
interface RapportCalcul {
  fenetre_utc: { debut: string; fin: string; jours: number };
  nb_detections_nasa_dans_wilayas: number;
  nb_detections_enrichies: number;
  nb_wilayas_couvertes: number;
  par_produit: Record<string, unknown>[];
  par_wilaya: Record<string, number>;
  dates_observees: { premiere: string | null; derniere: string | null };
}

const arguments_ = process.argv.slice(2);
const valeurDe = (option: string) =>
  arguments_.includes(option) ? arguments_[arguments_.indexOf(option) + 1] : undefined;
const sortie = valeurDe("--sortie") ?? DOSSIER_DEFAUT;
const essai = arguments_.includes("--essai") || process.env.SYNCHRO_ESSAI === "true";
const forcer = process.env.SYNCHRO_FORCER === "true";
const declencheur = forcer ? "forcer" : process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manuel" : "planifie";
const debutExecution = process.env.SYNCHRO_DEBUT?.trim() || new Date().toISOString();
const cle = process.env.CLE_SYNCHRO?.trim() || null;
const api = new ClientApi((process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, ""), cle);

async function rapporter(
  statut: "reussie" | "echec" | "essai",
  resume: string,
  rapportExecution: Record<string, unknown> = {}
): Promise<void> {
  console.log("[" + statut + "] " + resume);
  if (!cle) return;
  await api.rapporter(CODE, {
    statut,
    declencheur,
    debut: debutExecution,
    fin: new Date().toISOString(),
    resume,
    rapport: rapportExecution,
  });
}

async function lireTableau<T>(nom: string): Promise<T[]> {
  const texte = await readFile(join(sortie, nom), "utf8");
  const resultat: unknown = JSON.parse(texte);
  if (!Array.isArray(resultat)) throw new Error(nom + " doit contenir un tableau JSON.");
  return resultat as T[];
}

function jsonIdentique(contenuActuel: string | null, nouveau: unknown): boolean {
  if (contenuActuel === null) return false;
  try {
    return JSON.stringify(JSON.parse(contenuActuel)) === JSON.stringify(nouveau);
  } catch {
    return false;
  }
}

function verifierSortie(brutes: Record<string, unknown>[], enrichies: LigneEnrichie[], rapport: RapportCalcul): void {
  if (rapport.nb_detections_nasa_dans_wilayas !== brutes.length) {
    throw new Error("Le rapport ne correspond pas au nombre de lignes NASA du fichier brut.");
  }
  if (rapport.nb_detections_enrichies !== enrichies.length || brutes.length !== enrichies.length) {
    throw new Error("Les fichiers NASA et enrichi ne contiennent pas le même nombre de détections.");
  }
  if (rapport.fenetre_utc.jours !== 7 || !rapport.fenetre_utc.debut || !rapport.fenetre_utc.fin) {
    throw new Error("La fenêtre d'observation doit couvrir exactement sept jours UTC.");
  }
  const identifiants = new Set<string>();
  for (const ligne of enrichies) {
    if (
      !ligne.id_detection ||
      identifiants.has(ligne.id_detection) ||
      !Number.isFinite(ligne.latitude) ||
      !Number.isFinite(ligne.longitude) ||
      ligne.latitude < -90 ||
      ligne.latitude > 90 ||
      ligne.longitude < -180 ||
      ligne.longitude > 180 ||
      !/^\d{2}$/.test(ligne.code_wilaya) ||
      !ligne.wilaya ||
      !ligne.wilaya_ar ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(ligne.date_utc)
    ) {
      throw new Error("Détection enrichie invalide ou identifiant dupliqué : " + (ligne.id_detection || "sans identifiant"));
    }
    identifiants.add(ligne.id_detection);
  }
}

const totalFormate = (nombre: number) => new Intl.NumberFormat("fr-FR").format(nombre);

function rapportPublication(
  rapport: RapportCalcul,
  creee: boolean,
  publiee: boolean,
  versions: string[]
): Record<string, unknown> {
  return {
    fenetre_utc: rapport.fenetre_utc,
    donnees: {
      [SLUG]: {
        creee,
        publiee,
        version: versions.length ? versions.join(", ") : null,
        fichiers: {
          "wildfires-raw": { total: rapport.nb_detections_nasa_dans_wilayas },
          "wildfires-enriched": { total: rapport.nb_detections_enrichies },
          wildfires: { total: rapport.nb_detections_enrichies },
        },
        detections_par_wilaya: rapport.par_wilaya,
        produits: rapport.par_produit,
      },
    },
  };
}

// Échéance réglée dans /admin/sync.
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
      raison = "synchronisation absente de l'API : appliquer la migration du site avant l'automatisation";
    }
  } else if (forcer) {
    raison = "forcée";
  }
  console.log((aFaire ? "À faire" : "Rien à faire") + " : " + raison + ".");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "a_faire=" + aFaire + "\n");
  process.exit(0);
}

// Rapport d'un échec pendant le calcul.
if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul NASA FIRMS a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

// Lecture et contrôles des fichiers calculés.
const [brutes, enrichies, rapport] = await Promise.all([
  lireTableau<Record<string, unknown>>("wildfires-raw.json"),
  lireTableau<LigneEnrichie>("wildfires-enriched.json"),
  readFile(join(sortie, "rapport.json"), "utf8").then((texte) => JSON.parse(texte) as RapportCalcul),
]);
verifierSortie(brutes, enrichies, rapport);

const periode = rapport.fenetre_utc.debut + " → " + rapport.fenetre_utc.fin;
const resumeChiffres =
  totalFormate(enrichies.length) +
  " détections thermiques sur " +
  periode +
  ", " +
  rapport.nb_wilayas_couvertes +
  " wilayas couvertes.";

// Aucun point : ne pas remplacer les derniers fichiers non vides par une version vide.
if (enrichies.length === 0) {
  await rapporter(
    "essai",
    "Aucune détection dans les 69 wilayas sur " + periode + " ; aucun fichier vide publié.",
    rapportPublication(rapport, false, false, [])
  );
  process.exit(0);
}

const champs = {
  titre: {
    fr: "Détections de points chauds et anomalies thermiques (NASA FIRMS)",
    en: "Satellite hot spot and thermal anomaly detections (NASA FIRMS)",
    ar: "رصد البؤر الساخنة والشذوذات الحرارية بالأقمار الصناعية (NASA FIRMS)",
  },
  description: {
    fr:
      "Détections satellitaires d'anomalies thermiques en Algérie, issues des produits MODIS et VIIRS de NASA FIRMS. " +
      "Fenêtre glissante de sept jours en UTC (" + periode + "). Ces points sont des alertes de chaleur : ils ne prouvent pas à eux seuls un incendie, ne décrivent pas son périmètre et ne mesurent pas la surface brûlée.",
    en:
      "Satellite thermal anomaly detections in Algeria from NASA FIRMS MODIS and VIIRS products. " +
      "Rolling seven-day UTC window (" + periode + "). These points are heat detections: they do not by themselves confirm a fire, define its perimeter, or measure burned area.",
    ar:
      "رصد الشذوذات الحرارية بالأقمار الصناعية في الجزائر من منتجات MODIS وVIIRS التابعة لـ NASA FIRMS. " +
      "نافذة متحركة مدتها سبعة أيام بتوقيت UTC (" + periode + "). تمثل هذه النقاط إشارات حرارية ولا تؤكد وحدها وقوع حريق أو تحدد محيطه أو المساحة المحترقة.",
  },
  readme: [
    "## Détections de points chauds en Algérie",
    "",
    "Cette donnée rassemble les anomalies thermiques satellitaires publiées par NASA FIRMS pour le territoire des 69 wilayas. Elle est actualisée par une fenêtre glissante de sept jours (dates UTC).",
    "",
    "### Ce que la donnée représente",
    "",
    "- Une ligne correspond à une détection thermique d'un capteur MODIS ou VIIRS, à une date et une heure d'acquisition UTC.",
    "- Les fichiers NASA bruts sont les enregistrements FIRMS reçus dans l'emprise puis retenus à l'intérieur des 69 contours de wilaya ; les champs source sont conservés, avec le code produit FIRMS.",
    "- Les fichiers enrichis ajoutent un identifiant technique et l'affectation à une wilaya (code, nom français et nom arabe) calculée à partir des contours GeoAlgeria.",
    "- Les coordonnées sont en latitude / longitude (WGS 84). La puissance radiative du feu (FRP) est exprimée en mégawatts lorsqu'elle est fournie par le produit.",
    "- Les champs de confiance, de température de brillance, de balayage et de suivi sont conservés lorsqu'ils existent dans le produit FIRMS d'origine.",
    "",
    "### À savoir et limites",
    "",
    "- Une détection n'est pas un incendie confirmé. Une anomalie thermique peut avoir d'autres origines (brûlage agricole, activité industrielle, torchère, etc.) et un incendie peut ne pas être détecté.",
    "- Les points ne sont ni des périmètres de feu ni une mesure de surface brûlée. La puissance radiative et la confiance sont des attributs de détection, pas une estimation de superficie.",
    "- MODIS et VIIRS ont des résolutions spatiales, des heures de passage et des niveaux de confiance différents. Les détections de plusieurs satellites peuvent concerner le même événement ; elles ne sont pas fusionnées.",
    "- Les produits utilisés sont les flux near-real-time MODIS_NRT, VIIRS_SNPP_NRT, VIIRS_NOAA20_NRT et VIIRS_NOAA21_NRT. Leur disponibilité varie selon l'instrument et la date ; les lignes conservent le code du produit et la version fournie par NASA.",
    "- Les produits NRT peuvent être remplacés par des produits scientifiques standard après traitement. Cette extraction ne constitue donc pas un historique scientifique définitif.",
    "- La fenêtre publiée couvre les sept derniers jours UTC au moment du calcul. Les points situés dans l'emprise rectangulaire mais hors des 69 contours sont écartés.",
    "",
    "### Fichiers et licences",
    "",
    "- wildfires-raw (JSON et CSV) : détections NASA FIRMS, CC0-1.0.",
    "- wildfires-enriched (JSON et CSV) et wildfires (GeoJSON) : détections associées aux wilayas à partir des contours GeoAlgeria, ODbL-1.0. La source et la licence sont enregistrées au niveau de chaque fichier.",
    "- Source NASA FIRMS : https://firms.modaps.eosdis.nasa.gov/ ; documentation API : https://firms.modaps.eosdis.nasa.gov/api/area/ ; politique NASA sur les licences de données : https://www.earthdata.nasa.gov/about/science-data-licenses",
    "- Contours et nomenclature : GeoAlgeria, donnée divisions-administratives publiée sur data-dz : https://geoalgeria.com (ODbL-1.0).",
    "",
    "### Méthode et mise à jour",
    "",
    "L'extraction interroge l'API Area de NASA FIRMS sur l'emprise calculée à partir des contours des wilayas. L'API accepte au plus cinq jours par requête : la fenêtre de sept jours est donc récupérée en deux tranches. Une clé MAP_KEY gratuite est requise pour l'API. L'affectation aux wilayas est calculée par test point-dans-polygone sur les contours GeoAlgeria.",
    "",
    "Fréquence cible : quotidienne. Période du calcul : " + periode + ". Dates d'acquisition observées : " +
      (rapport.dates_observees.premiere ?? "aucune") + " à " + (rapport.dates_observees.derniere ?? "aucune") + ".",
    "",
    "Champs du fichier enrichi : id_detection, date_utc, latitude, longitude, code_wilaya, wilaya, wilaya_ar, instrument, satellite, produit_firms, version_produit, confiance_viirs, confiance_modis, frp_mw, scan, track, bright_ti4_k, bright_ti5_k, brightness_modis_k, bright_t31_modis_k et jour_nuit.",
  ].join("\n"),
  categorie_slug: "environnement",
  source_slug: "nasa-firms",
  licence_code: "CC0-1.0",
  licence_details:
    "Fichiers NASA FIRMS : CC0-1.0. Fichiers enrichis par rattachement aux contours GeoAlgeria : ODbL-1.0 (source et licence précisées au niveau de chaque fichier).",
  url_source: "https://firms.modaps.eosdis.nasa.gov/",
  mots_cles: [
    "feux", "incendies", "feux de forêt", "points chauds", "anomalies thermiques",
    "NASA", "FIRMS", "MODIS", "VIIRS", "wilaya", "wildfires", "حرائق", "بؤر ساخنة",
  ],
  frequence_maj: "quotidienne",
  infos_source: {
    fenetre_debut_utc: rapport.fenetre_utc.debut,
    fenetre_fin_utc: rapport.fenetre_utc.fin,
    jours_observes: rapport.fenetre_utc.jours,
    nb_detections: enrichies.length,
    nb_wilayas_couvertes: rapport.nb_wilayas_couvertes,
    dates_acquisition: { premiere: rapport.dates_observees.premiere, derniere: rapport.dates_observees.derniere },
    produits: rapport.par_produit.map((produit) => produit.produit),
    methode: "NASA FIRMS Area API (NRT), point-dans-polygone sur les 69 contours GeoAlgeria",
  },
};

const [actuelBrut, actuelEnrichi, actuelGeojson] = await Promise.all([
  api.lireFichier(SLUG, "wildfires-raw", "json"),
  api.lireFichier(SLUG, "wildfires-enriched", "json"),
  api.lireFichier(SLUG, "wildfires", "geojson"),
]);
const brutInchange = jsonIdentique(actuelBrut, brutes);
const enrichiInchange = jsonIdentique(actuelEnrichi, enrichies);
const geojsonAttendu = JSON.parse(await readFile(join(sortie, "wildfires.geojson"), "utf8")) as unknown;
const geojsonInchange = jsonIdentique(actuelGeojson, geojsonAttendu);

console.log(resumeChiffres);
console.log(
  "Comparaison aux fichiers en ligne : NASA " +
    (brutInchange ? "inchangé" : "à mettre à jour") +
    " ; enrichissement " +
    (enrichiInchange && geojsonInchange ? "inchangé" : "à mettre à jour") +
    "."
);

if (essai || !cle) {
  console.log("Essai : aucune métadonnée ni aucun fichier ne sera publié.");
  await rapporter(
    "essai",
    "Essai : " + resumeChiffres,
    rapportPublication(rapport, false, !(brutInchange && enrichiInchange && geojsonInchange), [])
  );
  process.exit(0);
}

// Création ou mise à jour de la fiche ; une nouvelle donnée reste en brouillon.
const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Métadonnées mises à jour ; statut existant conservé.");

const versions: string[] = [];
let publiee = false;

// Fichiers NASA : source nasa-firms et licence CC0-1.0 héritées de la donnée.
if (!brutInchange) {
  const [json, csv] = await Promise.all([
    readFile(join(sortie, "wildfires-raw.json"), "utf8"),
    readFile(join(sortie, "wildfires-raw.csv"), "utf8"),
  ]);
  const [cleJson, cleCsv] = await Promise.all([
    api.envoyerFichier(SLUG, "wildfires-raw", json, "json"),
    api.envoyerFichier(SLUG, "wildfires-raw", csv, "csv"),
  ]);
  const version = await api.publierVersion(SLUG, {
    notes: "NASA FIRMS, produits NRT, fenêtre UTC " + periode + " ; fichiers source CC0-1.0.",
    fichiers: [
      { cle: cleJson, nom: "wildfires-raw", format: "json", principal: true },
      { cle: cleCsv, nom: "wildfires-raw", format: "csv", principal: false },
    ],
  });
  versions.push(version.numero);
  publiee = true;
  console.log("Version NASA " + version.numero + " publiée (" + version.nb_lignes + " lignes).");
}

// Fichiers enrichis GeoAlgeria : ajout complémentaire, sous ODbL-1.0.
if (!enrichiInchange || !geojsonInchange) {
  const [json, csv, geo] = await Promise.all([
    readFile(join(sortie, "wildfires-enriched.json"), "utf8"),
    readFile(join(sortie, "wildfires-enriched.csv"), "utf8"),
    readFile(join(sortie, "wildfires.geojson"), "utf8"),
  ]);
  const [cleJson, cleCsv, cleGeo] = await Promise.all([
    api.envoyerFichier(SLUG, "wildfires-enriched", json, "json"),
    api.envoyerFichier(SLUG, "wildfires-enriched", csv, "csv"),
    api.envoyerFichier(SLUG, "wildfires", geo, "geojson"),
  ]);
  const version = await api.publierVersion(SLUG, {
    source_slug: "geoalgeria",
    licence_code: "ODbL-1.0",
    notes: "Enrichissement par wilaya à partir des contours GeoAlgeria, ODbL-1.0 ; fenêtre UTC " + periode + ".",
    fichiers: [
      { cle: cleJson, nom: "wildfires-enriched", format: "json" },
      { cle: cleCsv, nom: "wildfires-enriched", format: "csv" },
      { cle: cleGeo, nom: "wildfires", format: "geojson" },
    ],
  });
  versions.push(version.numero);
  publiee = true;
  console.log("Complément GeoAlgeria ajouté (version " + version.numero + ").");
}

const resumeFinal = (publiee ? "Publication terminée. " : "Fichiers inchangés. ") + resumeChiffres;
await rapporter("reussie", resumeFinal, rapportPublication(rapport, creee, publiee, versions));
