// Fonctions pures de la synchronisation OpenStreetMap (testées dans test/osm-fusion.test.ts).
// Format des fichiers : celui d'un export overpass-turbo (`@id`, étiquettes OSM telles quelles, point au centre,
// `@geometry: "center"`), déjà utilisé par les données OpenStreetMap du site, plus nos propriétés :
//   osm_ajoute_le      : date du premier passage où l'objet a été vu ;
//   osm_absent_depuis  : date du passage où il a disparu d'OpenStreetMap (jamais supprimé, à trancher par un admin) ;
//   geoalgeria_id      : objet GeoAlgeria correspondant (même identifiant, ou nom proche à côté / dans la même commune) ;
//   wilaya_code, commune_code, commune : lieu déduit de la position (frontières OSM des communes, codes GeoAlgeria).
// Aucune date de passage n'est écrite sur un objet inchangé : un fichier identique garde la même empreinte,
// et rien n'est republié.

import type { Flux } from "./categories.js";

export interface Point {
  type: "Point";
  coordinates: [number, number];
}

export interface Objet {
  type: "Feature";
  id?: string;
  geometry: Point;
  properties: Record<string, unknown> & { "@id": string };
}

export interface Collection {
  type: "FeatureCollection";
  features: Objet[];
  [cle: string]: unknown;
}

/** Algérie (cadre large) : un objet hors de ce cadre est une erreur de saisie ou d'extrait. */
const CADRE_ALGERIE = { ouest: -8.8, est: 12.1, sud: 18.8, nord: 37.3 };

/** Étiquettes sans intérêt pour un utilisateur (bruit d'édition, noms dans des dizaines de langues). */
const ETIQUETTE_IGNOREE = /^(created_by|fixme|FIXME|note(:.*)?|source(:.*)?|check_date(:.*)?|name:(?!(ar|fr|en|ber|kab|tzm)$).*|old_name:.*|alt_name:(?!(ar|fr|en)$).*|wikipedia:.*)$/;

// ---------------------------------------------------------------- Identifiants et géométrie

/** `n123` → `node/123`, `w123` → `way/123`, `r123` → `relation/123`, et les surfaces d'osmium : `a<2×id>` (chemin), `a<2×id+1>` (relation). */
export function idDepuisOsmium(id: string): string | null {
  const morceaux = id.match(/^([nwra])(\d+)$/);
  if (!morceaux) return null;
  const nombre = BigInt(morceaux[2]);
  if (morceaux[1] === "n") return `node/${nombre}`;
  if (morceaux[1] === "w") return `way/${nombre}`;
  if (morceaux[1] === "r") return `relation/${nombre}`;
  return nombre % 2n === 0n ? `way/${nombre / 2n}` : `relation/${(nombre - 1n) / 2n}`;
}

/** Identifiant OSM d'un objet déjà publié (`@id` d'overpass-turbo, ou `id` / `osm_id` au même format). */
export function idObjet(objet: { id?: unknown; properties?: Record<string, unknown> | null }): string | null {
  const candidats = [objet.properties?.["@id"], objet.properties?.osm_id, objet.properties?.id, objet.id];
  for (const candidat of candidats) {
    if (typeof candidat === "string" && /^(node|way|relation)\/\d+$/.test(candidat)) return candidat;
  }
  return null;
}

/** Centre du rectangle englobant (comme `out center` d'Overpass), arrondi au 10⁻⁷ degré (~1 cm). */
export function centre(geometrie: { type: string; coordinates: unknown }): [number, number] | null {
  let ouest = Infinity;
  let est = -Infinity;
  let sud = Infinity;
  let nord = -Infinity;
  const parcourir = (valeur: unknown): void => {
    if (!Array.isArray(valeur)) return;
    if (typeof valeur[0] === "number" && typeof valeur[1] === "number") {
      const [lon, lat] = valeur as [number, number];
      ouest = Math.min(ouest, lon);
      est = Math.max(est, lon);
      sud = Math.min(sud, lat);
      nord = Math.max(nord, lat);
      return;
    }
    for (const element of valeur) parcourir(element);
  };
  parcourir(geometrie.coordinates);
  if (!Number.isFinite(ouest)) return null;
  const arrondi = (n: number) => Math.round(n * 1e7) / 1e7;
  return [arrondi((ouest + est) / 2), arrondi((sud + nord) / 2)];
}

