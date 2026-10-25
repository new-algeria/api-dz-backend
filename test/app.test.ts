import { beforeAll, describe, expect, it } from "vitest";

// Configuration factice : ces tests n'appellent ni Supabase ni R2.
beforeAll(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://exemple.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    R2_ACCOUNT_ID: "compte",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
    URL_API: "https://api.data-dz.com",
    CLE_SYNCHRO: "x".repeat(40),
  });
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_REST_API_URL;
});

const { default: app } = await import("../src/index.js");

const requete = (chemin: string, init?: RequestInit) =>
  app.request(chemin, { ...init, headers: { "x-real-ip": "203.0.113.7", ...init?.headers } });

describe("API", () => {
  it("présente l'API à la racine", async () => {
    const reponse = await requete("/");
    expect(reponse.status).toBe(200);
    expect((await reponse.json()).documentation).toBe("https://api.data-dz.com/docs");
  });

  it("publie une spécification OpenAPI 3.1 avec les routes principales", async () => {
    const spec = await (await requete("/openapi.json")).json();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(["/v1/datasets", "/v1/datasets/{slug}", "/v1/datasets/{slug}/download", "/v1/admin/datasets"])
    );
  });

  it("pose les en-têtes de sécurité et un request id", async () => {
    const reponse = await requete("/health");
    expect(reponse.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(reponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reponse.headers.get("strict-transport-security")).toContain("max-age=63072000");
    expect(reponse.headers.get("x-request-id")).toBeTruthy();
  });

  it("autorise toutes les origines en lecture", async () => {
    const reponse = await requete("/health", { headers: { Origin: "https://exemple.org" } });
    expect(reponse.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("limite l'administration aux origines de data-dz", async () => {
    const preflight = (origine: string) =>
      requete("/v1/admin/datasets", {
        method: "OPTIONS",
        headers: { Origin: origine, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" },
      });
    expect((await preflight("https://data-dz.com")).headers.get("access-control-allow-origin")).toBe("https://data-dz.com");
    expect((await preflight("https://pirate.example")).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("répond 404 en problem+json", async () => {
    const reponse = await requete("/nulle-part");
    expect(reponse.status).toBe(404);
    expect(reponse.headers.get("content-type")).toContain("application/problem+json");
    const corps = await reponse.json();
    expect(corps).toMatchObject({ status: 404, code: "not_found" });
    expect(corps.requestId).toBeTruthy();
  });

  it("valide les paramètres (slug invalide → 400)", async () => {
    const reponse = await requete("/v1/datasets/PAS_UN_SLUG");
    expect(reponse.status).toBe(400);
    expect((await reponse.json()).code).toBe("invalid_parameters");
  });

  it("refuse un format de téléchargement inconnu", async () => {
    const reponse = await requete("/v1/datasets/sante/download?format=exe");
    expect(reponse.status).toBe(400);
  });

  it("exige un jeton pour l'administration", async () => {
    const reponse = await requete("/v1/admin/datasets");
    expect(reponse.status).toBe(401);
    expect(reponse.headers.get("cache-control")).toBe("no-store");
  });

  it("limite le débit par IP avec les en-têtes RateLimit", async () => {
    const ip = { "x-real-ip": "198.51.100.42" };
    let derniere: Response | undefined;
    for (let i = 0; i < 31; i++) derniere = await requete("/v1/datasets/sante/download?format=exe", { headers: ip });
    expect(derniere!.status).toBe(429);
    expect(derniere!.headers.get("retry-after")).toBeTruthy();
    expect(derniere!.headers.get("ratelimit-policy")).toBe("30;w=60");
    // Une autre IP n'est pas touchée.
    expect((await requete("/v1/datasets/sante/download?format=exe", { headers: { "x-real-ip": "198.51.100.43" } })).status).toBe(400);
  });
});

describe("cleLimite", async () => {
  const { cleLimite } = await import("../src/middleware/limite-debit.js");
  it("garde une IPv4 telle quelle", () => {
    expect(cleLimite("203.0.113.7")).toBe("203.0.113.7");
  });
  it("regroupe une IPv6 par /64, forme compressée ou non", () => {
    expect(cleLimite("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(cleLimite("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(cleLimite("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
});

describe("erreurBase", async () => {
  const { erreurBase } = await import("../src/lib/admin.js");
  const erreur = (code: string) => ({ code, message: "", details: "", hint: "", name: "PostgrestError" }) as Parameters<typeof erreurBase>[0];
  it("signale une migration manquante (colonne inconnue) au lieu d'un 502 opaque", () => {
    expect(erreurBase(erreur("42703"))).toMatchObject({ statut: 503, code: "schema_outdated" });
  });
  it("traduit un slug en double en conflit", () => {
    expect(erreurBase(erreur("23505"))).toMatchObject({ statut: 409, code: "conflict" });
  });
});

describe("OpenAPI", () => {
  it("met la spécification en cache", async () => {
    const reponse = await requete("/openapi.json");
    expect(reponse.headers.get("cdn-cache-control")).toContain("max-age=3600");
  });
});
