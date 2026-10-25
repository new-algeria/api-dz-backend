import { createHash } from "node:crypto";
import type { PostgrestError } from "@supabase/supabase-js";
import type { Acteur } from "../types.js";
import { avecIllustration } from "./catalogue.js";
import { decrireTable, lireTable, type FormatSource } from "./conversion.js";
import { ErreurApi, introuvable } from "./erreurs.js";
import { ecrireObjet, infosObjet, lienEnvoiSigne, lireObjet, supprimerObjet, urlPublique } from "./r2.js";
import { supabaseAdmin } from "./supabase.js";

export const STATUTS = ["brouillon", "en_revue", "publie", "archive"] as const;
export type Statut = (typeof STATUTS)[number];

/** Traduit les erreurs Postgres courantes en erreurs API lisibles. */
export function erreurBase(erreur: PostgrestError): ErreurApi {
  if (erreur.code === "23505") return new ErreurApi(409, "conflict", "Une donnée avec ce slug existe déjà.");
  if (erreur.code === "23503") return new ErreurApi(400, "unknown_reference", "Catégorie, licence ou source inconnue.", erreur.details);
  if (erreur.code === "23514" || erreur.code === "23502" || erreur.code === "22P02") {
    return new ErreurApi(400, "constraint_violation", "Valeur refusée par la base.", erreur.message);
  }
  // Sans ce log, une erreur de schéma (ex. 42703 : colonne absente, migration non appliquée) serait invisible.
  console.error("supabase:", erreur.code, erreur.message);
  if (erreur.code === "42703") {
    return new ErreurApi(503, "schema_outdated", "La base n'est pas à jour : une migration Supabase reste à appliquer.");
  }
  return new ErreurApi(502, "database_error", "Erreur de la base de données.");
}

// `illustration_url` est ajoutée par `avecIllustration` (absente tant que la migration 20261025000009 n'est pas appliquée).
const COLONNES_ADMIN = `
  id, slug, titre, description, readme, statut, categorie_slug, licence_code, licence_details, url_source,
  mots_cles, wilayas, frequence_maj, infos_source, cree_le, mis_a_jour_le, publie_le,
  score, nb_votes_pour, nb_votes_contre, nb_favoris, nb_commentaires,
  sources ( slug, nom, type ),
  versions!datasets_version_courante_fk ( numero, nb_lignes, publie_le, fichiers ( nom, format, principal, taille_octets ) )
`;

export async function listerDonneesAdmin(recherche?: string, statut?: Statut) {
  return avecIllustration(COLONNES_ADMIN, async (colonnes) => {
    let requete = supabaseAdmin().from("datasets").select(colonnes).order("mis_a_jour_le", { ascending: false });
    if (statut) requete = requete.eq("statut", statut);
    if (recherche) requete = requete.textSearch("recherche", recherche, { config: "simple", type: "websearch" });
    const { data, error } = await requete;
    return { data: (data ?? []) as unknown as Record<string, unknown>[], error };
  });
}

async function donneeParSlug(slug: string) {
  const data = await avecIllustration(COLONNES_ADMIN, async (colonnes) => {
    const { data, error } = await supabaseAdmin().from("datasets").select(colonnes).eq("slug", slug).maybeSingle();
    return { data: data as unknown, error };
  });
  return data as (Record<string, unknown> & { id: string; slug: string; statut: Statut; illustration_url: string | null }) | null;
}

export async function chargerDonneeAdmin(slug: string) {
  const donnee = await donneeParSlug(slug);
  if (!donnee) throw introuvable("Donnée");
  return donnee;
}

async function idSource(slug: string): Promise<string> {
  const { data, error } = await supabaseAdmin().from("sources").select("id").eq("slug", slug).maybeSingle();
  if (error) throw erreurBase(error);
  if (!data) throw new ErreurApi(400, "unknown_reference", `Source inconnue : ${slug}.`);
  return data.id as string;
}

export interface ChampsDonnee {
  titre?: Record<string, string>;
  description?: Record<string, string> | null;
  readme?: string | null;
  categorie_slug?: string | null;
  source_slug?: string;
  licence_code?: string | null;
  licence_details?: string | null;
  url_source?: string | null;
  mots_cles?: string[];
  wilayas?: string[];
  frequence_maj?: string | null;
  infos_source?: Record<string, unknown> | null;
  statut?: Statut;
}

async function versLigne(champs: ChampsDonnee) {
  const { source_slug, ...colonnes } = champs;
  const ligne: Record<string, unknown> = Object.fromEntries(Object.entries(colonnes).filter(([, valeur]) => valeur !== undefined));
  if (source_slug) ligne.source_id = await idSource(source_slug);
  if (champs.statut === "publie") ligne.publie_le = new Date().toISOString();
  return ligne;
}

export async function creerDonnee(slug: string, champs: ChampsDonnee & { titre: Record<string, string> }, acteur: Acteur) {
  const ligne = await versLigne({ statut: "brouillon", ...champs });
  if (acteur.type === "admin") ligne.auteur_id = acteur.id;
  const { error } = await supabaseAdmin().from("datasets").insert({ slug, ...ligne });
  if (error) throw erreurBase(error);
  return chargerDonneeAdmin(slug);
}

