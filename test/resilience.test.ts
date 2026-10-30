import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Panne simulée : les modules natifs de l'image ne se chargent pas (cas de la production le 30/10/2026).
vi.mock("sharp", () => {
  throw new Error("Could not load the sharp module using the linux-x64 runtime");
});
vi.mock("@resvg/resvg-js", () => {
  throw new Error("Cannot find native binding");
});

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

const { default: app } = await import("../src/index.js");

/** Faux Supabase : une fiche publiée pour `/datasets`, des listes vides ailleurs. */
function simulerSupabase() {
  vi.stubGlobal("fetch", async (entree: RequestInfo | URL) => {
    const url = decodeURIComponent(String(entree instanceof Request ? entree.url : entree));
    const fiche = { slug: "pharmacies", titre: { fr: "Pharmacies" }, description: null, versions: null, categories: null, sources: null, licences: null };
    const corps = url.includes("/rest/v1/datasets") && url.includes("slug=eq.pharmacies") ? fiche : [];
    return new Response(JSON.stringify(corps), { status: 200, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("une panne des modules de l'image ne touche que l'image", () => {
  it("l'API démarre et répond", async () => {
    simulerSupabase();
    expect((await app.request("/v1/categories", { headers: { "x-real-ip": "203.0.113.80" } })).status).toBe(200);
    expect((await app.request("/health")).status).toBe(200);
  });

  it("la page de partage répond, l'image retombe sur l'image générale du site", async () => {
    simulerSupabase();
    const page = await app.request("/v1/datasets/pharmacies/share", { headers: { "x-real-ip": "203.0.113.81" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('property="og:title"');
    const image = await app.request("/v1/datasets/pharmacies/preview.png", { headers: { "x-real-ip": "203.0.113.82" } });
    expect(image.status).toBe(302);
    expect(image.headers.get("location")).toBe("https://data-dz.com/og-image.png");
  });
});
