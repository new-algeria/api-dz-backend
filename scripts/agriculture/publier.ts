// Publication du dataset « Production agricole et élevage en Algérie » (FAOSTAT) sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// Une version n'est ajoutée que si les fichiers calculés ont changé.
//
//   npx tsx scripts/agriculture/publier.ts --verifier
//   npx tsx scripts/agriculture/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/agriculture/publier.ts --sortie DOSSIER
//   npx tsx scripts/agriculture/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";
import { SELECTION, type LigneSelection, type Rapport } from "./calculer.js";

const CODE = "agriculture-fao";
const SLUG = "production-agricole-algerie";
const FICHIERS = ["principales-productions", "production-detaillee", "classement-produits"] as const;

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
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration agriculture-fao à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul de la production agricole a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const lireJson = async <T>(nom: string) => JSON.parse(await readFile(join(sortie, `${nom}.json`), "utf8")) as T;
const selection = await lireJson<LigneSelection[]>("principales-productions");
const detail = await lireJson<object[]>("production-detaillee");
const classement = await lireJson<object[]>("classement-produits");
const rapport = await lireJson<Rapport>("rapport");
if (selection.length !== rapport.nb_lignes_selection || detail.length !== rapport.nb_lignes_detail || !classement.length) {
  throw new Error("Sorties vides ou incohérentes avec rapport.json.");
}
for (const ligne of selection) {
  if (!Number.isInteger(ligne.annee) || !ligne.indicateur || !ligne.unite || !Number.isFinite(ligne.valeur)) {
    throw new Error("Ligne de production invalide (année, indicateur, valeur ou unité).");
  }
}

