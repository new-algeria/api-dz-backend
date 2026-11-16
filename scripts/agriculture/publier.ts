// Publication des séries agricoles nationales FAOSTAT.
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "agriculture-faostat";
const SLUG = "production-agricole-algerie";
const MAX = 100 * 1024 * 1024;
const GROUPES = [
  { nom: "agriculture-algerie-series", lignes: "nb_lignes_series", principal: true },
  { nom: "agriculture-algerie-indicateurs", lignes: "nb_lignes_indicateurs" },
  { nom: "agriculture-algerie-qualite", lignes: "nb_lignes_qualite" },
] as const;
interface Rapport {
  source: string; source_url: string; api_url: string; licence: string;
  empreinte_sha256_archive: string; filtres: Record<string, string>;
  premiere_annee: number; derniere_annee: number; nb_observations: number;
  nb_produits: number; nb_types_indicateurs: number;
  nb_lignes_series: number; nb_lignes_indicateurs: number; nb_lignes_qualite: number;
}
const args = process.argv.slice(2);
const val = (option: string) => args.includes(option) ? args[args.indexOf(option) + 1] : undefined;
const sortie = val("--sortie") ?? join(import.meta.dirname, "sortie");
const essai = args.includes("--essai") || process.env.SYNCHRO_ESSAI === "true";
const forcer = process.env.SYNCHRO_FORCER === "true";
const declencheur = forcer ? "forcer" : process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manuel" : "planifie";
const debut = process.env.SYNCHRO_DEBUT?.trim() || new Date().toISOString();
const cle = process.env.CLE_SYNCHRO?.trim() || null;
const api = new ClientApi((process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, ""), cle);

async function rapporter(statut: "reussie" | "echec" | "essai", resume: string, rapport: Record<string, unknown> = {}) {
  console.log("[" + statut + "] " + resume);
  if (cle) await api.rapporter(CODE, { statut, declencheur, debut, fin: new Date().toISOString(), resume, rapport });
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
      if (!(erreur instanceof ErreurAppel) || ![404, 503].includes(erreur.statut)) throw erreur;
      aFaire = false;
      raison = "synchronisation inconnue de l'API : appliquer la migration agriculture FAOSTAT";
    }
  } else if (forcer) raison = "forcée";
  console.log((aFaire ? "À faire : " : "Rien à faire : ") + raison + ".");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "a_faire=" + aFaire + "\n");
  process.exit(0);
}
if (args.includes("--echec")) {
  await rapporter("echec", val("--echec") || "Échec de la collecte FAOSTAT.");
  process.exit(0);
}

const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport;
const fichiers = new Map<string, { json: string; csv: string; lignes: unknown[] }>();
for (const groupe of GROUPES) {
  const json = await readFile(join(sortie, groupe.nom + ".json"), "utf8");
  const csv = await readFile(join(sortie, groupe.nom + ".csv"), "utf8");
  const lignes = JSON.parse(json) as unknown[];
  if (!Array.isArray(lignes) || lignes.length !== rapport[groupe.lignes] || !lignes.length) {
    throw new Error("Fichier " + groupe.nom + " vide ou incohérent avec rapport.json.");
  }
  for (const ext of ["json", "csv"]) {
    const taille = await stat(join(sortie, groupe.nom + "." + ext));
    if (taille.size > MAX) throw new Error(groupe.nom + "." + ext + " dépasse 100 Mio.");
  }
  fichiers.set(groupe.nom, { json, csv, lignes });
}
if (rapport.nb_observations < 1 || rapport.nb_produits < 1 ||
    rapport.nb_lignes_series !== fichiers.get(GROUPES[0].nom)!.lignes.length ||
    !/^[a-f0-9]{64}$/i.test(rapport.empreinte_sha256_archive)) {
  throw new Error("Rapport FAOSTAT incomplet ou empreinte invalide.");
}
const format = (n: number) => new Intl.NumberFormat("fr-FR").format(n);
const resume = format(rapport.nb_observations) + " observations nationales, " +
  format(rapport.nb_produits) + " produits, " + rapport.premiere_annee + "–" + rapport.derniere_annee + ".";
