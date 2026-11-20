import type { Table } from "./conversion.js";
import { codeWilaya as lireCodeWilaya, positionDe, type ContourWilaya } from "./wilayas.js";

/**
 * Vignette d'une donnée pour le survol des cartes du catalogue : petite carte (points, formes ou wilayas colorées)
 * ou petit graphique (courbe, barres), sans aucun texte (lisible dans toutes les langues). Fond transparent et couleurs
 * lisibles en clair comme en sombre. Fonctions pures : la lecture des fichiers et la conversion en WebP sont dans
 * `vignette-image.ts`. Même ordre de priorité que le visuel de la fiche (src/lib/detecterVisuel.ts du site).
 */

export const LARGEUR_VIGNETTE = 720;
export const HAUTEUR_VIGNETTE = 300;
/** Au-delà, les points sont échantillonnés (régulièrement) : le dessin reste léger et lisible. */
export const MAX_POINTS = 6000;
/** Nombre de coordonnées au-delà duquel les formes sont simplifiées (un sommet sur n). */
const MAX_SOMMETS = 24000;
const MAX_BARRES = 8;
const MAX_SERIES = 50;

type Ligne = Record<string, unknown>;
interface Geometrie {
  type: string;
  coordinates?: unknown;
  geometries?: Geometrie[];
}
type Position = [number, number];

export type PlanVignette =
  | { genre: "points"; points: Position[] }
  | { genre: "formes"; lignes: Position[][]; surfaces: Position[][] }
  | { genre: "wilayas"; valeurs: Record<string, number> }
  | { genre: "courbe"; points: { tri: number; valeur: number; projection: boolean }[]; debut: string; fin: string }
  | { genre: "barres"; valeurs: number[] };

// ---------------------------------------------------------------- Rôles des colonnes

export const normaliserCle = (nom: string) =>
  nom
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function lireNombre(valeur: unknown): number | null {
  if (typeof valeur === "number") return Number.isFinite(valeur) ? valeur : null;
  if (typeof valeur === "string" && /^\s*-?\d+(?:[.,]\d+)?\s*$/.test(valeur)) return Number(valeur.trim().replace(",", "."));
  return null;
}

/** Temps lu dans une cellule : année (1 à 2200) ou date ISO, avec une clé de tri et un libellé. */
export function lireTemps(valeur: unknown): { tri: number; etiquette: string } | null {
  if (valeur === null || valeur === undefined || valeur === "") return null;
  const nombre = lireNombre(valeur);
  if (nombre !== null && Number.isInteger(nombre) && nombre >= 1 && nombre <= 2200) return { tri: nombre * 10000, etiquette: String(nombre) };
  const date = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(valeur).trim());
  if (!date) return null;
  const [, annee, mois = "01", jour = "01"] = date;
  return { tri: Number(annee) * 10000 + Number(mois) * 100 + Number(jour), etiquette: annee };
}

const NOMS_TEMPS = new Set(["annee", "year", "an", "date", "mois", "month", "periode", "period", "trimestre", "quarter"]);
const NOMS_CODE_WILAYA = new Set(["code_wilaya", "wilaya_code", "code_w", "id_wilaya", "wilaya_id", "num_wilaya", "numero_wilaya", "matricule", "wilaya"]);
const NOMS_NOM_WILAYA = new Set(["wilaya", "nom_wilaya", "wilaya_nom", "wilaya_name", "name_wilaya", "wilaya_fr", "nom_wilaya_fr"]);
const NOMS_VALEUR = new Set(["valeur", "value", "val", "montant", "total", "effectif"]);
const NOMS_UNITE = new Set(["unite", "unit", "unites", "units", "unite_mesure"]);
const NOMS_TYPE = new Set(["type", "statut", "nature", "type_valeur", "type_donnee", "type_observation"]);
const MOTIF_EXCLU = /^(id|fid|gid|objectid|ogc_fid|osm_id|uuid|x|y|lat|lng|lon|long|latitude|longitude)$|(^|_)(id|code|codes|cle|key|ref|refs|iso|iso2|iso3|matricule)(_|$)/;
const MOTIF_TEXTE_LIBRE = /(^|_)(description|note|notes|commentaire|commentaires|remarque|source|sources|url|lien|liens|adresse|address|email|telephone|phone)(_|$)/;
const estProjection = (valeur: unknown) => typeof valeur === "string" && /projection|projete|projet[ée]|prevision|prévision|forecast/i.test(valeur);

