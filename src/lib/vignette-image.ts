import { createHash } from "node:crypto";
import sharp from "sharp";
import { chargerFicheInterne, estRestreinte, nomFichier, type FichierInterne } from "./catalogue.js";
import { lireTable, type FormatSource, type Table } from "./conversion.js";
import { ErreurApi, introuvable } from "./erreurs.js";
import { ecrireObjet, lireObjet } from "./r2.js";
import { estCarte, planVignette, svgVignette, type PlanVignette } from "./vignette.js";
import { indexerContours, type ContourWilaya } from "./wilayas.js";

/**
 * Vignette WebP d'une donnée (survol des cartes du catalogue), rangée dans R2 une fois par version des fichiers :
 * `exports/vignettes/<VERSION>/<slug>/<empreinte>.webp`, ou un marqueur `.vide` quand il n'y a rien à dessiner.
 * Chargé à la demande par la route (`await import`) : sharp est un module natif.
 */

/** Version du dessin : la changer force le recalcul de toutes les vignettes. */
const VERSION = "v2";
/** Au-delà, le fichier n'est pas lu (mémoire et durée de la fonction). */
export const TAILLE_MAX_VIGNETTE = 25 * 1024 * 1024;
const REFERENTIEL = "divisions-administratives";
const FICHIER_CONTOURS = "wilaya-boundaries";

// `taille_octets` vaut 0 quand la taille est inconnue (fichiers publiés par certaines synchros) : ce n'est pas un fichier vide.
const lisible = (fichier: FichierInterne): fichier is FichierInterne & { format: FormatSource } =>
  ["geojson", "json", "csv"].includes(fichier.format) && (fichier.taille_octets ?? 0) <= TAILLE_MAX_VIGNETTE;

/** Fichiers essayés au plus pour une vignette (le premier qui donne un visuel l'emporte). */
const MAX_ESSAIS = 3;

/**
 * Fichiers à essayer, dans l'ordre du visuel de la fiche : les GeoJSON (le principal d'abord), puis les JSON
 * (le principal, puis du plus léger au plus lourd), puis les CSV dans le même ordre.
 */
export function fichiersVignette(fichiers: FichierInterne[]): (FichierInterne & { format: FormatSource })[] {
  const candidats = fichiers.filter(lisible);
  return (["geojson", "json", "csv"] as const).flatMap((format) =>
    candidats
      .filter((fichier) => fichier.format === format)
      .map((fichier, ordre) => ({ fichier, ordre }))
      .sort((a, b) => Number(b.fichier.principal) - Number(a.fichier.principal) || (format === "geojson" ? a.ordre - b.ordre : (a.fichier.taille_octets ?? 0) - (b.fichier.taille_octets ?? 0)))
      .map(({ fichier }) => fichier)
  );
}

const empreinte = (fichier: FichierInterne) =>
  createHash("sha256")
    .update(fichier.sha256 ?? `${fichier.cle_stockage}:${fichier.taille_octets ?? ""}`)
    .digest("hex")
    .slice(0, 20);

async function lireFichier(fichier: FichierInterne & { format: FormatSource }): Promise<Table | null> {
  const reponse = await lireObjet(fichier.cle_stockage);
  if (!reponse) return null;
  return lireTable(await reponse.text(), fichier.format);
}

/** Contours des wilayas, gardés en mémoire par l'instance (ils changent rarement). */
let contoursEnMemoire: { valeur: ContourWilaya[]; expire: number } | null = null;
async function chargerContours(): Promise<ContourWilaya[]> {
  if (contoursEnMemoire && contoursEnMemoire.expire > Date.now()) return contoursEnMemoire.valeur;
  const referentiel = await chargerFicheInterne(REFERENTIEL);
  const fichier = referentiel?.fichiers.find((f) => nomFichier(f) === FICHIER_CONTOURS && f.format === "geojson");
  const table = fichier ? await lireFichier(fichier as FichierInterne & { format: FormatSource }) : null;
  if (!table) throw new ErreurApi(503, "boundaries_unavailable", "Les contours des wilayas sont indisponibles. Réessayez plus tard.");
  const valeur = indexerContours(table);
  contoursEnMemoire = { valeur, expire: Date.now() + 6 * 3600_000 };
  return valeur;
}

const pasDeVignette = () => new ErreurApi(404, "no_thumbnail", "Cette donnée n'a pas de carte ni de graphique à prévisualiser.");

/** Vignette WebP (720 × 300, fond transparent) d'une donnée publiée. Lève 404 `no_thumbnail` s'il n'y a rien à dessiner. */
export async function vignetteDonnee(slug: string): Promise<Uint8Array> {
  const resultat = await chargerFicheInterne(slug);
  if (!resultat) throw introuvable("Donnée");
  // Données non redistribuables : aucun fichier, donc aucun aperçu de leur contenu.
  if (estRestreinte(resultat.fiche)) throw new ErreurApi(403, "not_redistributable", "Ces données ne sont pas redistribuées par data-dz.");
  const candidats = fichiersVignette(resultat.fichiers).slice(0, MAX_ESSAIS);
  if (candidats.length === 0) throw pasDeVignette();

  const base = `exports/vignettes/${VERSION}/${slug}/${createHash("sha256").update(candidats.map(empreinte).join(":")).digest("hex").slice(0, 20)}`;
  const enCache = await lireObjet(`${base}.webp`);
  if (enCache) return new Uint8Array(await enCache.arrayBuffer());
  if (await lireObjet(`${base}.vide`)) throw pasDeVignette();

  let plan: PlanVignette | null = null;
  for (const fichier of candidats) {
    const table = await lireFichier(fichier).catch(() => null);
    plan = table ? planVignette(table) : null;
    if (plan) break;
  }
  if (!plan) {
    await ecrireObjet(`${base}.vide`, "", "text/plain", "private, max-age=31536000, immutable");
    throw pasDeVignette();
  }
  const svg = svgVignette(plan, estCarte(plan) ? await chargerContours() : []);
  const webp = await sharp(Buffer.from(svg)).webp({ quality: 82, alphaQuality: 90 }).toBuffer();
  await ecrireObjet(`${base}.webp`, webp, "image/webp", "private, max-age=31536000, immutable");
  return new Uint8Array(webp);
}
