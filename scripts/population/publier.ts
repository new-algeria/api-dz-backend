// Synchronisation « population » : publie « Population par wilaya » sur data-dz à partir des fichiers de calculer.py,
// puis dépose le rapport de l'exécution (ligne `population` de la table `synchronisations`, visible dans /admin/sync).
//
//   npx tsx scripts/population/publier.ts --verifier           # échéance : écrit a_faire=true|false (GITHUB_OUTPUT)
//   npx tsx scripts/population/publier.ts [--sortie DOSSIER]   # publie (si les chiffres ont changé) et rapporte
//   npx tsx scripts/population/publier.ts --essai              # vérifie et rapporte « essai », ne publie rien
//   npx tsx scripts/population/publier.ts --echec "message"    # rapporte un échec (calcul impossible…)
//
// Variables : API_URL (défaut https://api.data-dz.com), CLE_SYNCHRO (sans clé : essai local seulement),
// SYNCHRO_FORCER (« true » : ignorer l'échéance), SYNCHRO_DEBUT (date ISO du début de l'exécution).
// Une donnée nouvelle est créée en brouillon : un administrateur la relit puis la publie depuis /admin/datasets.
// Une donnée existante garde son statut et son illustration ; une version n'est ajoutée que si les chiffres changent.

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "population";
const SLUG = "population-wilayas";
const FICHIER = "population-wilayas";

interface Ligne {
  code_wilaya: string;
  wilaya: string;
  wilaya_ar: string;
  annee: number;
  valeur: number;
  unite: string;
  type: "estimation" | "projection";
}

