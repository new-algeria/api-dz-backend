import { z } from "@hono/zod-openapi";
import { FORMATS_SORTIE } from "./lib/conversion.js";

export const Slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80)
  .openapi({ param: { name: "slug", in: "path" }, example: "protection-civile" });

export const ParamsSlug = z.object({ slug: Slug });

/** Nom logique d'un fichier d'une donnée (ex. `postoffices`, `5g-mobilis`). */
export const NomFichier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
  .openapi({ example: "postoffices", description: "Nom du fichier (voir `ressources[].nom`). Par défaut : le fichier principal." });

const Multilingue = z
  .object({ fr: z.string().optional(), en: z.string().optional(), ar: z.string().optional() })
  .openapi("TexteMultilingue");

const Source = z
  .object({ slug: z.string(), nom: z.string(), url: z.string().nullable(), verifiee: z.boolean().optional() })
  .openapi("Source");

const Liens = z.object({ api: z.url(), page: z.url() });

const Compteurs = {
  id: z.uuid(),
  score: z.number(),
  nb_votes_pour: z.number(),
  nb_votes_contre: z.number(),
  nb_favoris: z.number(),
  nb_commentaires: z.number(),
};

const Ressource = z
  .object({
    nom: z.string(),
    principal: z.boolean(),
    fichiers: z.array(z.object({ format: z.string(), taille_octets: z.number().nullable(), url: z.url() })),
    telechargements: z.array(z.object({ format: z.enum(FORMATS_SORTIE), natif: z.boolean(), url: z.url() })),
  })
  .openapi("Ressource", { description: "Un fichier de la donnée, dans ses formats d'origine et les formats de téléchargement." });

export const ResumeDonnee = z
  .looseObject({
    ...Compteurs,
    slug: z.string(),
    titre: Multilingue,
    description: Multilingue.nullable(),
    categorie_slug: z.string().nullable(),
    licence_code: z.string().nullable(),
    mots_cles: z.array(z.string()).nullable(),
    mis_a_jour_le: z.string(),
    publie_le: z.string().nullable().openapi({ description: "Première publication dans le catalogue" }),
    cree_le: z.string(),
    illustration_url: z.string().nullable(),
    diffusion_restreinte: z.boolean().openapi({
      description: "Fichiers non redistribuables par data-dz : `ressources` est vide et /data, /sample, /download répondent 403 `not_redistributable`",
    }),
    lien_paquet: z.string().nullable().openapi({ description: "Où obtenir une donnée restreinte (paquet npm de la source)" }),
    source: Source.nullable(),
    infos_source: z.record(z.string(), z.unknown()).nullable(),
    version: z
      .looseObject({
        numero: z.string(),
        nb_lignes: z.number().nullable(),
        publie_le: z.string().nullable(),
        colonnes: z.array(z.object({ nom: z.string(), type: z.string() })).nullable(),
      })
      .nullable(),
    ressources: z.array(Ressource).openapi({ description: "Fichiers de la version et leurs liens de téléchargement (comme la fiche)" }),
    liens: Liens,
  })
  .openapi("ResumeDonnee");

export const FicheDonnee = ResumeDonnee.extend({
  readme: z.string().nullable(),
  licence_details: z.string().nullable(),
  url_source: z.string().nullable(),
  wilayas: z.array(z.string()).nullable(),
  frequence_maj: z.string().nullable(),
  infos_source: z.record(z.string(), z.unknown()).nullable(),
  categorie: z.looseObject({ slug: z.string(), nom: Multilingue, icone: z.string().nullable() }).nullable(),
  licence: z.looseObject({ code: z.string(), nom: z.string(), url: z.string().nullable() }).nullable(),
  version: z
    .looseObject({
      numero: z.string(),
      notes: z.string().nullable(),
      nb_lignes: z.number().nullable(),
      colonnes: z.array(z.looseObject({ nom: z.string(), type: z.string().optional() })).nullable(),
      apercu: z.unknown(),
      publie_le: z.string().nullable(),
    })
    .nullable(),
  ressources: z.array(Ressource),
}).openapi("FicheDonnee");

export const Pagination = z.object({ page: z.number(), limit: z.number(), total: z.number(), pages: z.number() }).openapi("Pagination");

export const Probleme = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number(),
    code: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  })
  .openapi("Probleme", { description: "Erreur au format RFC 9457 (application/problem+json)." });

type StatutErreur = keyof typeof DESCRIPTIONS_ERREUR;
type ReponseErreur = { description: string; content: { "application/problem+json": { schema: typeof Probleme } } };

export const reponsesErreur = <S extends StatutErreur>(...statuts: S[]) =>
  Object.fromEntries(
    statuts.map((statut) => [
      statut,
      { description: DESCRIPTIONS_ERREUR[statut], content: { "application/problem+json": { schema: Probleme } } },
    ])
  ) as unknown as { [K in S]: ReponseErreur };

const DESCRIPTIONS_ERREUR = {
  400: "Paramètres invalides",
  401: "Authentification requise",
  403: "Accès refusé",
  404: "Introuvable",
  409: "Conflit",
  413: "Réponse ou envoi trop volumineux",
  422: "Conversion impossible pour ce fichier",
  429: "Trop de requêtes (voir les en-têtes RateLimit et Retry-After)",
  503: "Service non configuré",
} as const;
