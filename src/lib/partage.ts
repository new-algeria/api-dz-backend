import { lireConfig } from "../config.js";
import { URL_SITE } from "./catalogue.js";

/**
 * Aperçu d'une donnée sur les réseaux sociaux (WhatsApp, Facebook, X, LinkedIn, Slack, Discord…).
 * Les robots de ces sites ne lancent pas le JavaScript du site : `vercel.json` (dépôt data-dz) leur envoie
 * `/v1/datasets/<slug>/share`, une page HTML avec les balises Open Graph, dont l'image `preview.png` (1200 × 630).
 * L'image est dessinée par `image-apercu.ts`, chargé à la demande : ses modules natifs ne touchent jamais au reste de l'API.
 */

export type LangueApercu = "fr" | "en" | "ar";
export const LARGEUR_APERCU = 1200;
export const HAUTEUR_APERCU = 630;

/** Ce que l'aperçu utilise d'une fiche (lignes de `chargerFicheInterne`). */
export interface FicheApercu {
  slug: string;
  titre: Record<string, string> | null;
  description: Record<string, string> | null;
  wilayas?: string[] | null;
  licence_code?: string | null;
  illustration_url?: string | null;
  mis_a_jour_le?: string | null;
  categories?: { slug: string; nom: Record<string, string> | null; icone: string | null } | null;
  sources?: { nom: string } | null;
  versions?: { nb_lignes: number | null; fichiers?: { format: string; nom: string | null }[] | null } | null;
}

// ---------------------------------------------------------------- Textes (fonctions pures, testées)

export const ARABE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Texte dans la langue voulue, sinon anglais, français, arabe. */
export function texteDans(valeur: Record<string, string> | null | undefined, langue: LangueApercu): string {
  if (!valeur) return "";
  for (const code of [langue, "en", "fr", "ar"]) {
    const texte = valeur[code]?.trim();
    if (texte) return texte;
  }
  return "";
}

/** `pharmacies-de-garde` → « Pharmacies de garde » (dernier recours pour le titre de l'image). */
const titreDepuisSlug = (slug: string) => slug.replace(/-/g, " ").replace(/^./, (lettre) => lettre.toUpperCase());

/**
 * Titre dessiné sur l'image : la police n'a que l'alphabet latin et le rendu ne gère pas l'écriture de droite
 * à gauche, donc un titre en arabe est remplacé par le titre anglais ou français, sinon par l'identifiant.
 */
export function titreImage(fiche: FicheApercu, langue: LangueApercu): string {
  const candidats = [texteDans(fiche.titre, langue === "ar" ? "en" : langue), fiche.titre?.en, fiche.titre?.fr];
  return candidats.find((texte) => texte && !ARABE.test(texte))?.trim() ?? titreDepuisSlug(fiche.slug);
}

export const couper = (texte: string, max: number) => (texte.length <= max ? texte : `${texte.slice(0, max - 1).trimEnd()}…`);

export const LIBELLES = {
  fr: { lignes: "lignes", fichiers: "fichiers", fichier: "fichier", wilayas: "wilayas", wilaya: "wilaya", source: "Source : ", donnees: "Données ouvertes sur l'Algérie" },
  en: { lignes: "rows", fichiers: "files", fichier: "file", wilayas: "wilayas", wilaya: "wilaya", source: "Source: ", donnees: "Open data on Algeria" },
  ar: { lignes: "سطر", fichiers: "ملفات", fichier: "ملف", wilayas: "ولايات", wilaya: "ولاية", source: "المصدر: ", donnees: "بيانات مفتوحة عن الجزائر" },
} as const;

const nombre = (valeur: number, langue: LangueApercu) =>
  new Intl.NumberFormat(langue === "en" ? "en-US" : "fr-FR").format(valeur).replace(/[  ]/g, " ");

/** Formats distincts des fichiers, dans un ordre stable (`GeoJSON · CSV · JSON`). */
export function formatsDe(fiche: FicheApercu): string[] {
  const ordre = ["geojson", "csv", "json"];
  const formats = [...new Set((fiche.versions?.fichiers ?? []).map((fichier) => fichier.format.toLowerCase()))];
  return formats
    .sort((a, b) => (ordre.indexOf(a) + 1 || 99) - (ordre.indexOf(b) + 1 || 99))
    .map((format) => (format === "geojson" ? "GeoJSON" : format.toUpperCase()));
}

