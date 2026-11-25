// Publication du dataset « Pétrole et gaz naturel en Algérie » (EIA) sur data-dz.
// La nouvelle donnée est créée en brouillon ; une donnée existante conserve son statut.
// Une version n'est ajoutée que si les fichiers calculés ont changé.
//
//   npx tsx scripts/petrole-gaz/publier.ts --verifier
//   npx tsx scripts/petrole-gaz/publier.ts --essai --sortie DOSSIER
//   npx tsx scripts/petrole-gaz/publier.ts --sortie DOSSIER
//   npx tsx scripts/petrole-gaz/publier.ts --echec "message"

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";
import type { LigneBilan, LigneSerie, Rapport } from "./calculer.js";

const CODE = "petrole-gaz";
const SLUG = "petrole-gaz-algerie";
const FICHIER_SERIES = "series-annuelles";
const FICHIER_BILAN = "bilan-annuel";

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
    series_mises_a_jour_le: rapport.series_mises_a_jour_le,
    sha256: rapport.source_sha256,
    octets: rapport.source_octets,
  },
  periode: [rapport.premiere_annee, rapport.derniere_annee],
  derniere_annee: rapport.derniere_annee_chiffres,
  donnees: {
    [SLUG]: {
      fichiers: { [FICHIER_SERIES]: { total: rapport.nb_lignes }, [FICHIER_BILAN]: { total: rapport.nb_annees } },
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
      raison = `synchronisation inconnue de l'API (${erreur.statut}) : migration petrole-gaz à appliquer`;
    }
  } else if (forcer) raison = "forcée";
  console.log(`${aFaire ? "À faire" : "Rien à faire"} : ${raison}.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `a_faire=${aFaire}\n`);
  process.exit(0);
}

if (arguments_.includes("--echec")) {
  await rapporter("echec", valeurDe("--echec") || "Le calcul du pétrole et du gaz a échoué (voir les journaux de la GitHub Action).");
  process.exit(0);
}

const series = JSON.parse(await readFile(join(sortie, `${FICHIER_SERIES}.json`), "utf8")) as LigneSerie[];
const bilan = JSON.parse(await readFile(join(sortie, `${FICHIER_BILAN}.json`), "utf8")) as LigneBilan[];
const rapport = JSON.parse(await readFile(join(sortie, "rapport.json"), "utf8")) as Rapport;
if (!series.length || series.length !== rapport.nb_lignes || bilan.length !== rapport.nb_annees || rapport.nb_annees < 40) {
  throw new Error("Sorties vides ou incohérentes avec rapport.json.");
}
for (const ligne of series) {
  if (!Number.isInteger(ligne.annee) || !ligne.indicateur || !ligne.unite || !Number.isFinite(ligne.valeur)) {
    throw new Error("Ligne de série invalide (année, indicateur, valeur ou unité).");
  }
}

const { annee, petrole_brut_production_kbj: brut, gaz_production_gm3: gaz, part_gaz_exportee_pct: part } = rapport.derniere_annee_chiffres;
const periode = `${rapport.premiere_annee}–${rapport.derniere_annee}`;
const chiffres = `${rapport.nb_lignes} valeurs, ${rapport.nb_indicateurs} indicateurs, ${periode}`;
const champs = {
  titre: {
    fr: "Pétrole et gaz naturel en Algérie",
    en: "Oil and natural gas in Algeria",
    ar: "النفط والغاز الطبيعي في الجزائر",
  },
  description: {
    fr: `Production, consommation et exportations de pétrole et de gaz naturel de l'Algérie, chaque année de ${periode}, d'après les statistiques internationales de l'EIA (domaine public). En ${annee} : ${brut} milliers de barils de brut par jour et ${gaz} milliards de m³ de gaz, dont ${part} % exportés. Données nationales, sans ventilation par wilaya.`,
    en: `Algeria's oil and natural gas production, consumption and exports, every year from ${periode}, from the EIA international energy statistics (public domain). In ${annee}: ${brut} thousand barrels of crude per day and ${gaz} billion m³ of gas, ${part}% of it exported. National data, not broken down by wilaya.`,
    ar: `إنتاج النفط والغاز الطبيعي في الجزائر واستهلاكهما وصادراتهما سنويًا من ${rapport.premiere_annee} إلى ${rapport.derniere_annee}، وفق الإحصاءات الدولية لإدارة معلومات الطاقة الأمريكية (EIA، ملك عام). في ${annee}: ${brut} ألف برميل من النفط الخام يوميًا و${gaz} مليار متر مكعب من الغاز، صُدّر منها ${part}٪. بيانات وطنية دون توزيع حسب الولايات.`,
  },
  readme: [
    "## Pétrole et gaz naturel en Algérie",
    "",
    `${rapport.nb_indicateurs} séries annuelles de l'EIA (U.S. Energy Information Administration) pour l'Algérie, ${periode} : ${rapport.nb_lignes} valeurs.`,
    "",
    `En ${annee} : ${brut} milliers de barils de pétrole brut par jour, ${gaz} milliards de m³ de gaz naturel produits, dont ${part} % exportés.`,
    "",
    "### Fichiers",
    "- `series-annuelles` (principal, JSON et CSV) : format long (`annee`, `indicateur`, `valeur`, `unite`, `code_serie_eia`), une ligne par année et par indicateur.",
    "- `bilan-annuel` (JSON et CSV) : une ligne par année, une colonne par indicateur, plus `part_gaz_exportee_pct` (exportations ÷ production de gaz, calculée par data-dz).",
    "",
    "### Indicateurs",
    "- Pétrole brut (condensats compris selon l'EIA) : production et exportations, en milliers de barils par jour.",
    "- Pétrole et autres liquides : production (brut, condensats, liquides de gaz naturel, autres liquides) et consommation, en milliers de barils par jour.",
    "- Liquides de gaz naturel (LGN) : production, en milliers de barils par jour.",
    "- Gaz naturel sec : production, consommation et exportations, en milliards de m³.",
    "",
    "### À savoir",
    "- La répartition entre brut, condensats et LGN change selon les périodes dans les séries de l'EIA (par exemple, de 1992 à 2002, les condensats sont comptés avec les LGN et le brut paraît plus bas). Pour comparer dans le temps, utiliser « Pétrole et autres liquides : production ».",
    `- Les exportations de brut s'arrêtent en ${rapport.periodes.petrole_brut_exportations_kbj[1]} et celles de gaz commencent en ${rapport.periodes.gaz_exportations_gm3[0]} : l'EIA ne publie pas d'autre année pour l'Algérie. Une valeur absente reste vide, jamais remplacée par zéro.`,
    "- La dernière année peut être une estimation provisoire de l'EIA, révisée ensuite : la synchronisation reprend chaque mois les valeurs publiées.",
    "- Ce sont des statistiques nationales : ni production par gisement ou par wilaya, ni recettes, ni prix.",
    "",
    "### Méthode",
    "Le robot télécharge le fichier groupé « International » de l'EIA (INTL.zip), garde les séries annuelles de l'Algérie listées ci-dessus, vérifie que chaque valeur reste dans une plage plausible, arrondit (0,1 millier de barils, 0,01 milliard de m³) et publie une version seulement si les valeurs ont changé.",
    "",
    "### Source et licence",
    "- U.S. Energy Information Administration, *International Energy Statistics* : https://www.eia.gov/international/data/country/DZA",
    "- Les données de l'EIA sont du domaine public (travaux du gouvernement fédéral des États-Unis) ; l'EIA demande d'être citée comme source.",
    "",
    "Données : U.S. Energy Information Administration (EIA), International Energy Statistics.",
  ].join("\n"),
  categorie_slug: "energie",
  source_slug: "eia",
  licence_code: "PDM-1.0",
  licence_details: "Données de l'U.S. Energy Information Administration, domaine public (travaux du gouvernement fédéral des États-Unis). Citation de l'EIA demandée. Extraction des séries de l'Algérie et part exportée du gaz calculée par data-dz.",
  url_source: "https://www.eia.gov/international/data/country/DZA",
  mots_cles: ["pétrole", "gaz naturel", "hydrocarbures", "production", "exportations", "consommation", "barils", "Sonatrach", "énergie", "EIA", "نفط", "غاز"],
  frequence_maj: "mensuelle",
  infos_source: {
    nb_indicateurs: rapport.nb_indicateurs,
    premiere_annee_observee: rapport.premiere_annee,
    derniere_annee_observee: rapport.derniere_annee,
    nb_observations: rapport.nb_lignes,
    periodes: rapport.periodes,
    series_mises_a_jour_le: rapport.series_mises_a_jour_le,
    date_fichier_source: rapport.source_modifie_le,
    empreinte_sha256_source: rapport.source_sha256,
    methode: "Séries annuelles de l'Algérie (DZA) extraites du fichier groupé International de l'EIA, valeurs absentes laissées vides.",
  },
};