const nombre = (n: number) => Math.round(n).toLocaleString("fr-FR");
const officielle = rapport.derniere_annee_officielle;
const valeurOfficielle = (code: string) => {
  const libelle = SELECTION.find((s) => s.code === code)!.fr;
  return selection.find((l) => l.indicateur === libelle && l.annee === officielle)?.valeur ?? null;
};
const dattes = valeurOfficielle("577");
const ble = valeurOfficielle("15");
const moutons = valeurOfficielle("976");
const periode = `${rapport.premiere_annee}–${rapport.derniere_annee}`;
const chiffres = `${rapport.nb_lignes_detail} valeurs, ${rapport.nb_produits} produits, ${periode}, dernière année officielle ${officielle}`;
const estimees = Object.entries(rapport.part_officielle_par_annee).filter(([, part]) => part < 50).map(([annee]) => annee);
const champs = {
  titre: {
    fr: "Production agricole et élevage en Algérie",
    en: "Agricultural production and livestock in Algeria",
    ar: "الإنتاج الزراعي وتربية المواشي في الجزائر",
  },
  description: {
    fr: `Production annuelle des cultures et de l'élevage en Algérie de ${rapport.premiere_annee} à ${rapport.derniere_annee} d'après FAOSTAT (CC BY 4.0) : céréales, légumes, fruits, dattes, olives, lait, viandes, cheptel, avec surfaces et rendements (${rapport.nb_produits} produits). En ${officielle}, dernière année déclarée officiellement : ${dattes !== null ? `${nombre(dattes)} t de dattes, ` : ""}${ble !== null ? `${nombre(ble)} t de blé, ` : ""}${moutons !== null ? `${nombre(moutons)} moutons` : ""}. Les années suivantes sont des estimations de la FAO.`,
    en: `Annual crop and livestock production in Algeria from ${rapport.premiere_annee} to ${rapport.derniere_annee}, from FAOSTAT (CC BY 4.0): cereals, vegetables, fruit, dates, olives, milk, meat, livestock, with areas and yields (${rapport.nb_produits} products). ${officielle} is the last officially reported year; later years are FAO estimates.`,
    ar: `الإنتاج السنوي للمحاصيل وتربية المواشي في الجزائر من ${rapport.premiere_annee} إلى ${rapport.derniere_annee} وفق FAOSTAT (CC BY 4.0): الحبوب والخضر والفواكه والتمور والزيتون والحليب واللحوم والمواشي، مع المساحات والمردود (${rapport.nb_produits} منتجًا). سنة ${officielle} هي آخر سنة مصرّح بها رسميًا، وما بعدها تقديرات من منظمة الأغذية والزراعة.`,
  },
  readme: [
    "## Production agricole et élevage en Algérie",
    "",
    `Statistiques FAOSTAT (domaine « Production : cultures et produits animaux ») pour l'Algérie, ${periode} : ${rapport.nb_lignes_detail} valeurs, ${rapport.nb_produits} produits.`,
    "",
    `**Dernière année déclarée officiellement : ${officielle}.** ${estimees.length ? `Années surtout estimées par la FAO : ${estimees.join(", ")}.` : ""}`,
    "",
    "### Fichiers",
    `- \`principales-productions\` (principal) : ${SELECTION.length} séries en format long (\`annee\`, \`indicateur\`, \`valeur\`, \`unite\`, \`code_statut\`) : céréales, blé, orge, légumes, pommes de terre, tomates, oignons, pastèques, fruits, dattes, olives, agrumes, raisins, pommes, lait, viandes, œufs, cheptel (moutons, chèvres, bovins, dromadaires, poulets).`,
    "- `production-detaillee` : toutes les valeurs de l'Algérie (production, surface récoltée, rendement, cheptel, abattages…), produit en anglais (nom FAOSTAT) et en français pour les séries principales, avec le statut de chaque valeur.",
    `- \`classement-produits\` : les 30 premières productions en tonnes en ${officielle} et en ${rapport.derniere_annee}.`,
    "",
    "### Statut des valeurs (`code_statut`, `statut`)",
    "- `A` officiel : chiffre transmis par l'Algérie.",
    "- `E` estimation FAO, `I` imputation FAO : calculés par la FAO quand le chiffre n'a pas été transmis.",
    "- `X` autre organisme international.",
    "",
    "Part officielle du tonnage récolté (productions élémentaires) :",
    "",
    "| Année | Part officielle |",
    "|---|---|",
    ...Object.entries(rapport.part_officielle_par_annee)
      .filter(([annee]) => Number(annee) > rapport.derniere_annee - 10)
      .map(([annee, part]) => `| ${annee} | ${part.toLocaleString("fr-FR")} % |`),
    "",
    `Ne jamais présenter une année estimée (${estimees.join(", ") || "aucune"}) comme un chiffre officiel.`,
    "",
    "### À savoir",
    "- Statistiques nationales : il n'y a pas de série FAOSTAT par wilaya.",
    "- Les totaux (céréales, légumes, fruits, lait, viandes) sont des agrégats calculés par la FAO : ne pas les additionner aux produits.",
    "- Les chiffres peuvent différer de ceux du ministère de l'Agriculture (définitions, campagne agricole ou année civile, révisions).",
    "",
    "### Méthode",
    "Le robot télécharge le fichier groupé « Africa » du domaine QCL de FAOSTAT, garde les lignes de l'Algérie, convertit le format large (une colonne par année) en format long, conserve le statut de chaque valeur et publie une version seulement si les valeurs ont changé.",
    "",
    "### Source et licence",
    "- FAO, FAOSTAT, *Crops and livestock products* : https://www.fao.org/faostat/en/#data/QCL",
    "- Licence CC BY 4.0 (conditions d'utilisation des bases statistiques de la FAO) : https://www.fao.org/contact-us/terms/db-terms-of-use/en",
    "",
    "Source : FAO, FAOSTAT. Licence CC BY 4.0. Extraction et mise en forme par data-dz.",
  ].join("\n"),
  categorie_slug: "agriculture",
  source_slug: "fao",
  licence_code: "CC-BY-4.0",
  licence_details: "FAO, FAOSTAT (Crops and livestock products), CC BY 4.0. Extraction de l'Algérie et mise en format long par data-dz. Attribution à la FAO requise.",
  url_source: "https://www.fao.org/faostat/en/#data/QCL",
  mots_cles: ["agriculture", "dattes", "blé", "céréales", "olives", "pommes de terre", "élevage", "moutons", "lait", "FAOSTAT", "زراعة", "تمور"],
  frequence_maj: "annuelle",
  infos_source: {
    nb_indicateurs: rapport.nb_indicateurs,
    premiere_annee_observee: rapport.premiere_annee,
    derniere_annee_observee: rapport.derniere_annee,
    derniere_annee_officielle: officielle,
    nb_produits: rapport.nb_produits,
    part_officielle_par_annee: rapport.part_officielle_par_annee,
    date_fichier_source: rapport.source_modifie_le,
    empreinte_sha256_source: rapport.source_sha256,
    methode: "Lignes de l'Algérie du fichier groupé Africa (domaine QCL) de FAOSTAT, format large converti en format long, statut de chaque valeur conservé.",
  },
};

const rapportDonnee = (resultat: Record<string, unknown>) => ({
  fichier_source: { url: rapport.source_url, modifie_le: rapport.source_modifie_le, sha256: rapport.source_sha256, octets: rapport.source_octets },
  periode: [rapport.premiere_annee, rapport.derniere_annee],
  derniere_annee_officielle: officielle,
  donnees: {
    [SLUG]: {
      fichiers: {
        "principales-productions": { total: selection.length },
        "production-detaillee": { total: detail.length },
        "classement-produits": { total: classement.length },
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
const cibles: Record<(typeof FICHIERS)[number], unknown> = { "principales-productions": selection, "production-detaillee": detail, "classement-produits": classement };
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
      principal: nom === "principales-productions" && format === "json",
    }))
  )
);
const version = await api.publierVersion(SLUG, {
  notes: `FAOSTAT QCL (fichier du ${rapport.source_modifie_le ?? rapport.source_sha256.slice(0, 12)}), ${periode}, dernière année officielle ${officielle}.`,
  fichiers: envois,
});
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee({ creee, publiee: true, version: version.numero }));