interface Rapport {
  annees: number[];
  nb_wilayas: number;
  nationaux: Record<string, { total: number }>;
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

/** Rapport d'exécution dans /admin/sync (sans clé : affiché seulement). Échec ou essai : l'échéance ne bouge pas. */
async function rapporter(statut: "reussie" | "echec" | "essai", resume: string, rapportExecution: Record<string, unknown> = {}) {
  console.log(`[${statut}] ${resume}`);
  if (!cle) return;
  await api.rapporter(CODE, { statut, declencheur, debut, fin: new Date().toISOString(), resume, rapport: rapportExecution });
}

// 1. Échéance réglée dans l'administration (active, intervalle, « forcer au prochain passage »).
if (arguments_.includes("--verifier")) {
  let aFaire = true;
  let raison = "aucune clé : calcul en local";
  if (cle && !forcer) {
    try {
      const synchro = await api.lireSynchro(CODE);
      aFaire = synchro.a_faire;
      raison = aFaire ? "échéance atteinte" : synchro.actif ? `prochain passage le ${synchro.prochaine_execution}` : "synchronisation désactivée";
    } catch (erreur) {
      // Ligne `population` absente (migration de data-dz pas encore appliquée) : ne rien lancer tout seul.
      if (!(erreur instanceof ErreurAppel) || (erreur.statut !== 404 && erreur.statut !== 503)) throw erreur;
      aFaire = false;
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration 20261114000022 de data-dz à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

// 2. Échec du calcul (étape précédente de la GitHub Action).
if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul de la population a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const lignes = JSON.parse(await readFile(join(sortie, "population-wilayas.json"), "utf8")) as Ligne[];
const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport;
const premiere = Math.min(...rapport.annees);
const derniere = Math.max(...rapport.annees);
const derniereEstimation = Math.max(...lignes.filter((ligne) => ligne.type === "estimation").map((ligne) => ligne.annee));

// Contrôles avant tout envoi : 69 wilayas par année, aucune valeur négative ni manquante.
for (const annee of rapport.annees) {
  const delAnnee = lignes.filter((ligne) => ligne.annee === annee);
  if (delAnnee.length !== rapport.nb_wilayas) throw new Error(`${annee} : ${delAnnee.length} wilayas au lieu de ${rapport.nb_wilayas}`);
  if (delAnnee.some((ligne) => !Number.isFinite(ligne.valeur) || ligne.valeur < 0)) throw new Error(`${annee} : population invalide`);
}

const totalFormate = (annee: number) => new Intl.NumberFormat("fr-FR").format(rapport.nationaux[String(annee)].total);

const champs = {
  titre: {
    fr: "Population par wilaya (estimations et projections)",
    en: "Population by wilaya (estimates and projections)",
    ar: "عدد السكان حسب الولاية (تقديرات وإسقاطات)",
  },
  description: {
    fr: `Nombre d'habitants de chacune des 69 wilayas, chaque année de ${premiere} à ${derniere}. Estimations par modèle de WorldPop jusqu'en ${derniereEstimation}, projections ensuite : ce ne sont pas des chiffres de recensement.`,
    en: `Number of inhabitants of each of the 69 wilayas, every year from ${premiere} to ${derniere}. Model-based estimates from WorldPop up to ${derniereEstimation}, projections afterwards: these are not census figures.`,
    ar: `عدد سكان كل ولاية من الولايات الـ69، كل سنة من ${premiere} إلى ${derniere}. تقديرات نموذجية من WorldPop حتى ${derniereEstimation} ثم إسقاطات بعدها: ليست أرقام تعداد.`,
  },
  readme: [
    "## Population par wilaya",
    "",
    `Une ligne par wilaya et par année (${rapport.nb_wilayas} wilayas, ${premiere}–${derniere}) : \`code_wilaya\`, \`wilaya\`, \`wilaya_ar\`, \`annee\`, \`valeur\` (habitants), \`unite\`, \`type\` (\`estimation\` jusqu'en ${derniereEstimation}, \`projection\` ensuite).`,
    "",
    `Total national : ${totalFormate(premiere)} habitants en ${premiere}, ${totalFormate(derniere)} en ${derniere}.`,
    "",
    "### Méthode",
    "La grille de population WorldPop Global 2 (R2025A v1, cellules de 100 m, version « constrained » : habitants répartis sur les zones bâties) est additionnée à l'intérieur des contours des 69 wilayas (GeoAlgeria, donnée « Divisions administratives » de data-dz). Moins de 0,2 % de la population tombe hors des contours (côtes, frontières).",
    "",
    "### À savoir",
    "- Ce sont des **estimations par modèle**, calées sur les totaux nationaux des Nations unies, pas des chiffres de l'ONS. Le dernier recensement publié par wilaya date de 2008 (48 wilayas).",
    "- Les 11 wilayas créées en 2026 (59 à 69) sont calculées sur leurs nouveaux contours, y compris pour les années antérieures à leur création.",
    "- La répartition entre wilayas change très peu d'une année à l'autre (toutes progressent d'environ 1,75 % par an dans cette version) : la donnée sert à comparer les wilayas entre elles et à suivre le total, pas à mesurer des écarts de croissance entre wilayas.",
    "",
    "### Sources et licences",
    "- Population : WorldPop, Université de Southampton, *Global 2 (R2025A v1)*, licence CC BY 4.0, https://doi.org/10.5258/SOTON/WP00839",
    "- Contours des wilayas : GeoAlgeria (Yasser's studio), licence ODbL 1.0, https://geoalgeria.com",
    "- Calcul : script `scripts/population/` du dépôt de l'API data-dz.",
  ].join("\n"),
  categorie_slug: "administratif",
  source_slug: "worldpop",
  licence_code: "CC-BY-4.0",
  licence_details: "Population © WorldPop (Université de Southampton), CC BY 4.0 ; contours des wilayas © GeoAlgeria, ODbL 1.0.",
  url_source: "https://hub.worldpop.org/geodata/listing?id=135",
  mots_cles: ["population", "habitants", "démographie", "wilaya", "worldpop", "projection", "سكان"],
  frequence_maj: "annuelle",
  infos_source: {
    premiere_annee_observee: premiere,
    derniere_annee_observee: derniereEstimation,
    derniere_annee_projetee: derniere,
    nb_series: rapport.nb_wilayas,
    nb_wilayas: rapport.nb_wilayas,
    methode: "Somme de la grille WorldPop Global 2 R2025A (100 m, constrained) par contour de wilaya",
  },
};

console.log(`${lignes.length} lignes (${rapport.nb_wilayas} wilayas × ${rapport.annees.length} années), ${premiere}–${derniere}.`);

/** Rapport par donnée, au format affiché par /admin/sync (comme la synchro OpenStreetMap). */
const rapportDonnee = (resultat: Record<string, unknown>) => ({
  extrait_du: process.env.SYNCHRO_EXTRAIT_DU || null,
  annees: [premiere, derniere],
  totaux: { [premiere]: rapport.nationaux[String(premiere)].total, [derniere]: rapport.nationaux[String(derniere)].total },
  donnees: { [SLUG]: { fichiers: { [FICHIER]: { total: lignes.length } }, ...resultat } },
});
const resumeChiffres = `${rapport.nb_wilayas} wilayas, ${premiere}–${derniere} : ${totalFormate(premiere)} → ${totalFormate(derniere)} habitants`;

if (essai || !cle) {
  console.log("Essai : rien n'est publié.", JSON.stringify(champs.infos_source));
  await rapporter("essai", `Essai : ${resumeChiffres}.`, rapportDonnee({ publiee: false }));
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");

// Mêmes chiffres que la version en ligne : pas de nouvelle version (évite des versions identiques chaque année).
const actuel = creee ? null : await api.lireFichier(SLUG, FICHIER, "json");
if (actuel && JSON.stringify(JSON.parse(actuel)) === JSON.stringify(lignes)) {
  await rapporter("reussie", `Inchangée : ${resumeChiffres}.`, rapportDonnee({ creee, publiee: false }));
  process.exit(0);
}

const csv = await readFile(join(sortie, "population-wilayas.csv"), "utf8");
const cleJson = await api.envoyerFichier(SLUG, FICHIER, JSON.stringify(lignes), "json");
const cleCsv = await api.envoyerFichier(SLUG, FICHIER, csv, "csv");
const version = await api.publierVersion(SLUG, {
  notes: `WorldPop Global 2 R2025A, ${premiere}–${derniere}, ${rapport.nb_wilayas} wilayas.`,
  fichiers: [
    { cle: cleJson, nom: FICHIER, format: "json", principal: true },
    { cle: cleCsv, nom: FICHIER, format: "csv", principal: false },
  ],
});
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${resumeChiffres}.`, rapportDonnee({ creee, publiee: true, version: version.numero }));
