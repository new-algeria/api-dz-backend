import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { mettreEnCache } from "../lib/cache-http.js";
import { URL_SITE } from "../lib/catalogue.js";
import {
  chargerFicheInterne,
  chargerStatistiques,
  listerCategories,
  listerDonnees,
  listerLicences,
  listerSources,
  versFiche,
} from "../lib/catalogue.js";
import { colonnesDe, FORMATS_SORTIE, lignesAPlat } from "../lib/conversion.js";
import { ErreurApi, introuvable } from "../lib/erreurs.js";
import { lienTelechargement, lireTableDonnee } from "../lib/fichiers.js";
import { langueApercu, pageIntrouvable, pagePartage, type FicheApercu } from "../lib/partage.js";
import { limiteDebit } from "../middleware/limite-debit.js";
import { FicheDonnee, NomFichier, Pagination, ParamsSlug, reponsesErreur, ResumeDonnee } from "../schemas.js";
import type { EnvApp } from "../types.js";
import { crochetValidation } from "../validation.js";

export const routesPubliques = new OpenAPIHono<EnvApp>({ defaultHook: crochetValidation });

const TAILLE_MAX_REPONSE = 4_000_000; // Vercel refuse les réponses de plus de 4,5 Mo.

// Familles de limites : le plus spécifique d'abord (un seul middleware s'applique par requête).
routesPubliques.use("/v1/datasets/:slug/download", limiteDebit("telechargement"));
routesPubliques.use("/v1/datasets/:slug/data", limiteDebit("donnees"));
routesPubliques.use("/v1/datasets/:slug/sample", limiteDebit("donnees"));
routesPubliques.use("/v1/*", async (c, next) => {
  // Routes à limite propre, et administration (limitée dans routes/admin.ts) : pas de double comptage.
  if (/^\/v1\/admin\//.test(c.req.path) || /^\/v1\/datasets\/[^/]+\/(download|data|sample)$/.test(c.req.path)) return next();
  return limiteDebit("lecture")(c, next);
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  200: { description, content: { "application/json": { schema } } },
});

// ---------------------------------------------------------------- Catalogue

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets",
    tags: ["Données"],
    summary: "Catalogue des données publiées",
    description: "Recherche plein texte, filtres et pagination. Les données masquées ou en brouillon n'apparaissent jamais.",
    request: {
      query: z.object({
        q: z.string().trim().max(200).optional().openapi({ description: "Recherche : chaque mot (pluriel accepté) doit commencer un mot du titre, de la description ou des mots-clés, ou figurer dans le titre ou la description (fr, en, ar)", example: "pharmacie" }),
        category: z.string().regex(/^[a-z0-9-]{1,60}$/).optional().openapi({ example: "sante" }),
        source: z.string().regex(/^[a-z0-9-]{1,60}$/).optional().openapi({ example: "geoalgeria" }),
        wilaya: z.string().regex(/^\d{2}$/).optional().openapi({ description: "Code de wilaya (01 à 69)", example: "16" }),
        sort: z.enum(["top", "recent", "name"]).default("name"),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    },
    responses: {
      ...json(z.object({ data: z.array(ResumeDonnee), pagination: Pagination }), "Liste paginée"),
      ...reponsesErreur(400, 429),
    },
  }),
  async (c) => {
    const { data, pagination } = await listerDonnees(c.req.valid("query"));
    mettreEnCache(c, "vivant");
    return c.json({ data: data as z.infer<typeof ResumeDonnee>[], pagination }, 200);
  }
);

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets/{slug}",
    tags: ["Données"],
    summary: "Fiche d'une donnée",
    description: "Métadonnées, version courante, colonnes, aperçu, fichiers et liens de téléchargement.",
    request: { params: ParamsSlug },
    responses: { ...json(FicheDonnee, "Fiche"), ...reponsesErreur(400, 404, 429) },
  }),
  async (c) => {
    const resultat = await chargerFicheInterne(c.req.valid("param").slug);
    if (!resultat) throw introuvable("Donnée");
    mettreEnCache(c, "vivant");
    return c.json(versFiche(resultat.fiche, resultat.fichiers) as z.infer<typeof FicheDonnee>, 200);
  }
);

// ---------------------------------------------------------------- Lignes