interface InfoColonne {
  nom: string;
  cle: string;
  nbValeurs: number;
  nbNombres: number;
  distincts: Set<string>;
  longueurMoyenne: number;
}

function analyserColonnes(lignes: Ligne[]): InfoColonne[] {
  const infos = new Map<string, InfoColonne & { longueur: number }>();
  for (const ligne of lignes) {
    for (const [nom, valeur] of Object.entries(ligne)) {
      let info = infos.get(nom);
      if (!info) infos.set(nom, (info = { nom, cle: normaliserCle(nom), nbValeurs: 0, nbNombres: 0, distincts: new Set(), longueurMoyenne: 0, longueur: 0 }));
      if (valeur === null || valeur === undefined || valeur === "" || typeof valeur === "object") continue;
      info.nbValeurs++;
      if (lireNombre(valeur) !== null) info.nbNombres++;
      const texte = String(valeur);
      if (info.distincts.size < 2000) info.distincts.add(texte);
      info.longueur += texte.length;
    }
  }
  return [...infos.values()].map((info) => ({ ...info, longueurMoyenne: info.nbValeurs ? info.longueur / info.nbValeurs : 0 }));
}

const estNumerique = (info: InfoColonne) => info.nbValeurs > 0 && info.nbNombres / info.nbValeurs >= 0.9;
const proportion = (info: InfoColonne, test: (texte: string) => boolean) => {
  const valeurs = [...info.distincts];
  return valeurs.length > 0 && valeurs.filter(test).length / valeurs.length >= 0.9;
};

interface Roles {
  temps: string | null;
  codeWilaya: string | null;
  nomWilaya: string | null;
  type: string | null;
  mesure: string | null;
  dimensions: string[];
  categorie: string | null;
}

function analyserRoles(lignes: Ligne[]): Roles {
  const infos = analyserColonnes(lignes);
  const trouver = (test: (info: InfoColonne) => boolean) => infos.find(test)?.nom ?? null;
  const temps = trouver((info) => (NOMS_TEMPS.has(info.cle) || /^(annee|year|date)_/.test(info.cle)) && proportion(info, (texte) => lireTemps(texte) !== null));
  const codeWilaya = trouver((info) => NOMS_CODE_WILAYA.has(info.cle) && proportion(info, (texte) => lireCodeWilaya(texte) !== null && Number.isInteger(lireNombre(texte))));
  const nomWilaya = trouver((info) => NOMS_NOM_WILAYA.has(info.cle) && info.nom !== codeWilaya && !estNumerique(info));
  const type = trouver((info) => NOMS_TYPE.has(info.cle) && [...info.distincts].some(estProjection));
  const unite = trouver((info) => NOMS_UNITE.has(info.cle) && !estNumerique(info));
  const reserves = new Set([temps, codeWilaya, type, unite].filter(Boolean));
  const libres = infos.filter((info) => !reserves.has(info.nom) && !MOTIF_EXCLU.test(info.cle) && info.nbValeurs > 0);
  const numeriques = libres.filter((info) => estNumerique(info) && info.distincts.size > 1);
  const textes = libres.filter((info) => !estNumerique(info) && !MOTIF_TEXTE_LIBRE.test(info.cle) && info.longueurMoyenne <= 80);
  const dimensions = textes.filter((info) => info.distincts.size >= 2 && info.distincts.size <= (info.nom === nomWilaya ? 69 : MAX_SERIES)).map((info) => info.nom);
  const mesure = (numeriques.find((info) => NOMS_VALEUR.has(info.cle)) ?? numeriques[0])?.nom ?? null;
  const categorie = nomWilaya ?? dimensions[0] ?? textes.find((info) => info.distincts.size >= 2 && info.longueurMoyenne <= 60)?.nom ?? null;
  return { temps, codeWilaya, nomWilaya, type, mesure, dimensions, categorie };
}

