// Publication du catalogue agrégé de la faune algérienne issu de GBIF.
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "faune-algerie";
const SLUG = "faune-algerie";
const TAILLE_MAX_FICHIER = 100 * 1024 * 1024;
const GROUPES = [
  { cle: "especes", nom: "faune-algerie-especes", lignes: "nb_lignes_especes", principal: true },
  { cle: "regions", nom: "faune-algerie-regions", lignes: "nb_lignes_regions" },
  { cle: "conservation", nom: "faune-algerie-conservation", lignes: "nb_lignes_conservation" },
  { cle: "historique", nom: "faune-algerie-historique", lignes: "nb_lignes_historique" },
  { cle: "sources", nom: "faune-algerie-sources", lignes: "nb_lignes_sources" },
  { cle: "indicateurs", nom: "faune-algerie-indicateurs", lignes: "nb_indicateurs" },
  { cle: "qualite", nom: "faune-algerie-qualite", lignes: "nb_lignes_qualite" },
] as const;

interface Rapport {
  source: string;
  source_url: string;
  api_url: string;
  cle_telechargement: string;
  doi: string | null;
  citation_gbif: string | null;
  total_enregistrements_telechargement: number | null;
  format: string;
  checklist_taxonomique: string;
  checklist_key: string;
  filtres: Record<string, unknown>;
  licences_incluses: string[];
  empreinte_sha256_archive: string;
  nb_occurrences_animales: number;
  occurrences_animales: number;
  occurrences_geolocalisees_valides: number;
  nb_especes: number;
  nb_regions_gadm: number;
  premiere_annee: number | null;
  derniere_annee: number | null;
  nb_lignes_especes: number;
  nb_lignes_regions: number;
  nb_lignes_conservation: number;
  nb_lignes_historique: number;
  nb_lignes_sources: number;
  nb_indicateurs: number;
  nb_lignes_qualite: number;
  avertissement: string;
}
interface Espece {
  espece_key: string;
  nom_scientifique: string;
  nb_occurrences: number;
  nb_occurrences_geolocalisees: number;
  famille: string;
  statut_iucn: string;
}
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
  const fichiers = Object.fromEntries(GROUPES.map((groupe) => [groupe.nom, { total: r[groupe.lignes] }]));
  return {
    fichier_source: {
      url: r.source_url,
      api_url: r.api_url,
      cle_telechargement: r.cle_telechargement,
      doi: r.doi,
      citation_gbif: r.citation_gbif,
      empreinte_sha256_archive: r.empreinte_sha256_archive,
    },
    periode: [r.premiere_annee, r.derniere_annee],
    controles: {
      occurrences_animales: r.occurrences_animales,
      nb_especes: r.nb_especes,
      nb_regions_gadm: r.nb_regions_gadm,
      occurrences_geolocalisees_valides: r.occurrences_geolocalisees_valides,
      licences_incluses: r.licences_incluses,
    },
    donnees: { [SLUG]: { fichiers, ...resultat } },
  };
}

async function rapporter(statut: "reussie" | "echec" | "essai", resume: string,
                         rapport: Record<string, unknown> = {}) {
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
      raison = aFaire ? "échéance atteinte" : synchro.actif
        ? "prochain passage le " + synchro.prochaine_execution
        : "synchronisation désactivée";
    } catch (erreur) {
      if (!(erreur instanceof ErreurAppel) || (erreur.statut !== 404 && erreur.statut !== 503)) throw erreur;
      aFaire = false;
      raison = "synchronisation inconnue de l'API (" + erreur.statut + ") : appliquer la migration faune GBIF";
    }
  } else if (forcer) raison = "forcée";
  console.log((aFaire ? "À faire : " : "Rien à faire : ") + raison + ".");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "a_faire=" + aFaire + "\n");
  process.exit(0);
}

if (args.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Échec de la collecte GBIF faune (voir les journaux GitHub Actions).");
  process.exit(0);
}

