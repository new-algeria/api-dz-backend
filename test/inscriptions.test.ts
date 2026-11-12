import { beforeAll, describe, expect, it } from "vitest";
import { construireEmailInscription, doitSignalerInscription } from "../src/lib/inscriptions.js";

beforeAll(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://exemple.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    R2_ACCOUNT_ID: "compte",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
  });
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_REST_API_URL;
});

const JOUR = 24 * 60 * 60 * 1000;
const maintenant = Date.parse("2026-11-12T12:00:00Z");

describe("doitSignalerInscription", () => {
  it("signale un compte récent pas encore signalé", () => {
    expect(doitSignalerInscription({ created_at: new Date(maintenant - 60_000).toISOString(), app_metadata: {} }, maintenant)).toBe(true);
  });

  it("ne signale jamais deux fois", () => {
    expect(doitSignalerInscription({ created_at: new Date(maintenant).toISOString(), app_metadata: { inscription_signalee: true } }, maintenant)).toBe(false);
  });

  it("ignore les comptes d'avant la fonction (plus de 7 jours)", () => {
    expect(doitSignalerInscription({ created_at: new Date(maintenant - 8 * JOUR).toISOString(), app_metadata: {} }, maintenant)).toBe(false);
    expect(doitSignalerInscription({ created_at: "pas une date", app_metadata: {} }, maintenant)).toBe(false);
  });
});

describe("construireEmailInscription", () => {
  const infos = {
    site: "new-algeria" as const,
    email: "amina@exemple.dz",
    pseudo: "amina",
    nomAffiche: "Amina B.",
    fournisseur: "google",
    creeLe: "2026-11-12T12:00:00Z",
  };

  it("indique le site, la personne et le mode de connexion", () => {
    const email = construireEmailInscription(infos);
    expect(email.sujet).toBe("🎉 Nouvel inscrit sur New Algeria : Amina B.");
    expect(email.texte).toContain("Site : New Algeria (newalgeria.org)");
    expect(email.texte).toContain("Email : amina@exemple.dz");
    expect(email.texte).toContain("Inscription via : Google");
    expect(email.texte).toContain("Profil public : https://newalgeria.org/members/amina");
    expect(email.html).toContain("https://newalgeria.org/members/amina");
  });

  it("échappe ce que le membre a saisi", () => {
    const email = construireEmailInscription({ ...infos, site: "data-dz", nomAffiche: '<img src=x onerror="alert(1)">' });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(email.texte).toContain("Site : data-dz (data-dz.com)");
  });

  it("reste lisible sans profil", () => {
    const email = construireEmailInscription({ ...infos, pseudo: null, nomAffiche: null, fournisseur: null });
    expect(email.sujet).toContain("amina@exemple.dz");
    expect(email.texte).not.toContain("Profil public");
  });
});

describe("POST /v1/members/registered", async () => {
  const { default: app } = await import("../src/index.js");
  const appeler = (init: RequestInit) =>
    app.request("/v1/members/registered", { method: "POST", ...init, headers: { "x-real-ip": "203.0.113.9", "Content-Type": "application/json", ...init.headers } });

  it("exige une session", async () => {
    const reponse = await appeler({ body: JSON.stringify({ site: "new-algeria" }) });
    expect(reponse.status).toBe(401);
    expect(reponse.headers.get("cache-control")).toBe("no-store");
  });

  it("refuse un site inconnu", async () => {
    const reponse = await appeler({ body: JSON.stringify({ site: "autre" }), headers: { Authorization: "Bearer x" } });
    expect(reponse.status).toBe(400);
  });

  it("accepte les appels de New Algeria (CORS), pas ceux d'un autre site", async () => {
    const preflight = (origine: string) =>
      app.request("/v1/members/registered", {
        method: "OPTIONS",
        headers: { Origin: origine, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
      });
    expect((await preflight("https://newalgeria.org")).headers.get("access-control-allow-origin")).toBe("https://newalgeria.org");
    expect((await preflight("https://www.data-dz.com")).headers.get("access-control-allow-origin")).toBe("https://www.data-dz.com");
    expect((await preflight("https://exemple.org")).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("est documentée dans OpenAPI", async () => {
    const spec = await (await app.request("/openapi.json")).json();
    expect(Object.keys(spec.paths)).toContain("/v1/members/registered");
  });
});
