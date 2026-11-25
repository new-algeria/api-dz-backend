// Publication du dataset « Pêche et aquaculture en Algérie » (FAO FishStat) sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// Une version n'est ajoutée que si les fichiers calculés ont changé.
//
//   npx tsx scripts/peche-aquaculture/publier.ts --verifier
//   npx tsx scripts/peche-aquaculture/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/peche-aquaculture/publier.ts --sortie DOSSIER
//   npx tsx scripts/peche-aquaculture/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";
import type { EspecePrincipale, LigneEspece, LigneProduction, Rapport } from "./calculer.js";

const CODE = "peche-aquaculture";
const SLUG = "peche-aquaculture-algerie";
const FICHIERS = ["production-annuelle", "production-par-espece", "especes-principales"] as const;

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
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration peche-aquaculture à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul de la pêche et de l'aquaculture a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const lireJson = async <T>(nom: string) => JSON.parse(await readFile(join(sortie, `${nom}.json`), "utf8")) as T;
const production = await lireJson<LigneProduction[]>("production-annuelle");
const especes = await lireJson<LigneEspece[]>("production-par-espece");
const principales = await lireJson<EspecePrincipale[]>("especes-principales");
const rapport = await lireJson<Rapport>("rapport");
if (production.length !== rapport.nb_lignes_production || especes.length !== rapport.nb_lignes_especes || !principales.length) {
  throw new Error("Sorties vides ou incohérentes avec rapport.json.");
}
for (const ligne of production) {
  if (!Number.isInteger(ligne.annee) || !ligne.indicateur || ligne.unite !== "tonnes" || !Number.isFinite(ligne.valeur)) {
    throw new Error("Ligne de production invalide (année, indicateur, valeur ou unité).");
  }
}

