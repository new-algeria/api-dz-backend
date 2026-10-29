import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import {
  chargerDonneeAdmin,
  creerDonnee,
  creerSource,
  enregistrerDonnee,
  enregistrerIllustration,
  FORMATS_ENVOI,
  listerDonneesAdmin,
  listerSourcesAdmin,
  modifierDonnee,
  preparerEnvoi,
  publierVersion,
  retirerIllustration,
  STATUTS,
  supprimerDonnee,
  TAILLE_MAX_ILLUSTRATION,
} from "../lib/admin.js";
import { sansCache } from "../lib/cache-http.js";
import { publierProposition } from "../lib/propositions.js";
import { ErreurApi } from "../lib/erreurs.js";
import { exigerAdmin } from "../middleware/admin.js";
import { limiteDebit } from "../middleware/limite-debit.js";
import { NomFichier, ParamsSlug, reponsesErreur, Slug } from "../schemas.js";
import type { EnvApp } from "../types.js";
import { crochetValidation } from "../validation.js";

export const routesAdmin = new OpenAPIHono<EnvApp>({ defaultHook: crochetValidation });

routesAdmin.openAPIRegistry.registerComponent("securitySchemes", "jeton", {
  type: "http",
  scheme: "bearer",
  description: "Session Supabase d'un administrateur, ou clé du script de synchronisation.",
});

routesAdmin.use("/v1/admin/*", limiteDebit("admin"), exigerAdmin, async (c, next) => {
  sansCache(c);
  await next();
});
const limiteImage = bodyLimit({
  maxSize: TAILLE_MAX_ILLUSTRATION + 64 * 1024,
  onError: () => {
    throw new ErreurApi(413, "file_too_large", "Image trop lourde (2 Mo maximum).");
  },
});
const limiteJson = bodyLimit({
  maxSize: 512 * 1024,
  onError: () => {
    throw new ErreurApi(413, "payload_too_large", "Corps de requête trop volumineux.");
  },
});
routesAdmin.use("/v1/admin/*", (c, next) => (c.req.path.endsWith("/illustration") ? limiteImage(c, next) : limiteJson(c, next)));

const securite = [{ jeton: [] }];
const Donnee = z.record(z.string(), z.unknown()).openapi("DonneeAdmin");
const contenu = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const ok = <T extends z.ZodType>(schema: T, description: string) => ({ 200: contenu(schema, description) });
const cree = <T extends z.ZodType>(schema: T, description: string) => ({ 201: contenu(schema, description) });

const Multilingue = z.object({
  fr: z.string().trim().min(1).max(300),
  en: z.string().trim().max(300).optional(),
  ar: z.string().trim().max(300).optional(),
});
const DescriptionMultilingue = z.object({
  fr: z.string().trim().max(5000).optional(),
  en: z.string().trim().max(5000).optional(),
  ar: z.string().trim().max(5000).optional(),
});
const UrlHttp = z.url({ protocol: /^https?$/ }).max(500);

const ChampsDonnee = z.object({
  titre: Multilingue,
  description: DescriptionMultilingue.nullable().optional(),
  readme: z.string().max(100_000).nullable().optional(),
  categorie_slug: z.string().regex(/^[a-z0-9-]{1,60}$/).nullable().optional(),
  source_slug: z.string().regex(/^[a-z0-9-]{1,60}$/).optional().openapi({ example: "communaute" }),
  licence_code: z.string().max(60).nullable().optional(),
  licence_details: z.string().max(2000).nullable().optional(),
  url_source: UrlHttp.nullable().optional(),
  mots_cles: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  wilayas: z.array(z.string().regex(/^\d{2}$/)).max(69).optional(),
  frequence_maj: z.string().max(60).nullable().optional(),
  infos_source: z.record(z.string(), z.unknown()).nullable().optional(),
  statut: z.enum(STATUTS).optional(),
});

// ---------------------------------------------------------------- Lecture

routesAdmin.openapi(
  createRoute({
    method: "get",
    path: "/v1/admin/datasets",
    tags: ["Administration"],
    summary: "Toutes les données (tous statuts)",
    security: securite,
    request: { query: z.object({ q: z.string().trim().max(200).optional(), statut: z.enum(STATUTS).optional() }) },
    responses: { ...ok(z.object({ data: z.array(Donnee) }), "Liste"), ...reponsesErreur(401, 403, 429) },
  }),
  async (c) => {
    const { q, statut } = c.req.valid("query");
    return c.json({ data: await listerDonneesAdmin(q, statut) }, 200);
  }
);

routesAdmin.openapi(
  createRoute({
    method: "get",
    path: "/v1/admin/datasets/{slug}",
    tags: ["Administration"],
    summary: "Une donnée (tous statuts)",
    security: securite,
    request: { params: ParamsSlug },
    responses: { ...ok(Donnee, "Donnée"), ...reponsesErreur(401, 403, 404) },
  }),
  async (c) => c.json(await chargerDonneeAdmin(c.req.valid("param").slug), 200)
);

