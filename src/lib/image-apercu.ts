import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { Antenna, Briefcase, Bus, Castle, ChartLine, HeartPulse, Landmark, Leaf, School, Shield, Sprout, Store, Tag, Trophy, type IconNode } from "lucide";
import * as moduleSatori from "satori";
import type { SatoriOptions } from "satori";
import sharp from "sharp";
import { lireConfig } from "../config.js";
import { ARABE, chiffresApercu, couper, formatsDe, HAUTEUR_APERCU, LARGEUR_APERCU, LIBELLES, texteDans, titreImage, type FicheApercu, type LangueApercu } from "./partage.js";

/**
 * Image d'aperçu 1200 × 630 d'une fiche. Modules natifs (resvg, sharp) et WebAssembly (satori) : ce fichier est
 * chargé à la demande par la route `preview.png` (`await import`), jamais au démarrage, pour qu'un échec de
 * chargement ne fasse tomber que l'image (repli sur l'image du site) et pas toute l'API.
 */

type Noeud = { type: string; props: Record<string, unknown> };
const h = (type: string, props: Record<string, unknown>, ...enfants: (Noeud | string | null | false)[]): Noeud => {
  const liste = enfants.filter((enfant): enfant is Noeud | string => Boolean(enfant));
  return { type, props: { ...props, children: liste.length <= 1 ? liste[0] : liste } };
};

/**
 * `satori` déclare son export par défaut de la même façon pour `import` et `require` : selon la compilation
 * (Vercel ne fait pas comme `tsc` en local), l'import par défaut donne la fonction ou le module entier.
 * On prend donc la fonction là où elle est, au typage comme à l'exécution.
 */
type Satori = (element: unknown, options: SatoriOptions) => Promise<string>;
const exportSatori = (moduleSatori as unknown as { default: Satori | { default: Satori } }).default;
const satori: Satori = typeof exportSatori === "function" ? exportSatori : exportSatori.default;

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

  const svg = await satori(arbre, {
    width: LARGEUR_APERCU,
    height: HAUTEUR_APERCU,
    fonts: [
      { name: "Inter", data: normale, weight: 400, style: "normal" },
      { name: "Inter", data: grasse, weight: 700, style: "normal" },
    ],
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: LARGEUR_APERCU } }).render().asPng();
}
