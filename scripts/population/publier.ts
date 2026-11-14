// Publie « Population par wilaya » sur data-dz à partir des fichiers produits par calculer.py.
//
//   CLE_SYNCHRO=… npx tsx scripts/population/publier.ts [--sortie scripts/population/sortie] [--essai]
//
// Variables : API_URL (défaut https://api.data-dz.com), CLE_SYNCHRO (obligatoire, sauf avec --essai).
// Une donnée nouvelle est créée en brouillon : un administrateur la relit puis la publie depuis /admin/datasets.
// Une donnée existante garde son statut et son illustration ; seule une nouvelle version est ajoutée.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi } from "../osm/api.js";

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
const sortie = arguments_.includes("--sortie") ? arguments_[arguments_.indexOf("--sortie") + 1] : join(import.meta.dirname, "sortie");
const essai = arguments_.includes("--essai");

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
if (essai) {
  console.log("Essai : rien n'est envoyé.", JSON.stringify(champs.infos_source));
  process.exit(0);
}

const cle = process.env.CLE_SYNCHRO?.trim();
if (!cle) throw new Error("CLE_SYNCHRO manquante (ou lancer avec --essai).");
const api = new ClientApi((process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, ""), cle);

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");

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