// ---------------------------------------------------------------- Écriture

routesAdmin.openapi(
  createRoute({
    method: "post",
    path: "/v1/admin/datasets",
    tags: ["Administration"],
    summary: "Créer une donnée",
    description: "Créée en brouillon par défaut. Ajoutez ensuite ses fichiers (`/uploads` puis `/versions`) et son illustration.",
    security: securite,
    request: { body: { content: { "application/json": { schema: ChampsDonnee.extend({ slug: Slug }) } }, required: true } },
    responses: { ...cree(Donnee, "Donnée créée"), ...reponsesErreur(400, 401, 403, 409) },
  }),
  async (c) => {
    const { slug, ...champs } = c.req.valid("json");
    return c.json(await creerDonnee(slug, champs, c.get("acteur")), 201);
  }
);

routesAdmin.openapi(
  createRoute({
    method: "patch",
    path: "/v1/admin/datasets/{slug}",
    tags: ["Administration"],
    summary: "Modifier une donnée (dont masquer : `statut: archive` ou `brouillon`)",
    security: securite,
    request: { params: ParamsSlug, body: { content: { "application/json": { schema: ChampsDonnee.partial() } }, required: true } },
    responses: { ...ok(Donnee, "Donnée modifiée"), ...reponsesErreur(400, 401, 403, 404) },
  }),
  async (c) => c.json(await modifierDonnee(c.req.valid("param").slug, c.req.valid("json")), 200)
);

routesAdmin.openapi(
  createRoute({
    method: "put",
    path: "/v1/admin/datasets/{slug}",
    tags: ["Administration"],
    summary: "Créer ou mettre à jour (script de synchronisation)",
    description: "Idempotent. Une donnée nouvelle est publiée ; une donnée existante garde son statut et son illustration.",
    security: securite,
    request: { params: ParamsSlug, body: { content: { "application/json": { schema: ChampsDonnee } }, required: true } },
    responses: {
      ...ok(z.object({ donnee: Donnee, creee: z.boolean() }), "Donnée enregistrée"),
      ...reponsesErreur(400, 401, 403),
    },
  }),
  async (c) => c.json(await enregistrerDonnee(c.req.valid("param").slug, c.req.valid("json"), c.get("acteur")), 200)
);

routesAdmin.openapi(
  createRoute({
    method: "delete",
    path: "/v1/admin/datasets/{slug}",
    tags: ["Administration"],
    summary: "Supprimer définitivement une donnée",
    description: "Irréversible. Pour la retirer du site sans la perdre, préférez `PATCH` avec `statut: archive`.",
    security: securite,
    request: {
      params: ParamsSlug,
      query: z.object({ files: z.enum(["true", "false"]).default("true").transform((valeur) => valeur === "true") }),
    },
    responses: { 204: { description: "Supprimée" }, ...reponsesErreur(401, 403, 404, 409) },
  }),
  async (c) => {
    await supprimerDonnee(c.req.valid("param").slug, c.req.valid("query").files);
    return c.body(null, 204);
  }
);

// ---------------------------------------------------------------- Fichiers

routesAdmin.openapi(
  createRoute({
    method: "post",
    path: "/v1/admin/datasets/{slug}/uploads",
    tags: ["Administration"],
    summary: "Préparer l'envoi d'un fichier",
    description: "Renvoie une URL `PUT` signée (15 min) : envoyez le fichier directement à cette URL avec le `Content-Type` indiqué.",
    security: securite,
    request: {
      params: ParamsSlug,
      body: { content: { "application/json": { schema: z.object({ nom: NomFichier, format: z.enum(FORMATS_ENVOI) }) } }, required: true },
    },
    responses: {
      ...cree(
        z.object({ cle: z.string(), url: z.url(), methode: z.string(), content_type: z.string(), expire_dans: z.number() }),
        "URL d'envoi"
      ),
      ...reponsesErreur(400, 401, 403, 404),
    },
  }),
  async (c) => {
    const { nom, format } = c.req.valid("json");
    return c.json(await preparerEnvoi(c.req.valid("param").slug, nom, format), 201);
  }
);

routesAdmin.openapi(
  createRoute({
    method: "post",
    path: "/v1/admin/datasets/{slug}/versions",
    tags: ["Administration"],
    summary: "Publier une nouvelle version à partir des fichiers envoyés",
    description: "Chaque fichier est relu et validé. Le fichier principal donne le nombre de lignes, les colonnes et l'aperçu.",
    security: securite,
    request: {
      params: ParamsSlug,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              numero: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
              notes: z.string().max(2000).nullable().optional(),
              fichiers: z
                .array(z.object({ cle: z.string().max(300), nom: NomFichier, format: z.enum(FORMATS_ENVOI), principal: z.boolean().optional() }))
                .min(1)
                .max(30),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      ...cree(z.object({ numero: z.string(), nb_lignes: z.number(), colonnes: z.array(z.unknown()), fichiers: z.number() }), "Version publiée"),
      ...reponsesErreur(400, 401, 403, 404, 413, 422),
    },
  }),
  async (c) => c.json(await publierVersion(c.req.valid("param").slug, c.req.valid("json"), c.get("acteur")), 201)
);

