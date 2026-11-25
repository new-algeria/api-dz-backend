import { describe, expect, it } from "vitest";
import { agreger, choisirPoints, lirePower, verifier, type Jour, type Point } from "../scripts/temperatures/calculer.js";

const wilaya = (code: number, capitale: number) => ({ code, name_fr: `W${code}`, name_ar: `و${code}`, capital_commune_code: capitale });

describe("points de mesure", () => {
  it("bureau principal du chef-lieu, sinon médiane des bureaux de la commune", () => {
    const points = choisirPoints(
      [wilaya(16, 1601), wilaya(49, 4901)],
      [
        { name: "ALGER RP", commune_code: "1601", commune: "ALGER CENTRE", lat: 36.77, lng: 3.06, postal_code: "16000" },
        { name: "ALGER 1ER MAI", commune_code: "1601", commune: "ALGER CENTRE", lat: 36.76, lng: 3.07 },
        { name: "MGUIDEN", commune_code: "4901", commune: "TIMIMOUN", lat: 29.0, lng: 0.0 },
        { name: "BADRIANE", commune_code: "4901", commune: "TIMIMOUN", lat: 29.2, lng: 0.2 },
        { name: "TIMIMOUN HAY", commune_code: "4901", commune: "TIMIMOUN", lat: 29.3, lng: 0.3 },
        { name: "AILLEURS", commune_code: "4902", commune: "AUTRE", lat: 10, lng: 10 },
      ]
    );
    expect(points[0]).toMatchObject({ code_wilaya: "16", chef_lieu: "Alger Centre", lat: 36.77, lng: 3.06, methode: "bureau_principal" });
    expect(points[1]).toMatchObject({ code_wilaya: "49", lat: 29.2, lng: 0.2, methode: "mediane_bureaux" });
  });

  it("erreur si un chef-lieu n'a aucun bureau géolocalisé", () => {
    expect(() => choisirPoints([wilaya(1, 101)], [{ name: "X", commune_code: "0101", commune: "ADRAR", lat: null, lng: null }])).toThrow(/wilaya 1/);
  });
});

describe("lecture NASA POWER", () => {
  it("valeurs -999 → null, jours absents en fin de série retirés", () => {
    const jours = lirePower("16", {
      properties: {
        parameter: {
          T2M_MAX: { "20240101": 18.234, "20240102": -999, "20240103": -999 },
          T2M_MIN: { "20240101": 9.1, "20240102": 8, "20240103": -999 },
          T2M: { "20240101": 13.5, "20240102": 11, "20240103": -999 },
        },
      },
    });
    expect(jours).toEqual([
      { code_wilaya: "16", date: "2024-01-01", tmax: 18.23, tmin: 9.1, tmoy: 13.5 },
      { code_wilaya: "16", date: "2024-01-02", tmax: null, tmin: 8, tmoy: 11 },
    ]);
  });

  it("refuse une température invraisemblable ou une réponse incomplète", () => {
    expect(() => lirePower("01", { properties: { parameter: { T2M_MAX: { "20240101": 75 }, T2M_MIN: { "20240101": 20 }, T2M: { "20240101": 40 } } } })).toThrow(/invraisemblable/);
    expect(() => lirePower("01", {})).toThrow(/incomplète/);
  });
});

/** Série synthétique : une valeur par jour de 1981 à 2024, plus chaude chaque année. */
function serie(code: string, base: number): Jour[] {
  const jours: Jour[] = [];
  for (let date = new Date(Date.UTC(1981, 0, 1)); date.getUTCFullYear() <= 2024; date.setUTCDate(date.getUTCDate() + 1)) {
    const annee = date.getUTCFullYear();
    const ete = date.getUTCMonth() === 6;
    const tmax = base + (annee - 1981) * 0.05 + (ete ? 15 : 0);
    jours.push({ code_wilaya: code, date: date.toISOString().slice(0, 10), tmax, tmin: tmax - 10, tmoy: tmax - 5 });
  }
  return jours;
}

const points: Point[] = Array.from({ length: 69 }, (_, i) => ({
  code_wilaya: String(i + 1).padStart(2, "0"),
  wilaya: `W${i + 1}`,
  wilaya_ar: "",
  chef_lieu: "",
  code_commune: "",
  lat: 30,
  lng: 3,
  methode: "bureau_principal",
}));

describe("synthèses", () => {
  const jours = points.flatMap((point, i) => serie(point.code_wilaya, 20 + (i % 10)));
  const calcul = agreger(points, jours);

  it("une ligne par wilaya et par année complète, avec les jours de chaleur", () => {
    expect(calcul.annuel).toHaveLength(69 * 44);
    const alger2024 = calcul.annuel.find((ligne) => ligne.code_wilaya === "10" && ligne.annee === 2024)!;
    // Wilaya 10 : base 29 °C + 2,15 en 2024, juillet à +15 → 31 jours à 40 °C ou plus, toute l'année au-dessus de 20 la nuit en juillet.
    expect(alger2024.jours_40).toBe(31);
    expect(alger2024.jours_35).toBe(31);
    expect(alger2024.ecart_normale).toBeGreaterThan(0);
  });

  it("mois complets seulement et synthèse nationale des 69 wilayas", () => {
    expect(calcul.mensuel).toHaveLength(69 * 44 * 12);
    expect(calcul.national[0].annee).toBe(1981);
    expect(calcul.national).toHaveLength(44);
    expect(calcul.national[43].wilayas_au_moins_un_jour_40).toBeGreaterThan(0);
  });

  it("une année incomplète n'est pas synthétisée", () => {
    const tronques = jours.filter((jour) => !(jour.code_wilaya === "01" && jour.date >= "2024-03-01"));
    const resultat = agreger(points, tronques);
    expect(resultat.annuel.some((ligne) => ligne.code_wilaya === "01" && ligne.annee === 2024)).toBe(false);
    expect(resultat.national.some((ligne) => ligne.annee === 2024)).toBe(false);
  });

  it("vérification : rapport complet, et refus s'il manque une wilaya", () => {
    const rapport = verifier(points, jours, calcul);
    expect(rapport).toMatchObject({ nb_points: 69, premiere_annee: 1981, derniere_annee_complete: 2024, derniere_date: "2024-12-31" });
    expect(() => verifier(points.slice(1), jours, calcul)).toThrow(/68 points/);
  });
});
