// Publication du dataset « Pollution atmosphérique en Algérie » sur data-dz.
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "pollution-atmospherique";
const SLUG = "pollution-atmospherique-algerie";
const FICHIER = "pollution-atmospherique-algerie";
const FICHIER_GRILLE = "pollution-atmospherique-grille";
const FICHIER_GRILLE_RECENTE = "pollution-atmospherique-grille-recente";
const FICHIER_INDICATEURS = "pollution-atmospherique-indicateurs";
const TAILLE_MAX_FICHIER = 100 * 1024 * 1024;

interface Rapport {
  source: string;
  dataset_api: string;
  url_source: string;
  doi: string;
  licence: string;
  genere_le: string;
  periode: { debut: string; fin: string; nb_mois: number };
  resolution_grille: string;
  nb_mailles: number;
  nb_lignes_nationales: number;
  nb_lignes_grille: number;
  nb_lignes_grille_recente: number;
  nb_indicateurs_annuels: number;
  empreinte_sha256_netcdf: string;
  avertissement: string;
}
interface LigneNationale {
  date: string; annee: number; mois: number; filiere: string;
  valeur: number; unite: string; nb_mailles: number;
}
interface Indicateur {
  annee: number; polluant: string; valeur_moyenne: number;
  minimum_mensuel: number; maximum_mensuel: number; nb_mois: number; unite: string;
}

const args = process.argv.slice(2);
const valeurDe = (option: string) => args.includes(option) ? args[args.indexOf(option) + 1] : undefined;
const sortie = valeurDe("--sortie") ?? join(import.meta.dirname, "sortie");
const essai = args.includes("--essai") || process.env.SYNCHRO_ESSAI === "true";
const forcer = process.env.SYNCHRO_FORCER === "true";
const declencheur = forcer ? "forcer" : process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manuel" : "planifie";
const debut = process.env.SYNCHRO_DEBUT?.trim() || new Date().toISOString();
const cle = process.env.CLE_SYNCHRO?.trim() || null;
const api = new ClientApi((process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, ""), cle);

function donneesRapport(r: Rapport, resultat: Record<string, unknown>) {
  return {
    fichier_source: {
      url: r.url_source,
      dataset_api: r.dataset_api,
      doi: r.doi,
      licence: r.licence,
      sha256_netcdf: r.empreinte_sha256_netcdf,
    },
    periode: [r.periode.debut, r.periode.fin],
    controles: {
      nb_mailles: r.nb_mailles,
      nb_mois: r.periode.nb_mois,
      resolution_grille: r.resolution_grille,
    },
    donnees: {
      [SLUG]: {
        fichiers: {
          [FICHIER]: { total: r.nb_lignes_nationales },
          [FICHIER_GRILLE]: { total: r.nb_lignes_grille },
          [FICHIER_GRILLE_RECENTE]: { total: r.nb_lignes_grille_recente },
          [FICHIER_INDICATEURS]: { total: r.nb_indicateurs_annuels },
        },
        ...resultat,
      },
    },
  };
}
async function rapporter(statut: "reussie" | "echec" | "essai", resume: string, donnees: Record<string, unknown> = {}) {
  console.log("[" + statut + "] " + resume);
  if (cle) await api.rapporter(CODE, {
    statut, declencheur, debut, fin: new Date().toISOString(), resume, rapport: donnees,
  });
}

