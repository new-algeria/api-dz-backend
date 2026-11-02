import { beforeAll, describe, expect, it } from "vitest";

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

const { etatSynchro } = await import("../src/lib/synchro.js");
const { aLaPermission, permissionRequise } = await import("../src/lib/permissions.js");
const { ressourcesDe } = await import("../src/lib/catalogue.js");
const { versionSuivante } = await import("../src/lib/admin.js");

const JOUR = 24 * 60 * 60 * 1000;
const maintenant = new Date("2026-12-01T03:20:00Z");
const base = { mode: "interne" as const, actif: true, intervalle_jours: 30, forcer: false };

describe("échéance des synchronisations", () => {
  it("travaille la première fois, puis à l'échéance (marge de 2 h)", () => {
    expect(etatSynchro({ ...base, derniere_execution: null }, maintenant).a_faire).toBe(true);
    const ilYa30Jours = new Date(maintenant.getTime() - 30 * JOUR + 60 * 60 * 1000).toISOString();
    expect(etatSynchro({ ...base, derniere_execution: ilYa30Jours }, maintenant).a_faire).toBe(true);
    const ilYa29Jours = new Date(maintenant.getTime() - 29 * JOUR).toISOString();
    const etat = etatSynchro({ ...base, derniere_execution: ilYa29Jours }, maintenant);
    expect(etat.a_faire).toBe(false);
    expect(etat.prochaine_execution).toBe(new Date(maintenant.getTime() + JOUR).toISOString());
  });

  it("« forcer » passe outre l'échéance, sauf synchronisation inactive ou externe", () => {
    const hier = new Date(maintenant.getTime() - JOUR).toISOString();
    expect(etatSynchro({ ...base, forcer: true, derniere_execution: hier }, maintenant).a_faire).toBe(true);
    expect(etatSynchro({ ...base, forcer: true, actif: false, derniere_execution: hier }, maintenant).a_faire).toBe(false);
    expect(etatSynchro({ ...base, mode: "externe", derniere_execution: null }, maintenant).a_faire).toBe(false);
  });
});

describe("permissions", () => {
  it("les synchronisations demandent synchro.gerer, le reste donnees.gerer", () => {
    expect(permissionRequise("/v1/admin/sync")).toBe("synchro.gerer");
    expect(permissionRequise("/v1/admin/sync/openstreetmap/runs")).toBe("synchro.gerer");
    expect(permissionRequise("/v1/admin/synchronized")).toBe("donnees.gerer");
    expect(permissionRequise("/v1/admin/datasets/sante/versions")).toBe("donnees.gerer");
  });

  it("un administrateur a toutes les permissions", () => {
    expect(aLaPermission({ admin: true, permissions: [] }, "synchro.gerer")).toBe(true);
    expect(aLaPermission({ admin: false, permissions: ["donnees.gerer"] }, "donnees.gerer")).toBe(true);
    expect(aLaPermission({ admin: false, permissions: ["donnees.gerer"] }, "synchro.gerer")).toBe(false);
  });
});

describe("ressources par source", () => {
  it("chaque fichier porte sa source et sa licence, sinon celles de la donnée", () => {
    const ressources = ressourcesDe(
      "sante",
      [
        { nom: "sante", format: "geojson", cle_stockage: "geojson/sante.geojson", principal: true, taille_octets: 10 },
        {
          nom: "hopitaux-osm",
          format: "geojson",
          cle_stockage: "datasets/sante/1/hopitaux-osm.geojson",
          principal: false,
          taille_octets: 20,
          licence_code: "ODbL-1.0",
          sources: { slug: "openstreetmap", nom: "OpenStreetMap" },
        },
      ],
      { source: { slug: "geoalgeria", nom: "GeoAlgeria" }, licence_code: "donnees-publiques" }
    );
    expect(ressources.map((r) => [r.nom, r.source?.slug, r.licence_code])).toEqual([
      ["sante", "geoalgeria", "donnees-publiques"],
      ["hopitaux-osm", "openstreetmap", "ODbL-1.0"],
    ]);
  });
});

describe("numéro de version", () => {
  it("mineure pour la source de la donnée, corrective pour une autre source", () => {
    expect(versionSuivante("2.3.0")).toBe("2.4.0");
    expect(versionSuivante("2.3.0", true)).toBe("2.3.1");
    expect(versionSuivante(undefined, true)).toBe("1.0.0");
  });
});
