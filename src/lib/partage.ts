import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { Antenna, Briefcase, Bus, Castle, ChartLine, HeartPulse, Landmark, Leaf, School, Shield, Sprout, Store, Tag, Trophy, type IconNode } from "lucide";
import satori from "satori";
import sharp from "sharp";
import { lireConfig } from "../config.js";
import { URL_SITE } from "./catalogue.js";

/**
 * Aperçu d'une donnée sur les réseaux sociaux (WhatsApp, Facebook, X, LinkedIn, Slack, Discord…).
 * Les robots de ces sites ne lancent pas le JavaScript du site : `vercel.json` (dépôt data-dz) leur envoie
 * `/v1/datasets/<slug>/share`, une page HTML avec les balises Open Graph, dont l'image `preview.png` (1200 × 630).
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

const ARABE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

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

const LIBELLES = {
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

// ---------------------------------------------------------------- Image

type Noeud = { type: string; props: Record<string, unknown> };
const h = (type: string, props: Record<string, unknown>, ...enfants: (Noeud | string | null | false)[]): Noeud => {
  const liste = enfants.filter((enfant): enfant is Noeud | string => Boolean(enfant));
  return { type, props: { ...props, children: liste.length <= 1 ? liste[0] : liste } };
};

const enDataUri = (type: string, octets: Uint8Array | Buffer) => `data:${type};base64,${Buffer.from(octets).toString("base64")}`;

let ressources: Promise<{ normale: Buffer; grasse: Buffer; logo: string }> | undefined;
function chargerRessources() {
  ressources ??= Promise.all([
    readFile(new URL("../../assets/inter-latin-400-normal.woff", import.meta.url)),
    readFile(new URL("../../assets/inter-latin-700-normal.woff", import.meta.url)),
    readFile(new URL("../../assets/logo-data-dz.png", import.meta.url)),
  ]).then(([normale, grasse, logo]) => ({ normale, grasse, logo: enDataUri("image/png", logo) }));
  ressources.catch(() => (ressources = undefined));
  return ressources;
}

// Icônes des catégories (`categories.icone`), mêmes correspondances que src/lib/apparence.ts du site.
const ICONES: Record<string, IconNode> = {
  landmark: Landmark,
  "heart-pulse": HeartPulse,
  bus: Bus,
  school: School,
  "chart-line": ChartLine,
  briefcase: Briefcase,
  antenna: Antenna,
  "building-store": Store,
  "building-arch": Castle,
  "ball-football": Trophy,
  shield: Shield,
  plant: Sprout,
  leaf: Leaf,
};

function svgIcone(icone: string | null | undefined, couleur: string): string {
  const [, attributs, enfants] = (ICONES[icone ?? ""] ?? Tag) as unknown as [string, Record<string, unknown>, [string, Record<string, unknown>][]];
  const attrs = (objet: Record<string, unknown>) => Object.entries(objet).map(([cle, valeur]) => `${cle}="${valeur}"`).join(" ");
  const corps = enfants.map(([balise, a]) => `<${balise} ${attrs(a)}/>`).join("");
  return enDataUri("image/svg+xml", Buffer.from(`<svg ${attrs({ ...attributs, stroke: couleur })}>${corps}</svg>`));
}

// Drapeau de l'Algérie (proportions officielles, comme DrapeauAlgerie.tsx du site).
const DRAPEAU = enDataUri(
  "image/svg+xml",
  Buffer.from(
    (() => {
      const etoile = Array.from({ length: 10 }, (_, i) => {
        const rayon = i % 2 === 0 ? 75 : 75 * 0.382;
        const angle = Math.PI + (i * Math.PI) / 5;
        return `${(490 + rayon * Math.cos(angle)).toFixed(1)},${(300 + rayon * Math.sin(angle)).toFixed(1)}`;
      }).join(" ");
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600"><rect width="450" height="600" fill="#006233"/><rect x="450" width="450" height="600" fill="#fff"/><mask id="m"><rect width="900" height="600" fill="#fff"/><circle cx="487.5" cy="300" r="120" fill="#000"/></mask><circle cx="450" cy="300" r="150" fill="#D21034" mask="url(#m)"/><polygon points="${etoile}" fill="#D21034"/></svg>`;
    })()
  )
);

// Images par défaut du pack (web-assets/webp/), mêmes correspondances que src/lib/illustrations.ts du site.
const IMAGES_PACK: Record<string, string> = {
  agriculture: "03-agriculture",
  aviation: "06-aeroport-transports",
  banques: "11-banques-finance",
  buses: "17-transport-routier",
  cliniques: "04-sante",
  culture: "08-patrimoine-culturel",
  "divisions-administratives": "09-carte-algerie-donnees",
  djezzy: "12-boutiques-telecom",
  ecoles: "05-education",
  emploi: "10-agences-emploi",
  "enseignement-superieur": "27-enseignement-superieur",
  ferroviaire: "19-gares-ferroviaires",
  "formation-professionnelle": "14-formation-professionnelle",
  "gares-routieres": "20-gares-routieres-bus",
  "industrie-pharmaceutique": "21-industrie-pharmaceutique",
  jeunesse: "15-sport-jeunesse",
  livraison: "23-points-relais-livraison",
  mobilis: "12-boutiques-telecom",
  mosquees: "24-mosquees",
  ooredoo: "12-boutiques-telecom",
  pharmacies: "22-pharmacies",
  poste: "13-poste-gab",
  "protection-civile": "26-protection-civile",
  sante: "04-sante",
  sports: "15-sport-jeunesse",
  telecom: "02-antennes-telecom",
  tourisme: "18-tourisme-nature",
};

/** Illustration de la donnée (choisie par un admin, sinon celle du pack), seulement sur le domaine public des fichiers. */
export function urlIllustrationApercu(fiche: FicheApercu): string | null {
  const base = lireConfig().R2_PUBLIC_URL.replace(/\/+$/, "");
  if (fiche.illustration_url) return fiche.illustration_url.startsWith(`${base}/`) ? fiche.illustration_url : null;
  const nom = IMAGES_PACK[fiche.slug];
  return nom ? `${base}/web-assets/webp/${nom}-600.webp` : null;
}