if (args.includes("--verifier")) {
  let aFaire = true;
  let raison = "aucune clé : calcul local";
  if (cle && !forcer) {
    try {
      const synchro = await api.lireSynchro(CODE);
      aFaire = synchro.a_faire;
      raison = aFaire ? "échéance atteinte" : synchro.actif ? "prochain passage le " + synchro.prochaine_execution : "synchronisation désactivée";
    } catch (erreur) {
      if (!(erreur instanceof ErreurAppel) || (erreur.statut !== 404 && erreur.statut !== 503)) throw erreur;
      aFaire = false;
      raison = "synchronisation inconnue de l'API (" + erreur.statut + ") : appliquer la migration pollution-atmospherique";
    }
  } else if (forcer) raison = "forcée";
  console.log((aFaire ? "À faire : " : "Rien à faire : ") + raison + ".");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "a_faire=" + aFaire + "\n");
  process.exit(0);
}
if (args.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Échec de la collecte CAMS EAC4 (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const fichiersATester = [FICHIER + ".json", FICHIER + ".csv", FICHIER_GRILLE + ".csv", FICHIER_GRILLE_RECENTE + ".csv", FICHIER_INDICATEURS + ".json", FICHIER_INDICATEURS + ".csv"];
for (const nom of fichiersATester) {
  const infos = await stat(join(sortie, nom));
  if (infos.size > TAILLE_MAX_FICHIER) throw new Error(nom + " dépasse la limite de sécurité de 100 Mo (" + infos.size + " octets).");
}
const lignes = JSON.parse(await readFile(join(sortie, FICHIER + ".json"), "utf8")) as LigneNationale[];
const indicateurs = JSON.parse(await readFile(join(sortie, FICHIER_INDICATEURS + ".json"), "utf8")) as Indicateur[];
const grilleCsv = await readFile(join(sortie, FICHIER_GRILLE + ".csv"), "utf8");
const grilleRecenteCsv = await readFile(join(sortie, FICHIER_GRILLE_RECENTE + ".csv"), "utf8");
const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport;

if (!lignes.length || lignes.length !== rapport.nb_lignes_nationales ||
    indicateurs.length !== rapport.nb_indicateurs_annuels ||
    !grilleCsv.trim() || !grilleRecenteCsv.trim()) {
  throw new Error("Sorties CAMS vides ou incohérentes avec rapport.json.");
}
const dates = [...new Set(lignes.map((ligne) => ligne.date))].sort();
if (dates.length !== rapport.periode.nb_mois || dates[0]?.slice(0, 7) !== rapport.periode.debut ||
    dates.at(-1)?.slice(0, 7) !== rapport.periode.fin) {
  throw new Error("La période du fichier principal ne correspond pas au rapport CAMS.");
}
for (const ligne of lignes) {
  if (!/^\d{4}-\d{2}-01$/.test(ligne.date) || !Number.isInteger(ligne.annee) ||
      !Number.isInteger(ligne.mois) || ligne.mois < 1 || ligne.mois > 12 ||
      !ligne.filiere || !Number.isFinite(ligne.valeur) || ligne.valeur < 0 ||
      !["µg/m³", "ppbv"].includes(ligne.unite) || ligne.nb_mailles !== rapport.nb_mailles) {
    throw new Error("Ligne nationale CAMS invalide.");
  }
}
for (const ligne of indicateurs) {
  if (!Number.isInteger(ligne.annee) || !ligne.polluant || !Number.isFinite(ligne.valeur_moyenne) ||
      ligne.valeur_moyenne < 0 || ligne.nb_mois !== 12 || !["µg/m³", "ppbv"].includes(ligne.unite)) {
    throw new Error("Indicateur annuel CAMS invalide.");
  }
}
if (!/^[a-f0-9]{64}$/i.test(rapport.empreinte_sha256_netcdf) || rapport.nb_mailles < 20) {
  throw new Error("Rapport CAMS incomplet : empreinte ou grille non valide.");
}

const formatNombre = (n: number) => new Intl.NumberFormat("fr-FR").format(n);
const descriptionFr =
  "Séries mensuelles 2003–2025 de fond régional de la pollution atmosphérique en Algérie, issues de la réanalyse Copernicus CAMS EAC4. " +
  "Six polluants : PM2.5, PM10, CO, NO₂, O₃ et SO₂. " + formatNombre(rapport.nb_mailles) +
  " mailles de 0,75° (~80 km), valeurs nationales pondérées par latitude et grille géographique téléchargeable. " +
  "Modèle de fond régional : pas de mesures de station, pas d'indice AQI réglementaire, pas de détail par wilaya.";

const champs = {
  titre: {
    fr: "Pollution atmosphérique en Algérie",
    en: "Air pollution in Algeria",
    ar: "تلوث الهواء في الجزائر",
  },
  description: {
    fr: descriptionFr,
    en: "Monthly 2003–2025 regional-background air composition in Algeria from the Copernicus CAMS EAC4 reanalysis. Six pollutants: PM2.5, PM10, CO, NO2, O3 and SO2. Native 0.75-degree (~80 km) grid and latitude-weighted national series. Modelled background data, not station measurements or a regulatory AQI; no wilaya-level detail.",
    ar: "سلاسل شهرية من 2003 إلى 2025 لتركيب الهواء في الجزائر من إعادة التحليل Copernicus CAMS EAC4. تشمل ستة ملوثات: PM2.5 وPM10 وCO وNO2 وO3 وSO2. شبكة أصلية بدقة 0.75 درجة (نحو 80 كم) ومتوسطات وطنية مرجحة بخط العرض. بيانات نموذجية إقليمية وليست قياسات محطات أو مؤشر جودة هواء تنظيمي، ولا تتوفر تفاصيل حسب الولايات.",
  },
  readme: [
    "# Pollution atmosphérique en Algérie",
    "",
    "Séries mensuelles CAMS EAC4 de " + rapport.periode.debut + " à " + rapport.periode.fin + ". " +
      formatNombre(rapport.nb_lignes_nationales) + " valeurs nationales et " +
      formatNombre(rapport.nb_lignes_grille) + " valeurs spatiales sur " + rapport.nb_mailles + " mailles.",
    "",
    "## Polluants et unités",
    "- PM2.5 et PM10 : µg/m³ (conversion des concentrations CAMS en kg/m³).",
    "- CO, NO₂, O₃ et SO₂ : ppbv (conversion des rapports massiques kg/kg selon les masses molaires).",
    "",
    "## Fichiers",
    "- " + FICHIER + ".json/.csv : moyenne nationale mensuelle pondérée par cos(latitude), une série par polluant.",
    "- " + FICHIER_GRILLE_RECENTE + ".csv : dernière période mensuelle disponible, centres des mailles et valeurs par polluant pour la carte.",
    "- " + FICHIER_GRILLE + ".csv : historique complet par date, cellule, coordonnées et polluant.",
    "- " + FICHIER_INDICATEURS + ".json/.csv : moyennes annuelles pondérées par le nombre de jours, minima et maxima mensuels.",
    "- rapport.json : période, source, résolution, nombre de mailles, conversions et empreinte des NetCDF.",
    "",
    "## Source et méthode",
    "Copernicus Atmosphere Monitoring Service (CAMS), EAC4 monthly averaged fields, DOI 10.24381/fd75fff2, licence CC BY 4.0. Les centres de mailles de 0,75° couverts par les contours GeoAlgeria sont conservés. La moyenne nationale est pondérée par cos(latitude). Aucune agrégation par wilaya n'est publiée.",
    "",
    "## Interprétation",
    "- CAMS EAC4 est une réanalyse modélisée de fond régional, pas une mesure de station, un capteur individuel ou une prévision en temps réel.",
    "- La grille d'environ 80 km ne distingue pas les quartiers, communes ou villes proches. La carte montre des centres de mailles CAMS, pas des stations.",
    "- Les valeurs ne sont ni un indice AQI réglementaire, ni un diagnostic sanitaire, ni une alerte. Les moyennes mensuelles ne décrivent pas les pics horaires ou journaliers.",
    "- Les particules sont publiées en µg/m³ ; les gaz en ppbv. Ces unités ne doivent pas être comparées directement entre familles de polluants.",
    "- La couverture CAMS actuellement publiée s'arrête en 2025 et le service actualise la réanalyse environ deux fois par an avec plusieurs mois de retard.",
    "",
    "## Attribution",
    "Contient des informations modifiées du Copernicus Atmosphere Monitoring Service (CAMS). Ni la Commission européenne ni l'ECMWF ne sont responsables de l'usage qui pourrait être fait des informations ou données Copernicus contenues dans cette publication.",
  ].join("\n"),
  categorie_slug: "environnement",
  source_slug: "copernicus-cams-eac4",
  licence_code: "CC-BY-4.0",
  licence_details: "Copernicus Atmosphere Monitoring Service (CAMS), EAC4 monthly averaged fields, DOI 10.24381/fd75fff2, licence CC BY 4.0. Données adaptées : extraction spatiale des mailles dont le centre se situe dans l'Algérie, conversion des unités et calcul de moyennes nationales et annuelles. Attribution Copernicus requise.",
  url_source: "https://ads.atmosphere.copernicus.eu/datasets/cams-global-reanalysis-eac4-monthly",
  mots_cles: [
    "pollution atmosphérique", "qualité de l'air", "PM2.5", "PM10", "NO2", "O3", "SO2", "CO",
    "CAMS", "Copernicus", "ECMWF", "aérosols", "atmosphère", "Algérie",
    "تلوث الهواء", "جودة الهواء", "الجزائر",
  ],
  frequence_maj: "semestrielle",
  infos_source: {
    source: rapport.source,
    dataset_api: rapport.dataset_api,
    doi: rapport.doi,
    periode: rapport.periode,
    resolution_grille: rapport.resolution_grille,
    nb_mailles: rapport.nb_mailles,
    nb_lignes_nationales: rapport.nb_lignes_nationales,
    nb_lignes_grille: rapport.nb_lignes_grille,
    nb_lignes_grille_recente: rapport.nb_lignes_grille_recente,
    nb_indicateurs_annuels: rapport.nb_indicateurs_annuels,
    empreinte_sha256_netcdf: rapport.empreinte_sha256_netcdf,
    methode_spatiale: "Mailles de 0,75° ; moyenne nationale pondérée par cos(latitude) ; pas de valeurs par wilaya.",
    avertissement: rapport.avertissement,
  },
};

const metaRapport = donneesRapport(rapport, { creee: false, publiee: false });
if (essai || !cle) {
  const resume = "Essai : " + rapport.nb_lignes_nationales + " valeurs nationales, " +
    rapport.nb_lignes_grille + " valeurs maillées, " + rapport.nb_mailles + " cellules ; aucune publication.";
  console.log(resume);
  await rapporter("essai", resume, metaRapport);
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
const [actuel, actuelIndicateurs, actuelleGrille, actuelleGrilleRecente] = creee
  ? [null, null, null, null]
  : await Promise.all([
      api.lireFichier(SLUG, FICHIER, "json"),
      api.lireFichier(SLUG, FICHIER_INDICATEURS, "json"),
      api.lireFichier(SLUG, FICHIER_GRILLE, "csv"),
      api.lireFichier(SLUG, FICHIER_GRILLE_RECENTE, "csv"),
    ]);
const [json, csv, grille, grilleRecente, indicateursJson, indicateursCsv] = await Promise.all([
  readFile(join(sortie, FICHIER + ".json"), "utf8"),
  readFile(join(sortie, FICHIER + ".csv"), "utf8"),
  readFile(join(sortie, FICHIER_GRILLE + ".csv"), "utf8"),
  readFile(join(sortie, FICHIER_GRILLE_RECENTE + ".csv"), "utf8"),
  readFile(join(sortie, FICHIER_INDICATEURS + ".json"), "utf8"),
  readFile(join(sortie, FICHIER_INDICATEURS + ".csv"), "utf8"),
]);
const identique = (contenu: string | null, cible: string) => contenu !== null && contenu.trim() === cible.trim();
if (
  identique(actuel, json) && identique(actuelIndicateurs, indicateursJson) &&
  identique(actuelleGrille, grille) && identique(actuelleGrilleRecente, grilleRecente)
) {
  await rapporter("reussie", "Aucun changement dans les champs CAMS ; aucune nouvelle version.", metaRapport);
  process.exit(0);
}

const [cleJson, cleCsv, cleGrille, cleGrilleRecente, cleIndicateursJson, cleIndicateursCsv] = await Promise.all([
  api.envoyerFichier(SLUG, FICHIER, json, "json"),
  api.envoyerFichier(SLUG, FICHIER, csv, "csv"),
  api.envoyerFichier(SLUG, FICHIER_GRILLE, grille, "csv"),
  api.envoyerFichier(SLUG, FICHIER_GRILLE_RECENTE, grilleRecente, "csv"),
  api.envoyerFichier(SLUG, FICHIER_INDICATEURS, indicateursJson, "json"),
  api.envoyerFichier(SLUG, FICHIER_INDICATEURS, indicateursCsv, "csv"),
]);
const version = await api.publierVersion(SLUG, {
  notes: "Copernicus CAMS EAC4, " + rapport.periode.debut + "–" + rapport.periode.fin +
    ", grille 0,75°, " + rapport.nb_mailles + " mailles ; empreinte " + rapport.empreinte_sha256_netcdf.slice(0, 12) + ".",
  fichiers: [
    { cle: cleJson, nom: FICHIER, format: "json", principal: true },
    { cle: cleCsv, nom: FICHIER, format: "csv", principal: false },
    { cle: cleGrille, nom: FICHIER_GRILLE, format: "csv", principal: false },
    { cle: cleGrilleRecente, nom: FICHIER_GRILLE_RECENTE, format: "csv", principal: false },
    { cle: cleIndicateursJson, nom: FICHIER_INDICATEURS, format: "json", principal: false },
    { cle: cleIndicateursCsv, nom: FICHIER_INDICATEURS, format: "csv", principal: false },
  ],
});
console.log("Version " + version.numero + " publiée (" + version.nb_lignes + " lignes principales).");
await rapporter(
  "reussie",
  "Version " + version.numero + " publiée : " + rapport.nb_lignes_nationales + " valeurs nationales, " +
    rapport.nb_lignes_grille + " valeurs maillées sur " + rapport.nb_mailles + " cellules.",
  donneesRapport(rapport, { creee, publiee: true, version: version.numero })
);
