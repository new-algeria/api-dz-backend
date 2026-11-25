/**
 * Commerce extérieur de l'Algérie (biens) depuis BACI (CEPII) : exportations et importations par année, par section
 * du Système harmonisé, par partenaire et par produit.
 *
 * Source : base BACI du CEPII (flux bilatéraux réconciliés à partir de UN Comtrade), nomenclature HS92, depuis 1995,
 * licence Etalab 2.0. L'archive fait environ 2,4 Go : elle n'est téléchargée que si la version a changé
 * (`derniereVersion()`), puis lue fichier par fichier avec `unzip -p` en ne gardant que les flux de l'Algérie.
 *
 *   npx tsx scripts/commerce-exterieur/calculer.ts [--cache DOSSIER] [--sortie DOSSIER] [--archive FICHIER.zip]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Papa from "papaparse";

export const PAGE_BACI = "https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=37";
export const urlArchive = (version: string) => `https://www.cepii.fr/DATA_DOWNLOAD/baci/data/BACI_HS92_V${version}.zip`;
const AGENT = "data-dz-commerce-exterieur/1.0 (+https://github.com/new-algeria/api-dz-backend)";
const DOSSIER = import.meta.dirname;

/** Sections du Système harmonisé : chapitres couverts et intitulé français (abrégé de l'intitulé officiel). */
export const SECTIONS: { code: string; debut: number; fin: number; fr: string }[] = [
  { code: "I", debut: 1, fin: 5, fr: "Animaux vivants et produits animaux" },
  { code: "II", debut: 6, fin: 14, fr: "Produits végétaux" },
  { code: "III", debut: 15, fin: 15, fr: "Graisses et huiles" },
  { code: "IV", debut: 16, fin: 24, fr: "Produits alimentaires, boissons et tabacs" },
  { code: "V", debut: 25, fin: 27, fr: "Produits minéraux (dont hydrocarbures)" },
  { code: "VI", debut: 28, fin: 38, fr: "Produits chimiques" },
  { code: "VII", debut: 39, fin: 40, fr: "Plastiques et caoutchouc" },
  { code: "VIII", debut: 41, fin: 43, fr: "Peaux et cuirs" },
  { code: "IX", debut: 44, fin: 46, fr: "Bois et liège" },
  { code: "X", debut: 47, fin: 49, fr: "Papier et carton" },
  { code: "XI", debut: 50, fin: 63, fr: "Textiles et vêtements" },
  { code: "XII", debut: 64, fin: 67, fr: "Chaussures et coiffures" },
  { code: "XIII", debut: 68, fin: 70, fr: "Pierre, céramique et verre" },
  { code: "XIV", debut: 71, fin: 71, fr: "Perles, pierres et métaux précieux" },
  { code: "XV", debut: 72, fin: 83, fr: "Métaux communs (fer, acier, aluminium…)" },
  { code: "XVI", debut: 84, fin: 85, fr: "Machines et appareils électriques" },
  { code: "XVII", debut: 86, fin: 89, fr: "Matériel de transport" },
  { code: "XVIII", debut: 90, fin: 92, fr: "Instruments d'optique, médicaux et de mesure" },
  { code: "XIX", debut: 93, fin: 93, fr: "Armes et munitions" },
  { code: "XX", debut: 94, fin: 96, fr: "Meubles, jouets et articles divers" },
  { code: "XXI", debut: 97, fin: 99, fr: "Objets d'art et de collection" },
];

/** Section d'un code SH à 6 chiffres. */
export function sectionDe(codeSh: string): (typeof SECTIONS)[number] {
  const chapitre = Number(codeSh.padStart(6, "0").slice(0, 2));
  return SECTIONS.find((s) => chapitre >= s.debut && chapitre <= s.fin) ?? SECTIONS[SECTIONS.length - 1];
}
/** Hydrocarbures : chapitre 27 (combustibles minéraux, huiles minérales, gaz). */
export const estHydrocarbure = (codeSh: string) => codeSh.padStart(6, "0").startsWith("27");