export async function modifierDonnee(slug: string, champs: ChampsDonnee) {
  const actuelle = await chargerDonneeAdmin(slug);
  const ligne = await versLigne(champs);
  // `publie_le` garde la date de première publication.
  if (actuelle.statut === "publie" || actuelle.publie_le) delete ligne.publie_le;
  if (Object.keys(ligne).length > 0) {
    const { error } = await supabaseAdmin()
      .from("datasets")
      .update({ ...ligne, mis_a_jour_le: new Date().toISOString() })
      .eq("id", actuelle.id);
    if (error) throw erreurBase(error);
  }
  return chargerDonneeAdmin(slug);
}

/** Création ou mise à jour (script de synchronisation) : ne touche jamais au statut ni à l'illustration d'une donnée existante. */
export async function enregistrerDonnee(slug: string, champs: ChampsDonnee & { titre: Record<string, string> }, acteur: Acteur) {
  const existante = await donneeParSlug(slug);
  if (!existante) return { donnee: await creerDonnee(slug, { statut: "publie", ...champs }, acteur), creee: true };
  const { statut: _statut, ...reste } = champs;
  return { donnee: await modifierDonnee(slug, reste), creee: false };
}

/** Préfixe R2 propre à une donnée : les fichiers envoyés par l'API ne sont jamais partagés entre données. */
const prefixeDonnee = (slug: string) => `datasets/${slug}/`;

export async function supprimerDonnee(slug: string, supprimerFichiers: boolean) {
  const donnee = await chargerDonneeAdmin(slug);
  const cles: string[] = [];
  if (supprimerFichiers) {
    const { data: versions } = await supabaseAdmin().from("versions").select("fichiers ( cle_stockage )").eq("dataset_id", donnee.id);
    for (const version of (versions ?? []) as { fichiers: { cle_stockage: string }[] }[]) {
      for (const fichier of version.fichiers) if (fichier.cle_stockage.startsWith(prefixeDonnee(slug))) cles.push(fichier.cle_stockage);
    }
  }
  const { error } = await supabaseAdmin().from("datasets").delete().eq("id", donnee.id);
  if (error) {
    if (error.code === "23503") {
      throw new ErreurApi(409, "has_dependencies", "Cette donnée est référencée ailleurs (versions, votes, propositions) : archivez-la plutôt.");
    }
    throw erreurBase(error);
  }
  if (donnee.illustration_url) cles.push(...cleIllustration(donnee.illustration_url));
  // Nettoyage au mieux : la donnée est déjà supprimée, un fichier orphelin n'est pas bloquant.
  await Promise.allSettled(cles.map(supprimerObjet));
}

// ---------------------------------------------------------------- Fichiers et versions

export const FORMATS_ENVOI = ["json", "geojson", "csv"] as const;
const TYPES_ENVOI: Record<(typeof FORMATS_ENVOI)[number], string> = {
  json: "application/json",
  geojson: "application/geo+json",
  csv: "text/csv",
};
export const TAILLE_MAX_FICHIER = 100 * 1024 * 1024;

export async function preparerEnvoi(slug: string, nom: string, format: (typeof FORMATS_ENVOI)[number]) {
  await chargerDonneeAdmin(slug);
  const cle = `${prefixeDonnee(slug)}${Date.now()}/${nom}.${format}`;
  const typeContenu = TYPES_ENVOI[format];
  return { cle, url: await lienEnvoiSigne(cle, typeContenu), methode: "PUT", content_type: typeContenu, expire_dans: 900 };
}

function versionSuivante(numero: string | undefined): string {
  const morceaux = numero?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!morceaux) return "1.0.0";
  return `${morceaux[1]}.${Number(morceaux[2]) + 1}.0`;
}

export interface FichierVersion {
  cle: string;
  nom: string;
  format: FormatSource;
  principal?: boolean;
}

/**
 * Publie une nouvelle version à partir de fichiers déjà envoyés sur R2 (`preparerEnvoi`).
 * Chaque fichier est relu et validé ; le principal fournit lignes, colonnes et aperçu.
 */