const Ligne = z.record(z.string(), z.unknown()).openapi("Ligne");

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets/{slug}/data",
    tags: ["Données"],
    summary: "Lignes d'un fichier (JSON paginé)",
    description:
      "Lit le fichier (principal par défaut) et renvoie ses enregistrements. Les points deviennent `longitude` / `latitude` ; " +
      "les autres géométries ne sont incluses qu'avec `geometry=wkt`. Pour le fichier complet, utilisez `/download`.",
    request: {
      params: ParamsSlug,
      query: z.object({
        file: NomFichier.optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        fields: z
          .string()
          .regex(/^[\w-]+(,[\w-]+)*$/)
          .optional()
          .openapi({ description: "Colonnes à garder, séparées par des virgules", example: "name,wilaya_code,lat,lng" }),
        wilaya: z.string().regex(/^\d{2}$/).optional().openapi({ description: "Filtre sur la colonne `wilaya_code`", example: "16" }),
        geometry: z.enum(["none", "wkt"]).default("none"),
      }),
    },
    responses: {
      ...json(
        z.object({
          fichier: z.string(),
          colonnes: z.array(z.string()),
          data: z.array(Ligne),
          pagination: z.object({ offset: z.number(), limit: z.number(), total: z.number() }),
        }),
        "Enregistrements"
      ),
      ...reponsesErreur(400, 404, 413, 422, 429),
    },
  }),
  async (c) => {
    const { slug } = c.req.valid("param");
    const { file, offset, limit, fields, wilaya, geometry } = c.req.valid("query");
    const { nom, table } = await lireTableDonnee(slug, file);

    let lignes = geometry === "wkt" ? lignesAPlat(table) : lignesAPlat({ ...table, geometries: table.geometries?.map((g) => (g?.type === "Point" ? g : null)) ?? null });
    if (wilaya) lignes = lignes.filter((ligne) => String(ligne.wilaya_code ?? "").padStart(2, "0") === wilaya);
    const total = lignes.length;
    let page = lignes.slice(offset, offset + limit);
    const champs = fields?.split(",");
    if (champs) page = page.map((ligne) => Object.fromEntries(champs.filter((champ) => champ in ligne).map((champ) => [champ, ligne[champ]])));

    const corps = { fichier: nom, colonnes: champs ?? colonnesDe(lignes.slice(0, 1000)), data: page, pagination: { offset, limit, total } };
    if (Buffer.byteLength(JSON.stringify(corps)) > TAILLE_MAX_REPONSE) {
      throw new ErreurApi(413, "response_too_large", "Réponse trop volumineuse : réduisez `limit`, choisissez des `fields` ou utilisez `/download`.");
    }
    mettreEnCache(c, "donnees");
    return c.json(corps, 200);
  }
);

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets/{slug}/sample",
    tags: ["Données"],
    summary: "Échantillon d'enregistrements",
    request: {
      params: ParamsSlug,
      query: z.object({
        file: NomFichier.optional(),
        n: z.coerce.number().int().min(1).max(50).default(5),
        random: z.enum(["true", "false", "1", "0"]).default("false").transform((valeur) => valeur === "true" || valeur === "1"),
      }),
    },
    responses: { ...json(z.object({ fichier: z.string(), data: z.array(Ligne) }), "Échantillon"), ...reponsesErreur(400, 404, 422, 429) },
  }),
  async (c) => {
    const { slug } = c.req.valid("param");
    const { file, n, random } = c.req.valid("query");
    const { nom, table } = await lireTableDonnee(slug, file);
    const lignes = lignesAPlat({ ...table, geometries: table.geometries?.map((g) => (g?.type === "Point" ? g : null)) ?? null });
    let echantillon = lignes.slice(0, n);
    if (random) {
      const indices = new Set<number>();
      while (indices.size < Math.min(n, lignes.length)) indices.add(Math.floor(Math.random() * lignes.length));
      echantillon = [...indices].map((indice) => lignes[indice]);
    }
    mettreEnCache(c, random ? "vivant" : "donnees");
    return c.json({ fichier: nom, data: echantillon }, 200);
  }
);

// ---------------------------------------------------------------- Téléchargement

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets/{slug}/download",
    tags: ["Données"],
    summary: "Télécharger un fichier (CSV, XLSX, JSON, GeoJSON)",
    description:
      "Redirige (302) vers un lien signé valable 10 minutes. Les conversions sont faites une seule fois par version du fichier. " +
      "Partagez toujours cette URL, jamais le lien signé (il expire).",
    request: {
      params: ParamsSlug,
      query: z.object({
        format: z.enum(FORMATS_SORTIE).default("json"),
        file: NomFichier.optional(),
        inline: z.enum(["1", "0", "true", "false"]).optional().transform((valeur) => valeur === "1" || valeur === "true"),
      }),
    },
    responses: {
      302: { description: "Redirection vers le fichier", headers: z.object({ Location: z.url() }) },
      ...reponsesErreur(400, 404, 422, 429),
    },
  }),
  async (c) => {
    const { slug } = c.req.valid("param");
    const { format, file, inline } = c.req.valid("query");
    const lien = await lienTelechargement(slug, format, file, inline);
    mettreEnCache(c, "redirection");
    return c.redirect(lien, 302);
  }
);

