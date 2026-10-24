import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { Context, MiddlewareHandler } from "hono";
import { lireConfig } from "../config.js";
import { ErreurApi } from "../lib/erreurs.js";

/**
 * Limites par adresse IP et par famille de routes (fenêtre glissante de 60 s).
 * Les réponses servies par le cache CDN de Vercel n'atteignent pas la fonction et ne comptent donc pas :
 * ces limites ne visent que les requêtes réellement calculées.
 */
export const LIMITES = {
  lecture: { requetes: 120, fenetre: 60 },
  donnees: { requetes: 30, fenetre: 60 },
  telechargement: { requetes: 20, fenetre: 60 },
  admin: { requetes: 60, fenetre: 60 },
} as const;

export type FamilleLimite = keyof typeof LIMITES;

interface Verdict {
  succes: boolean;
  limite: number;
  restant: number;
  /** Instant de remise à zéro (ms depuis l'epoch). */
  reinitialisation: number;
}

type Limiteur = (identifiant: string) => Promise<Verdict>;

/** Repli sans Redis : fenêtre fixe en mémoire, propre à chaque instance (protection minimale). */
function limiteurMemoire(requetes: number, fenetre: number): Limiteur {
  const compteurs = new Map<string, { nombre: number; fin: number }>();
  return async (identifiant) => {
    const maintenant = Date.now();
    let compteur = compteurs.get(identifiant);
    if (!compteur || compteur.fin <= maintenant) {
      compteur = { nombre: 0, fin: maintenant + fenetre * 1000 };
      compteurs.set(identifiant, compteur);
      if (compteurs.size > 10_000) {
        for (const [cle, valeur] of compteurs) if (valeur.fin <= maintenant) compteurs.delete(cle);
      }
    }
    compteur.nombre += 1;
    return {
      succes: compteur.nombre <= requetes,
      limite: requetes,
      restant: Math.max(0, requetes - compteur.nombre),
      reinitialisation: compteur.fin,
    };
  };
}

function limiteurRedis(redis: Redis, famille: FamilleLimite, requetes: number, fenetre: number): Limiteur {
  const limiteur = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requetes, `${fenetre} s`),
    prefix: `data-dz-api:${famille}`,
    ephemeralCache: new Map(),
  });
  return async (identifiant) => {
    const resultat = await limiteur.limit(identifiant);
    return { succes: resultat.success, limite: resultat.limit, restant: resultat.remaining, reinitialisation: resultat.reset };
  };
}

const limiteurs = new Map<FamilleLimite, Limiteur>();

function limiteurPour(famille: FamilleLimite): Limiteur {
  let limiteur = limiteurs.get(famille);
  if (limiteur) return limiteur;
  const { requetes, fenetre } = LIMITES[famille];
  const config = lireConfig();
  limiteur =
    config.UPSTASH_REDIS_REST_URL && config.UPSTASH_REDIS_REST_TOKEN
      ? limiteurRedis(new Redis({ url: config.UPSTASH_REDIS_REST_URL, token: config.UPSTASH_REDIS_REST_TOKEN }), famille, requetes, fenetre)
      : limiteurMemoire(requetes, fenetre);
  limiteurs.set(famille, limiteur);
  return limiteur;
}

/** Adresse du client. Sur Vercel, `x-real-ip` est posé par la plateforme (non falsifiable par le client). */
export function adresseClient(c: Context): string {
  return (
    c.req.header("x-real-ip") ??
    c.req.header("x-vercel-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "inconnue"
  );
}

export function limiteDebit(famille: FamilleLimite): MiddlewareHandler {
  return async (c, next) => {
    const { fenetre } = LIMITES[famille];
    let verdict: Verdict;
    try {
      verdict = await limiteurPour(famille)(adresseClient(c));
    } catch (erreur) {
      // Redis indisponible : on laisse passer plutôt que de couper l'API (le WAF Vercel reste devant).
      console.error("limite-debit: limiteur indisponible", erreur);
      return next();
    }
    const secondesRestantes = Math.max(0, Math.ceil((verdict.reinitialisation - Date.now()) / 1000));
    // En-têtes du brouillon IETF « RateLimit header fields for HTTP ».
    c.header("RateLimit-Policy", `${verdict.limite};w=${fenetre}`);
    c.header("RateLimit", `limit=${verdict.limite}, remaining=${verdict.restant}, reset=${secondesRestantes}`);
    if (!verdict.succes) {
      c.header("Retry-After", String(Math.max(1, secondesRestantes)));
      throw new ErreurApi(429, "rate_limited", `Trop de requêtes : ${verdict.limite} par ${fenetre} s maximum. Réessayez dans ${secondesRestantes} s.`);
    }
    await next();
  };
}
