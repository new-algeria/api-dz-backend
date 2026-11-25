// Publication du dataset « Indicateurs de développement de l'Algérie (Banque mondiale) » sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// Une version n'est ajoutée que si les fichiers calculés ont changé.
//
//   npx tsx scripts/banque-mondiale/publier.ts --verifier
//   npx tsx scripts/banque-mondiale/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/banque-mondiale/publier.ts --sortie DOSSIER
//   npx tsx scripts/banque-mondiale/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";
import { INDICATEURS, type LigneIndicateur, type Rapport } from "./calculer.js";

const CODE = "banque-mondiale";
const SLUG = "indicateurs-developpement-algerie";
const FICHIERS = ["indicateurs-annuels", "bilan-annuel", "dictionnaire"] as const;

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
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration banque-mondiale à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul des indicateurs de la Banque mondiale a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const lireJson = async <T>(nom: string) => JSON.parse(await readFile(join(sortie, `${nom}.json`), "utf8")) as T;
const lignes = await lireJson<LigneIndicateur[]>("indicateurs-annuels");
const bilan = await lireJson<object[]>("bilan-annuel");
const dictionnaire = await lireJson<object[]>("dictionnaire");
const rapport = await lireJson<Rapport>("rapport");
if (lignes.length !== rapport.nb_lignes || bilan.length !== rapport.nb_annees || dictionnaire.length !== rapport.nb_indicateurs) {
  throw new Error("Sorties vides ou incohérentes avec rapport.json.");
}
for (const ligne of lignes) {
  if (!Number.isInteger(ligne.annee) || !ligne.indicateur || !ligne.unite || !Number.isFinite(ligne.valeur)) {
    throw new Error("Ligne d'indicateur invalide (année, indicateur, valeur ou unité).");
  }
}