/** Noms français des produits les plus échangés par l'Algérie (le fichier du CEPII est en anglais). */
export const PRODUITS_FR: Record<string, string> = {
  "270900": "Pétrole brut",
  "271121": "Gaz naturel (gazeux, par gazoduc)",
  "271111": "Gaz naturel liquéfié (GNL)",
  "271000": "Produits pétroliers raffinés",
  "271112": "Propane liquéfié",
  "271113": "Butanes liquéfiés",
  "271119": "Autres gaz de pétrole liquéfiés",
  "271390": "Résidus pétroliers",
  "271129": "Autres gaz de pétrole (à l'état gazeux)",
  "260112": "Minerais de fer agglomérés",
  "260111": "Minerais de fer non agglomérés",
  "310210": "Urée",
  "281410": "Ammoniac anhydre",
  "310230": "Nitrate d'ammonium",
  "252310": "Clinker",
  "252329": "Ciment Portland",
  "170199": "Sucre raffiné",
  "170111": "Sucre brut de canne",
  "080410": "Dattes",
  "100190": "Blé",
  "100110": "Blé dur",
  "100590": "Maïs",
  "100300": "Orge",
  "040221": "Lait en poudre",
  "040210": "Lait écrémé en poudre",
  "300490": "Médicaments",
  "120100": "Soja",
  "230400": "Tourteaux de soja",
  "150710": "Huile de soja brute",
  "090111": "Café vert",
  "870323": "Voitures (1 500 à 3 000 cm³)",
  "870322": "Voitures (1 000 à 1 500 cm³)",
  "870421": "Camionnettes diesel",
  "720851": "Tôles d'acier laminées",
  "721420": "Barres d'acier pour béton",
  "730630": "Tubes en acier",
  "760110": "Aluminium brut",
  "290511": "Méthanol",
  "280300": "Noir de carbone",
  "251010": "Phosphates naturels",
  "251020": "Phosphates naturels moulus",
  "071331": "Haricots secs",
  "071340": "Lentilles",
  "071320": "Pois chiches",
  "020230": "Viande bovine congelée",
  "851712": "Téléphones portables",
  "851770": "Pièces d'appareils de télécommunication",
  "847130": "Ordinateurs portables",
};

const nomsFr = new Intl.DisplayNames(["fr"], { type: "region" });
const nomsAr = new Intl.DisplayNames(["ar"], { type: "region" });
const nomPays = (affichage: Intl.DisplayNames, iso2: string | undefined, secours: string) => {
  if (!iso2 || !/^[A-Z]{2}$/.test(iso2)) return secours;
  try {
    return affichage.of(iso2) ?? secours;
  } catch {
    return secours;
  }
};

export interface Pays {
  code: string;
  nom_en: string;
  iso2: string;
  iso3: string;
}