/** Chiffres de l'aperçu (lignes, fichiers, wilayas), seulement ceux qui existent. L'image n'affiche que fr ou en. */
export function chiffresApercu(fiche: FicheApercu, langue: LangueApercu): { valeur: string; libelle: string }[] {
  const l = LIBELLES[langue];
  const chiffres: { valeur: string; libelle: string }[] = [];
  const lignes = fiche.versions?.nb_lignes;
  if (lignes) chiffres.push({ valeur: nombre(lignes, langue), libelle: l.lignes });
  const noms = new Set((fiche.versions?.fichiers ?? []).map((fichier) => fichier.nom ?? fichier.format));
  if (noms.size > 0) chiffres.push({ valeur: String(noms.size), libelle: noms.size > 1 ? l.fichiers : l.fichier });
  const wilayas = fiche.wilayas?.length ?? 0;
  if (wilayas > 0) chiffres.push({ valeur: String(wilayas), libelle: wilayas > 1 ? l.wilayas : l.wilaya });
  return chiffres;
}

/** Description des balises (160 caractères) : celle de la donnée, sinon une phrase tirée de ses chiffres. */
export function descriptionApercu(fiche: FicheApercu, langue: LangueApercu): string {
  const description = texteDans(fiche.description, langue);
  if (description) return couper(description.replace(/\s+/g, " "), 160);
  const morceaux = chiffresApercu(fiche, langue).map(({ valeur, libelle }) => `${valeur} ${libelle}`);
  if (fiche.sources?.nom) morceaux.push(`${LIBELLES[langue].source}${fiche.sources.nom}`);
  return [...morceaux, LIBELLES[langue].donnees].join(" · ");
}

/** Langue demandée (`?lng=fr`, `fr-FR`…), anglais par défaut. */
export const langueApercu = (valeur: string | undefined): LangueApercu => {
  const code = valeur?.slice(0, 2).toLowerCase();
  return code === "fr" || code === "ar" ? code : "en";
};

const echapper = (texte: string) =>
  texte.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LOCALES: Record<LangueApercu, string> = { fr: "fr_FR", en: "en_US", ar: "ar_DZ" };

/** Page lue par les robots des réseaux sociaux : balises Open Graph / Twitter, puis renvoi vers la fiche. */
export function pagePartage(fiche: FicheApercu, langue: LangueApercu): string {
  const titre = texteDans(fiche.titre, langue) || titreImage(fiche, langue);
  const description = descriptionApercu(fiche, langue);
  const urlFiche = `${URL_SITE}/datasets/${fiche.slug}${langue === "fr" ? "" : `?lng=${langue}`}`;
  const version = encodeURIComponent(fiche.mis_a_jour_le ?? "");
  const urlImage = `${lireConfig().URL_API}/v1/datasets/${fiche.slug}/preview.png?lng=${langue}&v=${version}`;
  const balises: [string, string, string][] = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", "data-dz"],
    ["property", "og:title", titre],
    ["property", "og:description", description],
    ["property", "og:url", urlFiche],
    ["property", "og:locale", LOCALES[langue]],
    ["property", "og:image", urlImage],
    ["property", "og:image:type", "image/png"],
    ["property", "og:image:width", String(LARGEUR_APERCU)],
    ["property", "og:image:height", String(HAUTEUR_APERCU)],
    ["property", "og:image:alt", `${titre} · data-dz`],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", titre],
    ["name", "twitter:description", description],
    ["name", "twitter:image", urlImage],
    ["name", "description", description],
  ];
  return `<!doctype html>
<html lang="${langue}"${langue === "ar" ? ' dir="rtl"' : ""}>
<head>
<meta charset="utf-8">
<title>${echapper(titre)} · data-dz</title>
<link rel="canonical" href="${echapper(urlFiche)}">
${balises.map(([attribut, nom, valeur]) => `<meta ${attribut}="${nom}" content="${echapper(valeur)}">`).join("\n")}
<meta http-equiv="refresh" content="0; url=${echapper(urlFiche)}">
</head>
<body><p><a href="${echapper(urlFiche)}">${echapper(titre)}</a> · data-dz</p></body>
</html>
`;
}

/**
 * Donnée introuvable : page avec l'aperçu général du site (pas de renvoi vers la fiche, que `vercel.json`
 * renverrait ici pour un robot : ce serait une boucle).
 */
export function pageIntrouvable(): string {
  const titre = "data-dz · Open data on Algeria";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${titre}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="data-dz">
<meta property="og:title" content="${titre}">
<meta property="og:url" content="${URL_SITE}">
<meta property="og:image" content="${URL_SITE}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
</head>
<body><p><a href="${URL_SITE}">data-dz</a></p></body>
</html>
`;
}
