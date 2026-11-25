// Publication du dataset « Commerce extérieur de l'Algérie » (BACI, CEPII) sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// L'archive BACI (2,4 Go) n'est téléchargée que si le CEPII a publié une version plus récente que celle en ligne.
//
//   npx tsx scripts/commerce-exterieur/publier.ts --verifier
//   npx tsx scripts/commerce-exterieur/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/commerce-exterieur/publier.ts --sortie DOSSIER
//   npx tsx scripts/commerce-exterieur/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";
import { derniereVersion, type LigneEchange, type Rapport } from "./calculer.js";

const CODE = "commerce-exterieur";
const SLUG = "commerce-exterieur-algerie";
const FICHIERS = ["echanges-annuels", "echanges-par-section", "partenaires", "produits-principaux"] as const;

const arguments_ = process.argv.slice(2);
const valeurDe = (option: string) => (arguments_.includes(option) ? arguments_[arguments_.indexOf(option) + 1] : undefined);
const sortie = valeurDe("--sortie") ?? join(import.meta.dirname, "sortie");
const essai = arguments_.includes("--essai") || process.env.SYNCHRO_ESSAI === "true";
const forcer = process.env.SYNCHRO_FORCER === "true";
const declencheur = forcer ? "forcer" : process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manuel" : "planifie";
const debut = process.env.SYNCHRO_DEBUT?.trim() || new Date().toISOString();
const cle = process.env.CLE_SYNCHRO?.trim() || null;
const urlApi = (process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, "");
const api = new ClientApi(urlApi, cle);

async function rapporter(statut: "reussie" | "echec" | "essai", resume: string, donnees: Record<string, unknown> = {}) {
  console.log(`[${statut}] ${resume}`);
  if (cle) await api.rapporter(CODE, { statut, declencheur, debut, fin: new Date().toISOString(), resume, rapport: donnees });
}

