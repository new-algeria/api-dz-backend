import * as XLSX from "xlsx";
import type { Acteur } from "../types.js";
import { chargerDonneeAdmin, creerDonnee, erreurBase, modifierDonnee, prefixeDonnee, publierVersion, slugLibre, supprimerDonnee, type ChampsDonnee } from "./admin.js";
import type { FormatSource } from "./conversion.js";
import { ErreurApi, introuvable } from "./erreurs.js";
import { ecrireObjet } from "./r2.js";
import { supabaseAdmin } from "./supabase.js";
import { slugDepuisTitre } from "./textes.js";

/**
 * Mise en ligne d'une proposition acceptée : la donnée est créée (ou reçoit une nouvelle version)
 * à partir du contenu et des fichiers de la proposition, puis la proposition passe en « publiée »
 * (`marquer_soumission_publiee`, réservée à la clé secrète ; la base notifie l'auteur).
 */

const BUCKET_SOUMISSIONS = "soumissions";
const SOURCE_COMMUNAUTE = "communaute";
const TYPES_CONTENU: Record<FormatProposition, string> = { json: "application/json", geojson: "application/geo+json", csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ics: "text/calendar" };
/** Ordre de préférence du fichier principal : la carte, le tableau, puis le calendrier. */
const PRIORITE_PRINCIPAL: Record<FormatProposition, number> = { geojson: 0, csv: 1, json: 2, xlsx: 3, ics: 4 };

interface Soumission {
  id: string;
  type: "nouvelle_donnee" | "mise_a_jour";
  statut: string;
  dataset_id: string | null;
  titre: Record<string, string>;
  description: Record<string, string> | null;
  categorie_slug: string | null;
  licence_code: string | null;
  source_nom: string | null;
  source_url: string | null;
  mots_cles: string[];
  wilayas: string[];
  periode_debut: string | null;
  periode_fin: string | null;
  soumission_fichiers: { chemin_stockage: string; nom_original: string; type_mime: string | null; cree_le: string }[];
}

// ---------------------------------------------------------------- Fonctions pures (testées)

