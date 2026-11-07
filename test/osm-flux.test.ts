import { describe, expect, it } from "vitest";
import { FLUX } from "../scripts/osm/categories.js";
import { fluxDuTag } from "../src/lib/osm-flux.js";
import { FORMAT_FILTRE, filtreDepuis, lireFiltre } from "../src/lib/osm-format.js";

describe("format des flux OpenStreetMap", () => {
  it("accepte les 33 flux du code (copiés tels quels dans osm_flux par la migration)", () => {
    for (const flux of FLUX) for (const filtre of flux.filtres) expect(FORMAT_FILTRE.test(filtre), filtre).toBe(true);
  });

  it("refuse une clé seule, une valeur vide ou des caractères dangereux", () => {
    for (const filtre of ["nwr/building", "nwr/amenity=", "nwr/amenity=cafe,", 'nwr/amenity=ca"fe', "nwr/amenity=cafe;rm", "amenity=cafe", "nwr/Amenity=cafe"]) {
      expect(FORMAT_FILTRE.test(filtre), filtre).toBe(false);
    }
  });

  it("construit et relit une expression", () => {
    const filtre = filtreDepuis("tourism", ["hotel", "guest_house"]);
    expect(filtre).toBe("nwr/tourism=hotel,guest_house");
    expect(lireFiltre(filtre)).toEqual({ cle: "tourism", valeurs: ["hotel", "guest_house"] });
    expect(lireFiltre("nwr/building")).toBeNull();
  });

  it("retrouve le flux actif qui extrait déjà un tag", () => {
    const flux = [
      { code: "hebergements", filtres: ["nwr/tourism=hotel,motel"], actif: true },
      { code: "ancien", filtres: ["nwr/amenity=cafe"], actif: false },
    ];
    expect(fluxDuTag(flux, "tourism", "motel")).toBe("hebergements");
    expect(fluxDuTag(flux, "amenity", "cafe")).toBeNull();
    expect(fluxDuTag(flux, "tourism", "camp_site")).toBeNull();
  });
});
