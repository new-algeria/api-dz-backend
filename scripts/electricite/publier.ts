// Publication du dataset « Production et consommation d'électricité en Algérie » sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// Une version n'est ajoutée que si les fichiers calculés ont changé.
//
//   npx tsx scripts/electricite/publier.ts --verifier
//   npx tsx scripts/electricite/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/electricite/publier.ts --sortie DOSSIER
//   npx tsx scripts/electricite/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE = "electricite";
const SLUG = "electricite-algerie";
const FICHIER = "electricite-algerie";
const FICHIER_INDICATEURS = "electricite-algerie-indicateurs";

interface Ligne {
  annee: number;
  source_electricite: string;
  type_ligne: string;
  valeur_twh: number | null;
}
interface Indicateur {
  annee: number;
  production_totale_twh: number | null;
  demande_electricite_twh: number | null;
}
interface Rapport {
  source_url: string;
  source_modifie_le: string | null;
  source_etag: string | null;
  source_sha256: string;
  source_octets: number;
  premiere_annee: number;
  derniere_annee: number;
  annees: number[];
  nb_lignes: number;
  nb_series: number;
  nb_sources_electricite: number;
  reference_2024: { production_totale_twh: number; demande_electricite_twh: number; controle: string };
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

const rapportDonnee = (rapport: Rapport, resultat: Record<string, unknown>) => ({
  fichier_source: {
    url: rapport.source_url,
    modifie_le: rapport.source_modifie_le,
    etag: rapport.source_etag,
    sha256: rapport.source_sha256,
    octets: rapport.source_octets,
  },
  periode: [rapport.premiere_annee, rapport.derniere_annee],
  controles: { reference_2024: rapport.reference_2024 },
  donnees: {
    [SLUG]: {
      fichiers: {
        [FICHIER]: { total: rapport.nb_lignes },
        [FICHIER_INDICATEURS]: { total: rapport.nb_series },
      },
      ...resultat,
    },
  },
});

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
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration electricite à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul de l'électricité a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const lignes = JSON.parse(await readFile(join(sortie, `${FICHIER}.json`), "utf8")) as Ligne[];
const indicateurs = JSON.parse(await readFile(join(sortie, `${FICHIER_INDICATEURS}.json`), "utf8")) as Indicateur[];
const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport;
if (!lignes.length || lignes.length !== rapport.nb_lignes || !indicateurs.length || indicateurs.length !== rapport.nb_series) {
  throw new Error("Sorties vides ou incohérentes avec rapport.json.");
}
if (new Set(lignes.map((ligne) => ligne.annee)).size < 20) throw new Error("Couverture historique trop courte.");
for (const ligne of lignes) {
  if (!Number.isInteger(ligne.annee) || !ligne.source_electricite || (ligne.valeur_twh !== null && (!Number.isFinite(ligne.valeur_twh)))) {
    throw new Error("Ligne électrique invalide (année, source ou valeur).");
  }
}
for (const ligne of indicateurs) {
  if (!Number.isInteger(ligne.annee)) throw new Error("Indicateur annuel sans année.");
}

const chiffres = `${rapport.nb_lignes} observations, ${rapport.nb_sources_electricite} sources électriques, ${rapport.premiere_annee}–${rapport.derniere_annee}`;
const champs = {
  titre: {
    fr: "Production et consommation d'électricité en Algérie",
    en: "Electricity production and demand in Algeria",
    ar: "إنتاج واستهلاك الكهرباء في الجزائر",
  },
  description: {
    fr: `Séries annuelles Ember pour l'Algérie de ${rapport.premiere_annee} à ${rapport.derniere_annee} : production électrique totale et par filière, demande, importations nettes, capacités installées et émissions du secteur. Données nationales, sans ventilation par wilaya.`,
    en: `Ember annual electricity series for Algeria from ${rapport.premiere_annee} to ${rapport.derniere_annee}: total and source-level generation, demand, net imports, installed capacity and power-sector emissions. National data, not broken down by wilaya.`,
    ar: `سلاسل سنوية من Ember للجزائر من ${rapport.premiere_annee} إلى ${rapport.derniere_annee}: إجمالي إنتاج الكهرباء والإنتاج حسب المصدر والطلب وصافي الواردات والقدرات المركبة والانبعاثات. بيانات وطنية دون توزيع حسب الولايات.`,
  },
  readme: [
    "## Production et consommation d'électricité en Algérie",
    "",
    `Séries annuelles de ${rapport.premiere_annee} à ${rapport.derniere_annee}. Le fichier principal contient une ligne par année et par source/agrégat Ember (${rapport.nb_lignes} lignes, ${rapport.nb_sources_electricite} libellés de source). Le fichier d'indicateurs contient une ligne par année (${rapport.nb_series} années).`,
    "",
    `Contrôle de cohérence pour 2024 : ${rapport.reference_2024.production_totale_twh} TWh de production totale et ${rapport.reference_2024.demande_electricite_twh} TWh de demande, valeurs proches des statistiques publiées par Ember pour cette année.`,
    "",
    "### Fichiers",
    "- `electricite-algerie.json` / `.csv` : une ligne par année et par ligne Ember ; `valeur_twh` est la valeur TWh de la ligne, `source_electricite` conserve le libellé Ember, `type_ligne` distingue demande, échanges nets, production totale, agrégats et production par filière.",
    "- `electricite-algerie-indicateurs.json` / `.csv` : synthèse annuelle, avec production totale, demande, importations nettes, capacité installée, émissions et intensité.",
    "- `rapport.json` : plage temporelle, empreinte SHA-256 et ETag/date HTTP du fichier source, effectifs et contrôle de référence.",
    "",
    "### Méthode",
    "Le pipeline télécharge le CSV mondial « Yearly Electricity Data » d'Ember, filtre le code pays ISO 3166-1 alpha-3 DZA, puis normalise les colonnes en français. Les lignes de la source sont conservées, y compris les agrégats ; `source_agregee=true` permet de les distinguer des filières élémentaires. Le fichier de synthèse sélectionne uniquement les lignes « Total generation », « Demand » et « Net imports » : aucune addition des agrégats et des filières n'est effectuée.",
    "",
    "### À savoir",
    "- Les valeurs sont annuelles et nationales : elles ne décrivent ni la consommation de chaque wilaya, ni la charge heure par heure, ni les coupures, ni la puissance de pointe.",
    "- « Demand » est la mesure de demande telle que publiée par Ember ; elle ne doit pas être assimilée sans précaution aux seules ventes facturées aux ménages.",
    "- Les valeurs manquantes restent nulles : elles ne sont jamais remplacées par zéro. Les dernières années peuvent être provisoires ou estimées selon la méthodologie Ember ; consulter la date du fichier et la méthode de la source.",
    "- « Capacity (GW) » mesure une puissance installée, pas l'énergie produite (TWh). Les émissions et l'intensité sont reprises selon les définitions Ember.",
    "- La source couvre plus de 200 territoires, mais la disponibilité des dernières années varie selon les pays. La période algérienne affichée ici est détectée dans le fichier téléchargé, elle n'est pas prolongée artificiellement.",
    "- Les lignes marquées `source_agregee=true` se recoupent avec les lignes de détail : ne pas les additionner.",
    "",
    "### Sources et licences",
    "- Ember, *Yearly Electricity Data*, fichier mondial CSV, CC BY 4.0 : https://ember-energy.org/data/yearly-electricity-data/",
    "- Licence : https://creativecommons.org/licenses/by/4.0/",
    "- Modifications apportées : extraction de l'Algérie (DZA), normalisation/traduction des noms de colonnes et création d'une table annuelle synthétique. Les libellés de sources énergétiques sont conservés tels que publiés par Ember.",
    "",
    "Données : Ember, Yearly Electricity Data. Attribution à Ember requise, CC BY 4.0.",
  ].join("\n"),
  categorie_slug: "energie",
  source_slug: "ember-electricity",
  licence_code: "CC-BY-4.0",
  licence_details: "Données Ember, Yearly Electricity Data, CC BY 4.0. Extraction filtrée sur l'Algérie (DZA), colonnes normalisées en français et fichier synthétique dérivé. Attribution à Ember requise.",
  url_source: "https://ember-energy.org/data/yearly-electricity-data/",
  mots_cles: ["électricité", "production électrique", "demande électrique", "consommation", "gaz", "solaire", "énergies renouvelables", "mix électrique", "Ember", "طاقة", "كهرباء"],
  frequence_maj: "bimensuelle",
  infos_source: {
    premiere_annee: rapport.premiere_annee,
    derniere_annee: rapport.derniere_annee,
    nb_observations: rapport.nb_lignes,
    nb_series_annuelles: rapport.nb_series,
    nb_sources_electricite: rapport.nb_sources_electricite,
    date_fichier_source: rapport.source_modifie_le,
    etag_source: rapport.source_etag,
    empreinte_sha256_source: rapport.source_sha256,
    reference_2024: rapport.reference_2024,
    methode: "Extraction des lignes de l'Algérie (DZA) du CSV mondial Ember ; agrégats conservés et explicitement signalés.",
  },
};

const donneesRapport = rapportDonnee(rapport, { creee: false, publiee: false });
if (essai || !cle) {
  console.log(`Essai : aucune publication. ${chiffres}.`);
  console.log(JSON.stringify(champs.infos_source));
  await rapporter("essai", `Essai : ${chiffres}.`, donneesRapport);
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
const [actuel, actuelIndicateurs] = creee
  ? [null, null]
  : await Promise.all([
      api.lireFichier(SLUG, FICHIER, "json"),
      api.lireFichier(SLUG, FICHIER_INDICATEURS, "json"),
    ]);
const identique = (contenu: string | null, cible: unknown) =>
  contenu !== null && JSON.stringify(JSON.parse(contenu)) === JSON.stringify(cible);
if (identique(actuel, lignes) && identique(actuelIndicateurs, indicateurs)) {
  await rapporter("reussie", `Inchangée : ${chiffres}.`, rapportDonnee(rapport, { creee, publiee: false }));
  process.exit(0);
}

const [json, csv, indicateursJson, indicateursCsv] = await Promise.all([
  readFile(join(sortie, `${FICHIER}.json`), "utf8"),
  readFile(join(sortie, `${FICHIER}.csv`), "utf8"),
  readFile(join(sortie, `${FICHIER_INDICATEURS}.json`), "utf8"),
  readFile(join(sortie, `${FICHIER_INDICATEURS}.csv`), "utf8"),
]);
const [cleJson, cleCsv, cleIndicateursJson, cleIndicateursCsv] = await Promise.all([
  api.envoyerFichier(SLUG, FICHIER, json, "json"),
  api.envoyerFichier(SLUG, FICHIER, csv, "csv"),
  api.envoyerFichier(SLUG, FICHIER_INDICATEURS, indicateursJson, "json"),
  api.envoyerFichier(SLUG, FICHIER_INDICATEURS, indicateursCsv, "csv"),
]);
const version = await api.publierVersion(SLUG, {
  notes: `Ember Yearly Electricity Data, ${rapport.premiere_annee}–${rapport.derniere_annee}, extraction DZA ; source ${rapport.source_modifie_le ?? rapport.source_sha256.slice(0, 12)}.`,
  fichiers: [
    { cle: cleJson, nom: FICHIER, format: "json", principal: true },
    { cle: cleCsv, nom: FICHIER, format: "csv", principal: false },
    { cle: cleIndicateursJson, nom: FICHIER_INDICATEURS, format: "json", principal: false },
    { cle: cleIndicateursCsv, nom: FICHIER_INDICATEURS, format: "csv", principal: false },
  ],
});
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee(rapport, { creee, publiee: true, version: version.numero }));
