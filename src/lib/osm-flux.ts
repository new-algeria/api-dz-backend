import { ErreurApi, introuvable } from "./erreurs.js";
import { filtreDepuis, lireFiltre } from "./osm-format.js";
import { supabaseAdmin } from "./supabase.js";
import { erreurSynchro } from "./synchro.js";

// Tags OpenStreetMap gérés depuis l'administration (tables `osm_flux` et `osm_tags`, migration 20261107000019 de data-dz).
// Un flux = des expressions `osmium tags-filter` (« nwr/cle=v1,v2 ») rangées dans un fichier d'une donnée.
// L'inventaire (`osm_tags`) est déposé par le robot à chaque passage ; « pris » se déduit des flux.

export const ETATS_TAG = ["nouveau", "a_etudier", "ecarte"] as const;
export type EtatTag = (typeof ETATS_TAG)[number];

export { FORMAT_CLE, FORMAT_FILTRE, FORMAT_VALEUR, filtreDepuis, lireFiltre } from "./osm-format.js";

export interface FluxOsm {
  code: string;
  dataset_slug: string;
  fichier: string;
  filtres: string[];
  exige: Record<string, string[]>;
  rayon_m: number | null;
  actif: boolean;
  ordre: number;
  dernier_compte: number | null;
  dernier_compte_le: string | null;
}

/** Flux qui extrait déjà ce tag (sans compter les conditions `exige`), ou `null`. */
export function fluxDuTag(flux: Pick<FluxOsm, "code" | "filtres" | "actif">[], cle: string, valeur: string) {
  return flux.find((f) => f.actif && f.filtres.some((filtre) => {
    const lu = lireFiltre(filtre);
    return lu?.cle === cle && lu.valeurs.includes(valeur);
  }))?.code ?? null;
}

const COLONNES_FLUX = "code, dataset_slug, fichier, filtres, exige, rayon_m, actif, ordre, dernier_compte, dernier_compte_le";

export async function listerFlux(): Promise<FluxOsm[]> {
  const { data, error } = await supabaseAdmin().from("osm_flux").select(COLONNES_FLUX).order("ordre").order("code");
  if (error) throw erreurSynchro(error);
  return (data ?? []) as FluxOsm[];
}

export interface ChampsFlux {
  dataset_slug: string;
  fichier: string;
  cle: string;
  valeurs: string[];
  exige?: Record<string, string[]>;
  rayon_m?: number | null;
  actif?: boolean;
  ordre?: number;
}

/**
 * Crée ou remplace un flux. La donnée cible doit exister (une donnée créée par la synchro elle-même existe dès
 * qu'un flux la vise déjà : c'est le cas des nouvelles données prévues dans le code).
 */
export async function enregistrerFlux(code: string, champs: ChampsFlux) {
  const base = supabaseAdmin();
  const [{ data: donnee, error: erreurDonnee }, { data: dejaVisee, error: erreurVisee }] = await Promise.all([
    base.from("datasets").select("slug, diffusion_restreinte").eq("slug", champs.dataset_slug).maybeSingle(),
    base.from("osm_flux").select("code").eq("dataset_slug", champs.dataset_slug).limit(1),
  ]);
  if (erreurDonnee) throw erreurSynchro(erreurDonnee);
  if (erreurVisee) throw erreurSynchro(erreurVisee);
  if (!donnee && !dejaVisee?.length) throw new ErreurApi(400, "unknown_dataset", "Donnée inconnue : créez-la d'abord dans l'administration.");
  if (donnee?.diffusion_restreinte) throw new ErreurApi(400, "not_redistributable", "Donnée en diffusion restreinte : pas de fichier OpenStreetMap.");

  const ligne = {
    code,
    dataset_slug: champs.dataset_slug,
    fichier: champs.fichier,
    filtres: [filtreDepuis(champs.cle, champs.valeurs)],
    exige: champs.exige ?? {},
    rayon_m: champs.rayon_m ?? null,
    actif: champs.actif ?? true,
    ...(champs.ordre !== undefined ? { ordre: champs.ordre } : {}),
    modifie_le: new Date().toISOString(),
  };
  const { data, error } = await base.from("osm_flux").upsert(ligne, { onConflict: "code" }).select(COLONNES_FLUX).single();
  if (error) {
    if (error.code === "23505") throw new ErreurApi(409, "conflict", "Cette donnée a déjà un fichier de ce nom.");
    throw erreurSynchro(error);
  }
  return data as FluxOsm;
}

