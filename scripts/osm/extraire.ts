// Téléchargement de l'extrait Geofabrik et extraction des flux avec osmium (une seule passe sur tout le pays).

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Flux } from "./categories.js";
import { appartientAuFlux, versObjet, type Objet } from "./fusion.js";

export const URL_EXTRAIT = "https://download.geofabrik.de/africa/algeria-latest.osm.pbf";
const AGENT = "data-dz-synchro/1.0 (+https://www.data-dz.com)";

/** Date de l'extrait (en-tête `Last-Modified` de Geofabrik), sans le télécharger. */
export async function dateExtrait(): Promise<string | null> {
  const reponse = await fetch(URL_EXTRAIT, { method: "HEAD", headers: { "user-agent": AGENT } });
  if (!reponse.ok) throw new Error(`Geofabrik : HTTP ${reponse.status}`);
  const date = reponse.headers.get("last-modified");
  return date ? new Date(date).toISOString() : null;
}

/** Télécharge l'extrait (~300 Mo) dans `dossier`, sauf s'il y est déjà (cache de l'Action ou passage local). */
export async function telechargerExtrait(dossier: string, cheminLocal?: string): Promise<string> {
  if (cheminLocal) return cheminLocal;
  const chemin = join(dossier, "algeria-latest.osm.pbf");
  if (existsSync(chemin) && (await stat(chemin)).size > 1_000_000) return chemin;
  const reponse = await fetch(URL_EXTRAIT, { headers: { "user-agent": AGENT } });
  if (!reponse.ok || !reponse.body) throw new Error(`Geofabrik : HTTP ${reponse.status}`);
  await pipeline(Readable.fromWeb(reponse.body as import("node:stream/web").ReadableStream), createWriteStream(chemin));
  return chemin;
}

function lancer(commande: string, args: string[]): Promise<void> {
  return new Promise((resoudre, rejeter) => {
    const processus = spawn(commande, args, { stdio: ["ignore", "inherit", "inherit"] });
    processus.on("error", rejeter);
    processus.on("close", (code) => (code === 0 ? resoudre() : rejeter(new Error(`${commande} ${args[0]} : code ${code}`))));
  });
}

/**
 * Filtre l'extrait sur toutes les expressions des flux (osmium tags-filter), l'exporte en GeoJSON ligne à ligne
 * (osmium export), puis range chaque objet dans les flux dont il vérifie les filtres.
 */
export async function extraireFlux(extrait: string, dossier: string, flux: Flux[]): Promise<Map<string, Objet[]>> {
  const filtre = join(dossier, "filtre.osm.pbf");
  const export_ = join(dossier, "filtre.geojsonseq");
  const expressions = [...new Set(flux.flatMap((f) => f.filtres))];
  await lancer("osmium", ["tags-filter", "--overwrite", "-o", filtre, extrait, ...expressions]);
  await lancer("osmium", ["export", "--overwrite", "-f", "geojsonseq", "-x", "print_record_separator=false", "--add-unique-id=type_id", "-o", export_, filtre]);

  const parFlux = new Map<string, Objet[]>(flux.map((f) => [f.code, []]));
  const lignes = createInterface({ input: createReadStream(export_, "utf8"), crlfDelay: Infinity });
  for await (const ligne of lignes) {
    if (!ligne.trim()) continue;
    const brut = JSON.parse(ligne.replace(/^\u001e/, ""));
    const etiquettes = brut.properties ?? {};
    const cibles = flux.filter((f) => appartientAuFlux(etiquettes, f));
    if (cibles.length === 0) continue;
    const objet = versObjet(brut);
    if (!objet) continue;
    for (const cible of cibles) parFlux.get(cible.code)!.push(objet);
  }
  return parFlux;
}

/** Clés inventoriées à chaque passage (en plus de celles des flux) : équipements et lieux, pas la géométrie. */
export const CLES_INVENTAIRE = [
  "amenity", "shop", "office", "healthcare", "leisure", "tourism", "man_made", "power", "historic", "craft", "emergency",
  "public_transport", "aeroway", "railway", "military", "government", "landuse", "natural", "waterway", "building",
  "sport", "education", "telecom", "industrial", "highway", "place", "barrier",
];
export const SEUIL_INVENTAIRE = 30;

/** Tous les « clé=valeur » d'au moins 30 objets pour ces clés (osmium tags-count, une passe sur l'extrait). */
export async function inventaireTags(extrait: string, dossier: string, cles: string[]): Promise<{ cle: string; valeur: string; nb: number }[]> {
  const sortie = join(dossier, "tags.tsv");
  await lancer("osmium", ["tags-count", "--overwrite", "-m", String(SEUIL_INVENTAIRE), "-s", "count-desc", "-o", sortie, extrait, ...cles.map((cle) => `${cle}=*`)]);
  const tags = [];
  for (const ligne of (await readFile(sortie, "utf8")).split("\n")) {
    const [nb, cle, valeur] = ligne.split("\t");
    if (!valeur) continue;
    tags.push({ cle: cle.replace(/^"|"$/g, ""), valeur: valeur.replace(/^"|"$/g, ""), nb: Number(nb) });
  }
  return tags;
}