// ---------------------------------------------------------------- Référentiels

const Categorie = z
  .object({ slug: z.string(), nom: z.record(z.string(), z.string()), icone: z.string().nullable(), ordre: z.number() })
  .openapi("Categorie");

// ---------------------------------------------------------------- Aperçu sur les réseaux sociaux

const QueryLangue = z.object({
  lng: z.string().max(10).optional().openapi({ description: "fr, en ou ar (anglais par défaut)", example: "fr" }),
  v: z.string().max(60).optional().openapi({ description: "Version de l'image (date de mise à jour), pour les caches" }),
});

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets/{slug}/share",
    tags: ["Données"],
    summary: "Page d'aperçu pour les réseaux sociaux",
    description:
      "Balises Open Graph et Twitter de la fiche (titre, description, image `preview.png`), puis renvoi vers la fiche. " +
      "Servie aux robots des réseaux sociaux à la place de https://data-dz.com/datasets/{slug}.",
    request: { params: ParamsSlug, query: QueryLangue },
    responses: { 200: { description: "Page HTML", content: { "text/html": { schema: z.string() } } }, ...reponsesErreur(404, 429) },
  }),
  async (c) => {
    const resultat = await chargerFicheInterne(c.req.valid("param").slug);
    mettreEnCache(c, "apercu");
    if (!resultat) return c.html(pageIntrouvable(), 404);
    return c.html(pagePartage(resultat.fiche as unknown as FicheApercu, langueApercu(c.req.valid("query").lng)), 200);
  }
);

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/datasets/{slug}/preview.png",
    tags: ["Données"],
    summary: "Image d'aperçu (1200 × 630)",
    description: "Logo data-dz, drapeau, catégorie, titre, source, chiffres et illustration de la donnée. En cas d'échec : redirection vers l'image générale du site.",
    request: { params: ParamsSlug, query: QueryLangue },
    responses: {
      200: { description: "Image PNG", content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } } },
      302: { description: "Image générale du site" },
      ...reponsesErreur(404, 429),
    },
  }),
  async (c) => {
    const resultat = await chargerFicheInterne(c.req.valid("param").slug);
    if (!resultat) throw introuvable("Donnée");
    try {
      // Chargé à la demande : un module natif ou WebAssembly qui ne charge pas ne touche que l'image.
      const { imageApercu } = await import("../lib/image-apercu.js");
      const png = await imageApercu(resultat.fiche as unknown as FicheApercu, langueApercu(c.req.valid("query").lng));
      mettreEnCache(c, "apercu");
      return c.body(png as Uint8Array<ArrayBuffer>, 200, { "Content-Type": "image/png" });
    } catch (erreur) {
      // Mieux vaut l'image générale qu'un aperçu vide.
      console.error("apercu:", erreur);
      mettreEnCache(c, "redirection");
      return c.redirect(`${URL_SITE}/og-image.png`, 302);
    }
  }
);

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/categories",
    tags: ["Référentiels"],
    summary: "Catégories",
    responses: { ...json(z.object({ data: z.array(Categorie) }), "Catégories"), ...reponsesErreur(429) },
  }),
  async (c) => {
    mettreEnCache(c, "referentiel");
    return c.json({ data: (await listerCategories()) as z.infer<typeof Categorie>[] }, 200);
  }
);

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/licences",
    tags: ["Référentiels"],
    summary: "Licences",
    responses: { ...json(z.object({ data: z.array(z.record(z.string(), z.unknown())) }), "Licences"), ...reponsesErreur(429) },
  }),
  async (c) => {
    mettreEnCache(c, "referentiel");
    return c.json({ data: await listerLicences() }, 200);
  }
);

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/sources",
    tags: ["Référentiels"],
    summary: "Sources des données",
    responses: { ...json(z.object({ data: z.array(z.record(z.string(), z.unknown())) }), "Sources"), ...reponsesErreur(429) },
  }),
  async (c) => {
    mettreEnCache(c, "referentiel");
    return c.json({ data: await listerSources() }, 200);
  }
);

routesPubliques.openapi(
  createRoute({
    method: "get",
    path: "/v1/stats",
    tags: ["Référentiels"],
    summary: "Chiffres du catalogue",
    responses: {
      ...json(
        z.object({ nb_donnees: z.number(), nb_categories: z.number(), total_lignes: z.number(), nb_membres: z.number() }),
        "Statistiques"
      ),
      ...reponsesErreur(429),
    },
  }),
  async (c) => {
    mettreEnCache(c, "referentiel");
    return c.json(await chargerStatistiques(), 200);
  }
);
