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

const { default: app } = await import("../src/index.js");

const ligne = {
  id: "d1",
  slug: "plages",
  titre: { fr: "Plages" },
  description: null,
  categorie_slug: "tourisme",
  licence_code: "ODbL-1.0",
  mots_cles: [],
  mis_a_jour_le: "2026-10-28T00:00:00Z",
  publie_le: "2026-10-27T00:00:00Z",
  cree_le: "2026-10-27T00:00:00Z",
  infos_source: { nb_enregistrements: 586 },
  illustration_url: null,
  score: 0,
  nb_votes_pour: 0,
  nb_votes_contre: 0,
  nb_favoris: 0,
  nb_commentaires: 0,
  sources: { slug: "geoalgeria", nom: "GeoAlgeria", url: null, verifiee: true },
  versions: {
    numero: "1.0.0",
    nb_lignes: 586,
    publie_le: "2026-10-27T00:00:00Z",
    colonnes: [{ nom: "name", type: "texte" }],
    fichiers: [
      { nom: "plages", format: "geojson", cle_stockage: "geojson/plages.geojson", principal: true, taille_octets: 1000 },
      { nom: "plages", format: "json", cle_stockage: "json/plages.json", principal: false, taille_octets: 500 },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("catalogue : ce que reçoivent les cartes", () => {
  it("renvoie colonnes, infos_source et ressources, jamais la clé de stockage", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify([ligne]), { status: 200, headers: { "content-type": "application/json", "content-range": "0-0/1" } })
    );
    const reponse = await app.request("/v1/datasets", { headers: { "x-real-ip": "203.0.113.90" } });
    expect(reponse.status).toBe(200);
    const texte = await reponse.text();
    expect(texte).not.toContain("cle_stockage");
    expect(texte).not.toContain("geojson/plages.geojson");
    const [donnee] = JSON.parse(texte).data;
    expect(donnee.infos_source).toEqual({ nb_enregistrements: 586 });
    expect(donnee.version.colonnes).toEqual([{ nom: "name", type: "texte" }]);
    expect(donnee.version.fichiers).toBeUndefined();
    expect(donnee.ressources).toHaveLength(1);
    expect(donnee.ressources[0]).toMatchObject({ nom: "plages", principal: true });
    expect(donnee.ressources[0].telechargements.map((t: { format: string }) => t.format)).toEqual(expect.arrayContaining(["csv", "geojson"]));
  });
});