export const dansAlgerie = ([lon, lat]: [number, number]) =>
  lon >= CADRE_ALGERIE.ouest && lon <= CADRE_ALGERIE.est && lat >= CADRE_ALGERIE.sud && lat <= CADRE_ALGERIE.nord;

/** Distance en mètres (haversine). */
export function distanceM([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------- Classement des objets extraits

/** Une expression `osmium tags-filter` (`nwr/cle=v1,v2`, `nwr/cle`) vérifiée sur des étiquettes. */
export function verifieFiltre(etiquettes: Record<string, unknown>, filtre: string): boolean {
  const expression = filtre.replace(/^[nwr]+\//, "");
  const [cle, valeurs] = expression.split("=");
  const valeur = etiquettes[cle];
  if (typeof valeur !== "string") return false;
  return valeurs === undefined || valeurs.split(",").includes(valeur);
}

export function appartientAuFlux(etiquettes: Record<string, unknown>, flux: Flux): boolean {
  if (!flux.filtres.some((filtre) => verifieFiltre(etiquettes, filtre))) return false;
  return Object.entries(flux.exige ?? {}).every(([cle, attendues]) => {
    const valeur = etiquettes[cle];
    return typeof valeur === "string" && valeur.split(";").some((morceau) => attendues.includes(morceau.trim()));
  });
}

/** Objet osmium (`geojsonseq`) → objet publié : point au centre, étiquettes utiles, `@id`. `null` si inutilisable. */
export function versObjet(brut: { id?: string; geometry?: { type: string; coordinates: unknown } | null; properties?: Record<string, unknown> | null }): Objet | null {
  const id = brut.id ? idDepuisOsmium(brut.id) : null;
  const point = brut.geometry ? centre(brut.geometry) : null;
  if (!id || !point || !dansAlgerie(point)) return null;
  const etiquettes: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(brut.properties ?? {})) {
    if (!ETIQUETTE_IGNOREE.test(cle) && valeur !== null && valeur !== "") etiquettes[cle] = valeur;
  }
  return { type: "Feature", id, geometry: { type: "Point", coordinates: point }, properties: { "@id": id, ...etiquettes, "@geometry": "center" } };
}

// ---------------------------------------------------------------- Fusion avec le fichier précédent

export interface RapportFusion {
  ajoutes: number;
  mis_a_jour: number;
  inchanges: number;
  absents: number;
  nouveaux_absents: number;
  revenus: number;
  total: number;
}

// Ajoutées par data-dz (jamais lues comme des étiquettes OSM) ; codes : scripts/osm/localisation.ts.
const NOS_PROPRIETES = ["osm_ajoute_le", "osm_absent_depuis", "geoalgeria_id", "wilaya_code", "commune_code", "commune"] as const;

function sansNosProprietes(proprietes: Record<string, unknown>) {
  const copie = { ...proprietes };
  for (const cle of NOS_PROPRIETES) delete copie[cle];
  return copie;
}

/** Propriétés triées (`@id` en premier, `@geometry` en dernier) : même contenu = même texte = même empreinte. */
export function trierProprietes(proprietes: Record<string, unknown>): Objet["properties"] {
  const cles = Object.keys(proprietes).sort((a, b) => {
    const rang = (cle: string) => (cle === "@id" ? 0 : cle === "@geometry" ? 2 : 1);
    return rang(a) - rang(b) || a.localeCompare(b);
  });
  return Object.fromEntries(cles.map((cle) => [cle, proprietes[cle]])) as Objet["properties"];
}

const memesDonnees = (a: Objet, b: Objet) =>
  a.geometry.coordinates[0] === b.geometry.coordinates[0] &&
  a.geometry.coordinates[1] === b.geometry.coordinates[1] &&
  JSON.stringify(trierProprietes(sansNosProprietes(a.properties))) === JSON.stringify(trierProprietes(sansNosProprietes(b.properties)));

/**
 * Ajoute les objets extraits aux objets déjà publiés, sans jamais en retirer :
 * - déjà connu (`@id`) : ses étiquettes et sa position sont mises à jour, `osm_ajoute_le` est gardé ;
 * - nouveau : ajouté avec `osm_ajoute_le = date` ;
 * - publié mais absent de l'extrait : gardé, avec `osm_absent_depuis` (posé une fois) ;
 * - revenu dans l'extrait : `osm_absent_depuis` est retiré.
 * Les objets publiés sans identifiant OSM (saisis à la main) sont gardés tels quels.
 */
export function fusionner(precedents: Objet[], extraits: Objet[], date: string): { objets: Objet[]; rapport: RapportFusion } {
  const rapport: RapportFusion = { ajoutes: 0, mis_a_jour: 0, inchanges: 0, absents: 0, nouveaux_absents: 0, revenus: 0, total: 0 };
  const anciens = new Map<string, Objet>();
  const sansId: Objet[] = [];
  for (const objet of precedents) {
    const id = idObjet(objet);
    if (id) anciens.set(id, objet);
    else sansId.push(objet);
  }

  const resultat = new Map<string, Objet>();
  for (const extrait of extraits) {
    const id = extrait.properties["@id"];
    if (resultat.has(id)) continue; // un chemin fermé sort deux fois d'osmium (ligne et surface)
    const ancien = anciens.get(id);
    if (!ancien) {
      rapport.ajoutes++;
      resultat.set(id, { ...extrait, properties: trierProprietes({ ...extrait.properties, osm_ajoute_le: date }) });
      continue;
    }
    const etaitAbsent = typeof ancien.properties.osm_absent_depuis === "string";
    if (etaitAbsent) rapport.revenus++;
    const garde: Record<string, unknown> = {};
    if (ancien.properties.osm_ajoute_le !== undefined) garde.osm_ajoute_le = ancien.properties.osm_ajoute_le;
    for (const cle of ["geoalgeria_id", "wilaya_code", "commune_code", "commune"] as const) {
      if (ancien.properties[cle] !== undefined) garde[cle] = ancien.properties[cle];
    }
    const objet: Objet = { ...extrait, properties: trierProprietes({ ...extrait.properties, ...garde }) };
    if (!etaitAbsent && memesDonnees(objet, ancien)) {
      rapport.inchanges++;
      resultat.set(id, { ...ancien, id, properties: trierProprietes({ ...ancien.properties }) });
    } else {
      if (!etaitAbsent) rapport.mis_a_jour++;
      resultat.set(id, objet);
    }
  }

  for (const [id, ancien] of anciens) {
    if (resultat.has(id)) continue;
    rapport.absents++;
    const dejaAbsent = typeof ancien.properties.osm_absent_depuis === "string";
    if (!dejaAbsent) rapport.nouveaux_absents++;
    resultat.set(id, {
      ...ancien,
      id,
      properties: trierProprietes({ ...ancien.properties, "@id": id, osm_absent_depuis: dejaAbsent ? ancien.properties.osm_absent_depuis : date }),
    });
  }

  const objets = [...[...resultat.values()].sort((a, b) => a.properties["@id"].localeCompare(b.properties["@id"])), ...sansId];
  rapport.total = objets.length;
  return { objets, rapport };
}

// ---------------------------------------------------------------- Rapprochement avec GeoAlgeria

/** Nom comparable : minuscules, sans accents ni ponctuation, sans les mots génériques des établissements. */
export function normaliserNom(nom: string): string {
  return nom
    .normalize("NFD")
    .replace(/[̀-ًͯ-ٰٟ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(etablissement|hospitalier|hospitaliere|public|publique|specialise|specialisee|de|du|des|la|le|les|d|l|eph|ehs|chu|epsp|hopital|clinique|pharmacie|ecole|station|service)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Similarité de deux noms (coefficient de Dice sur les bigrammes, 0 à 1). */
export function similarite(a: string, b: string): number {
  const x = normaliserNom(a);
  const y = normaliserNom(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bigrammes = (texte: string) => {
    const liste = new Map<string, number>();
    for (let i = 0; i < texte.length - 1; i++) liste.set(texte.slice(i, i + 2), (liste.get(texte.slice(i, i + 2)) ?? 0) + 1);
    return liste;
  };
  const bx = bigrammes(x);
  const by = bigrammes(y);
  let communs = 0;
  for (const [bigramme, nombre] of bx) communs += Math.min(nombre, by.get(bigramme) ?? 0);
  return (2 * communs) / (Math.max(1, x.length - 1) + Math.max(1, y.length - 1));
}

const nomsDe = (proprietes: Record<string, unknown>) =>
  ["name", "name:fr", "name:ar", "name_fr", "name_ar", "nom", "nom_fr", "nom_ar"].map((cle) => proprietes[cle]).filter((v): v is string => typeof v === "string" && v.trim() !== "");

interface ObjetGeoAlgeria {
  type?: string;
  id?: unknown;
  geometry?: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/** Identifiants partagés par les deux sources, préfixés par leur nature (`osm:`, `wikidata:`, `icao:`, `iata:`). */
function identifiantsGeoAlgeria(proprietes: Record<string, unknown>): string[] {
  const refs = (proprietes.refs ?? {}) as Record<string, unknown>;
  const ids: string[] = [];
  const ajouter = (nature: string, valeur: unknown) => {
    if (typeof valeur === "string" && valeur.trim()) ids.push(`${nature}:${valeur.trim().toUpperCase()}`);
  };
  ajouter("osm", refs.osm);
  for (const nature of ["wikidata", "icao", "iata"]) {
    ajouter(nature, refs[nature]);
    ajouter(nature, proprietes[nature]);
  }
  return ids;
}

function identifiantsOsm(proprietes: Record<string, unknown>): string[] {
  const ids = [`osm:${String(proprietes["@id"]).toUpperCase()}`];
  for (const nature of ["wikidata", "icao", "iata"]) {
    const valeur = proprietes[nature];
    if (typeof valeur === "string" && valeur.trim()) ids.push(`${nature}:${valeur.trim().toUpperCase()}`);
  }
  return ids;
}

/** Position GeoAlgeria approximative (centre de la commune) : la distance ne veut rien dire, seule la commune compte. */
const estApproximatif = (proprietes: Record<string, unknown>) =>
  proprietes.geo_precision === "approximate" || proprietes.geo_method === "commune_centroid";

/**
 * Note sur chaque objet OSM l'objet GeoAlgeria correspondant (`geoalgeria_id`), dans cet ordre :
 * 1. même identifiant : OSM (`refs.osm`), Wikidata, code OACI / IATA (aéroports) ;
 * 2. nom proche (similarité ≥ 0,8) et à moins de `rayonM` mètres d'un point GeoAlgeria précis ;
 * 3. nom proche dans la même commune (`commune_code`) d'un point GeoAlgeria approximatif (centre de commune).
 * Renvoie le nombre d'objets rapprochés.
 */
export function rapprocher(objets: Objet[], geoalgeria: ObjetGeoAlgeria[], rayonM: number): number {
  const parIdentifiant = new Map<string, string>();
  const points: { id: string; point: [number, number]; noms: string[]; approximatif: boolean; commune: string | null }[] = [];
  for (const objet of geoalgeria) {
    const proprietes = objet.properties ?? {};
    const id = proprietes.id ?? objet.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
    for (const identifiant of identifiantsGeoAlgeria(proprietes)) if (!parIdentifiant.has(identifiant)) parIdentifiant.set(identifiant, String(id));
    const point = objet.geometry ? centre(objet.geometry) : null;
    const commune = typeof proprietes.commune_code === "string" && proprietes.commune_code ? proprietes.commune_code : null;
    if (point) points.push({ id: String(id), point, noms: nomsDe(proprietes), approximatif: estApproximatif(proprietes), commune });
  }

  let rapproches = 0;
  for (const objet of objets) {
    let trouve = identifiantsOsm(objet.properties).map((identifiant) => parIdentifiant.get(identifiant)).find(Boolean);
    if (!trouve) {
      const noms = nomsDe(objet.properties);
      const commune = typeof objet.properties.commune_code === "string" ? objet.properties.commune_code : null;
      let meilleur = 0;
      for (const candidat of points) {
        if (noms.length === 0 || candidat.noms.length === 0) continue;
        const voisin = candidat.approximatif
          ? commune !== null && candidat.commune === commune
          : distanceM(objet.geometry.coordinates, candidat.point) <= rayonM;
        if (!voisin) continue;
        const score = Math.max(...noms.flatMap((nom) => candidat.noms.map((autre) => similarite(nom, autre))));
        if (score >= 0.8 && score > meilleur) {
          meilleur = score;
          trouve = candidat.id;
        }
      }
    }
    if (trouve) {
      rapproches++;
      objet.properties = trierProprietes({ ...objet.properties, geoalgeria_id: trouve });
    } else if (objet.properties.geoalgeria_id !== undefined) {
      const { geoalgeria_id: _ancien, ...reste } = objet.properties;
      objet.properties = reste as Objet["properties"];
    }
  }
  return rapproches;
}

/**
 * Fichier GeoAlgeria de référence d'une donnée : celui qui a le plus de points (ex. `airports` plutôt que `routes`,
 * des lignes, pour « aviation »), le principal à égalité. Même règle dans l'API pour `file=all`.
 */
export function fichierReference<T extends { principal: boolean; nbPoints: number }>(fichiers: T[]): T | null {
  return [...fichiers].filter((fichier) => fichier.nbPoints > 0).sort((a, b) => b.nbPoints - a.nbPoints || Number(b.principal) - Number(a.principal))[0] ?? null;
}

// ---------------------------------------------------------------- Contrôles avant publication

/**
 * Baisse anormale : moins de 90 % des objets présents au passage précédent sont encore dans l'extrait
 * (vandalisme, extrait tronqué). Ignoré sous 20 objets.
 */
export function baisseAnormale(precedents: Objet[], extraits: Objet[]): boolean {
  const presents = precedents.filter((objet) => typeof objet.properties.osm_absent_depuis !== "string").length;
  return presents >= 20 && new Set(extraits.map((objet) => objet.properties["@id"])).size < presents * 0.9;
}

/**
 * Numéro d'une version qui ne change que le complément OpenStreetMap d'une donnée d'une autre source :
 * même majeure et mineure, correctif = la date (`2.3.0` → `2.3.20261102`), pour ne jamais prendre un numéro
 * que la source de la donnée (GeoAlgeria) pourrait publier ensuite. Deux passages le même jour : +1.
 */
export function numeroComplement(actuel: string | null, date: string): string {
  const morceaux = actuel?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const jour = Number(date.replaceAll("-", ""));
  if (!morceaux) return `1.0.${jour}`;
  const correctif = Number(morceaux[3]);
  return `${morceaux[1]}.${morceaux[2]}.${correctif >= jour ? correctif + 1 : jour}`;
}

/** Texte publié : FeatureCollection stable (aucune date), un objet par ligne pour des diffs lisibles. */
export function serialiser(objets: Objet[]): string {
  const entete = {
    type: "FeatureCollection",
    generator: "data-dz synchro OpenStreetMap (Geofabrik + osmium)",
    copyright: "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
  };
  const lignes = objets.map((objet) => JSON.stringify({ type: "Feature", id: objet.properties["@id"], geometry: objet.geometry, properties: objet.properties }));
  return `${JSON.stringify(entete).slice(0, -1)},"features":[\n${lignes.join(",\n")}\n]}\n`;
}
