import { createHash } from "node:crypto";
import { chargerFicheInterne, nomFichier, URL_SITE, type FichierInterne } from "./catalogue.js";
import { convertir, lireTable, TYPES_CONTENU, type FormatSortie, type FormatSource, type Table } from "./conversion.js";
import { ErreurApi, introuvable } from "./erreurs.js";
import { ecrireObjet, infosObjet, lienSigne, lireObjet } from "./r2.js";
import { texteMultilingue } from "./textes.js";

/** Durée de validité des liens signés : assez longue pour survivre au cache CDN (60 s) de la redirection. */
export const DUREE_LIEN = 600;

const FORMATS_SOURCE: FormatSource[] = ["geojson", "json", "csv"];
const TYPES_NATIFS: Record<string, string> = { ...TYPES_CONTENU, xml: "application/xml", zip: "application/zip", pdf: "application/pdf" };

async function fichiersDe(slug: string, nom?: string) {
  const resultat = await chargerFicheInterne(slug);
  if (!resultat) throw introuvable("Donnée");
  const { fiche, fichiers } = resultat;
  const nomVise = nom ?? (fichiers.find((fichier) => fichier.principal) ?? fichiers[0]);
  const cible = typeof nomVise === "string" ? nomVise : nomVise ? nomFichier(nomVise) : undefined;
  const versions = fichiers.filter((fichier) => nomFichier(fichier) === cible);
  if (versions.length === 0) throw introuvable("Fichier");
  return { fiche, nom: cible!, versions };
}

/** Empreinte d'un fichier source : change dès que le fichier change, ce qui invalide les exports. */
function empreinte(fichier: FichierInterne): string {
  const base = fichier.sha256 ?? `${fichier.cle_stockage}:${fichier.taille_octets ?? ""}`;
  return createHash("sha256").update(base).digest("hex").slice(0, 20);
}

function sourcePourConversion(versions: FichierInterne[]): FichierInterne & { format: FormatSource } {
  for (const format of FORMATS_SOURCE) {
    const fichier = versions.find((version) => version.format === format);
    if (fichier) return fichier as FichierInterne & { format: FormatSource };
  }
  throw new ErreurApi(422, "not_convertible", "Le format d'origine de ce fichier ne peut pas être converti.");
}

async function lireSource(fichier: FichierInterne & { format: FormatSource }): Promise<Table> {
  const reponse = await lireObjet(fichier.cle_stockage);
  if (!reponse) throw introuvable("Fichier");
  return lireTable(await reponse.text(), fichier.format);
}

/**
 * URL signée (R2) pour télécharger un fichier dans le format demandé.
 * Format d'origine : lien direct. Sinon : conversion une seule fois par version du fichier,
 * rangée dans `exports/<empreinte>/`, puis lien vers ce fichier.
 */
export async function lienTelechargement(slug: string, format: FormatSortie, nom?: string, inline = false): Promise<string> {
  const { fiche, nom: nomCible, versions } = await fichiersDe(slug, nom);
  const nomTelecharge = `${nomCible === slug ? slug : `${slug}-${nomCible}`}.${format}`;
  const options = { expiration: DUREE_LIEN, nomFichier: nomTelecharge, inline, typeContenu: TYPES_NATIFS[format] };

  const natif = versions.find((version) => version.format === format);
  if (natif) return lienSigne(natif.cle_stockage, options);

  const source = sourcePourConversion(versions);
  const cleExport = `exports/${empreinte(source)}/${nomCible}.${format}`;
  if (!(await infosObjet(cleExport))) {
    const table = await lireSource(source);
    const contenu = convertir(table, format, {
      titre: texteMultilingue(fiche.titre),
      source: (fiche.sources as { nom?: string } | null)?.nom ?? null,
      licence: [fiche.licence_code, fiche.licence_details].filter(Boolean).join(" — ") || null,
      urlFiche: `${URL_SITE}/datasets/${slug}`,
    });
    await ecrireObjet(cleExport, contenu, TYPES_CONTENU[format], "private, max-age=31536000, immutable");
  }
  return lienSigne(cleExport, options);
}

// ---------------------------------------------------------------- Lignes (route /data)

/** Petit cache mémoire des tables lues (Fluid compute réutilise l'instance entre requêtes). */
const cacheTables = new Map<string, { table: Table; lu: number }>();
const TAILLE_CACHE = 4;

export async function lireTableDonnee(slug: string, nom?: string) {
  const { nom: nomCible, versions } = await fichiersDe(slug, nom);
  const source = sourcePourConversion(versions);
  const cle = empreinte(source);
  let entree = cacheTables.get(cle);
  if (!entree) {
    entree = { table: await lireSource(source), lu: Date.now() };
    cacheTables.set(cle, entree);
    if (cacheTables.size > TAILLE_CACHE) {
      const plusAncienne = [...cacheTables.entries()].sort((a, b) => a[1].lu - b[1].lu)[0][0];
      cacheTables.delete(plusAncienne);
    }
  }
  entree.lu = Date.now();
  return { nom: nomCible, table: entree.table };
}
