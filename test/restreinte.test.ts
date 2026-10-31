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
const { lienPaquet } = await import("../src/lib/catalogue.js");

/** Donnée non redistribuable (migration 20261031000011) : la fiche reste, les fichiers jamais. */
const poste = {
  id: "d2",
  slug: "poste",
  titre: { fr: "Bureaux de poste" },
  description: null,
  readme: null,
  categorie_slug: "administratif",
  licence_code: null,
  licence_details: "Données © Algérie Poste",
  url_source: "https://www.npmjs.com/package/@geoalgeria/poste",
  mots_cles: [],
  wilayas: [],
  frequence_maj: "hebdomadaire",
  mis_a_jour_le: "2026-10-28T00:00:00Z",
  publie_le: "2026-10-20T00:00:00Z",
  cree_le: "2026-10-20T00:00:00Z",
  infos_source: { paquet: "@geoalgeria/poste" },
  illustration_url: null,
  diffusion_restreinte: true,
  licence_manuelle: false,
  score: 0,
  nb_votes_pour: 0,
  nb_votes_contre: 0,
  nb_favoris: 0,
  nb_commentaires: 0,
  categories: null,
  licences: null,
  sources: { slug: "geoalgeria", nom: "GeoAlgeria", url: null, verifiee: true },
  versions: {
    numero: "1.0.0",
    notes: null,
    nb_lignes: 3908,
    publie_le: "2026-10-20T00:00:00Z",
    colonnes: [{ nom: "nom", type: "texte" }],
    apercu: [{ nom: "Bureau d'Alger-Centre" }],
    fichiers: [{ nom: "poste", format: "json", cle_stockage: "json/poste.json", principal: true, taille_octets: 1000, sha256: null }],
  },
};

/** Faux Supabase qui renvoie toujours `poste` ; note chaque appel (R2 compris, qui ne doit jamais être appelé). */
function simuler(liste: boolean) {
  const appels: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entree: RequestInfo | URL) => {
      const url = String(entree instanceof Request ? entree.url : entree);
      appels.push(url);
      return new Response(JSON.stringify(liste ? [poste] : poste), {
        status: 200,
        headers: { "content-type": "application/json", "content-range": "0-0/1" },
      });
    })
  );
  return appels;
}

const entetes = { headers: { "x-real-ip": "203.0.113.91" } };

afterEach(() => vi.unstubAllGlobals());

describe("données non redistribuables", () => {
  it("catalogue : pas de ressources, mais le lien vers le paquet npm", async () => {
    simuler(true);
    const reponse = await app.request("/v1/datasets", entetes);
    expect(reponse.status).toBe(200);
    const texte = await reponse.text();
    expect(texte).not.toContain("json/poste.json");
    expect(texte).not.toContain("/download");
    const [donnee] = JSON.parse(texte).data;
    expect(donnee.diffusion_restreinte).toBe(true);
    expect(donnee.lien_paquet).toBe("https://www.npmjs.com/package/@geoalgeria/poste");
    expect(donnee.ressources).toEqual([]);
    expect(donnee.licence_manuelle).toBeUndefined();
  });

  it("fiche : métadonnées et colonnes, sans aperçu ni fichier", async () => {
    simuler(false);
    const reponse = await app.request("/v1/datasets/poste", entetes);
    expect(reponse.status).toBe(200);
    const fiche = await reponse.json();
    expect(fiche.version.nb_lignes).toBe(3908);
    expect(fiche.version.colonnes).toEqual([{ nom: "nom", type: "texte" }]);
    expect(fiche.version.apercu).toBeNull();
    expect(fiche.ressources).toEqual([]);
  });

  it.each(["/v1/datasets/poste/download?format=csv", "/v1/datasets/poste/data", "/v1/datasets/poste/sample"])(
    "%s répond 403 sans jamais lire R2",
    async (chemin) => {
      const appels = simuler(false);
      const reponse = await app.request(chemin, entetes);
      expect(reponse.status).toBe(403);
      const probleme = await reponse.json();
      expect(probleme.code ?? probleme.type).toContain("not_redistributable");
      expect(appels.every((url) => url.startsWith("https://exemple.supabase.co"))).toBe(true);
    }
  );

  it("lien du paquet : nom de paquet valide, sinon page npm de la source, sinon rien", () => {
    expect(lienPaquet({ infos_source: { paquet: "geoalgeria" } })).toBe("https://www.npmjs.com/package/geoalgeria");
    expect(lienPaquet({ infos_source: { paquet: "<script>" }, url_source: "https://www.npmjs.com/package/@geoalgeria/poste" })).toBe(
      "https://www.npmjs.com/package/@geoalgeria/poste"
    );
    expect(lienPaquet({ infos_source: null, url_source: "https://dgpc.dz" })).toBeNull();
  });
});

describe("licence corrigée à la main", () => {
  it("la synchro ne réécrit ni la licence ni le statut", async () => {
    const { champsSynchronises } = await import("../src/lib/admin.js");
    const champs = { titre: { fr: "Protection civile" }, licence_code: "ODbL-1.0", licence_details: "ODbL-1.0", statut: "publie" as const };
    expect(champsSynchronises({ licence_manuelle: true }, champs)).toEqual({ titre: { fr: "Protection civile" } });
    expect(champsSynchronises({ licence_manuelle: false }, champs)).toEqual({
      titre: { fr: "Protection civile" },
      licence_code: "ODbL-1.0",
      licence_details: "ODbL-1.0",
    });
  });
});