/** Nom logique d'un fichier (`Pharmacies 2026.geojson` → `pharmacies-2026`), conforme à `NomFichier`. */
export function nomLogique(nomOriginal: string): string {
  return (
    nomOriginal
      .replace(/\.[^.]+$/, "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "")
      .slice(0, 100) || "donnees"
  );
}

export type FormatProposition = FormatSource | "xlsx" | "ics";

/** Format publiable d'un fichier joint ; `null` pour ceux que le catalogue ne sait pas lire (pdf, zip, xml…). */
export function formatProposition(nomOriginal: string, typeMime: string | null): FormatProposition | null {
  const extension = nomOriginal.split(".").pop()?.toLowerCase();
  if (extension === "geojson" || typeMime === "application/geo+json") return "geojson";
  if (extension === "json") return "json";
  if (extension === "csv") return "csv";
  if (extension === "xlsx") return "xlsx";
  if (extension === "ics" || typeMime === "text/calendar" || typeMime === "application/ics") return "ics";
  return null;
}

/** Champs de la donnée créée à partir d'une proposition (source choisie par l'admin, sinon « communauté » ; la page d'origine en `url_source`). */
export function champsDepuisProposition(soumission: Soumission, sourceSlug = SOURCE_COMMUNAUTE): ChampsDonnee & { titre: Record<string, string> } {
  const periode = [soumission.periode_debut?.slice(0, 4), soumission.periode_fin?.slice(0, 4)].filter(Boolean);
  const infos: Record<string, unknown> = { soumission_id: soumission.id };
  if (soumission.source_nom) infos.source_nom = soumission.source_nom;
  if (periode.length > 0) infos.periode = [...new Set(periode)].join("-");
  // Le catalogue trie et affiche d'abord le titre français : il est repris de l'anglais ou de l'arabe s'il manque.
  const { fr, en, ar } = soumission.titre;
  return {
    titre: { ...soumission.titre, fr: fr || en || ar || "" },
    description: soumission.description,
    categorie_slug: soumission.categorie_slug,
    licence_code: soumission.licence_code,
    url_source: soumission.source_url,
    mots_cles: soumission.mots_cles,
    wilayas: soumission.wilayas,
    source_slug: sourceSlug,
    infos_source: infos,
  };
}

// ---------------------------------------------------------------- Mise en ligne

async function chargerProposition(id: string): Promise<Soumission> {
  const { data, error } = await supabaseAdmin()
    .from("soumissions")
    .select(
      `id, type, statut, dataset_id, titre, description, categorie_slug, licence_code, source_nom, source_url,
       mots_cles, wilayas, periode_debut, periode_fin,
       soumission_fichiers ( chemin_stockage, nom_original, type_mime, cree_le )`
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw erreurBase(error);
  if (!data) throw introuvable("Proposition");
  return data as unknown as Soumission;
}

/** Première feuille d'un classeur Excel en CSV. */
export function xlsxEnCsv(octets: ArrayBuffer): string {
  const classeur = XLSX.read(new Uint8Array(octets), { type: "array" });
  const feuille = classeur.Sheets[classeur.SheetNames[0] ?? ""];
  if (!feuille) throw new ErreurApi(422, "invalid_file", "Classeur Excel vide.");
  return XLSX.utils.sheet_to_csv(feuille);
}

/** Copie les fichiers lisibles de la proposition (bucket privé Supabase) vers le dossier R2 de la donnée. */
async function copierFichiers(soumission: Soumission, slug: string) {
  const dossier = `${prefixeDonnee(slug)}${Date.now()}/`;
  const fichiers: { cle: string; nom: string; format: FormatSource | "ics"; principal: boolean }[] = [];
  const ignores: string[] = [];
  const nomsPris = new Set<string>();

  const joints = [...soumission.soumission_fichiers]
    .map((joint) => ({ joint, format: formatProposition(joint.nom_original, joint.type_mime) }))
    .sort((a, b) => a.joint.cree_le.localeCompare(b.joint.cree_le));

  for (const { joint, format } of joints) {
    if (!format) {
      ignores.push(joint.nom_original);
      continue;
    }
    const { data: blob, error } = await supabaseAdmin().storage.from(BUCKET_SOUMISSIONS).download(joint.chemin_stockage);
    if (error || !blob) throw new ErreurApi(502, "storage_error", `Fichier illisible : ${joint.nom_original}.`);

    const formatFinal: FormatSource | "ics" = format === "xlsx" ? "csv" : format;
    const contenu = format === "xlsx" ? xlsxEnCsv(await blob.arrayBuffer()) : new Uint8Array(await blob.arrayBuffer());
    let nom = nomLogique(joint.nom_original);
    for (let n = 2; nomsPris.has(`${nom}.${formatFinal}`); n++) nom = `${nomLogique(joint.nom_original).slice(0, 95)}-${n}`;
    nomsPris.add(`${nom}.${formatFinal}`);

    const cle = `${dossier}${nom}.${formatFinal}`;
    await ecrireObjet(cle, contenu, TYPES_CONTENU[formatFinal]);
    fichiers.push({ cle, nom, format: formatFinal, principal: false });
  }

  if (fichiers.length === 0) {
    throw new ErreurApi(
      422,
      "no_usable_file",
      "Aucun fichier CSV, JSON, GeoJSON, Excel ou ICS dans la proposition : créez la donnée depuis la gestion des données."
    );
  }
  const principal = fichiers.reduce((meilleur, fichier) => (PRIORITE_PRINCIPAL[fichier.format] < PRIORITE_PRINCIPAL[meilleur.format] ? fichier : meilleur));
  principal.principal = true;
  return { fichiers, ignores };
}

export async function publierProposition(id: string, acteur: Acteur, options: { slug?: string; source_slug?: string } = {}) {
  if (acteur.type !== "admin") throw new ErreurApi(403, "forbidden", "Réservé aux administrateurs.");
  const soumission = await chargerProposition(id);
  if (soumission.statut !== "acceptee") {
    throw new ErreurApi(409, "invalid_status", "Seule une proposition acceptée peut être mise en ligne.");
  }

  let slug: string;
  let creee = false;
  if (soumission.type === "mise_a_jour") {
    const { data: cible, error } = await supabaseAdmin()
      .from("datasets")
      .select("slug, sources ( type )")
      .eq("id", soumission.dataset_id!)
      .maybeSingle();
    if (error) throw erreurBase(error);
    if (!cible) throw new ErreurApi(409, "dataset_missing", "La donnée à mettre à jour n'existe plus.");
    if ((cible.sources as { type?: string } | null)?.type === "synchronisee") {
      throw new ErreurApi(409, "synchronized_source", "Une donnée synchronisée ne se met pas à jour par une proposition.");
    }
    slug = cible.slug as string;
  } else {
    slug = options.slug ?? (await slugLibre("datasets", slugDepuisTitre(soumission.titre.fr || soumission.titre.en || "")));
    // Brouillon tant que les fichiers ne sont pas publiés : un visiteur ne voit jamais une donnée vide.
    await creerDonnee(slug, { ...champsDepuisProposition(soumission, options.source_slug), statut: "brouillon" }, acteur);
    creee = true;
  }

  try {
    const { fichiers, ignores } = await copierFichiers(soumission, slug);
    const version = await publierVersion(slug, { fichiers }, acteur);
    if (creee) await modifierDonnee(slug, { statut: "publie" });
    const donnee = await chargerDonneeAdmin(slug);
    const { error } = await supabaseAdmin().rpc("marquer_soumission_publiee", { soumission_id: soumission.id, dataset_id: donnee.id });
    if (error) throw erreurBase(error);
    return { slug, creee, version, fichiers_ignores: ignores };
  } catch (erreur) {
    // Une nouvelle donnée à moitié créée est retirée (avec ses fichiers R2) : on peut relancer proprement.
    if (creee) await supprimerDonnee(slug, true).catch((e) => console.error("propositions: nettoyage impossible", slug, e));
    throw erreur;
  }
}