export async function modifierFlux(code: string, champs: { actif?: boolean; rayon_m?: number | null; ordre?: number }) {
  const maj = Object.fromEntries(Object.entries(champs).filter(([, valeur]) => valeur !== undefined));
  const { data, error } = await supabaseAdmin()
    .from("osm_flux")
    .update({ ...maj, modifie_le: new Date().toISOString() })
    .eq("code", code)
    .select(COLONNES_FLUX)
    .maybeSingle();
  if (error) throw erreurSynchro(error);
  if (!data) throw introuvable("Flux");
  return data as FluxOsm;
}

/** Retire un flux : le robot ne l'extrait plus, le fichier déjà publié reste en ligne tel quel. */
export async function supprimerFlux(code: string) {
  const { data, error } = await supabaseAdmin().from("osm_flux").delete().eq("code", code).select("code");
  if (error) throw erreurSynchro(error);
  if (!data?.length) throw introuvable("Flux");
}

export async function listerTags() {
  const [flux, { data, error }] = await Promise.all([
    listerFlux(),
    supabaseAdmin().from("osm_tags").select("cle, valeur, nb, nb_precedent, etat, premier_vu, dernier_vu").order("nb", { ascending: false }).limit(5000),
  ]);
  if (error) throw erreurSynchro(error);
  const tags = (data ?? []).map((tag) => ({ ...tag, flux: fluxDuTag(flux, tag.cle, tag.valeur) }));
  const dernier = tags.reduce<string | null>((max, tag) => (!max || tag.dernier_vu > max ? tag.dernier_vu : max), null);
  return { data: tags, inventaire_du: dernier };
}

export async function classerTag(cle: string, valeur: string, etat: EtatTag) {
  const { data, error } = await supabaseAdmin().from("osm_tags").update({ etat }).eq("cle", cle).eq("valeur", valeur).select("cle").maybeSingle();
  if (error) throw erreurSynchro(error);
  if (!data) throw introuvable("Tag");
}

/** Inventaire déposé par le robot ; renvoie les tags apparus depuis le passage précédent. */
export async function deposerInventaire(tags: { cle: string; valeur: string; nb: number }[], flux: { code: string; nb: number }[]) {
  const { data, error } = await supabaseAdmin().rpc("enregistrer_inventaire_osm", { p_tags: tags, p_flux: flux });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      console.error("supabase:", error.code, error.message);
      throw new ErreurApi(503, "schema_outdated", "La base n'est pas à jour : une migration Supabase reste à appliquer.");
    }
    throw erreurSynchro(error);
  }
  return { nouveaux: (data ?? []) as { cle: string; valeur: string; nb: number }[] };
}

const OVERPASS = "https://overpass-api.de/api/interpreter";
const echapperRegex = (texte: string) => texte.replace(/[.+]/g, "\\$&");

/**
 * Nombre d'objets portant ces tags en Algérie : l'inventaire du dernier passage s'il les connaît tous (aucun appel
 * externe), sinon une seule requête Overpass `out count` (légère, réservée aux gestionnaires).
 */
export async function compterTag(cle: string, valeurs: string[]) {
  const { data, error } = await supabaseAdmin().from("osm_tags").select("valeur, nb, dernier_vu").eq("cle", cle).in("valeur", valeurs);
  if (error) throw erreurSynchro(error);
  if (data && data.length === valeurs.length) {
    return { nb: data.reduce((total, tag) => total + tag.nb, 0), source: "inventaire" as const, date: data[0]?.dernier_vu ?? null };
  }

  const requete =
    `[out:json][timeout:20];area["ISO3166-1"="DZ"][admin_level=2]->.dz;` +
    `nwr["${cle}"~"^(${valeurs.map(echapperRegex).join("|")})$"](area.dz);out count;`;
  let reponse: Response;
  try {
    reponse = await fetch(OVERPASS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "data-dz-admin/1.0 (+https://www.data-dz.com)" },
      body: new URLSearchParams({ data: requete }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new ErreurApi(502, "overpass_unavailable", "Overpass ne répond pas : réessayez dans une minute.");
  }
  if (!reponse.ok) throw new ErreurApi(502, "overpass_unavailable", `Overpass a refusé la requête (${reponse.status}) : réessayez dans une minute.`);
  const json = (await reponse.json().catch(() => null)) as { elements?: { tags?: { total?: string } }[]; osm3s?: { timestamp_osm_base?: string } } | null;
  const total = Number(json?.elements?.[0]?.tags?.total);
  if (!Number.isFinite(total)) throw new ErreurApi(502, "overpass_unavailable", "Réponse d'Overpass illisible.");
  return { nb: total, source: "overpass" as const, date: json?.osm3s?.timestamp_osm_base ?? null };
}