const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport;
const tables = new Map<string, unknown[]>();
const contenus = new Map<string, { json: string; csv: string }>();

for (const groupe of GROUPES) {
  const json = await readFile(join(sortie, groupe.nom + ".json"), "utf8");
  const csv = await readFile(join(sortie, groupe.nom + ".csv"), "utf8");
  const lignes = JSON.parse(json) as unknown[];
  if (!Array.isArray(lignes) || lignes.length !== rapport[groupe.lignes]) {
    throw new Error("Fichier " + groupe.nom + " vide ou incohérent avec rapport.json.");
  }
  tables.set(groupe.cle, lignes);
  contenus.set(groupe.nom, { json, csv });
  for (const extension of ["json", "csv"]) {
    const infos = await stat(join(sortie, groupe.nom + "." + extension));
    if (infos.size > TAILLE_MAX_FICHIER) {
      throw new Error(groupe.nom + "." + extension + " dépasse la limite de 100 Mo (" + infos.size + " octets).");
    }
  }
}

const especes = tables.get("especes") as Espece[];
const indicateurs = tables.get("indicateurs") as Indicateur[];
if (!especes.length || !indicateurs.length || rapport.nb_occurrences_animales < 1 ||
    rapport.nb_especes !== especes.length || rapport.nb_especes < 1 ||
    !/^[a-f0-9]{64}$/i.test(rapport.empreinte_sha256_archive) ||
    !rapport.cle_telechargement || rapport.format !== "DWCA") {
  throw new Error("Rapport GBIF incomplet : inventaire, téléchargement ou empreinte invalide.");
}
for (const espece of especes) {
  if (!espece.espece_key || !espece.nom_scientifique ||
      !Number.isSafeInteger(espece.nb_occurrences) || espece.nb_occurrences < 1 ||
      !Number.isSafeInteger(espece.nb_occurrences_geolocalisees) ||
      espece.nb_occurrences_geolocalisees < 0) {
    throw new Error("Ligne d'espèce GBIF invalide.");
  }
}

const nombre = (n: number) => new Intl.NumberFormat("fr-FR").format(n);
const descriptionFr =
  "Catalogue agrégé des espèces animales signalées en Algérie dans GBIF : " +
  nombre(rapport.nb_especes) + " espèces identifiées parmi " +
  nombre(rapport.occurrences_animales) + " occurrences présentes, sous licences CC0 ou CC BY. " +
  "Taxonomie, catégories IUCN disponibles, dates, types de preuve et régions administratives GADM de niveau 1. " +
  "Les occurrences ne mesurent ni le nombre d'animaux ni l'évolution des populations.";