if (essai || !cle) {
  console.log(`Essai : aucune publication. ${chiffres}.`);
  console.log(JSON.stringify(champs.infos_source));
  await rapporter("essai", `Essai : ${chiffres}.`, rapportDonnee(rapport, { creee: false, publiee: false }));
  process.exit(0);
}

const { creee } = await api.enregistrerDonnee(SLUG, { ...champs, statut: "brouillon" });
console.log(creee ? "Donnée créée en brouillon." : "Donnée existante mise à jour (statut inchangé).");
const [actuelSeries, actuelBilan] = creee
  ? [null, null]
  : await Promise.all([api.lireFichier(SLUG, FICHIER_SERIES, "json"), api.lireFichier(SLUG, FICHIER_BILAN, "json")]);
const identique = (contenu: string | null, cible: unknown) => contenu !== null && JSON.stringify(JSON.parse(contenu)) === JSON.stringify(cible);
if (identique(actuelSeries, series) && identique(actuelBilan, bilan)) {
  await rapporter("reussie", `Inchangée : ${chiffres}.`, rapportDonnee(rapport, { creee, publiee: false }));
  process.exit(0);
}

const lire = (nom: string, format: "json" | "csv") => readFile(join(sortie, `${nom}.${format}`), "utf8");
const [seriesJson, seriesCsv, bilanJson, bilanCsv] = await Promise.all([
  lire(FICHIER_SERIES, "json"),
  lire(FICHIER_SERIES, "csv"),
  lire(FICHIER_BILAN, "json"),
  lire(FICHIER_BILAN, "csv"),
]);
const [cleSeriesJson, cleSeriesCsv, cleBilanJson, cleBilanCsv] = await Promise.all([
  api.envoyerFichier(SLUG, FICHIER_SERIES, seriesJson, "json"),
  api.envoyerFichier(SLUG, FICHIER_SERIES, seriesCsv, "csv"),
  api.envoyerFichier(SLUG, FICHIER_BILAN, bilanJson, "json"),
  api.envoyerFichier(SLUG, FICHIER_BILAN, bilanCsv, "csv"),
]);
const version = await api.publierVersion(SLUG, {
  notes: `EIA International Energy Statistics, ${periode}, séries de l'Algérie ; mise à jour EIA ${rapport.series_mises_a_jour_le ?? rapport.source_sha256.slice(0, 12)}.`,
  fichiers: [
    { cle: cleSeriesJson, nom: FICHIER_SERIES, format: "json", principal: true },
    { cle: cleSeriesCsv, nom: FICHIER_SERIES, format: "csv", principal: false },
    { cle: cleBilanJson, nom: FICHIER_BILAN, format: "json", principal: false },
    { cle: cleBilanCsv, nom: FICHIER_BILAN, format: "csv", principal: false },
  ],
});
console.log(`Version ${version.numero} publiée (${version.nb_lignes} lignes principales).`);
await rapporter("reussie", `Version ${version.numero} publiée : ${chiffres}.`, rapportDonnee(rapport, { creee, publiee: true, version: version.numero }));
