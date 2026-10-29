import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://exemple.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    R2_ACCOUNT_ID: "compte",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
    URL_API: "https://api.data-dz.com",
  });
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_REST_API_URL;
});

const { lienRenomme } = await import("../src/lib/admin.js");
const { default: app } = await import("../src/index.js");

/** Faux Supabase : aucune donnée sous `ancien`, mais `nouveau` porte `ancien` dans `anciens_slugs`. */
function simulerSupabase() {
  const appels: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entree: RequestInfo | URL) => {
      const url = decodeURIComponent(String(entree instanceof Request ? entree.url : entree));
      appels.push(url);
      const corps = url.includes("anciens_slugs=cs.{ancien}") ? [{ slug: "nouveau" }] : [];
      return new Response(JSON.stringify(corps), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
  return appels;
}

afterEach(() => vi.unstubAllGlobals());

describe("renommage d'une donnée", () => {
  it("réécrit les liens internes vers l'ancien identifiant", () => {
    expect(lienRenomme("/datasets/ancien", "ancien", "nouveau")).toBe("/datasets/nouveau");
    expect(lienRenomme("/datasets/ancien#comment-12", "ancien", "nouveau")).toBe("/datasets/nouveau#comment-12");
    expect(lienRenomme("/datasets/ancien?x=1", "ancien", "nouveau")).toBe("/datasets/nouveau?x=1");
    // Un autre identifiant qui commence pareil n'est pas touché.
    expect(lienRenomme("/datasets/ancien-bis", "ancien", "nouveau")).toBeNull();
    expect(lienRenomme("/my-submissions/1", "ancien", "nouveau")).toBeNull();
  });

  it("redirige l'ancien identifiant vers le nouveau (fiche et sous-routes, paramètres gardés)", async () => {
    const appels = simulerSupabase();
    const fiche = await app.request("/v1/datasets/ancien", { headers: { "x-real-ip": "203.0.113.50" } });
    expect(fiche.status).toBe(307);
    expect(fiche.headers.get("location")).toBe("/v1/datasets/nouveau");
    expect(appels.some((url) => url.includes("anciens_slugs=cs.{ancien}") && url.includes("statut=eq.publie"))).toBe(true);

    const donnees = await app.request("/v1/datasets/ancien/data?limit=5", { headers: { "x-real-ip": "203.0.113.51" } });
    expect(donnees.status).toBe(307);
    expect(donnees.headers.get("location")).toBe("/v1/datasets/nouveau/data?limit=5");
  });

  it("répond 404 quand l'identifiant n'a jamais existé", async () => {
    simulerSupabase();
    const reponse = await app.request("/v1/datasets/inconnu", { headers: { "x-real-ip": "203.0.113.52" } });
    expect(reponse.status).toBe(404);
  });
});