const champs = {
  titre: {
    fr: "Faune d'Algérie — espèces, observations et conservation",
    en: "Algerian fauna — species, records and conservation",
    ar: "الحياة البرية في الجزائر — الأنواع والرصد والحفاظ عليها",
  },
  description: {
    fr: descriptionFr,
    en: "Aggregated catalogue of animal species recorded in Algeria through GBIF. Includes taxonomy, available IUCN categories, record counts, observation years, record types and GADM first-level regions. Occurrence records are not animal population counts.",
    ar: "فهرس إحصائي للأنواع الحيوانية المسجلة في الجزائر عبر GBIF، مع التصنيف العلمي وفئات IUCN المتاحة وعدد السجلات وسنوات الرصد وأنواع السجلات والمناطق الإدارية من المستوى الأول وفق GADM. عدد السجلات لا يمثل عدد الحيوانات أو حجم التجمعات.",
  },
  readme: [
    "# Faune d'Algérie — espèces, observations et conservation",
    "",
    "Catalogue agrégé de " + nombre(rapport.nb_especes) + " espèces animales identifiées à partir de " +
      nombre(rapport.occurrences_animales) + " occurrences GBIF. Région enregistrée : " +
      (rapport.premiere_annee ?? "non renseignée") + "–" + (rapport.derniere_annee ?? "non renseignée") + ".",
    "",
    "## Fichiers",
    "- faune-algerie-especes.json/.csv : une ligne par espèce GBIF, classification, statut IUCN disponible, nombre de signalements, dates et régions GADM de présence.",
    "- faune-algerie-regions.json/.csv : signalements géolocalisés et espèces distinctes par région GADM de niveau 1.",
    "- faune-algerie-conservation.json/.csv : nombre d'espèces par catégorie IUCN ; les statuts multiples ou non renseignés restent séparés.",
    "- faune-algerie-historique.json/.csv : occurrences et espèces distinctes par année et type d'enregistrement.",
    "- faune-algerie-sources.json/.csv : principaux jeux de données contributeurs.",
    "- faune-algerie-indicateurs.json/.csv : couverture générale et indicateurs de synthèse.",
    "- faune-algerie-qualite.json/.csv : contrôles de complétude et de géolocalisation.",
    "- rapport.json : filtres, identifiant et DOI GBIF, empreinte SHA-256 de l'archive source et méthode.",
    "",
    "## Source et extraction",
    "GBIF Occurrence Download API, format Darwin Core Archive (DWCA), taxonomie Catalogue of Life Extended Release. Filtre : country=DZ, occurrenceStatus=PRESENT, licences CC0 1.0 et CC BY 4.0. Le téléchargement asynchrone contient les occurrences interprétées par GBIF ; il est agrégé localement sans republier les fiches individuelles.",
    "DOI du téléchargement : " + (rapport.doi ?? "non fourni par GBIF") + ".",
    "",
    "## Méthode et prudence d'interprétation",
    "- Le catalogue ne conserve que les occurrences du règne Animalia pour lesquelles GBIF fournit une clé et un nom d'espèce. Les enregistrements moins précis taxonomiquement restent comptés dans les indicateurs de qualité, mais ne deviennent pas artificiellement des espèces.",
    "- Le nombre d'occurrences mesure des enregistrements GBIF, pas le nombre d'individus. Le champ individualCount n'est pas additionné : son renseignement et ses unités varient selon les jeux de données.",
    "- Les catégories IUCN proviennent du champ interprété par GBIF. Elles peuvent manquer ou différer entre occurrences d'une même espèce ; dans ce cas, le statut est indiqué comme multiple au lieu d'être arbitrairement choisi.",
    "- Les régions de présence sont les régions GADM de niveau 1 fournies par GBIF. Elles ne constituent pas un référentiel garanti des 69 wilayas administratives actuelles.",
    "- Les coordonnées exactes, identifiants d'occurrence, noms d'observateurs et localités détaillées ne sont pas publiés. Les régions sont agrégées.",
    "- L'historique temporel dépend de l'effort d'observation, de la numérisation des collections et des jeux de données versés. Il ne mesure pas une augmentation ou un déclin des populations animales.",
    "- GBIF est une infrastructure de mobilisation de données, pas un inventaire exhaustif de toute la faune algérienne. L'absence de signalement ne prouve pas l'absence d'une espèce.",
    "",
    "## Attribution et licences",
    "Les occurrences source sont limitées aux licences CC0 1.0 et CC BY 4.0. Cette synthèse est publiée sous CC BY 4.0 avec attribution à GBIF.org et aux éditeurs des jeux de données contributeurs. Citer le DOI du téléchargement GBIF indiqué dans rapport.json.",
    "Documentation GBIF : https://techdocs.gbif.org/en/data-use/api-downloads",
  ].join("\n"),
  categorie_slug: "environnement",
  source_slug: "gbif-faune-algerie",
  licence_code: "CC-BY-4.0",
  licence_details:
    "Synthèse agrégée construite à partir d'occurrences GBIF présentes en Algérie, sous CC0 1.0 et CC BY 4.0. Aucune fiche individuelle, coordonnée précise, localité détaillée ou donnée personnelle d'observateur n'est redistribuée. Attribution à GBIF.org et aux éditeurs des jeux de données, avec citation du DOI de téléchargement.",
  url_source: rapport.source_url,
  mots_cles: [
    "faune", "animaux", "espèces", "mammifères", "oiseaux", "reptiles", "amphibiens", "poissons",
    "insectes", "conservation", "IUCN", "GBIF", "Algérie", "الحياة البرية", "الحيوانات", "الجزائر",
  ],
  frequence_maj: "mensuelle",
  infos_source: {
    cle_telechargement: rapport.cle_telechargement,
    doi: rapport.doi,
    citation_gbif: typeof rapport.citation_gbif === "string" ? rapport.citation_gbif.slice(0, 5000) : null,
    total_enregistrements_telechargement: rapport.total_enregistrements_telechargement,
    occurrences_animales: rapport.occurrences_animales,
    nb_especes: rapport.nb_especes,
    nb_regions_gadm: rapport.nb_regions_gadm,
    premiere_annee: rapport.premiere_annee,
    derniere_annee: rapport.derniere_annee,
    licences_incluses: rapport.licences_incluses,
    empreinte_sha256_archive: rapport.empreinte_sha256_archive,
    methode: "Téléchargement DWCA GBIF authentifié, agrégation par clé d'espèce acceptée et région GADM de niveau 1 ; aucune occurrence individuelle ni coordonnée précise redistribuée.",
  },
};

