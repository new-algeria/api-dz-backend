import type { PostgrestError } from "@supabase/supabase-js";
import { lireConfig } from "../config.js";
import { FORMATS_SORTIE, type FormatSortie } from "./conversion.js";
import { erreurSupabase } from "./erreurs.js";
import { supabasePublic } from "./supabase.js";

export const URL_SITE = "https://data-dz.com";


interface LigneFichier {
  nom: string | null;
  format: string;
  cle_stockage: string;
  principal: boolean;
  taille_octets: number | null;
  sha256: string | null;
}

/** Fichier tel que la base le décrit ; `cle_stockage` ne quitte jamais l'API. */
export type FichierInterne = LigneFichier;

const COLONNES_RESUME = `
  id, slug, titre, description, categorie_slug, licence_code, mots_cles, mis_a_jour_le,
  score, nb_votes_pour, nb_votes_contre, nb_favoris, nb_commentaires,
  sources ( slug, nom, url, verifiee ),
  versions!datasets_version_courante_fk ( numero, nb_lignes, publie_le )
`;

const COLONNES_FICHE = `
  id, slug, titre, description, readme, categorie_slug, licence_code, licence_details,
  url_source, mots_cles, wilayas, frequence_maj, infos_source, mis_a_jour_le,
  score, nb_votes_pour, nb_votes_contre, nb_favoris, nb_commentaires,
  categories ( slug, nom, icone ),
  sources ( slug, nom, url, verifiee ),
  licences ( code, nom, url, usage_commercial, attribution_requise, partage_identique ),
  versions!datasets_version_courante_fk (
    numero, notes, nb_lignes, colonnes, apercu, publie_le,
    fichiers ( nom, format, cle_stockage, principal, taille_octets, sha256 )
  )
`;

/**
 * La colonne `illustration_url` arrive avec la migration 20261025000009. Tant qu'elle n'est pas appliquée,
 * on relance la requête sans elle (code Postgres 42703 : colonne inconnue) au lieu de casser l'API.
 */
let illustrationDisponible = true;

async function avecIllustration<T>(
  colonnes: string,
  executer: (select: string) => PromiseLike<{ data: T; error: PostgrestError | null }>
): Promise<T> {
  if (illustrationDisponible) {
    const resultat = await executer(`illustration_url, ${colonnes}`);
    if (!resultat.error) return resultat.data;
    if (resultat.error.code !== "42703") throw erreurSupabase(resultat.error);
    illustrationDisponible = false;
  }
  const resultat = await executer(colonnes);
  if (resultat.error) throw erreurSupabase(resultat.error);
  return resultat.data;
}

export const urlApiDonnee = (slug: string) => `${lireConfig().URL_API}/v1/datasets/${slug}`;
const urlPageDonnee = (slug: string) => `${URL_SITE}/datasets/${slug}`;

export function urlTelechargement(slug: string, nom: string, format: string, inline = false): string {
  const params = new URLSearchParams({ format, file: nom });
  if (inline) params.set("inline", "1");
  return `${urlApiDonnee(slug)}/download?${params}`;
}

// ---------------------------------------------------------------- Catalogue

export type Tri = "top" | "recent" | "name";

export interface FiltresCatalogue {
  q?: string;
  category?: string;
  source?: string;
  wilaya?: string;
  sort: Tri;
  page: number;
  limit: number;
}

type LigneResume = Record<string, unknown> & { slug: string; illustration_url?: string | null };

function versResume(ligne: LigneResume) {
  const { sources, versions, illustration_url, ...reste } = ligne;
  return {
    ...reste,
    illustration_url: illustration_url ?? null,
    source: sources ?? null,
    version: versions ?? null,
    liens: { api: urlApiDonnee(ligne.slug), page: urlPageDonnee(ligne.slug) },
  };
}

export async function listerDonnees(filtres: FiltresCatalogue) {
  const debut = (filtres.page - 1) * filtres.limit;
  const { lignes, total } = await avecIllustration(COLONNES_RESUME, async (select) => {
    let requete = supabasePublic().from("datasets").select(select, { count: "exact" }).eq("statut", "publie");
    if (filtres.q) requete = requete.textSearch("recherche", filtres.q, { config: "simple", type: "websearch" });
    if (filtres.category) requete = requete.eq("categorie_slug", filtres.category);
    if (filtres.wilaya) requete = requete.contains("wilayas", [filtres.wilaya]);
    if (filtres.source) {
      const { data: source } = await supabasePublic().from("sources").select("id").eq("slug", filtres.source).maybeSingle();
      requete = requete.eq("source_id", source?.id ?? "00000000-0000-0000-0000-000000000000");
    }
    if (filtres.sort === "top") requete = requete.order("score", { ascending: false }).order("nb_votes_pour", { ascending: false });
    else if (filtres.sort === "recent") requete = requete.order("mis_a_jour_le", { ascending: false });
    requete = requete.order("titre->>fr").range(debut, debut + filtres.limit - 1);
    const { data, error, count } = await requete;
    return { data: { lignes: (data ?? []) as unknown as LigneResume[], total: count ?? 0 }, error };
  });

  return {
    data: lignes.map(versResume),
    pagination: {
      page: filtres.page,
      limit: filtres.limit,
      total,
      pages: Math.max(1, Math.ceil(total / filtres.limit)),
    },
  };
}