const d = rapport.derniers_chiffres;
const nombre = (n: number) => n.toLocaleString("fr-FR");
const chiffre = (code: string) => d[code];
const periode = `${rapport.premiere_annee}–${rapport.derniere_annee}`;
const chiffres = `${rapport.nb_lignes} valeurs, ${rapport.nb_indicateurs} indicateurs, ${periode}`;
const vie = chiffre("SP.DYN.LE00.IN");
const net = chiffre("IT.NET.USER.ZS");
const pib = chiffre("NY.GDP.PCAP.CD");
const themes = [...new Set(INDICATEURS.map((i) => i.theme))];
const modelises = INDICATEURS.filter((i) => i.modelise).map((i) => i.fr);
const champs = {
  titre: {
    fr: "Indicateurs de développement de l'Algérie (Banque mondiale)",
    en: "Algeria development indicators (World Bank)",
    ar: "مؤشرات التنمية في الجزائر (البنك الدولي)",
  },
  description: {
    fr: `${rapport.nb_indicateurs} indicateurs annuels de la Banque mondiale sur l'Algérie de ${rapport.premiere_annee} à ${rapport.derniere_annee} : population, santé, éducation, économie, emploi, numérique et environnement. Par exemple, espérance de vie de ${nombre(vie.valeur)} ans en ${vie.annee}, ${nombre(net.valeur)} % d'internautes en ${net.annee}, PIB par habitant de ${nombre(pib.valeur)} dollars en ${pib.annee}. Licence CC BY 4.0.`,
    en: `${rapport.nb_indicateurs} annual World Bank indicators on Algeria from ${rapport.premiere_annee} to ${rapport.derniere_annee}: population, health, education, economy, employment, digital and environment. For example, life expectancy of ${vie.valeur} years in ${vie.annee}, ${net.valeur}% Internet users in ${net.annee}, GDP per capita of ${nombre(pib.valeur)} dollars in ${pib.annee}. CC BY 4.0 licence.`,
    ar: `${rapport.nb_indicateurs} مؤشرًا سنويًا من البنك الدولي عن الجزائر من ${rapport.premiere_annee} إلى ${rapport.derniere_annee}: السكان والصحة والتعليم والاقتصاد والتشغيل والرقمنة والبيئة. مثلًا: متوسط العمر المتوقع ${vie.valeur} سنة في ${vie.annee}، ونسبة مستخدمي الإنترنت ${net.valeur}٪ في ${net.annee}. رخصة CC BY 4.0.`,
  },
  readme: [
    "## Indicateurs de développement de l'Algérie (Banque mondiale)",
    "",
    `${rapport.nb_indicateurs} séries annuelles des Indicateurs du développement dans le monde (WDI) de la Banque mondiale pour l'Algérie, ${periode} : ${rapport.nb_lignes} valeurs. Base mise à jour par la Banque mondiale le ${rapport.base_mise_a_jour_le ?? "?"}.`,
    "",
    `Thèmes : ${themes.join(", ")}.`,
    "",
    "### Fichiers",
    "- `indicateurs-annuels` (principal) : format long (`annee`, `indicateur`, `valeur`, `unite`), une ligne par année et par indicateur ; courbe avec sélecteur sur la fiche.",
    "- `bilan-annuel` : une ligne par année, une colonne par indicateur (code de la Banque mondiale, par exemple `SP.POP.TOTL`).",
    "- `dictionnaire` : pour chaque code, le libellé, l'unité, le thème, les années couvertes et s'il s'agit d'une estimation modélisée.",
    "",
    "### Indicateurs",
    ...themes.map((theme) => `- **${theme}** : ${INDICATEURS.filter((i) => i.theme === theme).map((i) => `${i.fr} (${i.unite})`).join(" ; ")}.`),
    "",
    "### À savoir",
    `- Estimations modélisées (OIT, OMS, Unicef…), et non relevés nationaux : ${modelises.join(", ")}. Le chômage, en particulier, suit la définition harmonisée de l'OIT et peut différer des chiffres publiés par l'ONS.`,
    "- Les années couvertes varient selon l'indicateur (voir `dictionnaire`) : une année absente reste vide, jamais remplacée par zéro.",
    "- Un taux de scolarisation brut peut dépasser 100 % (élèves plus âgés ou plus jeunes que l'âge officiel).",
    "- PIB et réserves sont en milliards de dollars courants (valeur de la Banque mondiale divisée par un milliard) ; le PIB par habitant est en dollars courants.",
    "- La Banque mondiale révise régulièrement ses séries : la synchronisation reprend les valeurs publiées chaque mois.",
    "",
    "### Méthode",
    "Le robot interroge l'API v2 de la Banque mondiale (sans clé), un appel par indicateur, vérifie que chaque valeur reste dans une plage plausible, arrondit et publie une version seulement si les valeurs ont changé.",
    "",
    "### Source et licence",
    "- Banque mondiale, *World Development Indicators* : https://data.worldbank.org/country/algeria",
    "- Licence CC BY 4.0 : https://datacatalog.worldbank.org/public-licenses",
    "",
    "Source : Banque mondiale, Indicateurs du développement dans le monde. Licence CC BY 4.0. Sélection et conversions par data-dz.",
  ].join("\n"),
  categorie_slug: "economie",
  source_slug: "banque-mondiale",
  licence_code: "CC-BY-4.0",
  licence_details: "Banque mondiale, World Development Indicators, CC BY 4.0. Sélection de séries pour l'Algérie, PIB et réserves convertis en milliards de dollars par data-dz. Attribution à la Banque mondiale requise.",
  url_source: "https://data.worldbank.org/country/algeria",
  mots_cles: ["Banque mondiale", "indicateurs", "développement", "PIB", "espérance de vie", "chômage", "internet", "scolarisation", "inflation", "population", "مؤشرات", "تنمية"],
  frequence_maj: "mensuelle",
  infos_source: {
    nb_indicateurs: rapport.nb_indicateurs,
    premiere_annee_observee: rapport.premiere_annee,
    derniere_annee_observee: rapport.derniere_annee,
    nb_observations: rapport.nb_lignes,
    base_mise_a_jour_le: rapport.base_mise_a_jour_le,
    themes,
    methode: "API v2 de la Banque mondiale (base WDI), un appel par indicateur, valeurs absentes laissées vides.",
  },
};

const rapportDonnee = (resultat: Record<string, unknown>) => ({
  base_mise_a_jour_le: rapport.base_mise_a_jour_le,
  periode: [rapport.premiere_annee, rapport.derniere_annee],
  derniers_chiffres: d,
  donnees: {
    [SLUG]: {
      fichiers: {
        "indicateurs-annuels": { total: lignes.length },
        "bilan-annuel": { total: bilan.length },
        dictionnaire: { total: dictionnaire.length },
      },
      ...resultat,
    },
  },
});

if (essai || !cle) {
  console.log(`Essai : aucune publication. ${chiffres}.`);
  console.log(champs.description.fr);
  await rapporter("essai", `Essai : ${chiffres}.`, rapportDonnee({ creee: false, publiee: false }));
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
const cibles: Record<(typeof FICHIERS)[number], unknown> = { "indicateurs-annuels": lignes, "bilan-annuel": bilan, dictionnaire };
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
      principal: nom === "indicateurs-annuels" && format === "json",
    }))
  )
);
const version = await api.publierVersion(SLUG, {
  notes: `Banque mondiale, World Development Indicators (base du ${rapport.base_mise_a_jour_le ?? "?"}), ${periode}.`,
  fichiers: envois,
});
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee({ creee, publiee: true, version: version.numero }));