const champs = {
  titre: {
    fr: "Agriculture en Algérie — production végétale et animale",
    en: "Agriculture in Algeria — crop and livestock production",
    ar: "الزراعة في الجزائر — الإنتاج النباتي والحيواني",
  },
  description: {
    fr: "Séries nationales FAOSTAT : " + resume + " Production, superficies récoltées, rendements et autres éléments disponibles, par produit, année et unité. Pas de ventilation par wilaya.",
    en: "National FAOSTAT time series: " + resume + " Production, harvested area, yields and other available elements by item, year and unit. No wilaya-level breakdown.",
    ar: "سلاسل وطنية من FAOSTAT: " + resume + " الإنتاج والمساحات المحصودة والمردودية والمؤشرات المتاحة حسب المنتج والسنة والوحدة. لا تتوفر تفاصيل حسب الولاية.",
  },
  readme: [
    "# Agriculture en Algérie — production végétale et animale", "",
    "## Contenu",
    "- agriculture-algerie-series.json/.csv : séries nationales annuelles par produit, élément, valeur et unité.",
    "- agriculture-algerie-indicateurs.json/.csv : période et indicateurs de couverture.",
    "- agriculture-algerie-qualite.json/.csv : observations par code et description de qualité FAOSTAT.",
    "- rapport.json : source, filtre, période et empreinte SHA-256.", "",
    "## Source et méthode",
    "FAOSTAT QCL — Crops and livestock products. Filtre : Area = Algeria. Les données sont conservées au niveau national, par année, produit, élément et unité. Les unités ne sont pas converties ni additionnées entre catégories différentes.",
    "Source : " + rapport.source_url,
    "Archive : " + rapport.api_url,
    "Licence indiquée par le fournisseur : " + rapport.licence + ".", "",
    "## Limites",
    "Ce jeu de données ne contient pas de ventilation par wilaya. Les publications nationales ou régionales du ministère algérien et l'enquête communale de l'ONS doivent être exploitées séparément pour créer une couche territoriale. Les années et produits disponibles varient selon l'indicateur. Une valeur absente ne signifie pas une production nulle. FAOSTAT peut réviser les séries.",
    "Les valeurs ne sont jamais additionnées entre produits ou unités incompatibles. Les indicateurs et unités originaux sont conservés.", "",
    "## Attribution",
    "FAOSTAT — Organisation des Nations Unies pour l'alimentation et l'agriculture (FAO). Respecter la licence et les conditions d'attribution indiquées par FAOSTAT.",
  ].join("\n"),
  categorie_slug: "agriculture",
  source_slug: "faostat-qcl",
  licence_code: "CC-BY-4.0",
  licence_details: "Séries nationales FAOSTAT QCL. Attribution à la FAO/FAOSTAT ; consulter les conditions de réutilisation et d'attribution affichées par le fournisseur.",
  url_source: rapport.source_url,
  mots_cles: ["agriculture", "production agricole", "céréales", "blé", "orge", "dattes", "olives", "agrumes", "élevage", "rendement", "FAOSTAT", "FAO", "Algérie", "الزراعة", "الجزائر"],
  frequence_maj: "mensuelle",
  infos_source: {
    source: rapport.source, api_url: rapport.api_url, filtres: rapport.filtres,
    premiere_annee: rapport.premiere_annee, derniere_annee: rapport.derniere_annee,
    nb_observations: rapport.nb_observations, nb_produits: rapport.nb_produits,
    nb_types_indicateurs: rapport.nb_types_indicateurs,
    empreinte_sha256_archive: rapport.empreinte_sha256_archive,
    granularite: "nationale uniquement",
  },
};
const meta = {
  source: rapport.source, source_url: rapport.source_url, api_url: rapport.api_url,
  periode: [rapport.premiere_annee, rapport.derniere_annee],
  observations: rapport.nb_observations, produits: rapport.nb_produits,
  empreinte_sha256_archive: rapport.empreinte_sha256_archive,
};
if (essai || !cle) {
  await rapporter("essai", "Essai : " + resume + " Aucune publication.", meta);
  process.exit(0);
}
const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
const formats = ["json", "csv"] as const;
const actuels = creee ? new Map<string, string | null>() : new Map(
  (await Promise.all(GROUPES.flatMap(g => formats.map(async f => ({
    key: g.nom + "." + f, value: await api.lireFichier(SLUG, g.nom, f),
  }))))).map(x => [x.key, x.value])
);
if (GROUPES.every(g => formats.every(f => {
  const actuel = actuels.get(g.nom + "." + f);
  return actuel !== null && actuel !== undefined && actuel.trim() === fichiers.get(g.nom)![f].trim();
}))) {
  await rapporter("reussie", "Aucun changement dans les séries FAOSTAT ; aucune nouvelle version.", meta);
  process.exit(0);
}
const envois = await Promise.all(GROUPES.flatMap(g => formats.map(async f => ({
  nom: g.nom, format: f, principal: Boolean("principal" in g && g.principal && f === "json"),
  cle: await api.envoyerFichier(SLUG, g.nom, fichiers.get(g.nom)![f], f),
}))));
const version = await api.publierVersion(SLUG, {
  notes: "FAOSTAT QCL " + rapport.premiere_annee + "–" + rapport.derniere_annee +
    " ; " + format(rapport.nb_observations) + " observations ; empreinte " +
    rapport.empreinte_sha256_archive.slice(0, 12) + ".",
  fichiers: envois,
});
console.log("Version " + version.numero + " publiée (" + version.nb_lignes + " lignes principales).");
await rapporter("reussie", "Version " + version.numero + " publiée : " + resume, { ...meta, version: version.numero, creee });
