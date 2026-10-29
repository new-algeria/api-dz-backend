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

const { cleNomSource } = await import("../src/lib/admin.js");
const { slugDepuisTitre } = await import("../src/lib/textes.js");

describe("sources", () => {
  it("compare les noms sans casse, accents, ponctuation ni espaces", () => {
    expect(cleNomSource("Banque Mondiale")).toBe(cleNomSource("banque-mondiale"));
    expect(cleNomSource("Ministère de la Santé")).toBe(cleNomSource("ministere de la sante"));
    expect(cleNomSource("O.N.S.")).toBe(cleNomSource("ONS"));
    expect(cleNomSource("ONS")).not.toBe(cleNomSource("ONM"));
  });

  it("tire le slug du nom", () => {
    expect(slugDepuisTitre("Office National des Statistiques (ONS)")).toBe("office-national-des-statistiques-ons");
  });
});
