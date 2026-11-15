import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "biodiversite";
const SLUG = "biodiversite-algerie";
const FICHIER = "biodiversite-algerie";
const FICHIER_DETAILS = "biodiversite-algerie-details";
const FICHIER_INDICATEURS = "biodiversite-algerie-indicateurs";
interface Rapport {
  source_url: string; api_url: string; source_etag: string | null; source_modifie_le: string | null;
  empreinte_sha256: string; occurrences_total: number; premiere_annee: number | null; derniere_annee: number | null;
  nb_regnes: number; nb_regions_declarees: number; nb_lignes_graphique: number; nb_lignes_details: number;
  nb_indicateurs: number; licences_incluses: string[];
}
interface LigneGraphique { annee: number; filiere: string; valeur: number; unite: string }
interface LigneDetail { dimension: string; modalite: string; valeur: number; unite: string }
interface Indicateur { indicateur: string; valeur: number | string; unite: string }

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
      url: r.source_url, api_url: r.api_url, etag: r.source_etag,
      modifie_le: r.source_modifie_le, sha256: r.empreinte_sha256,
    },
    periode: [r.premiere_annee, r.derniere_annee],
    controles: { occurrences_total: r.occurrences_total, licences_incluses: r.licences_incluses, nb_regnes: r.nb_regnes },
    donnees: {
      [SLUG]: {
        fichiers: {
          [FICHIER]: { total: r.nb_lignes_graphique },
          [FICHIER_DETAILS]: { total: r.nb_lignes_details },
          [FICHIER_INDICATEURS]: { total: r.nb_indicateurs },
        },
        ...resultat,
      },
    },
  };
}
async function rapporter(statut: "reussie" | "echec" | "essai", resume: string, rapport: Record<string, unknown> = {}) {
  console.log("[" + statut + "] " + resume);
  if (cle) await api.rapporter(CODE, {
    statut, declencheur, debut, fin: new Date().toISOString(), resume, rapport,
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
      raison = "synchronisation inconnue de l'API (" + erreur.statut + ") : migration biodiversite à appliquer";
    }
  } else if (forcer) raison = "forcée";
  console.log((aFaire ? "À faire : " : "Rien à faire : ") + raison + ".");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "a_faire=" + aFaire + "\n");
  process.exit(0);
}
if (args.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Échec de la collecte GBIF (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const lignes = JSON.parse(await readFile(join(sortie, FICHIER + ".json"), "utf8")) as LigneGraphique[];
const details = JSON.parse(await readFile(join(sortie, FICHIER_DETAILS + ".json"), "utf8")) as LigneDetail[];
const indicateurs = JSON.parse(await readFile(join(sortie, FICHIER_INDICATEURS + ".json"), "utf8")) as Indicateur[];
const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport;
if (!lignes.length || lignes.length !== rapport.nb_lignes_graphique ||
    details.length !== rapport.nb_lignes_details || indicateurs.length !== rapport.nb_indicateurs) {
  throw new Error("Sorties vides ou incohérentes avec rapport.json.");
}
if (rapport.occurrences_total < 1 || rapport.nb_regnes < 1 || !rapport.empreinte_sha256) {
  throw new Error("Les contrôles de base GBIF sont incomplets.");
}
for (const ligne of lignes) {
  if (!Number.isInteger(ligne.annee) || !ligne.filiere || ligne.unite !== "occurrences" ||
      !Number.isSafeInteger(ligne.valeur) || ligne.valeur < 0) throw new Error("Ligne graphique GBIF invalide.");
}
for (const ligne of details) {
  if (!ligne.dimension || !ligne.modalite || ligne.unite !== "occurrences" ||
      !Number.isSafeInteger(ligne.valeur) || ligne.valeur < 0) throw new Error("Ligne détaillée GBIF invalide.");
}

const nombre = (n: number) => new Intl.NumberFormat("fr-FR").format(n);
const descriptionFr = "Synthèse des occurrences d'espèces enregistrées en Algérie dans le réseau GBIF. " +
  nombre(rapport.occurrences_total) +
  " occurrences géolocalisées, sans anomalie spatiale et sous licence CC0 ou CC BY 4.0, réparties par année, règne taxonomique, région déclarée et type d'enregistrement. Les régions sont des libellés source non harmonisés, pas un découpage officiel des wilayas.";

const champs = {
  titre: {
    fr: "Biodiversité en Algérie — observations et répartition des espèces",
    en: "Biodiversity in Algeria — species occurrences and distribution",
    ar: "التنوع البيولوجي في الجزائر — رصد الأنواع وتوزيعها",
  },
  description: {
    fr: descriptionFr,
    en: "Statistical summary of species occurrences recorded in Algeria through GBIF. Only present, georeferenced records without geospatial issues and under CC0 or CC BY 4.0 are included. Distributions use source-reported region names, not a standardized wilaya boundary set.",
    ar: "ملخص إحصائي لسجلات رصد الأنواع في الجزائر عبر GBIF. يشمل فقط السجلات الحاضرة والمحددة جغرافيًا والخالية من الأخطاء المكانية والمرخصة بموجب CC0 أو CC BY 4.0. أسماء المناطق من المصادر الأصلية وليست تقسيمًا موحدًا للولايات.",
  },
  readme: [
    "# Biodiversité en Algérie — observations et répartition des espèces",
    "",
    "Synthèse de " + nombre(rapport.occurrences_total) + " occurrences GBIF filtrées. Période renseignée : " +
      (rapport.premiere_annee ?? "non renseignée") + "–" + (rapport.derniere_annee ?? "non renseignée") + ".",
    "",
    "## Fichiers",
    "- " + FICHIER + ".json / .csv : série temporelle longue (annee, filiere, valeur, unite), avec le total et les règnes taxonomiques.",
    "- " + FICHIER_DETAILS + ".json / .csv : agrégats par règne, année, région déclarée et type d'enregistrement.",
    "- " + FICHIER_INDICATEURS + ".json / .csv : indicateurs de synthèse et valeurs de couverture.",
    "- rapport.json : requête, filtres, date, empreinte et volumes contrôlés.",
    "",
    "## Méthode et filtres",
    "Le calcul utilise l'API GBIF Occurrence et ses facettes avec limit=0 : il ne télécharge pas les occurrences individuelles. Sont retenus les enregistrements country=DZ, occurrenceStatus=PRESENT, hasCoordinate=true, hasGeospatialIssue=false, et sous licence CC0_1_0 ou CC_BY_4_0. Des requêtes de comptage par règne récupèrent les séries annuelles.",
    "",
    "## Limites d'interprétation",
    "- Une occurrence est un signalement ou un enregistrement biologique, pas une mesure d'abondance. Le nombre d'occurrences n'est pas le nombre d'individus ni le nombre d'espèces distinctes.",
    "- Les types incluent observations, spécimens conservés, fossiles et autres enregistrements ; consulter la dimension type_enregistrement.",
    "- La région reprend le champ GBIF stateProvince tel qu'il est fourni. Il peut désigner une province, une région ou une wilaya, comporter des variantes linguistiques et rester vide. Il n'est pas normalisé aux wilayas administratives algériennes.",
    "- La facette régionale est limitée aux 200 modalités les plus fréquentes. La ligne résiduelle regroupe les enregistrements sans région et les valeurs non renvoyées par cette facette.",
    "- La couverture géographique et temporelle dépend des éditeurs et des efforts de collecte ; les données sont plus abondantes dans les zones et groupes les mieux observés.",
    "- Les occurrences sans coordonnées, avec anomalie géospatiale, marquées absentes ou sous des licences autres que CC0 et CC BY 4.0 sont exclues. Les résultats ne constituent pas l'inventaire exhaustif de la biodiversité algérienne.",
    "- La recherche GBIF limite la pagination des fiches individuelles. Ce projet évite cette limite en ne demandant que des comptes et facettes (limit=0) ; aucun échantillon de 100 000 fiches n'est présenté comme l'ensemble des données.",
    "",
    "## Sources et attribution",
    "- GBIF, Occurrence API : " + rapport.api_url,
    "- Recherche GBIF pour l'Algérie : " + rapport.source_url,
    "- Documentation : https://techdocs.gbif.org/en/openapi/",
    "- Filtres de licence : CC0 1.0 et CC BY 4.0. Les fiches individuelles ne sont pas redistribuées ; seules des statistiques agrégées sont publiées.",
    "- Attribution : GBIF.org et les éditeurs des jeux de données accessibles via GBIF.",
  ].join("\n"),
  categorie_slug: "environnement",
  source_slug: "gbif-biodiversite-algerie",
  licence_code: "CC-BY-4.0",
  licence_details: "Synthèse statistique agrégée construite à partir des occurrences GBIF filtrées sur les licences CC0 1.0 et CC BY 4.0 ; aucune fiche individuelle ni coordonnée précise n'est redistribuée. Attribution à GBIF.org et aux éditeurs des jeux de données.",
  url_source: rapport.source_url,
  mots_cles: [
    "biodiversité", "espèces", "observations", "occurrences", "faune", "flore", "champignons",
    "plantes", "animaux", "répartition", "GBIF", "Algérie", "التنوع البيولوجي", "الأنواع", "الجزائر",
  ],
  frequence_maj: "bimensuelle",
  infos_source: {
    occurrences_total: rapport.occurrences_total,
    licences_incluses: rapport.licences_incluses,
    premiere_annee: rapport.premiere_annee,
    derniere_annee: rapport.derniere_annee,
    nb_regnes: rapport.nb_regnes,
    nb_regions_declarees: rapport.nb_regions_declarees,
    source_etag: rapport.source_etag,
    source_modifie_le: rapport.source_modifie_le,
    empreinte_sha256: rapport.empreinte_sha256,
    methode: "Agrégation des facettes GBIF avec limit=0 ; aucune fiche individuelle téléchargée.",
  },
};

const metaRapport = donneesRapport(rapport, { creee: false, publiee: false });
if (essai || !cle) {
  const resume = "Essai : " + nombre(rapport.occurrences_total) + " occurrences, " +
    rapport.nb_regnes + " règnes et " + rapport.nb_regions_declarees + " valeurs régionales ; aucune publication.";
  console.log(resume);
  await rapporter("essai", resume, metaRapport);
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
const [actuel, actuelDetails, actuelIndicateurs] = creee
  ? [null, null, null]
  : await Promise.all([
      api.lireFichier(SLUG, FICHIER, "json"),
      api.lireFichier(SLUG, FICHIER_DETAILS, "json"),
      api.lireFichier(SLUG, FICHIER_INDICATEURS, "json"),
    ]);
const identique = (contenu: string | null, cible: unknown) =>
  contenu !== null && JSON.stringify(JSON.parse(contenu)) === JSON.stringify(cible);
if (identique(actuel, lignes) && identique(actuelDetails, details) && identique(actuelIndicateurs, indicateurs)) {
  await rapporter("reussie", "Aucun changement dans les agrégats GBIF.", donneesRapport(rapport, { creee, publiee: false }));
  process.exit(0);
}

const [json, csv, detailsJson, detailsCsv, indicateursJson, indicateursCsv] = await Promise.all([
  readFile(join(sortie, FICHIER + ".json"), "utf8"),
  readFile(join(sortie, FICHIER + ".csv"), "utf8"),
  readFile(join(sortie, FICHIER_DETAILS + ".json"), "utf8"),
  readFile(join(sortie, FICHIER_DETAILS + ".csv"), "utf8"),
  readFile(join(sortie, FICHIER_INDICATEURS + ".json"), "utf8"),
  readFile(join(sortie, FICHIER_INDICATEURS + ".csv"), "utf8"),
]);
const [cleJson, cleCsv, cleDetailsJson, cleDetailsCsv, cleIndicateursJson, cleIndicateursCsv] = await Promise.all([
  api.envoyerFichier(SLUG, FICHIER, json, "json"),
  api.envoyerFichier(SLUG, FICHIER, csv, "csv"),
  api.envoyerFichier(SLUG, FICHIER_DETAILS, detailsJson, "json"),
  api.envoyerFichier(SLUG, FICHIER_DETAILS, detailsCsv, "csv"),
  api.envoyerFichier(SLUG, FICHIER_INDICATEURS, indicateursJson, "json"),
  api.envoyerFichier(SLUG, FICHIER_INDICATEURS, indicateursCsv, "csv"),
]);
const version = await api.publierVersion(SLUG, {
  notes: "GBIF Occurrence API ; " + nombre(rapport.occurrences_total) +
    " occurrences filtrées ; empreinte " + rapport.empreinte_sha256.slice(0, 12) + ".",
  fichiers: [
    { cle: cleJson, nom: FICHIER, format: "json", principal: true },
    { cle: cleCsv, nom: FICHIER, format: "csv", principal: false },
    { cle: cleDetailsJson, nom: FICHIER_DETAILS, format: "json", principal: false },
    { cle: cleDetailsCsv, nom: FICHIER_DETAILS, format: "csv", principal: false },
    { cle: cleIndicateursJson, nom: FICHIER_INDICATEURS, format: "json", principal: false },
    { cle: cleIndicateursCsv, nom: FICHIER_INDICATEURS, format: "csv", principal: false },
  ],
});
console.log("Version " + version.numero + " publiée (" + version.nb_lignes + " lignes principales).");
await rapporter(
  "reussie",
  "Version " + version.numero + " publiée : " + nombre(rapport.occurrences_total) + " occurrences agrégées.",
  donneesRapport(rapport, { creee, publiee: true, version: version.numero })
);
