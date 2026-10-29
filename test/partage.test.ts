import { writeFileSync } from "node:fs";
import sharp from "sharp";
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
});

const { chiffresApercu, descriptionApercu, formatsDe, imageApercu, langueApercu, pagePartage, titreImage, urlIllustrationApercu } = await import(
  "../src/lib/partage.js"
);

const fiche = {
  slug: "pharmacies",
  titre: { fr: "Pharmacies d'Algérie", en: "Pharmacies in Algeria", ar: "صيدليات الجزائر" },
  description: { fr: "Toutes les pharmacies <recensées> par OpenStreetMap." },
  wilayas: ["16", "31", "25"],
  licence_code: "ODbL-1.0",
  illustration_url: null,
  mis_a_jour_le: "2026-10-28T10:00:00Z",
  categories: { slug: "sante", nom: { fr: "Santé", en: "Health" }, icone: "heart-pulse" },
  sources: { nom: "GeoAlgeria" },
  versions: {
    nb_lignes: 12345,
    fichiers: [
      { format: "json", nom: "pharmacies" },
      { format: "geojson", nom: "pharmacies" },
      { format: "csv", nom: "gardes" },
    ],
  },
};

describe("aperçu sur les réseaux sociaux", () => {
  it("choisit la langue (anglais par défaut)", () => {
    expect(langueApercu(undefined)).toBe("en");
    expect(langueApercu("fr-FR")).toBe("fr");
    expect(langueApercu("ar")).toBe("ar");
    expect(langueApercu("de")).toBe("en");
  });

  it("n'écrit jamais d'arabe sur l'image (police latine, pas de droite à gauche)", () => {
    expect(titreImage(fiche, "ar")).toBe("Pharmacies in Algeria");
    expect(titreImage({ ...fiche, titre: { fr: "صيدليات", ar: "صيدليات" } }, "fr")).toBe("Pharmacies");
    expect(titreImage({ ...fiche, slug: "pharmacies-de-garde", titre: null }, "en")).toBe("Pharmacies de garde");
  });

  it("résume les chiffres et les formats", () => {
    expect(chiffresApercu(fiche, "en")).toEqual([
      { valeur: "12,345", libelle: "rows" },
      { valeur: "2", libelle: "files" },
      { valeur: "3", libelle: "wilayas" },
    ]);
    expect(chiffresApercu(fiche, "fr")[0]).toEqual({ valeur: "12 345", libelle: "lignes" });
    expect(formatsDe(fiche)).toEqual(["GeoJSON", "CSV", "JSON"]);
    expect(chiffresApercu({ slug: "x", titre: null, description: null }, "en")).toEqual([]);
  });

  it("décrit la donnée, sinon ses chiffres", () => {
    expect(descriptionApercu(fiche, "fr")).toBe("Toutes les pharmacies <recensées> par OpenStreetMap.");
    expect(descriptionApercu({ ...fiche, description: null }, "en")).toBe("12,345 rows · 2 files · 3 wilayas · Source: GeoAlgeria · Open data on Algeria");
  });

  it("écrit des balises Open Graph échappées, avec l'image versionnée", () => {
    const page = pagePartage(fiche, "fr");
    expect(page).toContain('<meta property="og:title" content="Pharmacies d&#39;Algérie">');
    expect(page).toContain("&lt;recensées&gt;");
    expect(page).toContain('<meta property="og:url" content="https://data-dz.com/datasets/pharmacies">');
    expect(page).toContain(
      '<meta property="og:image" content="https://api.data-dz.com/v1/datasets/pharmacies/preview.png?lng=fr&amp;v=2026-10-28T10%3A00%3A00Z">'
    );
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(pagePartage(fiche, "ar")).toContain('<html lang="ar" dir="rtl">');
    expect(pagePartage(fiche, "en")).toContain("https://data-dz.com/datasets/pharmacies?lng=en");
  });

  it("n'utilise que des illustrations du domaine public des fichiers", () => {
    expect(urlIllustrationApercu(fiche)).toBe("https://files.data-dz.com/web-assets/webp/22-pharmacies-600.webp");
    expect(urlIllustrationApercu({ ...fiche, illustration_url: "https://ailleurs.example/x.png" })).toBeNull();
    expect(urlIllustrationApercu({ ...fiche, slug: "sans-image" })).toBeNull();
  });

  it("dessine une image PNG de 1200 × 630", async () => {
    // Sans illustration : aucun appel réseau.
    const png = await imageApercu({ ...fiche, slug: "sans-image" }, "en");
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const vue = new DataView(png.buffer, png.byteOffset);
    expect([vue.getUint32(16), vue.getUint32(20)]).toEqual([1200, 630]);
    if (process.env.APERCU_SORTIE) writeFileSync(process.env.APERCU_SORTIE, png);
  }, 20000);

  it("dessine l'illustration WebP de la donnée (convertie en PNG), et s'en passe si elle manque", async () => {
    const webp = await sharp({ create: { width: 600, height: 360, channels: 3, background: "#d97706" } }).webp().toBuffer();
    const appels: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      appels.push(String(url));
      return new Response(new Uint8Array(webp), { headers: { "content-type": "image/webp" } });
    });
    const avec = await imageApercu(fiche, "fr");
    expect(appels).toEqual(["https://files.data-dz.com/web-assets/webp/22-pharmacies-600.webp"]);
    vi.stubGlobal("fetch", async () => new Response("absente", { status: 404 }));
    const sans = await imageApercu(fiche, "fr");
    expect(Buffer.from(avec).equals(Buffer.from(sans))).toBe(false);
    if (process.env.APERCU_SORTIE) writeFileSync(process.env.APERCU_SORTIE.replace(".png", "-illustration.png"), avec);
  }, 20000);
});

afterEach(() => vi.unstubAllGlobals());

describe("routes d'aperçu", () => {
  it("sont documentées", async () => {
    const { default: app } = await import("../src/index.js");
    const spec = await (await app.request("/openapi.json")).json();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/datasets/{slug}/share", "/v1/datasets/{slug}/preview.png"]));
  });
});