export async function publierVersion(
  slug: string,
  entree: { numero?: string; notes?: string | null; fichiers: FichierVersion[] },
  acteur: Acteur
) {
  const donnee = await chargerDonneeAdmin(slug);
  const fichiers = entree.fichiers.map((fichier, indice) => ({ ...fichier, principal: fichier.principal ?? indice === 0 }));
  if (fichiers.filter((fichier) => fichier.principal).length !== 1) {
    throw new ErreurApi(400, "invalid_files", "Exactement un fichier doit être principal.");
  }

  // Un fichier à la fois : jusqu'à 30 fichiers de 100 Mo ne tiendraient pas en mémoire ensemble.
  const analyses = [];
  for (const fichier of fichiers) {
    if (!fichier.cle.startsWith(prefixeDonnee(slug))) {
      throw new ErreurApi(400, "invalid_files", `Clé hors du dossier de la donnée : ${fichier.cle}.`);
    }
    const infos = await infosObjet(fichier.cle);
    if (!infos) throw new ErreurApi(400, "invalid_files", `Fichier non envoyé : ${fichier.nom}.${fichier.format}.`);
    if (infos.taille > TAILLE_MAX_FICHIER) throw new ErreurApi(413, "file_too_large", `${fichier.nom} dépasse 100 Mo.`);
    const reponse = await lireObjet(fichier.cle);
    const texte = await reponse!.text();
    const table = lireTable(texte, fichier.format);
    analyses.push({
      fichier,
      taille: infos.taille,
      sha256: createHash("sha256").update(texte).digest("hex"),
      description: fichier.principal ? decrireTable(table) : null,
    });
  }
  const principal = analyses.find((analyse) => analyse.fichier.principal)!.description!;

  const { data: courante } = await supabaseAdmin()
    .from("datasets")
    .select("versions!datasets_version_courante_fk ( numero )")
    .eq("id", donnee.id)
    .maybeSingle();
  const numero = entree.numero ?? versionSuivante((courante?.versions as { numero?: string } | null)?.numero);

  const { data: version, error } = await supabaseAdmin()
    .from("versions")
    .insert({
      dataset_id: donnee.id,
      numero,
      notes: entree.notes ?? null,
      auteur_id: acteur.type === "admin" ? acteur.id : null,
      nb_lignes: principal.nbLignes,
      colonnes: principal.colonnes,
      apercu: principal.apercu,
      publie_le: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw erreurBase(error);

  const { error: erreurFichiers } = await supabaseAdmin()
    .from("fichiers")
    .insert(
      analyses.map(({ fichier, taille, sha256 }) => ({
        version_id: version.id,
        format: fichier.format,
        cle_stockage: fichier.cle,
        nom: fichier.nom,
        principal: fichier.principal,
        taille_octets: taille,
        sha256,
      }))
    );
  if (erreurFichiers) {
    await supabaseAdmin().from("versions").delete().eq("id", version.id);
    throw erreurBase(erreurFichiers);
  }

  const { error: erreurCourante } = await supabaseAdmin()
    .from("datasets")
    .update({ version_courante_id: version.id, mis_a_jour_le: new Date().toISOString() })
    .eq("id", donnee.id);
  if (erreurCourante) throw erreurBase(erreurCourante);

  return { numero, nb_lignes: principal.nbLignes, colonnes: principal.colonnes, fichiers: analyses.length };
}

// ---------------------------------------------------------------- Illustration

const PREFIXE_ILLUSTRATIONS = "web-assets/datasets/";
export const TAILLE_MAX_ILLUSTRATION = 2 * 1024 * 1024;

/** Type réel de l'image d'après ses premiers octets (on ne fait pas confiance au type annoncé). */
export function typeImage(octets: Uint8Array): { extension: string; type: string } | null {
  const debut = (n: number) => [...octets.slice(0, n)];
  if (debut(8).join() === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].join()) return { extension: "png", type: "image/png" };
  if (debut(3).join() === [0xff, 0xd8, 0xff].join()) return { extension: "jpg", type: "image/jpeg" };
  const texte = new TextDecoder().decode(octets.slice(0, 12));
  if (texte.startsWith("RIFF") && texte.slice(8, 12) === "WEBP") return { extension: "webp", type: "image/webp" };
  return null;
}

/** Clé R2 d'une illustration envoyée par l'API (les images du pack d'origine ne sont jamais supprimées). */
function cleIllustration(url: string): string[] {
  const indice = url.indexOf(PREFIXE_ILLUSTRATIONS);
  return indice >= 0 ? [url.slice(indice)] : [];
}

export async function enregistrerIllustration(slug: string, octets: Uint8Array) {
  const donnee = await chargerDonneeAdmin(slug);
  if (octets.byteLength > TAILLE_MAX_ILLUSTRATION) throw new ErreurApi(413, "file_too_large", "Image trop lourde (2 Mo maximum).");
  const type = typeImage(octets);
  if (!type) throw new ErreurApi(400, "invalid_image", "Formats acceptés : PNG, JPEG, WebP.");

  const cle = `${PREFIXE_ILLUSTRATIONS}${slug}-${Date.now()}.${type.extension}`;
  await ecrireObjet(cle, octets, type.type, "public, max-age=31536000, immutable");
  const url = urlPublique(cle);
  const { error } = await supabaseAdmin().from("datasets").update({ illustration_url: url }).eq("id", donnee.id);
  if (error) {
    await supprimerObjet(cle).catch(() => undefined);
    throw erreurBase(error);
  }
  if (donnee.illustration_url) await Promise.allSettled(cleIllustration(donnee.illustration_url).map(supprimerObjet));
  return { illustration_url: url };
}

export async function retirerIllustration(slug: string) {
  const donnee = await chargerDonneeAdmin(slug);
  const { error } = await supabaseAdmin().from("datasets").update({ illustration_url: null }).eq("id", donnee.id);
  if (error) throw erreurBase(error);
  if (donnee.illustration_url) await Promise.allSettled(cleIllustration(donnee.illustration_url).map(supprimerObjet));
}