const metaRapport = donneesRapport(rapport, { creee: false, publiee: false });
if (essai || !cle) {
  const resume = "Essai : " + nombre(rapport.nb_especes) + " espèces, " +
    nombre(rapport.occurrences_animales) + " occurrences animales, " +
    rapport.nb_regions_gadm + " régions GADM ; aucune publication.";
  console.log(resume);
  await rapporter("essai", resume, metaRapport);
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");

const formats = ["json", "csv"] as const;
const actuels = creee ? new Map<string, string | null>() : new Map(
  (await Promise.all(GROUPES.flatMap((groupe) =>
    formats.map(async (format) => ({
      cle: groupe.nom + "." + format,
      valeur: await api.lireFichier(SLUG, groupe.nom, format),
    }))
  ))).map((item) => [item.cle, item.valeur])
);
const identique = (contenu: string | null | undefined, cible: string) =>
  contenu !== null && contenu !== undefined && contenu.trim() === cible.trim();

if (GROUPES.every((groupe) => formats.every((format) => {
  const actuel = actuels.get(groupe.nom + "." + format);
  const cible = contenus.get(groupe.nom)![format];
  return identique(actuel, cible);
}))) {
  await rapporter("reussie", "Aucun changement dans le catalogue GBIF ; aucune nouvelle version.", metaRapport);
  process.exit(0);
}

const fichiersEnvoyes = await Promise.all(GROUPES.flatMap((groupe) =>
  formats.map(async (format) => ({
    nom: groupe.nom,
    format,
    principal: Boolean("principal" in groupe && groupe.principal && format === "json"),
    cle: await api.envoyerFichier(SLUG, groupe.nom, contenus.get(groupe.nom)![format], format),
  }))
));
const version = await api.publierVersion(SLUG, {
  notes: "GBIF DWCA " + rapport.cle_telechargement + " ; " +
    nombre(rapport.nb_especes) + " espèces / " +
    nombre(rapport.occurrences_animales) + " occurrences ; empreinte " +
    rapport.empreinte_sha256_archive.slice(0, 12) + ".",
  fichiers: fichiersEnvoyes,
});
console.log("Version " + version.numero + " publiée (" + version.nb_lignes + " espèces principales).");
await rapporter(
  "reussie",
  "Version " + version.numero + " publiée : " +
    nombre(rapport.nb_especes) + " espèces et " +
    nombre(rapport.occurrences_animales) + " occurrences agrégées.",
  donneesRapport(rapport, { creee, publiee: true, version: version.numero })
);