const c = rapport.derniere_annee_chiffres;
const nombre = (n: number) => n.toLocaleString("fr-FR");
const periode = `${rapport.premiere_annee}–${rapport.derniere_annee}`;
const chiffres = `${rapport.nb_lignes_production} valeurs annuelles, ${rapport.nb_especes} espèces, ${periode}`;
const estimees = rapport.annees_majoritairement_estimees;
const champs = {
  titre: {
    fr: "Pêche et aquaculture en Algérie",
    en: "Fisheries and aquaculture in Algeria",
    ar: "الصيد البحري وتربية المائيات في الجزائر",
  },
  description: {
    fr: `Production annuelle de la pêche et de l'aquaculture en Algérie de ${periode}, en tonnes, au total, par filière et par espèce (${rapport.nb_especes} espèces), d'après la FAO (FishStat, CC BY 4.0). En ${c.annee} : ${nombre(c.total_tonnes)} tonnes, dont ${nombre(c.aquaculture_tonnes)} t d'aquaculture ; ${c.premiere_espece.toLowerCase()} en tête (${c.premiere_espece_part_pct} %). Chaque valeur indique si elle est officielle ou estimée par la FAO. Données nationales, sans ventilation par wilaya.`,
    en: `Annual fisheries and aquaculture production in Algeria from ${periode}, in tonnes, in total, by sector and by species (${rapport.nb_especes} species), from FAO FishStat (CC BY 4.0). In ${c.annee}: ${nombre(c.total_tonnes)} tonnes, including ${nombre(c.aquaculture_tonnes)} t from aquaculture. Each value states whether it is official or estimated by FAO. National data, not broken down by wilaya.`,
    ar: `الإنتاج السنوي للصيد البحري وتربية المائيات في الجزائر من ${rapport.premiere_annee} إلى ${rapport.derniere_annee}، بالأطنان، إجمالًا وحسب الفرع وحسب النوع (${rapport.nb_especes} نوعًا)، وفق منظمة الأغذية والزراعة (FishStat، CC BY 4.0). في ${c.annee}: ${c.total_tonnes} طن، منها ${c.aquaculture_tonnes} طن من تربية المائيات. تبيّن كل قيمة إن كانت رسمية أو تقديرًا من المنظمة. بيانات وطنية دون توزيع حسب الولايات.`,
  },
  readme: [
    "## Pêche et aquaculture en Algérie",
    "",
    `Production annuelle de ${periode} en tonnes de poids vif, d'après la FAO (FishStat, édition ${rapport.edition}) : ${rapport.nb_especes} espèces, ${rapport.nb_lignes_especes} valeurs par espèce.`,
    "",
    `En ${c.annee} : ${nombre(c.total_tonnes)} tonnes, dont ${nombre(c.peche_tonnes)} t de pêche et ${nombre(c.aquaculture_tonnes)} t d'aquaculture. Première espèce : ${c.premiere_espece} (${c.premiere_espece_part_pct} % du total).`,
    "",
    "### Fichiers",
    "- `production-annuelle` (principal) : format long (`annee`, `indicateur`, `valeur` en tonnes, `part_officielle_pct`) : total, pêche en mer, pêche en eaux continentales, aquaculture (totale, marine, en eau saumâtre, en eau douce).",
    "- `production-par-espece` : une ligne par année, espèce, milieu et zone (noms français, anglais, arabe quand la FAO le donne, nom scientifique, groupe ISSCAAP), avec le statut de la valeur.",
    `- \`especes-principales\` : les 30 premières espèces de ${c.annee}, leur part du total et leur moyenne sur 10 ans.`,
    "",
    "### À savoir",
    `- **Valeurs officielles ou estimées** : la FAO comble les années non déclarées par ses propres estimations. \`part_officielle_pct\` donne la part du tonnage déclaré officiellement. Années surtout estimées : ${estimees.join(", ") || "aucune"}. En ${c.annee}, seulement ${c.part_officielle_pct} % du tonnage est officiel : la valeur sera révisée quand l'Algérie aura transmis ses chiffres.`,
    "- Les statistiques de la FAO sont nationales : il n'existe pas de série FAO par wilaya ni par port.",
    "- Tonnes de poids vif (poisson entier à la capture ou à la récolte), hors plantes aquatiques, coraux, éponges et mammifères marins, que la FAO ne compte pas en tonnes dans ce fichier.",
    "- « NCA » (non compris ailleurs) regroupe des espèces que la déclaration ne distingue pas.",
    "",
    "### Méthode",
    "Le robot télécharge la dernière édition du fichier groupé « Global production » de la FAO, garde les lignes de l'Algérie (code ONU 012), additionne les tonnages par filière et calcule la part officielle (statut « A ») ; une version n'est publiée que si les valeurs ont changé.",
    "",
    "### Source et licence",
    "- FAO, *FishStat : Global fisheries and aquaculture production 1950–*, https://www.fao.org/fishery/en/collection/global_production",
    "- Licence CC BY 4.0 (conditions d'utilisation des bases statistiques de la FAO) : https://www.fao.org/contact-us/terms/db-terms-of-use/en",
    "",
    `Source : FAO, Global fisheries and aquaculture production, édition ${rapport.edition}. Licence CC BY 4.0. Extraction et agrégats par data-dz.`,
  ].join("\n"),
  categorie_slug: "agriculture",
  source_slug: "fao-fishstat",
  licence_code: "CC-BY-4.0",
  licence_details: `FAO, Global fisheries and aquaculture production (FishStat), édition ${rapport.edition}, CC BY 4.0. Extraction de l'Algérie et agrégats par filière calculés par data-dz. Attribution à la FAO requise.`,
  url_source: "https://www.fao.org/fishery/en/collection/global_production",
  mots_cles: ["pêche", "aquaculture", "poisson", "sardine", "thon", "crevette", "production halieutique", "FAO", "mer Méditerranée", "صيد", "أسماك"],
  frequence_maj: "semestrielle",
  infos_source: {
    nb_indicateurs: rapport.nb_indicateurs,
    premiere_annee_observee: rapport.premiere_annee,
    derniere_annee_observee: rapport.derniere_annee,
    nb_especes: rapport.nb_especes,
    edition_fao: rapport.edition,
    part_officielle_derniere_annee_pct: c.part_officielle_pct,
    annees_majoritairement_estimees: estimees,
    date_fichier_source: rapport.source_modifie_le,
    empreinte_sha256_source: rapport.source_sha256,
    methode: "Lignes de l'Algérie (code ONU 012) du fichier Global production de la FAO, tonnages additionnés par filière, statut de chaque valeur conservé.",
  },
};

const rapportDonnee = (resultat: Record<string, unknown>) => ({
  fichier_source: { url: rapport.source_url, edition: rapport.edition, modifie_le: rapport.source_modifie_le, sha256: rapport.source_sha256, octets: rapport.source_octets },
  periode: [rapport.premiere_annee, rapport.derniere_annee],
  derniere_annee: c,
  donnees: {
    [SLUG]: {
      fichiers: {
        "production-annuelle": { total: production.length },
        "production-par-espece": { total: especes.length },
        "especes-principales": { total: principales.length },
      },
      ...resultat,
    },
  },
});

if (essai || !cle) {
  console.log(`Essai : aucune publication. ${chiffres}.`);
  console.log(JSON.stringify(champs.infos_source));
  await rapporter("essai", `Essai : ${chiffres}.`, rapportDonnee({ creee: false, publiee: false }));
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
const cibles: Record<(typeof FICHIERS)[number], unknown> = {
  "production-annuelle": production,
  "production-par-espece": especes,
  "especes-principales": principales,
};
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
      principal: nom === "production-annuelle" && format === "json",
    }))
  )
);
const version = await api.publierVersion(SLUG, {
  notes: `FAO FishStat Global production, édition ${rapport.edition}, ${periode}.`,
  fichiers: envois,
});
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee({ creee, publiee: true, version: version.numero }));
