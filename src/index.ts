import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
// Import direct de "hono" : Vercel s'en sert pour détecter le point d'entrée (preset Hono).
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { lireConfig } from "./config.js";
import { mettreEnCache } from "./lib/cache-http.js";
import { ErreurApi, reponseProbleme } from "./lib/erreurs.js";
import { LIMITES } from "./middleware/limite-debit.js";
import { routesAdmin } from "./routes/admin.js";
import { routesPubliques } from "./routes/public.js";
import type { EnvApp } from "./types.js";

const app = new OpenAPIHono<EnvApp>();

app.use(requestId());
app.use(logger());
app.use(trimTrailingSlash());

// En-têtes de sécurité. Une API JSON n'a besoin d'aucune ressource : CSP fermée, sauf la page /docs (Scalar).
app.use(
  secureHeaders({
    crossOriginResourcePolicy: "cross-origin",
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    referrerPolicy: "no-referrer",
  })
);
app.use(async (c, next) => {
  await next();
  if (c.req.path !== "/docs") c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
});

// CORS : lecture publique depuis n'importe quel site ; administration réservée aux origines de data-dz.
const corsPublic = cors({
  origin: "*",
  allowMethods: ["GET", "HEAD", "OPTIONS"],
  exposeHeaders: ["RateLimit", "RateLimit-Policy", "Retry-After", "X-Request-Id", "ETag"],
  maxAge: 86400,
});
let corsAdmin: ReturnType<typeof cors> | undefined;
app.use("*", (c, next) => {
  if (!c.req.path.startsWith("/v1/admin")) return corsPublic(c, next);
  corsAdmin ??= cors({
    origin: lireConfig().ORIGINES_ADMIN,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    exposeHeaders: ["RateLimit", "RateLimit-Policy", "Retry-After", "X-Request-Id"],
    maxAge: 600,
  });
  return corsAdmin(c, next);
});

app.use("/v1/*", etag());

app.get("/", (c) => {
  mettreEnCache(c, "documentation");
  return c.json({
    nom: "API data-dz",
    description: "Données ouvertes sur l'Algérie : catalogue, enregistrements, conversions CSV / XLSX / JSON / GeoJSON.",
    documentation: `${lireConfig().URL_API}/docs`,
    openapi: `${lireConfig().URL_API}/openapi.json`,
    site: "https://data-dz.com",
    limites: Object.fromEntries(Object.entries(LIMITES).filter(([famille]) => famille !== "admin").map(([famille, l]) => [famille, `${l.requetes} requêtes / ${l.fenetre} s / IP`])),
    exemples: [
      "/v1/datasets",
      "/v1/datasets/protection-civile",
      "/v1/datasets/protection-civile/data?limit=10",
      "/v1/datasets/protection-civile/download?format=csv",
    ],
  });
});

app.get("/health", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ statut: "ok" });
});

app.route("/", routesPubliques);
app.route("/", routesAdmin);

// Avant doc31 : son gestionnaire ne passe pas la main, un middleware déclaré après ne s'exécuterait jamais.
app.use("/openapi.json", async (c, next) => {
  await next();
  mettreEnCache(c, "documentation");
});
app.doc31("/openapi.json", (c) => ({
  openapi: "3.1.0",
  info: {
    title: "API data-dz",
    version: "1.0.0",
    description:
      "API publique et gratuite des données ouvertes sur l'Algérie publiées sur [data-dz.com](https://data-dz.com).\n\n" +
      "**Sans clé**, mais limitée par adresse IP (en-têtes `RateLimit`, `RateLimit-Policy`, `Retry-After` en cas de 429). " +
      "Les réponses sont mises en cache par le CDN : réutilisez-les plutôt que de les redemander.\n\n" +
      "Erreurs au format RFC 9457 (`application/problem+json`). Respectez la licence et l'attribution de chaque donnée (`licence`, `source`).",
    contact: { name: "New Algeria", url: "https://newalgeria.org" },
  },
  servers: [{ url: new URL(c.req.url).origin }],
  tags: [
    { name: "Données", description: "Catalogue, fiches, enregistrements et téléchargements" },
    { name: "Référentiels", description: "Catégories, licences, sources, chiffres" },
    { name: "Administration", description: "Réservé aux administrateurs de data-dz et au script de synchronisation" },
  ],
}));
app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "API data-dz" }));

app.notFound((c) => reponseProbleme(c, new ErreurApi(404, "not_found", "Route inconnue. Voir /docs.")));

app.onError((erreur, c) => {
  if (erreur instanceof ErreurApi) return reponseProbleme(c, erreur);
  if (erreur instanceof HTTPException) return reponseProbleme(c, new ErreurApi(erreur.status as 400, "http_error", erreur.message));
  // Erreur inattendue : détail dans les logs (avec le requestId), message générique au client.
  console.error(`[${c.get("requestId")}]`, erreur);
  return reponseProbleme(c, new ErreurApi(500, "internal_error", "Erreur interne. Réessayez plus tard."));
});

export default app satisfies Hono<EnvApp>;