/** Pays de BACI (`country_codes_V…csv` : country_code, country_name, country_iso2, country_iso3). */
export function lirePays(texte: string): Map<string, Pays> {
  const { data } = Papa.parse<Record<string, string>>(texte.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  const pays = new Map<string, Pays>();
  for (const ligne of data) {
    const code = String(Number(ligne.country_code));
    if (!ligne.country_code) continue;
    pays.set(code, { code, nom_en: ligne.country_name ?? "", iso2: (ligne.country_iso2 ?? "").trim(), iso3: (ligne.country_iso3 ?? "").trim() });
  }
  return pays;
}

/** Produits de BACI (`product_codes_HS92_V…csv` : code, description). */
export function lireProduits(texte: string): Map<string, string> {
  const { data } = Papa.parse<Record<string, string>>(texte.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  return new Map(data.filter((l) => l.code).map((l) => [l.code.trim().padStart(6, "0"), (l.description ?? "").trim()]));
}

/** Un flux de BACI qui concerne l'Algérie. */
export interface Flux {
  annee: number;
  exportateur: string;
  importateur: string;
  produit: string;
  /** Milliers de dollars courants. */
  valeur: number;
  /** Tonnes (peut manquer). */
  quantite: number | null;
}

/** Ligne CSV de BACI (t,i,j,k,v,q) → flux, ou null si elle ne concerne pas `code`. */
export function lireFlux(ligne: string, code: string): Flux | null {
  const champs = ligne.split(",");
  if (champs.length < 5) return null;
  const exportateur = String(Number(champs[1]));
  const importateur = String(Number(champs[2]));
  if (exportateur !== code && importateur !== code) return null;
  const valeur = Number(champs[4]);
  const quantite = Number(champs[5]);
  if (!Number.isFinite(valeur) || valeur < 0) throw new Error(`Valeur BACI invalide : ${ligne}`);
  return {
    annee: Number(champs[0]),
    exportateur,
    importateur,
    produit: champs[3].replace(/"/g, "").trim().padStart(6, "0"),
    valeur,
    quantite: champs[5] !== undefined && champs[5].trim() !== "" && Number.isFinite(quantite) ? quantite : null,
  };
}

export interface LigneEchange {
  annee: number;
  indicateur: string;
  valeur: number;
  unite: string;
}
export interface LigneSection {
  annee: number;
  flux: "exportations" | "importations";
  code_section: string;
  section: string;
  valeur_musd: number;
  part_pct: number;
}
export interface LignePartenaire {
  annee: number;
  flux: "exportations" | "importations";
  rang: number;
  code_iso3: string;
  pays: string;
  pays_ar: string;
  pays_en: string;
  valeur_musd: number;
  part_pct: number;
}
export interface LigneProduit {
  annee: number;
  flux: "exportations" | "importations";
  rang: number;
  code_sh6: string;
  produit: string;
  produit_en: string;
  section: string;
  valeur_musd: number;
  quantite_t: number | null;
  part_pct: number;
}

export interface Rapport {
  genere_le: string;
  version_baci: string;
  source_url: string;
  source_sha256: string | null;
  source_octets: number;
  premiere_annee: number;
  derniere_annee: number;
  nb_flux: number;
  nb_partenaires: number;
  nb_produits: number;
  derniere_annee_chiffres: {
    annee: number;
    exportations_mds: number;
    importations_mds: number;
    solde_mds: number;
    part_hydrocarbures_pct: number;
    exportations_hors_hydrocarbures_mds: number;
    premier_client: string;
    premier_fournisseur: string;
  };
}

const INDICATEURS = {
  exportations: "Exportations (total)",
  importations: "Importations (total)",
  solde: "Solde commercial",
  hydrocarbures: "Exportations d'hydrocarbures",
  horsHydrocarbures: "Exportations hors hydrocarbures",
  alimentaires: "Importations alimentaires",
} as const;
const UNITE = "milliards de dollars US courants";
const arrondi = (valeur: number, decimales: number) => Math.round(valeur * 10 ** decimales) / 10 ** decimales;
/** Sections I à IV : produits animaux, végétaux, huiles, produits alimentaires. */
const estAlimentaire = (codeSh: string) => ["I", "II", "III", "IV"].includes(sectionDe(codeSh).code);

/** Agrège les flux de l'Algérie (`code`) en séries annuelles, sections, partenaires et produits. */
export function calculer(flux: Flux[], code: string, pays: Map<string, Pays>, produits: Map<string, string>) {
  if (!flux.length) throw new Error("Aucun flux pour l'Algérie dans BACI.");
  type Cumul = Map<string, { valeur: number; quantite: number | null }>;
  const parAnnee = new Map<number, { exp: number; imp: number; hydro: number; alim: number; sections: Map<string, number>[]; partenaires: Map<string, number>[]; produits: Cumul[] }>();
  for (const f of flux) {
    const export_ = f.exportateur === code;
    if (f.exportateur === code && f.importateur === code) continue;
    const annee =
      parAnnee.get(f.annee) ??
      { exp: 0, imp: 0, hydro: 0, alim: 0, sections: [new Map(), new Map()], partenaires: [new Map(), new Map()], produits: [new Map(), new Map()] };
    const i = export_ ? 0 : 1;
    if (export_) {
      annee.exp += f.valeur;
      if (estHydrocarbure(f.produit)) annee.hydro += f.valeur;
    } else {
      annee.imp += f.valeur;
      if (estAlimentaire(f.produit)) annee.alim += f.valeur;
    }
    const section = sectionDe(f.produit).code;
    annee.sections[i].set(section, (annee.sections[i].get(section) ?? 0) + f.valeur);
    const partenaire = export_ ? f.importateur : f.exportateur;
    annee.partenaires[i].set(partenaire, (annee.partenaires[i].get(partenaire) ?? 0) + f.valeur);
    const produit = annee.produits[i].get(f.produit) ?? { valeur: 0, quantite: 0 };
    produit.valeur += f.valeur;
    produit.quantite = produit.quantite === null || f.quantite === null ? null : produit.quantite + f.quantite;
    annee.produits[i].set(f.produit, produit);
    parAnnee.set(f.annee, annee);
  }
  const annees = [...parAnnee.keys()].sort((a, b) => a - b);
  const mds = (milliers: number) => arrondi(milliers / 1e6, 3);
  const musd = (milliers: number) => arrondi(milliers / 1e3, 2);
  const libelleFlux = ["exportations", "importations"] as const;

  const echanges: LigneEchange[] = annees.flatMap((annee) => {
    const a = parAnnee.get(annee)!;
    return [
      { annee, indicateur: INDICATEURS.exportations, valeur: mds(a.exp), unite: UNITE },
      { annee, indicateur: INDICATEURS.importations, valeur: mds(a.imp), unite: UNITE },
      { annee, indicateur: INDICATEURS.solde, valeur: mds(a.exp - a.imp), unite: UNITE },
      { annee, indicateur: INDICATEURS.hydrocarbures, valeur: mds(a.hydro), unite: UNITE },
      { annee, indicateur: INDICATEURS.horsHydrocarbures, valeur: mds(a.exp - a.hydro), unite: UNITE },
      { annee, indicateur: INDICATEURS.alimentaires, valeur: mds(a.alim), unite: UNITE },
    ];
  });
  echanges.sort((x, y) => x.indicateur.localeCompare(y.indicateur, "fr") || x.annee - y.annee);

  const sections: LigneSection[] = annees.flatMap((annee) =>
    [0, 1].flatMap((i) => {
      const a = parAnnee.get(annee)!;
      const total = i === 0 ? a.exp : a.imp;
      return SECTIONS.filter((s) => a.sections[i].has(s.code)).map((s) => ({
        annee,
        flux: libelleFlux[i],
        code_section: s.code,
        section: s.fr,
        valeur_musd: musd(a.sections[i].get(s.code)!),
        part_pct: total ? arrondi((a.sections[i].get(s.code)! / total) * 100, 2) : 0,
      }));
    })
  );

  const ficheP = (codePays: string) => {
    const p = pays.get(codePays);
    const en = p?.nom_en || `Pays ${codePays}`;
    return { iso3: p?.iso3 || codePays, fr: nomPays(nomsFr, p?.iso2, en), ar: nomPays(nomsAr, p?.iso2, en), en };
  };
  const partenaires: LignePartenaire[] = annees.flatMap((annee) =>
    [0, 1].flatMap((i) => {
      const a = parAnnee.get(annee)!;
      const total = i === 0 ? a.exp : a.imp;
      return [...a.partenaires[i].entries()]
        .sort((x, y) => y[1] - x[1])
        .map(([codePays, valeur], index) => {
          const p = ficheP(codePays);
          return { annee, flux: libelleFlux[i], rang: index + 1, code_iso3: p.iso3, pays: p.fr, pays_ar: p.ar, pays_en: p.en, valeur_musd: musd(valeur), part_pct: total ? arrondi((valeur / total) * 100, 2) : 0 };
        });
    })
  );

  const principaux: LigneProduit[] = annees.flatMap((annee) =>
    [0, 1].flatMap((i) => {
      const a = parAnnee.get(annee)!;
      const total = i === 0 ? a.exp : a.imp;
      return [...a.produits[i].entries()]
        .sort((x, y) => y[1].valeur - x[1].valeur)
        .slice(0, 50)
        .map(([codeSh, { valeur, quantite }], index) => {
          const en = produits.get(codeSh) ?? codeSh;
          return {
            annee,
            flux: libelleFlux[i],
            rang: index + 1,
            code_sh6: codeSh,
            produit: PRODUITS_FR[codeSh] ?? en,
            produit_en: en,
            section: sectionDe(codeSh).fr,
            valeur_musd: musd(valeur),
            quantite_t: quantite === null ? null : Math.round(quantite),
            part_pct: total ? arrondi((valeur / total) * 100, 2) : 0,
          };
        });
    })
  );

  const derniere = annees.at(-1)!;
  const d = parAnnee.get(derniere)!;
  const premier = (i: number) => partenaires.find((l) => l.annee === derniere && l.flux === libelleFlux[i] && l.rang === 1)?.pays ?? "";
  return {
    echanges,
    sections,
    partenaires,
    produits: principaux,
    rapport: {
      premiere_annee: annees[0],
      derniere_annee: derniere,
      nb_flux: flux.length,
      nb_partenaires: new Set(partenaires.map((l) => l.code_iso3)).size,
      nb_produits: new Set(flux.map((f) => f.produit)).size,
      derniere_annee_chiffres: {
        annee: derniere,
        exportations_mds: mds(d.exp),
        importations_mds: mds(d.imp),
        solde_mds: mds(d.exp - d.imp),
        part_hydrocarbures_pct: d.exp ? arrondi((d.hydro / d.exp) * 100, 1) : 0,
        exportations_hors_hydrocarbures_mds: mds(d.exp - d.hydro),
        premier_client: premier(0),
        premier_fournisseur: premier(1),
      },
    },
  };
}

export type ResultatCalcul = ReturnType<typeof calculer>;

/** Contrôles avant publication : série depuis 1995, année récente, montants plausibles pour l'Algérie. */
export function verifier(resultat: ResultatCalcul, anneeCourante = new Date().getUTCFullYear()): void {
  const { rapport, echanges } = resultat;
  if (rapport.premiere_annee > 1995) throw new Error(`Série trop courte : début en ${rapport.premiere_annee}.`);
  if (rapport.derniere_annee < anneeCourante - 4) throw new Error(`Dernière année trop ancienne : ${rapport.derniere_annee}.`);
  for (const ligne of echanges) {
    if ((ligne.indicateur === INDICATEURS.exportations || ligne.indicateur === INDICATEURS.importations) && (ligne.valeur < 3 || ligne.valeur > 300)) {
      throw new Error(`${ligne.indicateur} invraisemblables en ${ligne.annee} : ${ligne.valeur} milliards de dollars.`);
    }
  }
}

/** Dernière version de BACI annoncée sur la page du CEPII (« BACI_HS92_V202601.zip » → « 202601 »). */
export function versionDepuisPage(html: string): string | null {
  const versions = [...html.matchAll(/BACI_HS92_V(\d{6})\.zip/g)].map((m) => m[1]).sort();
  return versions.at(-1) ?? null;
}

export async function derniereVersion(): Promise<string> {
  const reponse = await fetch(PAGE_BACI, { headers: { "user-agent": AGENT } });
  if (!reponse.ok) throw new Error(`CEPII : HTTP ${reponse.status} pour la page de BACI.`);
  const version = versionDepuisPage(await reponse.text());
  if (!version) throw new Error("Version de BACI introuvable sur la page du CEPII.");
  return version;
}

function sortieUnzip(arguments_: string[]) {
  const processus = spawn("unzip", arguments_, { stdio: ["ignore", "pipe", "inherit"] });
  const fin = new Promise<void>((resoudre, rejeter) => {
    processus.on("error", rejeter);
    processus.on("close", (codeSortie) => (codeSortie === 0 ? resoudre() : rejeter(new Error(`unzip ${arguments_.join(" ")} a échoué (code ${codeSortie}).`))));
  });
  return { flux: processus.stdout, fin };
}

async function texteUnzip(archive: string, fichier: string | null): Promise<string> {
  // Sans fichier : liste des entrées de l'archive (`unzip -Z1`).
  const { flux, fin } = sortieUnzip(fichier === null ? ["-Z1", archive] : ["-p", archive, fichier]);
  const morceaux: Buffer[] = [];
  for await (const morceau of flux) morceaux.push(morceau as Buffer);
  await fin;
  return Buffer.concat(morceaux).toString("utf8");
}

async function telecharger(version: string, cache: string): Promise<string> {
  const chemin = join(cache, `BACI_HS92_V${version}.zip`);
  try {
    if ((await stat(chemin)).size > 100_000_000) return chemin;
  } catch {
    // À télécharger.
  }
  await mkdir(cache, { recursive: true });
  const reponse = await fetch(urlArchive(version), { headers: { "user-agent": AGENT } });
  if (!reponse.ok || !reponse.body) throw new Error(`CEPII : HTTP ${reponse.status} pour l'archive ${version}.`);
  await pipeline(Readable.fromWeb(reponse.body as import("node:stream/web").ReadableStream), createWriteStream(`${chemin}.tmp`));
  await rename(`${chemin}.tmp`, chemin);
  return chemin;
}

async function empreinte(chemin: string): Promise<string> {
  const hachage = createHash("sha256");
  for await (const morceau of createReadStream(chemin)) hachage.update(morceau as Buffer);
  return hachage.digest("hex");
}

async function principal() {
  const option = (nom: string) => {
    const index = process.argv.indexOf(nom);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const cache = option("--cache") ?? join(DOSSIER, "cache");
  const sortie = option("--sortie") ?? join(DOSSIER, "sortie");
  const archiveLocale = option("--archive");
  const version = archiveLocale ? (/V(\d{6})/.exec(archiveLocale)?.[1] ?? "inconnue") : await derniereVersion();
  const archive = archiveLocale ?? (await telecharger(version, cache));

  const entrees = (await texteUnzip(archive, null)).split("\n").map((l) => l.trim()).filter(Boolean);
  const fichierPays = entrees.find((e) => /^country_codes_V\d+\.csv$/.test(e));
  const fichierProduits = entrees.find((e) => /^product_codes_HS92_V\d+\.csv$/.test(e));
  const fichiersAnnees = entrees.filter((e) => /^BACI_HS92_Y\d{4}_V\d+\.csv$/.test(e)).sort();
  if (!fichierPays || !fichierProduits || fichiersAnnees.length < 20) throw new Error("Archive BACI incomplète.");
  const pays = lirePays(await texteUnzip(archive, fichierPays));
  const produits = lireProduits(await texteUnzip(archive, fichierProduits));
  const algerie = [...pays.values()].find((p) => p.iso3 === "DZA");
  if (!algerie) throw new Error("Algérie (DZA) absente des codes pays de BACI.");

  const flux: Flux[] = [];
  for (const fichier of fichiersAnnees) {
    const { flux: sortieCsv, fin } = sortieUnzip(["-p", archive, fichier]);
    let entete = true;
    for await (const ligne of createInterface({ input: sortieCsv, crlfDelay: Infinity })) {
      if (entete) {
        entete = false;
        continue;
      }
      const f = lireFlux(ligne, algerie.code);
      if (f) flux.push(f);
    }
    await fin;
    console.log(`${fichier} : ${flux.length} flux de l'Algérie au total.`);
  }

  const resultat = calculer(flux, algerie.code, pays, produits);
  verifier(resultat);
  await mkdir(sortie, { recursive: true });
  const csv = (donnees: object[]) => Papa.unparse(donnees, { newline: "\n" }) + "\n";
  const fichiers: [string, object[]][] = [
    ["echanges-annuels", resultat.echanges],
    ["echanges-par-section", resultat.sections],
    ["partenaires", resultat.partenaires],
    ["produits-principaux", resultat.produits],
  ];
  await Promise.all(
    fichiers.flatMap(([nom, donnees]) => [
      writeFile(join(sortie, `${nom}.json`), JSON.stringify(donnees) + "\n", "utf8"),
      writeFile(join(sortie, `${nom}.csv`), csv(donnees), "utf8"),
    ])
  );
  const rapport: Rapport = {
    genere_le: new Date().toISOString(),
    version_baci: version,
    source_url: urlArchive(version),
    source_sha256: await empreinte(archive),
    source_octets: (await stat(archive)).size,
    ...resultat.rapport,
  };
  await writeFile(join(sortie, "rapport.json"), JSON.stringify(rapport, null, 2) + "\n", "utf8");
  const c = rapport.derniere_annee_chiffres;
  console.log(
    `BACI ${version} : ${rapport.nb_flux} flux, ${rapport.premiere_annee}–${rapport.derniere_annee}. ${c.annee} : exportations ${c.exportations_mds} Md$ ` +
      `(${c.part_hydrocarbures_pct} % d'hydrocarbures), importations ${c.importations_mds} Md$, solde ${c.solde_mds} Md$ ; ` +
      `1er client ${c.premier_client}, 1er fournisseur ${c.premier_fournisseur}.`
  );
}

if (process.argv[1]?.endsWith("/commerce-exterieur/calculer.ts") || process.argv[1]?.endsWith("\\commerce-exterieur\\calculer.ts")) {
  await principal();
}
