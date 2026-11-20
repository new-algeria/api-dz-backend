import { describe, expect, it } from "vitest";
import { analyser, competitionFr, verifier } from "../scripts/football/calculer.js";

const results = [
  "date,home_team,away_team,home_score,away_score,tournament,city,country,neutral",
  "1963-01-06,Algeria,Bulgaria,2,1,Friendly,Algiers,Algeria,FALSE",
  "1963-12-15,Tunisia,Algeria,1,1,Friendly,Tunis,Tunisia,FALSE",
  "1964-05-01,France,Brazil,0,0,Friendly,Paris,France,FALSE",
  "2019-07-11,Ivory Coast,Algeria,1,1,African Cup of Nations,Suez,Egypt,TRUE",
  "2019-07-19,Senegal,Algeria,0,1,African Cup of Nations,Cairo,Egypt,TRUE",
  "2020-01-01,Algeria,Tunisia,0,2,Some Cup,Oran,Algeria,FALSE",
  "2030-06-01,Algeria,Morocco,NA,NA,FIFA World Cup,Madrid,Spain,TRUE",
].join("\n");
const goalscorers = [
  "date,home_team,away_team,team,scorer,minute,own_goal,penalty",
  "1963-01-06,Algeria,Bulgaria,Algeria,Joueur A,10,FALSE,FALSE",
  "1963-01-06,Algeria,Bulgaria,Bulgaria,Joueur B,50,FALSE,FALSE",
  "1963-01-06,Algeria,Bulgaria,Algeria,Joueur C,NA,TRUE,FALSE",
  "2019-07-19,Senegal,Algeria,Algeria,Baghdad Bounedjah,2,FALSE,FALSE",
].join("\n");
const shootouts = ["date,home_team,away_team,winner,first_shooter", "2019-07-11,Ivory Coast,Algeria,Algeria,"].join("\n");

describe("équipe d'Algérie de football", () => {
  const resultat = analyser({ results, goalscorers, shootouts });

  it("garde les matchs joués de l'Algérie, du point de vue algérien", () => {
    expect(resultat.matchs.map((m) => [m.adversaire, m.buts_algerie, m.buts_adversaire, m.resultat, m.lieu])).toEqual([
      ["Bulgaria", 2, 1, "victoire", "domicile"],
      ["Tunisia", 1, 1, "nul", "exterieur"],
      ["Ivory Coast", 1, 1, "nul", "neutre"],
      ["Senegal", 1, 0, "victoire", "neutre"],
      ["Tunisia", 0, 2, "defaite", "domicile"],
    ]);
    expect(resultat.rapport.nb_matchs_a_venir_ecartes).toBe(1);
  });

  it("rattache les tirs au but sans changer le résultat du match", () => {
    const civ = resultat.matchs.find((m) => m.adversaire === "Ivory Coast")!;
    expect([civ.resultat, civ.tirs_au_but_vainqueur]).toEqual(["nul", "Algeria"]);
    expect(resultat.tirsAuBut).toEqual([
      { date: "2019-07-11", competition: "African Cup of Nations", competition_fr: "Coupe d'Afrique des nations", adversaire: "Ivory Coast", vainqueur: "Algeria", algerie_qualifiee: true },
    ]);
  });

  it("calcule les bilans par année, adversaire et compétition", () => {
    expect(resultat.bilanAnnuel.map((b) => [b.annee, b.matchs, b.victoires, b.nuls, b.defaites])).toEqual([
      [1963, 2, 1, 1, 0],
      [2019, 2, 1, 1, 0],
      [2020, 1, 0, 0, 1],
    ]);
    expect(resultat.adversaires[0]).toMatchObject({ adversaire: "Tunisia", matchs: 2, nuls: 1, defaites: 1, difference: -2, premier_match: "1963-12-15", dernier_match: "2020-01-01" });
    expect(resultat.competitions.find((c) => c.competition === "Some Cup")?.competition_fr).toBe("Some Cup");
    expect(resultat.rapport.bilan).toMatchObject({ matchs: 5, victoires: 2, nuls: 2, defaites: 1, buts_marques: 5, buts_encaisses: 5 });
  });

  it("ne garde que les buts de l'Algérie, CSC compris, et mesure la couverture des buteurs", () => {
    expect(resultat.buteurs.map((b) => [b.buteur, b.minute, b.contre_son_camp])).toEqual([
      ["Joueur A", 10, false],
      ["Joueur C", null, true],
      ["Baghdad Bounedjah", 2, false],
    ]);
    expect(resultat.rapport.couverture_buteurs_pct).toBe(60);
  });

  it("traduit les compétitions connues et garde les autres", () => {
    expect(competitionFr("FIFA World Cup qualification")).toBe("Éliminatoires de la Coupe du monde");
    expect(competitionFr("Kirin Cup")).toBe("Kirin Cup");
  });

  it("refuse une source tronquée ou modifiée", () => {
    expect(() => verifier(resultat)).toThrow(/Seulement 5 matchs/);
    expect(() => analyser({ results: "date,home_team\n2020-01-01,Algeria", goalscorers, shootouts })).toThrow(/Colonnes manquantes/);
  });
});