// ---------------------------------------------------------------- Plan de la vignette

function echantillon<T>(liste: T[], max: number): T[] {
  if (liste.length <= max) return liste;
  const pas = liste.length / max;
  return Array.from({ length: max }, (_, i) => liste[Math.floor(i * pas)]);
}

/** Anneaux et lignes d'une géométrie (les points sont traités à part). */
function traits(geometrie: Geometrie, surfaces: Position[][], lignes: Position[][]) {
  const c = geometrie.coordinates as unknown;
  if (geometrie.type === "Polygon") (c as Position[][]).forEach((anneau) => surfaces.push(anneau));
  else if (geometrie.type === "MultiPolygon") (c as Position[][][]).forEach((polygone) => polygone.forEach((anneau) => surfaces.push(anneau)));
  else if (geometrie.type === "LineString") lignes.push(c as Position[]);
  else if (geometrie.type === "MultiLineString") (c as Position[][]).forEach((ligne) => lignes.push(ligne));
  else if (geometrie.type === "GeometryCollection") geometrie.geometries?.forEach((sous) => traits(sous, surfaces, lignes));
}

/** Choisit la vignette d'une table : carte d'abord (géométries, coordonnées, codes de wilaya), puis graphique. `null` : rien à montrer. */
export function planVignette(table: Table): PlanVignette | null {
  const { lignes, geometries } = table;
  if (lignes.length === 0) return null;

  // 1. GeoJSON : points (ou premier point des géométries), sinon formes.
  if (geometries?.some(Boolean)) {
    const ponctuelles = geometries.filter((g) => g?.type === "Point" || g?.type === "MultiPoint").length;
    if (ponctuelles >= geometries.filter(Boolean).length / 2) {
      const points = geometries.map((g, i) => positionDe(lignes[i] ?? {}, g)).filter((p): p is Position => p !== null);
      if (points.length > 0) return { genre: "points", points: echantillon(points, MAX_POINTS) };
    } else {
      const surfaces: Position[][] = [];
      const traces: Position[][] = [];
      geometries.forEach((g) => g && traits(g, surfaces, traces));
      const total = [...surfaces, ...traces].reduce((somme, trait) => somme + trait.length, 0);
      const pas = Math.max(1, Math.ceil(total / MAX_SOMMETS));
      const simplifier = (trait: Position[]) => (pas === 1 ? trait : trait.filter((_, i) => i % pas === 0 || i === trait.length - 1));
      if (total > 0) return { genre: "formes", surfaces: surfaces.map(simplifier).filter((t) => t.length >= 3), lignes: traces.map(simplifier).filter((t) => t.length >= 2) };
    }
  }

  // 2. Coordonnées dans les colonnes.
  const points = lignes.map((ligne) => positionDe(ligne)).filter((p): p is Position => p !== null);
  if (points.length >= Math.min(10, lignes.length) && points.length >= lignes.length / 2) return { genre: "points", points: echantillon(points, MAX_POINTS) };

  const roles = analyserRoles(lignes);
  if (!roles.mesure) return null;
  const mesure = roles.mesure;

  // 3. Une mesure par wilaya (au dernier temps disponible).
  if (roles.codeWilaya && roles.dimensions.every((dimension) => dimension === roles.nomWilaya)) {
    const dernier = roles.temps ? Math.max(...lignes.map((ligne) => lireTemps(ligne[roles.temps!])?.tri ?? -Infinity)) : null;
    const valeurs: Record<string, number> = {};
    for (const ligne of lignes) {
      if (dernier !== null && lireTemps(ligne[roles.temps!])?.tri !== dernier) continue;
      const code = lireCodeWilaya(ligne[roles.codeWilaya]);
      const valeur = lireNombre(ligne[mesure]);
      if (code && valeur !== null) valeurs[code] = (valeurs[code] ?? 0) + valeur;
    }
    if (Object.keys(valeurs).length >= 5) return { genre: "wilayas", valeurs };
  }

  // 4. Courbe d'une seule série, moyenne par date.
  if (roles.temps) {
    // Série la plus importante (plus grande somme des valeurs, sinon l'ordre alphabétique), dimension par dimension
    // parmi les lignes déjà retenues : la combinaison existe toujours, et l'on évite une série presque nulle.
    let serie = lignes;
    for (const dimension of roles.dimensions) {
      const poids = new Map<string, number>();
      for (const ligne of serie) {
        const cle = String(ligne[dimension] ?? "");
        if (cle) poids.set(cle, (poids.get(cle) ?? 0) + Math.abs(lireNombre(ligne[mesure]) ?? 0));
      }
      const choisie = [...poids.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      if (choisie !== undefined) serie = serie.filter((ligne) => String(ligne[dimension] ?? "") === choisie);
    }
    // Plus de 60 dates (séries mensuelles longues) : moyenne par année, lisible en petit.
    const nbDates = new Set(serie.map((ligne) => lireTemps(ligne[roles.temps!])?.tri).filter((tri) => tri !== undefined)).size;
    const parAnnee = nbDates > 60;
    const parDate = new Map<number, { somme: number; nb: number; etiquette: string; projection: boolean }>();
    for (const ligne of serie) {
      const lu = lireTemps(ligne[roles.temps]);
      const valeur = lireNombre(ligne[mesure]);
      if (!lu || valeur === null) continue;
      const temps = parAnnee ? { tri: Math.floor(lu.tri / 10000) * 10000, etiquette: lu.etiquette } : lu;
      const entree = parDate.get(temps.tri) ?? { somme: 0, nb: 0, etiquette: temps.etiquette, projection: false };
      entree.somme += valeur;
      entree.nb++;
      entree.projection ||= roles.type !== null && estProjection(ligne[roles.type]);
      parDate.set(temps.tri, entree);
    }
    const tries = [...parDate.entries()].sort((a, b) => a[0] - b[0]);
    if (tries.length >= 2) {
      return {
        genre: "courbe",
        points: tries.map(([tri, e]) => ({ tri, valeur: e.somme / e.nb, projection: e.projection })),
        debut: tries[0][1].etiquette,
        fin: tries[tries.length - 1][1].etiquette,
      };
    }
    return null;
  }

  // 5. Barres : les plus grandes catégories.
  if (roles.categorie) {
    const sommes = new Map<string, number>();
    for (const ligne of lignes) {
      const valeur = lireNombre(ligne[mesure]);
      const categorie = ligne[roles.categorie];
      if (valeur === null || categorie === null || categorie === undefined || categorie === "") continue;
      sommes.set(String(categorie), (sommes.get(String(categorie)) ?? 0) + valeur);
    }
    const valeurs = [...sommes.values()].filter((v) => v > 0).sort((a, b) => b - a).slice(0, MAX_BARRES);
    if (valeurs.length >= 2) return { genre: "barres", valeurs };
  }
  return null;
}

/** La vignette dessine-t-elle l'Algérie (et a-t-elle besoin des contours des wilayas) ? */
export const estCarte = (plan: PlanVignette) => plan.genre === "points" || plan.genre === "formes" || plan.genre === "wilayas";

// ---------------------------------------------------------------- Dessin SVG

const VERT = "#10b981";
const GRIS = "#94a3b8";
const f = (n: number) => (Math.round(n * 10) / 10).toString();

/** Projection équirectangulaire (cos 28°) cadrée sur l'emprise des wilayas, centrée dans la vignette. */
function projection(contours: ContourWilaya[]) {
  const emprise = contours.reduce(
    (e, c) => [Math.min(e[0], c.emprise[0]), Math.min(e[1], c.emprise[1]), Math.max(e[2], c.emprise[2]), Math.max(e[3], c.emprise[3])],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
  const [ouest, sud, est, nord] = Number.isFinite(emprise[0]) ? emprise : [-8.7, 18.9, 12, 37.1];
  const k = Math.cos((28 * Math.PI) / 180);
  const marge = 10;
  const echelle = Math.min((LARGEUR_VIGNETTE - 2 * marge) / ((est - ouest) * k), (HAUTEUR_VIGNETTE - 2 * marge) / (nord - sud));
  const dx = (LARGEUR_VIGNETTE - (est - ouest) * k * echelle) / 2;
  const dy = (HAUTEUR_VIGNETTE - (nord - sud) * echelle) / 2;
  const projeter = ([x, y]: Position): Position => [dx + (x - ouest) * k * echelle, dy + (nord - y) * echelle];
  const dedans = ([x, y]: Position) => x >= ouest - 0.5 && x <= est + 0.5 && y >= sud - 0.5 && y <= nord + 0.5;
  return { projeter, dedans };
}

const chemin = (trait: Position[], projeter: (p: Position) => Position, ferme: boolean) =>
  trait.map((p, i) => `${i === 0 ? "M" : "L"}${projeter(p).map(f).join(",")}`).join("") + (ferme ? "Z" : "");

function fondWilayas(contours: ContourWilaya[], projeter: (p: Position) => Position, remplissage: (code: string) => string) {
  return contours
    .map((contour) => {
      const d = contour.polygones.map((polygone) => polygone.map((anneau) => chemin(anneau as Position[], projeter, true)).join("")).join("");
      return `<path d="${d}" fill-rule="evenodd" ${remplissage(contour.code)} stroke="${GRIS}" stroke-opacity="0.45" stroke-width="0.7"/>`;
    })
    .join("");
}

/** SVG 720 × 300 à fond transparent. `contours` : contours des wilayas (obligatoires pour une carte). */
export function svgVignette(plan: PlanVignette, contours: ContourWilaya[]): string {
  const ouvrir = `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGEUR_VIGNETTE}" height="${HAUTEUR_VIGNETTE}" viewBox="0 0 ${LARGEUR_VIGNETTE} ${HAUTEUR_VIGNETTE}">`;
  let corps = "";

  if (estCarte(plan)) {
    const { projeter, dedans } = projection(contours);
    if (plan.genre === "wilayas") {
      const valeurs = Object.values(plan.valeurs).sort((a, b) => a - b);
      const rang = (v: number) => (valeurs.length > 1 ? valeurs.findIndex((x) => x >= v) / (valeurs.length - 1) : 1);
      corps = fondWilayas(contours, projeter, (code) => {
        const valeur = plan.valeurs[code];
        return valeur === undefined ? `fill="${GRIS}" fill-opacity="0.15"` : `fill="${VERT}" fill-opacity="${f(0.18 + 0.77 * rang(valeur))}"`;
      });
    } else {
      corps = fondWilayas(contours, projeter, () => `fill="${GRIS}" fill-opacity="0.2"`);
      if (plan.genre === "points") {
        const points = plan.points.filter(dedans);
        const r = points.length < 200 ? 4 : points.length < 2000 ? 2.6 : 1.8;
        corps += `<g fill="${VERT}" fill-opacity="0.8">${points.map((p) => {
          const [x, y] = projeter(p);
          return `<circle cx="${f(x)}" cy="${f(y)}" r="${r}"/>`;
        }).join("")}</g>`;
      } else {
        corps += `<path d="${plan.surfaces.map((t) => chemin(t, projeter, true)).join("")}" fill="${VERT}" fill-opacity="0.35" fill-rule="evenodd" stroke="${VERT}" stroke-width="1"/>`;
        corps += `<path d="${plan.lignes.map((t) => chemin(t, projeter, false)).join("")}" fill="none" stroke="${VERT}" stroke-width="1.6" stroke-linejoin="round"/>`;
      }
    }
  } else if (plan.genre === "courbe") {
    const [g, d, h, b] = [40, 40, 24, 30];
    const xs = plan.points.map((p) => p.tri);
    const ys = plan.points.map((p) => p.valeur);
    const [xmin, xmax] = [Math.min(...xs), Math.max(...xs)];
    let [ymin, ymax] = [Math.min(...ys), Math.max(...ys)];
    if (ymin > 0 && ymin < ymax * 0.6) ymin = 0;
    if (ymax === ymin) [ymin, ymax] = [ymin - 1, ymax + 1];
    const px = (x: number) => g + ((x - xmin) / (xmax - xmin)) * (LARGEUR_VIGNETTE - g - d);
    const py = (y: number) => h + (1 - (y - ymin) / (ymax - ymin)) * (HAUTEUR_VIGNETTE - h - b);
    const sommets = plan.points.map((p) => [px(p.tri), py(p.valeur)] as Position);
    const ligne = (liste: Position[]) => liste.map((p, i) => `${i === 0 ? "M" : "L"}${f(p[0])},${f(p[1])}`).join("");
    const bas = HAUTEUR_VIGNETTE - b;
    const premiereProjection = plan.points.findIndex((p) => p.projection);
    const observes = premiereProjection > 0 ? sommets.slice(0, premiereProjection + 1) : premiereProjection === 0 ? [] : sommets;
    const projetes = premiereProjection >= 0 ? sommets.slice(Math.max(0, premiereProjection)) : [];
    const dernier = sommets[sommets.length - 1];
    corps =
      `<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${VERT}" stop-opacity="0.35"/><stop offset="1" stop-color="${VERT}" stop-opacity="0"/></linearGradient></defs>` +
      `<line x1="${g}" y1="${bas}" x2="${LARGEUR_VIGNETTE - d}" y2="${bas}" stroke="${GRIS}" stroke-opacity="0.5" stroke-width="1.5"/>` +
      `<path d="${ligne(sommets)}L${f(dernier[0])},${bas}L${f(sommets[0][0])},${bas}Z" fill="url(#a)"/>` +
      (observes.length > 1 ? `<path d="${ligne(observes)}" fill="none" stroke="${VERT}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>` : "") +
      (projetes.length > 1 ? `<path d="${ligne(projetes)}" fill="none" stroke="${VERT}" stroke-width="5" stroke-dasharray="10 9" stroke-linecap="round"/>` : "") +
      `<circle cx="${f(dernier[0])}" cy="${f(dernier[1])}" r="8" fill="${VERT}"/>`;
  } else {
    const max = Math.max(...plan.valeurs);
    const pas = (HAUTEUR_VIGNETTE - 40) / plan.valeurs.length;
    const epaisseur = Math.min(26, pas * 0.68);
    corps = plan.valeurs
      .map((valeur, i) => {
        const largeur = Math.max(10, (valeur / max) * (LARGEUR_VIGNETTE - 120));
        const y = 20 + i * pas + (pas - epaisseur) / 2;
        return `<rect x="60" y="${f(y)}" width="${f(largeur)}" height="${f(epaisseur)}" rx="${f(epaisseur / 2)}" fill="${VERT}" fill-opacity="${f(0.95 - (0.5 * i) / plan.valeurs.length)}"/>`;
      })
      .join("");
  }
  return `${ouvrir}${corps}</svg>`;
}
