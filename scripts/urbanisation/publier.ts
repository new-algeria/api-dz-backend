// Publication du dataset « Étalement urbain : surface bâtie par wilaya » (GHSL, JRC) sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// Une version n'est ajoutée que si les fichiers calculés ont changé.
//
//   npx tsx scripts/urbanisation/publier.ts --verifier
//   npx tsx scripts/urbanisation/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/urbanisation/publier.ts --sortie DOSSIER
//   npx tsx scripts/urbanisation/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "urbanisation";
const SLUG = "surface-batie-wilayas";
const FICHIERS = ["surface-batie-wilayas", "surface-batie-nationale"] as const;

export interface LigneWilaya {
  code_wilaya: string;
  wilaya: string;
  wilaya_ar: string;
  annee: number;
  type: "estimation" | "projection";
  surface_batie_km2: number;
  part_territoire_pct: number | null;
  m2_bati_par_habitant: number | null;
}
interface Rapport {
  epoques: number[];
  derniere_epoque_observee: number;
  nb_wilayas: number;
  tuiles: string[];
  territoire_km2: number;
  surface_batie_nationale_km2: Record<string, number>;
  avec_population: boolean;
  nb_lignes_wilayas: number;
  nb_lignes_nationales: number;
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
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration urbanisation à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul de la surface bâtie a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const lireJson = async <T>(nom: string) => JSON.parse(await readFile(join(sortie, `${nom}.json`), "utf8")) as T;
const wilayas = await lireJson<LigneWilaya[]>("surface-batie-wilayas");
const nationale = await lireJson<object[]>("surface-batie-nationale");
const rapport = await lireJson<Rapport>("rapport");
if (wilayas.length !== rapport.nb_lignes_wilayas || nationale.length !== rapport.nb_lignes_nationales || rapport.nb_wilayas !== 69) {
  throw new Error("Sorties vides ou incohérentes avec rapport.json.");
}
if (wilayas.length !== 69 * rapport.epoques.length) throw new Error(`${wilayas.length} lignes au lieu de ${69 * rapport.epoques.length}.`);
for (const ligne of wilayas) {
  if (!/^\d{2}$/.test(ligne.code_wilaya) || !Number.isInteger(ligne.annee) || !Number.isFinite(ligne.surface_batie_km2) || ligne.surface_batie_km2 < 0) {
    throw new Error(`Ligne invalide : wilaya ${ligne.code_wilaya}, ${ligne.annee}.`);
  }
}

const premiere = rapport.epoques[0];
const observee = rapport.derniere_epoque_observee;
const derniere = rapport.epoques.at(-1)!;
const national = rapport.surface_batie_nationale_km2;
const nombre = (n: number, decimales = 0) => n.toLocaleString("fr-FR", { maximumFractionDigits: decimales });
const multiplie = national[String(premiere)] ? national[String(observee)] / national[String(premiere)] : null;
const enTete = [...wilayas].filter((l) => l.annee === observee).sort((a, b) => b.surface_batie_km2 - a.surface_batie_km2)[0];
const chiffres = `${wilayas.length} lignes, 69 wilayas, ${premiere}–${derniere}`;
const champs = {
  titre: {
    fr: "Étalement urbain : surface bâtie par wilaya (1975–2030)",
    en: "Urban growth: built-up surface by wilaya (1975–2030)",
    ar: "التوسع العمراني: المساحة المبنية حسب الولاية (1975–2030)",
  },
  description: {
    fr: `Surface bâtie de chacune des 69 wilayas tous les 5 ans de ${premiere} à ${derniere}, mesurée par satellite (Global Human Settlement Layer de la Commission européenne, CC BY 4.0). En ${observee}, l'Algérie comptait ${nombre(national[String(observee)])} km² de surfaces bâties${multiplie ? `, ${nombre(multiplie, 1)} fois plus qu'en ${premiere}` : ""}, dont ${nombre(enTete.surface_batie_km2)} km² dans la wilaya de ${enTete.wilaya}. ${derniere > observee ? `Les années après ${observee} sont des projections.` : ""}`,
    en: `Built-up surface of each of the 69 wilayas every 5 years from ${premiere} to ${derniere}, measured by satellite (European Commission Global Human Settlement Layer, CC BY 4.0). In ${observee}, Algeria had ${nombre(national[String(observee)])} km² of built-up surface${multiplie ? `, ${nombre(multiplie, 1)} times more than in ${premiere}` : ""}. Years after ${observee} are projections.`,
    ar: `المساحة المبنية لكل ولاية من الولايات الـ69 كل 5 سنوات من ${premiere} إلى ${derniere}، مقيسة بالأقمار الصناعية (طبقة المستوطنات البشرية العالمية للمفوضية الأوروبية، CC BY 4.0). في ${observee} بلغت المساحات المبنية في الجزائر ${national[String(observee)]} كم². السنوات بعد ${observee} توقعات.`,
  },
  readme: [
    "## Étalement urbain : surface bâtie par wilaya",
    "",
    `Surface bâtie des 69 wilayas de ${premiere} à ${derniere}, tous les 5 ans, d'après GHS-BUILT-S R2023A (Global Human Settlement Layer, Centre commun de recherche de la Commission européenne).`,
    "",
    "| Année | Surface bâtie (km²) |",
    "|---|---|",
    ...rapport.epoques.map((annee) => `| ${annee}${annee > observee ? " (projection)" : ""} | ${nombre(national[String(annee)])} |`),
    "",
    "### Fichiers",
    "- `surface-batie-wilayas` (principal) : une ligne par wilaya et par époque : `surface_batie_km2`, `part_territoire_pct` (part de la superficie de la wilaya), `m2_bati_par_habitant` (de 2015 à 2030, avec la population de la donnée « Population par wilaya »), indice base 100 en " + premiere + ", `type` (estimation ou projection). Carte des wilayas colorée sur la fiche.",
    "- `surface-batie-nationale` : totaux nationaux en format long (surface bâtie, part du territoire, surface par habitant).",
    "",
    "### À savoir",
    "- « Surface bâtie » = emprise au sol des bâtiments (toits), mesurée sur une grille d'environ 90 m. Ce n'est ni la surface des villes au sens administratif, ni les routes, ni les surfaces de plancher.",
    `- ${premiere}–${observee} : estimations tirées des images Landsat et Sentinel-2 ; ${observee + 5}–${derniere} : projections du JRC. Ce sont des mesures satellites, avec une marge d'erreur, surtout pour les petites constructions dispersées et les années anciennes.`,
    `- Superficie des wilayas calculée sur la même grille à partir des contours GeoAlgeria (${nombre(rapport.territoire_km2)} km² au total).`,
    "",
    "### Méthode",
    `Le robot télécharge les tuiles GHSL (10° × 10°, 3 secondes d'arc) qui recouvrent l'Algérie (${rapport.tuiles.join(", ")}), place chaque cellule dans sa wilaya (contours de la donnée « Divisions administratives ») et additionne les surfaces bâties, pour chaque époque.`,
    "",
    "### Sources et licences",
    "- Pesaresi M., Politis P. (2023) : GHS-BUILT-S R2023A, Commission européenne, Centre commun de recherche (JRC), https://doi.org/10.2905/9F06F36F-4B11-47EC-ABB0-4F8B7B1D72EA, licence CC BY 4.0 (© Union européenne, 1995-2026).",
    "- Contours des wilayas : GeoAlgeria (ODbL), via data-dz. Population : WorldPop (CC BY 4.0), via data-dz.",
    "",
    "Source : Commission européenne, JRC, Global Human Settlement Layer. Licence CC BY 4.0. Calcul par wilaya par data-dz.",
  ].join("\n"),
  categorie_slug: "environnement",
  source_slug: "ghsl-jrc",
  licence_code: "CC-BY-4.0",
  licence_details: "GHS-BUILT-S R2023A, © Union européenne (JRC), CC BY 4.0. Somme par wilaya calculée par data-dz avec les contours GeoAlgeria (ODbL). Attribution à la Commission européenne requise.",
  url_source: "https://human-settlement.emergency.copernicus.eu/ghs_buS2023.php",
  mots_cles: ["urbanisation", "étalement urbain", "surface bâtie", "villes", "satellite", "GHSL", "Copernicus", "wilayas", "عمران", "توسع عمراني"],
  frequence_maj: "annuelle",
  infos_source: {
    nb_indicateurs: 4,
    premiere_annee_observee: premiere,
    derniere_annee_observee: observee,
    derniere_annee_projetee: derniere,
    epoques: rapport.epoques,
    tuiles_ghsl: rapport.tuiles,
    methode: "Somme des surfaces bâties GHS-BUILT-S R2023A (3 secondes d'arc) à l'intérieur des contours des 69 wilayas.",
  },
};

const rapportDonnee = (resultat: Record<string, unknown>) => ({
  epoques: rapport.epoques,
  surface_batie_nationale_km2: national,
  tuiles: rapport.tuiles,
  donnees: { [SLUG]: { fichiers: { "surface-batie-wilayas": { total: wilayas.length }, "surface-batie-nationale": { total: nationale.length } }, ...resultat } },
});

if (essai || !cle) {
  console.log(`Essai : aucune publication. ${chiffres}.`);
  console.log(champs.description.fr);
  await rapporter("essai", `Essai : ${chiffres}.`, rapportDonnee({ creee: false, publiee: false }));
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
const cibles: Record<(typeof FICHIERS)[number], unknown> = { "surface-batie-wilayas": wilayas, "surface-batie-nationale": nationale };
const actuels = creee ? FICHIERS.map(() => null) : await Promise.all(FICHIERS.map((nom) => api.lireFichier(SLUG, nom, "json")));
const identique = (contenu: string | null, cible: unknown) => contenu !== null && JSON.stringify(JSON.parse(contenu)) === JSON.stringify(cible);
if (FICHIERS.every((nom, index) => identique(actuels[index], cibles[nom]))) {
  await rapporter("reussie", `Inchangée : ${chiffres}.`, rapportDonnee({ creee, publiee: false }));
  process.exit(0);
}

const envois = await Promise.all(
  FICHIERS.flatMap((nom) =>
    (["json", "csv"] as const).map(async (format) => ({
      cle: await api.envoyerFichier(SLUG, nom, await readFile(join(sortie, `${nom}.${format}`), "utf8"), format),
      nom,
      format,
      principal: nom === "surface-batie-wilayas" && format === "json",
    }))
  )
);
const version = await api.publierVersion(SLUG, { notes: `GHS-BUILT-S R2023A, ${premiere}–${derniere}, 69 wilayas.`, fichiers: envois });
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee({ creee, publiee: true, version: version.numero }));