/** Version de BACI de la donnée en ligne (`infos_source.version_baci`), ou null. */
async function versionPubliee(): Promise<string | null> {
  try {
    const reponse = await fetch(`${urlApi}/v1/datasets/${SLUG}`);
    if (!reponse.ok) return null;
    const corps = (await reponse.json()) as { data?: { infos_source?: { version_baci?: string } }; infos_source?: { version_baci?: string } };
    return (corps.data ?? corps).infos_source?.version_baci ?? null;
  } catch {
    return null;
  }
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
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration commerce-exterieur à appliquer`;
    }
    if (aFaire) {
      const [disponible, publiee] = await Promise.all([derniereVersion(), versionPubliee()]);
      if (disponible === publiee) {
        aFaire = false;
        raison = `BACI ${disponible} déjà publiée`;
        await rapporter("reussie", `Inchangée : BACI ${disponible} déjà en ligne, archive non téléchargée.`, { version_baci: disponible });
      } else raison = `nouvelle version BACI ${disponible} (en ligne : ${publiee ?? "aucune"})`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul du commerce extérieur a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const lireJson = async <T>(nom: string) => JSON.parse(await readFile(join(sortie, `${nom}.json`), "utf8")) as T;
const echanges = await lireJson<LigneEchange[]>("echanges-annuels");
const sections = await lireJson<object[]>("echanges-par-section");
const partenaires = await lireJson<object[]>("partenaires");
const produits = await lireJson<object[]>("produits-principaux");
const rapport = await lireJson<Rapport>("rapport");
if (!echanges.length || !sections.length || !partenaires.length || !produits.length) throw new Error("Sorties vides.");
for (const ligne of echanges) {
  if (!Number.isInteger(ligne.annee) || !ligne.indicateur || !Number.isFinite(ligne.valeur)) throw new Error("Ligne d'échanges invalide.");
}

const c = rapport.derniere_annee_chiffres;
const nombre = (n: number, decimales = 1) => n.toLocaleString("fr-FR", { maximumFractionDigits: decimales });
const periode = `${rapport.premiere_annee}–${rapport.derniere_annee}`;
const chiffres = `BACI ${rapport.version_baci}, ${rapport.nb_flux} flux, ${periode}`;
const champs = {
  titre: {
    fr: "Commerce extérieur de l'Algérie : partenaires et produits",
    en: "Algeria's foreign trade: partners and products",
    ar: "التجارة الخارجية للجزائر: الشركاء والمنتجات",
  },
  description: {
    fr: `Exportations et importations de biens de l'Algérie de ${rapport.premiere_annee} à ${rapport.derniere_annee}, par partenaire, par produit et par grande famille, d'après la base BACI du CEPII (Licence Ouverte Etalab 2.0). En ${c.annee} : ${nombre(c.exportations_mds)} milliards de dollars d'exportations, dont ${nombre(c.part_hydrocarbures_pct)} % d'hydrocarbures, et ${nombre(c.importations_mds)} milliards d'importations. Premier client : ${c.premier_client} ; premier fournisseur : ${c.premier_fournisseur}.`,
    en: `Algeria's exports and imports of goods from ${rapport.premiere_annee} to ${rapport.derniere_annee}, by partner, product and product group, from the CEPII BACI database (Etalab Open Licence 2.0). In ${c.annee}: ${nombre(c.exportations_mds)} billion dollars of exports, ${nombre(c.part_hydrocarbures_pct)}% of them hydrocarbons, and ${nombre(c.importations_mds)} billion dollars of imports.`,
    ar: `صادرات الجزائر ووارداتها من السلع من ${rapport.premiere_annee} إلى ${rapport.derniere_annee}، حسب الشريك والمنتج والفئة، وفق قاعدة BACI لمركز CEPII (الرخصة المفتوحة Etalab 2.0). في ${c.annee}: ${c.exportations_mds} مليار دولار من الصادرات، منها ${c.part_hydrocarbures_pct}٪ محروقات، و${c.importations_mds} مليار دولار من الواردات.`,
  },
  readme: [
    "## Commerce extérieur de l'Algérie : partenaires et produits",
    "",
    `Flux de biens entre l'Algérie et ses partenaires, ${periode}, d'après BACI (CEPII), version ${rapport.version_baci}, nomenclature SH 1992 : ${rapport.nb_flux} flux, ${rapport.nb_partenaires} partenaires, ${rapport.nb_produits} produits.`,
    "",
    `En ${c.annee} : exportations ${nombre(c.exportations_mds)} milliards de dollars (hors hydrocarbures : ${nombre(c.exportations_hors_hydrocarbures_mds, 2)} milliards), importations ${nombre(c.importations_mds)} milliards, solde ${nombre(c.solde_mds)} milliards. Premier client : ${c.premier_client} ; premier fournisseur : ${c.premier_fournisseur}.`,
    "",
    "### Fichiers",
    "- `echanges-annuels` (principal) : format long (`annee`, `indicateur`, `valeur`, `unite`) : exportations, importations, solde, exportations d'hydrocarbures et hors hydrocarbures, importations alimentaires, en milliards de dollars courants.",
    "- `echanges-par-section` : exportations et importations par section du Système harmonisé (21 grandes familles), en millions de dollars et en part du total.",
    "- `partenaires` : tous les pays partenaires, chaque année et dans chaque sens, avec leur rang et leur part (noms en français, arabe et anglais, code ISO).",
    "- `produits-principaux` : les 50 premiers produits (code SH à 6 chiffres) exportés et importés chaque année, en valeur et en tonnes.",
    "",
    "### À savoir",
    "- **Données miroir** : BACI réconcilie les déclarations des deux pays d'un échange (base UN Comtrade). L'Algérie déclarant peu, ses échanges sont souvent reconstitués à partir des déclarations de ses partenaires : fiables pour les grands flux, plus approximatifs pour les petits.",
    "- Les valeurs sont « franco à bord » (FAB), sans frais de transport ni d'assurance : elles diffèrent des chiffres des Douanes algériennes, qui comptent les importations frais compris (CAF).",
    "- Biens seulement : ni services (tourisme, transport), ni transferts.",
    "- « Hydrocarbures » = chapitre 27 du Système harmonisé (pétrole, gaz, produits raffinés, charbon).",
    "- Décalage d'environ deux ans : la dernière année disponible est celle publiée par le CEPII.",
    "",
    "### Méthode",
    "Le robot vérifie la version publiée sur la page de BACI, télécharge l'archive HS92 seulement si elle est nouvelle, lit chaque année et ne garde que les flux dont l'Algérie est l'exportateur ou l'importateur, puis agrège par année, section, partenaire et produit.",
    "",
    "### Source et licence",
    "- CEPII, base BACI (Gaulier et Zignago, 2010) : https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=37",
    "- Licence Ouverte Etalab 2.0 : https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
    "",
    "Source : CEPII, BACI. Licence Ouverte Etalab 2.0. Extraction de l'Algérie et agrégats par data-dz.",
  ].join("\n"),
  categorie_slug: "economie",
  source_slug: "cepii-baci",
  licence_code: "etalab-2.0",
  licence_details: `CEPII, BACI version ${rapport.version_baci} (Gaulier et Zignago, 2010), Licence Ouverte Etalab 2.0. Extraction des flux de l'Algérie et agrégats par data-dz. Citer le CEPII.`,
  url_source: "https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=37",
  mots_cles: ["commerce extérieur", "exportations", "importations", "partenaires", "hydrocarbures", "hors hydrocarbures", "douanes", "BACI", "CEPII", "تجارة خارجية", "صادرات", "واردات"],
  frequence_maj: "annuelle",
  infos_source: {
    nb_indicateurs: 6,
    premiere_annee_observee: rapport.premiere_annee,
    derniere_annee_observee: rapport.derniere_annee,
    version_baci: rapport.version_baci,
    nb_partenaires: rapport.nb_partenaires,
    nb_produits: rapport.nb_produits,
    empreinte_sha256_source: rapport.source_sha256,
    methode: "Flux de l'Algérie extraits de BACI HS92 (CEPII), agrégés par année, section, partenaire et produit.",
  },
};

const rapportDonnee = (resultat: Record<string, unknown>) => ({
  fichier_source: { url: rapport.source_url, version: rapport.version_baci, sha256: rapport.source_sha256, octets: rapport.source_octets },
  periode: [rapport.premiere_annee, rapport.derniere_annee],
  derniere_annee: c,
  donnees: {
    [SLUG]: {
      fichiers: Object.fromEntries(FICHIERS.map((nom, i) => [nom, { total: [echanges, sections, partenaires, produits][i].length }])),
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
const cibles: Record<(typeof FICHIERS)[number], unknown> = {
  "echanges-annuels": echanges,
  "echanges-par-section": sections,
  partenaires,
  "produits-principaux": produits,
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
      principal: nom === "echanges-annuels" && format === "json",
    }))
  )
);
const version = await api.publierVersion(SLUG, { notes: `CEPII BACI HS92 version ${rapport.version_baci}, ${periode}.`, fichiers: envois });
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee({ creee, publiee: true, version: version.numero }));
