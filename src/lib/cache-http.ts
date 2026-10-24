import type { Context } from "hono";

/**
 * Politiques de cache. `CDN-Cache-Control` ne s'adresse qu'au CDN de Vercel : les navigateurs suivent
 * `Cache-Control`. Le cache CDN est la première protection de l'API : une réponse en cache ne réveille
 * ni la fonction, ni Supabase, ni R2.
 */
const POLITIQUES = {
  /** Catalogue et fiches : les compteurs de votes changent souvent, cache très court. */
  vivant: { navigateur: "public, max-age=0, must-revalidate", cdn: "max-age=15, stale-while-revalidate=60" },
  /** Catégories, licences, sources, statistiques. */
  referentiel: { navigateur: "public, max-age=300", cdn: "max-age=3600, stale-while-revalidate=86400" },
  /** Lignes d'un fichier (changent au plus une fois par semaine). */
  donnees: { navigateur: "public, max-age=300", cdn: "max-age=1800, stale-while-revalidate=86400" },
  /** Redirection vers un lien signé valable 10 min : 60 s de cache laissent toujours 9 min de validité. */
  redirection: { navigateur: "public, max-age=60", cdn: "max-age=60" },
  /** Documentation et OpenAPI. */
  documentation: { navigateur: "public, max-age=300", cdn: "max-age=3600, stale-while-revalidate=86400" },
} as const;

export type PolitiqueCache = keyof typeof POLITIQUES;

export function mettreEnCache(c: Context, politique: PolitiqueCache): void {
  c.header("Cache-Control", POLITIQUES[politique].navigateur);
  c.header("CDN-Cache-Control", POLITIQUES[politique].cdn);
}

export function sansCache(c: Context): void {
  c.header("Cache-Control", "no-store");
  c.header("CDN-Cache-Control", "no-store");
}