// ---------------------------------------------------------------- Illustration

routesAdmin.openapi(
  createRoute({
    method: "post",
    path: "/v1/admin/datasets/{slug}/illustration",
    tags: ["Administration"],
    summary: "Remplacer l'illustration",
    description: "Champ `image` (multipart) : PNG, JPEG ou WebP, 2 Mo maximum. Idéalement 1200 × 720 en WebP.",
    security: securite,
    request: {
      params: ParamsSlug,
      body: { content: { "multipart/form-data": { schema: z.object({ image: z.any().openapi({ type: "string", format: "binary" }) }) } }, required: true },
    },
    responses: { ...ok(z.object({ illustration_url: z.url() }), "Illustration enregistrée"), ...reponsesErreur(400, 401, 403, 404, 413) },
  }),
  async (c) => {
    const image = (await c.req.formData()).get("image");
    if (!(image instanceof File)) throw new ErreurApi(400, "invalid_image", "Champ `image` manquant.");
    return c.json(await enregistrerIllustration(c.req.valid("param").slug, new Uint8Array(await image.arrayBuffer())), 200);
  }
);

routesAdmin.openapi(
  createRoute({
    method: "delete",
    path: "/v1/admin/datasets/{slug}/illustration",
    tags: ["Administration"],
    summary: "Retirer l'illustration (retour à l'image par défaut)",
    security: securite,
    request: { params: ParamsSlug },
    responses: { 204: { description: "Retirée" }, ...reponsesErreur(401, 403, 404) },
  }),
  async (c) => {
    await retirerIllustration(c.req.valid("param").slug);
    return c.body(null, 204);
  }
);

// ---------------------------------------------------------------- Sources

const SourceAdmin = z.record(z.string(), z.unknown()).openapi("SourceAdmin");

routesAdmin.openapi(
  createRoute({
    method: "get",
    path: "/v1/admin/sources",
    tags: ["Administration"],
    summary: "Toutes les sources (sans cache)",
    security: securite,
    responses: { ...ok(z.object({ data: z.array(SourceAdmin) }), "Sources"), ...reponsesErreur(401, 403) },
  }),
  async (c) => c.json({ data: await listerSourcesAdmin() }, 200)
);

routesAdmin.openapi(
  createRoute({
    method: "post",
    path: "/v1/admin/sources",
    tags: ["Administration"],
    summary: "Créer une source",
    description:
      "Slug tiré du nom. Le type est celui de la source « communauté ». 409 `source_exists` (avec `details.slug`) si une source porte déjà ce nom (casse et accents ignorés).",
    security: securite,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              nom: z.string().trim().min(2).max(200),
              url: UrlHttp.nullable().optional(),
              description: z.string().trim().max(1000).nullable().optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: { ...cree(SourceAdmin, "Source créée"), ...reponsesErreur(400, 401, 403, 409) },
  }),
  async (c) => c.json(await creerSource(c.req.valid("json")), 201)
);

// ---------------------------------------------------------------- Propositions

routesAdmin.openapi(
  createRoute({
    method: "post",
    path: "/v1/admin/submissions/{id}/publish",
    tags: ["Administration"],
    summary: "Mettre en ligne une proposition acceptée",
    description:
      "Nouvelle donnée : créée avec le contenu de la proposition et la source `source_slug` (par défaut « communauté »), puis publiée. Mise à jour : nouvelle version de la donnée visée. " +
      "Les fichiers CSV, JSON et GeoJSON sont copiés tels quels, un Excel devient un CSV (première feuille) ; les autres formats sont ignorés et listés. " +
      "La proposition passe ensuite en « publiée » et son auteur est notifié. Session d'un administrateur uniquement.",
    security: securite,
    request: {
      params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }),
      body: {
        content: { "application/json": { schema: z.object({ slug: Slug.optional(), source_slug: z.string().regex(/^[a-z0-9-]{1,60}$/).optional() }) } },
        required: false,
      },
    },
    responses: {
      ...ok(
        z.object({
          slug: z.string(),
          creee: z.boolean(),
          version: z.object({ numero: z.string(), nb_lignes: z.number(), colonnes: z.array(z.unknown()), fichiers: z.number() }),
          fichiers_ignores: z.array(z.string()),
        }),
        "Proposition en ligne"
      ),
      ...reponsesErreur(400, 401, 403, 404, 409, 422),
    },
  }),
  async (c) => {
    const corps = c.req.header("content-type")?.includes("application/json") ? c.req.valid("json") : {};
    return c.json(await publierProposition(c.req.valid("param").id, c.get("acteur"), corps), 200);
  }
);