/** Illustration téléchargée puis convertie en PNG carré (le rendu ne lit pas le WebP). `null` si indisponible. */
async function illustrationPng(fiche: FicheApercu): Promise<string | null> {
  const url = urlIllustrationApercu(fiche);
  if (!url) return null;
  try {
    const reponse = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!reponse.ok) return null;
    const png = await sharp(Buffer.from(await reponse.arrayBuffer())).resize(380, 380, { fit: "cover" }).png().toBuffer();
    return enDataUri("image/png", png);
  } catch {
    return null;
  }
}

const VERT = "#34d399";

/** Image 1200 × 630 : logo, drapeau, catégorie, titre, source, chiffres, illustration et adresse de la fiche. */
export async function imageApercu(fiche: FicheApercu, langue: LangueApercu): Promise<Uint8Array> {
  const langueImage = langue === "fr" ? "fr" : "en";
  const [{ normale, grasse, logo }, illustration] = await Promise.all([chargerRessources(), illustrationPng(fiche)]);
  const titre = couper(titreImage(fiche, langueImage), 110);
  // Plus le titre est long, plus il est petit ; au-delà de 3 lignes il est coupé (« … »).
  const tailleTitre = titre.length > 70 ? 44 : titre.length > 45 ? 54 : titre.length > 28 ? 62 : 70;
  const categorie = fiche.categories ? texteDans(fiche.categories.nom, langueImage) : "";
  const chiffres = chiffresApercu(fiche, langueImage);
  const formats = formatsDe(fiche);
  const source = fiche.sources?.nom && !ARABE.test(fiche.sources.nom) ? couper(fiche.sources.nom, 60) : null;

  const arbre = h(
    "div",
    {
      style: {
        display: "flex",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundImage: "linear-gradient(135deg, #03140d 0%, #06301f 55%, #0a4a30 100%)",
        color: "#ffffff",
        fontFamily: "Inter",
      },
    },
    h(
      "div",
      { style: { display: "flex", flex: 1, padding: "56px 64px 40px 72px" } },
      // Colonne gauche
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", flex: 1, paddingRight: illustration ? 40 : 0 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center" } },
          h("img", { src: logo, width: 58, height: 59 }),
          h("div", { style: { display: "flex", fontSize: 38, fontWeight: 700, marginLeft: 16 } }, h("span", {}, "data-"), h("span", { style: { color: VERT } }, "dz")),
          h("img", { src: DRAPEAU, width: 54, height: 36, style: { marginLeft: 20, borderRadius: 5 } })
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" } },
          categorie || formats.length > 0
            ? h(
                "div",
                { style: { display: "flex", alignItems: "center", marginBottom: 22 } },
                categorie
                  ? h(
                      "div",
                      {
                        style: {
                          display: "flex",
                          alignItems: "center",
                          padding: "8px 18px 8px 14px",
                          borderRadius: 999,
                          backgroundColor: "rgba(52, 211, 153, 0.15)",
                          border: "1px solid rgba(52, 211, 153, 0.35)",
                          color: "#a7f3d0",
                          fontSize: 24,
                          marginRight: 14,
                        },
                      },
                      h("img", { src: svgIcone(fiche.categories?.icone, "#6ee7b7"), width: 26, height: 26, style: { marginRight: 10 } }),
                      couper(categorie, 30)
                    )
                  : null,
                formats.length > 0
                  ? h(
                      "div",
                      { style: { display: "flex", fontSize: 21, color: "#d1fae5", padding: "9px 16px", borderRadius: 999, backgroundColor: "rgba(255,255,255,0.08)" } },
                      formats.join(" · ")
                    )
                  : null
              )
            : null,
          h("div", { style: { display: "block", lineClamp: 3, fontSize: tailleTitre, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1 } }, titre),
          source ? h("div", { style: { display: "flex", marginTop: 18, fontSize: 26, color: "#a7f3d0" } }, `${LIBELLES[langueImage].source}${source}`) : null
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "flex-end" } },
          ...chiffres.map(({ valeur, libelle }) =>
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", marginRight: 48 } },
              h("div", { style: { display: "flex", fontSize: 44, fontWeight: 700 } }, valeur),
              h("div", { style: { display: "flex", fontSize: 22, color: "#94a3b8", marginTop: 2 } }, libelle)
            )
          )
        )
      ),
      // Colonne droite : illustration de la donnée, sinon le logo en grand
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "center", width: illustration ? 380 : 300 } },
        illustration
          ? h("img", { src: illustration, width: 380, height: 380, style: { borderRadius: 36, border: "2px solid rgba(52, 211, 153, 0.35)" } })
          : h("img", { src: logo, width: 260, height: 264, style: { opacity: 0.9 } })
      )
    ),
    h(
      "div",
      { style: { display: "flex", justifyContent: "space-between", padding: "0 64px 26px 72px", fontSize: 22, color: "#6ee7b7" } },
      h("div", { style: { display: "flex" } }, `data-dz.com/datasets/${couper(fiche.slug, 60)}`),
      h("div", { style: { display: "flex", color: "#94a3b8" } }, LIBELLES[langueImage].donnees)
    ),
    // Bande aux couleurs du drapeau
    h(
      "div",
      { style: { display: "flex", height: 10 } },
      h("div", { style: { display: "flex", flex: 1, backgroundColor: "#006233" } }),
      h("div", { style: { display: "flex", flex: 1, backgroundColor: "#ffffff" } }),
      h("div", { style: { display: "flex", width: 300, backgroundColor: "#D21034" } })
    )
  );

  const svg = await satori(arbre as never, {
    width: LARGEUR_APERCU,
    height: HAUTEUR_APERCU,
    fonts: [
      { name: "Inter", data: normale, weight: 400, style: "normal" },
      { name: "Inter", data: grasse, weight: 700, style: "normal" },
    ],
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: LARGEUR_APERCU } }).render().asPng();
}
