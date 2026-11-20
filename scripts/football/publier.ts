// Publication du dataset « Équipe d'Algérie masculine de football » sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// Une version n'est ajoutée que si les fichiers calculés ont changé.
//
//   npx tsx scripts/football/publier.ts --verifier
//   npx tsx scripts/football/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/football/publier.ts --sortie DOSSIER
//   npx tsx scripts/football/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

export const CODE = "equipe-algerie-foot-m";
export const SLUG = "equipe-algerie-foot-m";
/** Le premier fichier est le principal : la série annuelle, que la fiche et la vignette tracent en courbe. */
export const FICHIERS = ["bilan-annuel", "matchs", "bilan-adversaires", "bilan-competitions", "tirs-au-but", "buteurs"] as const;

interface Bilan {
  matchs: number;
  victoires: number;
  nuls: number;
  defaites: number;
  buts_marques: number;
  buts_encaisses: number;
}
interface Rapport {
  depot_source: string;
  premier_match: string;
  dernier_match: string;
  premiere_annee: number;
  derniere_annee: number;
  nb_matchs: number;
  nb_matchs_a_venir_ecartes: number;
  bilan: Bilan;
  nb_adversaires: number;
  nb_competitions: number;
  nb_tirs_au_but: number;
  nb_buts_avec_buteur: number;
  couverture_buteurs_pct: number;
  empreintes_sha256: Record<string, string>;
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
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration ${CODE} à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul des matchs de l'équipe d'Algérie a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport;
const contenus = Object.fromEntries(
  await Promise.all(
    FICHIERS.map(async (nom) => [nom, { json: await readFile(join(sortie, `${nom}.json`), "utf8"), csv: await readFile(join(sortie, `${nom}.csv`), "utf8") }] as const)
  )
) as Record<(typeof FICHIERS)[number], { json: string; csv: string }>;
const lignes = (nom: (typeof FICHIERS)[number]) => JSON.parse(contenus[nom].json) as Record<string, unknown>[];
if (lignes("matchs").length !== rapport.nb_matchs || rapport.nb_matchs < 500) throw new Error("Sorties vides ou incohérentes avec rapport.json.");
if (lignes("bilan-annuel").reduce((somme, ligne) => somme + Number(ligne.matchs), 0) !== rapport.nb_matchs) throw new Error("Bilan annuel incohérent.");

const { bilan } = rapport;
const chiffres = `${rapport.nb_matchs} matchs (${rapport.premiere_annee}–${rapport.derniere_annee}) : ${bilan.victoires} V, ${bilan.nuls} N, ${bilan.defaites} D`;
const rapportDonnee = (resultat: Record<string, unknown>) => ({
  depot_source: rapport.depot_source,
  empreintes_sha256: rapport.empreintes_sha256,
  periode: [rapport.premier_match, rapport.dernier_match],
  donnees: {
    [SLUG]: {
      fichiers: Object.fromEntries(FICHIERS.map((nom) => [nom, { total: lignes(nom).length }])),
      ...resultat,
    },
  },
});

const champs = {
  titre: {
    fr: "Équipe d'Algérie de football (hommes) : tous les matchs depuis 1963",
    en: "Algeria men's national football team: every match since 1963",
    ar: "المنتخب الجزائري لكرة القدم (رجال): جميع المباريات منذ 1963",
  },
  description: {
    fr: `Les ${rapport.nb_matchs} matchs officiels et amicaux des Verts, de ${rapport.premiere_annee} à ${rapport.derniere_annee} : score, adversaire, compétition, lieu, tirs au but, et bilans par année, par adversaire et par compétition (${bilan.victoires} victoires, ${bilan.nuls} nuls, ${bilan.defaites} défaites).`,
    en: `All ${rapport.nb_matchs} matches of Algeria's men's national team from ${rapport.premiere_annee} to ${rapport.derniere_annee}: score, opponent, competition, venue, penalty shoot-outs, and records by year, opponent and competition (${bilan.victoires} wins, ${bilan.nuls} draws, ${bilan.defaites} losses).`,
    ar: `جميع مباريات المنتخب الجزائري (${rapport.nb_matchs} مباراة) من ${rapport.premiere_annee} إلى ${rapport.derniere_annee}: النتيجة والمنافس والمنافسة والمكان وركلات الترجيح، مع الحصيلة حسب السنة والمنافس والمنافسة (${bilan.victoires} فوزًا، ${bilan.nuls} تعادلًا، ${bilan.defaites} هزيمة).`,
  },
  readme: [
    "## Équipe d'Algérie de football (hommes)",
    "",
    `${rapport.nb_matchs} matchs, du ${rapport.premier_match} au ${rapport.dernier_match} : ${bilan.victoires} victoires, ${bilan.nuls} nuls et ${bilan.defaites} défaites, ${bilan.buts_marques} buts marqués et ${bilan.buts_encaisses} encaissés, contre ${rapport.nb_adversaires} adversaires dans ${rapport.nb_competitions} compétitions.`,
    "",
    "### Fichiers",
    "- `bilan-annuel` (principal) : par année, matchs, victoires, nuls, défaites, buts marqués et encaissés, différence de buts.",
    "- `matchs` : un match par ligne (date, compétition et son nom français, adversaire, lieu `domicile` / `exterieur` / `neutre`, ville, pays, score, résultat, vainqueur d'une éventuelle séance de tirs au but).",
    "- `bilan-adversaires` et `bilan-competitions` : le même bilan par adversaire et par compétition, avec le premier et le dernier match.",
    "- `tirs-au-but` : les séances de tirs au but et leur vainqueur.",
    `- \`buteurs\` : les buts dont le buteur est connu (${rapport.nb_buts_avec_buteur}, soit ${rapport.couverture_buteurs_pct} % des buts marqués).`,
    "",
    "### À savoir",
    `- **Buteurs partiels** : la source ne renseigne les buteurs que pour une partie des matchs (${rapport.couverture_buteurs_pct} % des buts). Ce fichier ne permet donc pas d'établir un classement des meilleurs buteurs.`,
    "- Le résultat est celui du temps réglementaire et des prolongations ; une séance de tirs au but ne change pas `resultat` (un match nul reste nul), son vainqueur est dans `tirs_au_but_vainqueur`.",
    "- Les noms des adversaires, des villes et des pays sont ceux de la source, en anglais ; les noms des principales compétitions sont traduits dans `competition_fr`.",
    "- Matchs de l'équipe A masculine (officiels et amicaux reconnus par la source), hors équipes de jeunes, olympiques ou locales sauf indication de la compétition.",
    "- Les matchs annoncés mais pas encore joués sont écartés jusqu'à ce que leur score soit connu.",
    "",
    "### Source et licence",
    `- Mart Jürisoo, *International football results from 1872*, ${rapport.depot_source}, domaine public (CC0 1.0).`,
    "- Modifications : extraction des matchs de l'Algérie, point de vue algérien (buts pour et contre, résultat), traduction des compétitions et calcul des bilans.",
  ].join("\n"),
  categorie_slug: "sport-jeunesse",
  source_slug: "international-football-results",
  licence_code: "CC0-1.0",
  licence_details: "Données de Mart Jürisoo, International football results from 1872, versées au domaine public (CC0 1.0). Extraction et bilans calculés par data-dz.",
  url_source: rapport.depot_source,
  mots_cles: ["football", "équipe nationale", "Verts", "Fennecs", "Coupe d'Afrique des nations", "CAN", "Coupe du monde", "FAF", "كرة القدم", "المنتخب الوطني", "الخضر"],
  frequence_maj: "hebdomadaire",
  infos_source: {
    // Chiffre de la carte du catalogue : les matchs, pas les lignes du fichier principal (une par année).
    nb_enregistrements: rapport.nb_matchs,
    premier_match: rapport.premier_match,
    dernier_match: rapport.dernier_match,
    premiere_annee_observee: rapport.premiere_annee,
    derniere_annee_observee: rapport.derniere_annee,
    victoires: bilan.victoires,
    nuls: bilan.nuls,
    defaites: bilan.defaites,
    buts_marques: bilan.buts_marques,
    buts_encaisses: bilan.buts_encaisses,
    nb_adversaires: rapport.nb_adversaires,
    nb_competitions: rapport.nb_competitions,
    couverture_buteurs_pct: rapport.couverture_buteurs_pct,
    methode: "Extraction des matchs de « Algeria » du jeu International football results (CC0), du point de vue algérien.",
  },
};

if (essai || !cle) {
  console.log(`Essai : aucune publication. ${chiffres}.`);
  await rapporter("essai", `Essai : ${chiffres}.`, rapportDonnee({ creee: false, publiee: false }));
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
if (!creee) {
  const actuels = await Promise.all(FICHIERS.map((nom) => api.lireFichier(SLUG, nom, "json")));
  const identiques = actuels.every((actuel, i) => actuel !== null && JSON.stringify(JSON.parse(actuel)) === JSON.stringify(lignes(FICHIERS[i])));
  if (identiques) {
    await rapporter("reussie", `Inchangée : ${chiffres}.`, rapportDonnee({ creee, publiee: false }));
    process.exit(0);
  }
}

const fichiers = [];
for (const [i, nom] of FICHIERS.entries()) {
  const [cleJson, cleCsv] = await Promise.all([api.envoyerFichier(SLUG, nom, contenus[nom].json, "json"), api.envoyerFichier(SLUG, nom, contenus[nom].csv, "csv")]);
  fichiers.push({ cle: cleJson, nom, format: "json", principal: i === 0 }, { cle: cleCsv, nom, format: "csv", principal: false });
}
const version = await api.publierVersion(SLUG, {
  notes: `International football results (CC0), ${rapport.premier_match} → ${rapport.dernier_match} ; ${chiffres}.`,
  fichiers,
});
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee({ creee, publiee: true, version: version.numero }));
