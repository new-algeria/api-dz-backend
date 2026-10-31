import type { PostgrestError } from "@supabase/supabase-js";
import { lireConfig } from "../config.js";
import { FORMATS_SORTIE, type FormatSortie } from "./conversion.js";
import { erreurSupabase, RedirectionDonnee } from "./erreurs.js";
import { filtresRecherche } from "./recherche.js";
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

// `publie_le` (première publication, sinon `cree_le`) : le site met en avant les données ajoutées depuis peu.
// Colonnes, fichiers et `infos_source` : les cartes du catalogue en tirent leur chiffre (unité, séries temporelles),
// leurs boutons « Voir la carte » / « Graphique » et « Télécharger ». Les fichiers sortent en `ressources`
// (liens de l'API), jamais avec leur clé de stockage.
const COLONNES_RESUME = `
  id, slug, titre, description, categorie_slug, licence_code, mots_cles, mis_a_jour_le, publie_le, cree_le, infos_source,
  score, nb_votes_pour, nb_votes_contre, nb_favoris, nb_commentaires,
  sources ( slug, nom, url, verifiee ),
  versions!datasets_version_courante_fk ( numero, nb_lignes, publie_le, colonnes, fichiers ( nom, format, cle_stockage, principal, taille_octets ) )
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
 * Colonnes ajoutées par des migrations récentes : `illustration_url` (20261025000009), `diffusion_restreinte`
 * et `licence_manuelle` (20261031000011). Tant qu'une migration n'est pas appliquée, on relance la requête
 * sans la colonne inconnue (code Postgres 42703) au lieu de casser l'API ; elle vaut alors sa valeur par défaut.
 */
const COLONNES_RECENTES = ["illustration_url", "diffusion_restreinte", "licence_manuelle"] as const;
const colonnesAbsentes = new Set<string>();

export async function avecColonnesRecentes<T>(
  colonnes: string,
  executer: (select: string) => PromiseLike<{ data: T; error: PostgrestError | null }>
): Promise<T> {
  for (;;) {
    const recentes = COLONNES_RECENTES.filter((colonne) => !colonnesAbsentes.has(colonne));
    const resultat = await executer([...recentes, colonnes].join(", "));
    if (!resultat.error) return resultat.data;
    const manquante = resultat.error.code === "42703" ? recentes.find((colonne) => resultat.error!.message.includes(colonne)) : undefined;
    if (!manquante) throw erreurSupabase(resultat.error);
    colonnesAbsentes.add(manquante);
  }
}

/** Ancien nom, gardé pour les appels existants. */
export const avecIllustration = avecColonnesRecentes;

/** Fichiers non redistribuables (`diffusion_restreinte`) : jamais de lien de téléchargement ni de lignes. */
export const estRestreinte = (ligne: { diffusion_restreinte?: unknown }) => ligne.diffusion_restreinte === true;

/**
 * Où obtenir une donnée restreinte : le paquet npm de la source (`infos_source.paquet`, écrit par la synchro
 * GeoAlgeria), sinon la page de la source si c'est une page npm.
 */
export function lienPaquet(ligne: Record<string, unknown>): string | null {
  const paquet = (ligne.infos_source as { paquet?: unknown } | null | undefined)?.paquet;
  if (typeof paquet === "string" && /^(@[\w.-]+\/)?[\w.-]+$/.test(paquet)) return `https://www.npmjs.com/package/${paquet}`;
  const url = typeof ligne.url_source === "string" ? ligne.url_source : null;
  return url?.startsWith("https://www.npmjs.com/") ? url : null;
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

type LigneResume = Record<string, unknown> & {
  slug: string;
  illustration_url?: string | null;
  diffusion_restreinte?: boolean;
  licence_manuelle?: boolean;
};

function versResume(ligne: LigneResume) {
  const { sources, versions, illustration_url, diffusion_restreinte: _restreinte, licence_manuelle: _manuelle, ...reste } = ligne;
  const { fichiers, ...version } = (versions ?? {}) as Record<string, unknown> & { fichiers?: FichierInterne[] | null };
  const restreinte = estRestreinte(ligne);
  return {
    ...reste,
    illustration_url: illustration_url ?? null,
    diffusion_restreinte: restreinte,
    lien_paquet: restreinte ? lienPaquet(ligne) : null,
    source: sources ?? null,
    version: versions ? version : null,
    ressources: restreinte ? [] : ressourcesDe(ligne.slug, fichiers ?? []),
    liens: { api: urlApiDonnee(ligne.slug), page: urlPageDonnee(ligne.slug) },
  };
}

export async function listerDonnees(filtres: FiltresCatalogue) {
  const debut = (filtres.page - 1) * filtres.limit;
  const { lignes, total } = await avecColonnesRecentes(COLONNES_RESUME, async (select) => {
    let requete = supabasePublic().from("datasets").select(select, { count: "exact" }).eq("statut", "publie");
    for (const filtre of filtresRecherche(filtres.q ?? "")) requete = requete.or(filtre);
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
  const ligne = await avecColonnesRecentes(COLONNES_FICHE, async (select) => {
    const { data, error } = await supabasePublic()
      .from("datasets")
      .select(select)
      .eq("statut", "publie")
      .eq("slug", slug)
      .maybeSingle();
    return { data: data as unknown as LigneFiche | null, error };
  });
  if (!ligne) {
    const nouveau = await slugActuel(slug);
    if (nouveau) throw new RedirectionDonnee(nouveau);
    return null;
  }
  return { fiche: ligne, fichiers: ligne.versions?.fichiers ?? [] };
}

/**
 * Identifiant actuel d'une donnée publiée renommée (colonne `anciens_slugs`, migration 20261029000010).
 * Sans la migration (42703) ou en cas d'erreur, pas de redirection : la route répond 404 comme avant.
 */
async function slugActuel(ancien: string): Promise<string | null> {
  const { data, error } = await supabasePublic()
    .from("datasets")
    .select("slug")
    .eq("statut", "publie")
    .contains("anciens_slugs", [ancien])
    .limit(1)
    .maybeSingle();
  if (error) {
    if (error.code !== "42703") console.error("supabase:", error.code, error.message);
    return null;
  }
  return (data?.slug as string | undefined) ?? null;
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
  const restreinte = estRestreinte(ligne);
  return {
    ...versResume({ ...reste, versions: null }),
    categorie: categories ?? null,
    licence: licences ?? null,
    // Donnée restreinte : colonnes et nombre de lignes restent, mais aucune ligne de données (pas d'aperçu).
    version: versions ? (restreinte ? { ...version, apercu: null } : version) : null,
    ressources: restreinte ? [] : ressourcesDe(ligne.slug, fichiers),
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