// ---------------------------------------------------------------- Fiche

type LigneFiche = LigneResume & {
  versions: (Record<string, unknown> & { fichiers: LigneFichier[] | null }) | null;
  categories: unknown;
  licences: unknown;
};

/** Fiche publiée + fichiers internes (pour les routes qui lisent R2). `null` si absente ou non publiée. */
export async function chargerFicheInterne(slug: string): Promise<{ fiche: LigneFiche; fichiers: FichierInterne[] } | null> {
  const ligne = await avecIllustration(COLONNES_FICHE, async (select) => {
    const { data, error } = await supabasePublic()
      .from("datasets")
      .select(select)
      .eq("statut", "publie")
      .eq("slug", slug)
      .maybeSingle();
    return { data: data as unknown as LigneFiche | null, error };
  });
  if (!ligne) return null;
  return { fiche: ligne, fichiers: ligne.versions?.fichiers ?? [] };
}

/** Nom logique d'un fichier : `nom` en base, sinon le nom de la clé sans extension. */
export function nomFichier(fichier: FichierInterne): string {
  return fichier.nom ?? fichier.cle_stockage.split("/").pop()!.replace(/\.[^.]+$/, "");
}

/** Fichiers regroupés par nom : chaque ressource existe en un ou plusieurs formats d'origine. */
export function ressourcesDe(slug: string, fichiers: FichierInterne[]) {
  const groupes = new Map<string, FichierInterne[]>();
  for (const fichier of fichiers) {
    const nom = nomFichier(fichier);
    groupes.set(nom, [...(groupes.get(nom) ?? []), fichier]);
  }
  return [...groupes.entries()]
    .map(([nom, versions]) => {
      const natifs = versions.map((fichier) => fichier.format);
      return {
        nom,
        principal: versions.some((fichier) => fichier.principal),
        fichiers: versions.map((fichier) => ({
          format: fichier.format,
          taille_octets: fichier.taille_octets,
          url: urlTelechargement(slug, nom, fichier.format, true),
        })),
        // Tous les formats sont proposés ; une conversion impossible (pas de tableau, pas de coordonnées
        // pour un GeoJSON) répond 422 avec un message clair.
        telechargements: FORMATS_SORTIE.map((format) => ({
          format,
          natif: natifs.includes(format),
          url: urlTelechargement(slug, nom, format),
        })),
      };
    })
    .sort((a, b) => Number(b.principal) - Number(a.principal) || a.nom.localeCompare(b.nom));
}

export function versFiche(ligne: LigneFiche, fichiers: FichierInterne[]) {
  const { versions, categories, licences, ...reste } = ligne;
  const { fichiers: _fichiers, ...version } = versions ?? { fichiers: null };
  return {
    ...versResume({ ...reste, versions: null }),
    categorie: categories ?? null,
    licence: licences ?? null,
    version: versions ? version : null,
    ressources: ressourcesDe(ligne.slug, fichiers),
  };
}

// ---------------------------------------------------------------- Référentiels

export async function listerCategories() {
  const { data, error } = await supabasePublic().from("categories").select("slug, nom, icone, ordre").order("ordre");
  if (error) throw erreurSupabase(error);
  return data ?? [];
}

export async function listerLicences() {
  const { data, error } = await supabasePublic()
    .from("licences")
    .select("code, nom, url, usage_commercial, attribution_requise, partage_identique")
    .order("nom");
  if (error) throw erreurSupabase(error);
  return data ?? [];
}

export async function listerSources() {
  const { data, error } = await supabasePublic().from("sources").select("slug, nom, url, type, verifiee, description").order("nom");
  if (error) throw erreurSupabase(error);
  return data ?? [];
}

export async function chargerStatistiques() {
  const [{ data, error }, membres] = await Promise.all([
    supabasePublic()
      .from("datasets")
      .select("categorie_slug, versions!datasets_version_courante_fk ( nb_lignes )")
      .eq("statut", "publie"),
    supabasePublic().from("profils").select("id", { count: "exact", head: true }),
  ]);
  if (error) throw erreurSupabase(error);
  if (membres.error) throw erreurSupabase(membres.error);
  const lignes = (data ?? []) as unknown as { categorie_slug: string | null; versions: { nb_lignes: number | null } | null }[];
  return {
    nb_donnees: lignes.length,
    nb_categories: new Set(lignes.map((ligne) => ligne.categorie_slug).filter(Boolean)).size,
    total_lignes: lignes.reduce((total, ligne) => total + (ligne.versions?.nb_lignes ?? 0), 0),
    nb_membres: membres.count ?? 0,
  };
}

export function estFormatSortie(format: string): format is FormatSortie {
  return (FORMATS_SORTIE as readonly string[]).includes(format);
}
