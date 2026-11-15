import { describe, expect, it } from "vitest";
import { extraireDate, parserReleve, type Source } from "../collecter.js";

const source:Source={code_wilaya:"18",wilaya:"Jijel",source:"DCW Jijel",url:"https://example.test"};
const html=`<p>Journée du 11-11-2026</p><table>
<tr><td>Produits d'épicerie</td></tr>
<tr><td>Farine 1 Kg</td><td>45</td><td>65</td></tr>
<tr><td>Riz 1Kg</td><td>-</td><td>140</td></tr>
<tr><td>Produits frais</td></tr>
<tr><td>Tomate 1Kg</td><td>165</td><td>195</td></tr>
<tr><td>Carotte 1Kg</td><td>95</td><td>115</td></tr>
<tr><td>Poivron 1Kg</td><td>110</td><td>140</td></tr>
<tr><td>Oignon 1Kg</td><td>105</td><td>125</td></tr>
</table>`;
describe("collecte des mercuriales",()=>{
 it("lit la date du bulletin, pas la date de collecte",()=>expect(extraireDate(html)).toBe("2026-11-11"));
 it("conserve les prix absents en null et les valeurs publiées",()=>{
  const rows=parserReleve(html,source,"2026-11-15T10:00:00Z");
  expect(rows).toHaveLength(6);
  expect(rows[0]).toMatchObject({date_observation:"2026-11-11",code_wilaya:"18",prix_gros_da:45,prix_detail_da:65});
  expect(rows[1].prix_gros_da).toBeNull();
  expect(rows[1].prix_detail_da).toBe(140);
 });
 it("refuse un bulletin sans date explicite",()=>expect(()=>extraireDate("<table></table>")).toThrow(/Date du relevé introuvable/));
 it("refuse une page dont la structure ne ressemble pas à un relevé",()=>expect(()=>parserReleve("<p>Journée du 11-11-2026</p><table></table>",source)).toThrow(/incomplet/));
});
