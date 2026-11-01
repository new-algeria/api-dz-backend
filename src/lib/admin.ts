import { createHash } from "node:crypto";
import type { PostgrestError } from "@supabase/supabase-js";
import type { Acteur } from "../types.js";
import { avecIllustration } from "./catalogue.js";
import { decrireTable, lireTable, type FormatSource } from "./conversion.js";
import { ErreurApi, introuvable } from "./erreurs.js";
import { filtresRecherche } from "./recherche.js";
import { ecrireObjet, infosObjet, lienEnvoiSigne, lireObjet, supprimerObjet, urlPublique } from "./r2.js";
import { supabaseAdmin } from "./supabase.js";
import { slugDepuisTitre } from "./textes.js";

export const STATUTS = ["brouillon", "en_revue", "publie", "archive"] as const;
export type Statut = (typeof STATUTS)[number];

/** Traduit les erreurs Postgres courantes en erreurs API lisibles. */
export function erreurBase(erreur: PostgrestError): ErreurApi {
  if (erreur.code === "23505") return new ErreurApi(409, "conflict", "Une donnée avec ce slug existe déjà.");
  if (erreur.code === "23503") return new ErreurApi(400, "unknown_reference", "Catégorie, licence ou source inconnue.", erreur.details);
  if (erreur.code === "23514" || erreur.code === "23502" || erreur.code === "22P02") {
    return new ErreurApi(400, "constraint_violation", "Valeur refusée par la base.", erreur.message);
  }
  // Sans ce log, une erreur de schéma (ex. 42703 : colonne absente, migration non appliquée) serait invisible.
  console.error("supabase:", erreur.code, erreur.message);
  if (erreur.code === "42703") {
    return new ErreurApi(503, "schema_outdated", "La base n'est pas à jour : une migration Supabase reste à appliquer.");
  }
  return new ErreurApi(502, "database_error", "Erreur de la base de données.");
}

// `illustration_url`, `diffusion_restreinte` et `licence_manuelle` sont ajoutées par `avecIllustration`
// (absentes tant que les migrations 20261025000009 et 20261031000011 ne sont pas appliquées).
const COLONNES_ADMIN = `
  id, slug, titre, description, readme, statut, categorie_slug, licence_code, licence_details, url_source,
  mots_cles, wilayas, frequence_maj, infos_source, cree_le, mis_a_jour_le, publie_le,
  score, nb_votes_pour, nb_votes_contre, nb_favoris, nb_commentaires,
  sources ( slug, nom, type ),
  versions!datasets_version_courante_fk ( numero, nb_lignes, publie_le, fichiers ( nom, format, principal, taille_octets ) )
`;

export async function listerDonneesAdmin(recherche?: string, statut?: Statut) {
  return avecIllustration(COLONNES_ADMIN, async (colonnes) => {
    let requete = supabaseAdmin().from("datasets").select(colonnes).order("mis_a_jour_le", { ascending: false });
    if (statut) requete = requete.eq("statut", statut);
    for (const filtre of filtresRecherche(recherche ?? "")) requete = requete.or(filtre);
    const { data, error } = await requete;
    return { data: (data ?? []) as unknown as Record<string, unknown>[], error };
  });
}

async function donneeParSlug(slug: string) {
  const data = await avecIllustration(COLONNES_ADMIN, async (colonnes) => {
    const { data, error } = await supabaseAdmin().from("datasets").select(colonnes).eq("slug", slug).maybeSingle();
    return { data: data as unknown, error };
  });
  return data as (Record<string, unknown> & { id: string; slug: string; statut: Statut; illustration_url: string | null }) | null;
}

export async function chargerDonneeAdmin(slug: string) {
  const donnee = await donneeParSlug(slug);
  if (!donnee) throw introuvable("Donnée");
  return donnee;
}

async function idSource(slug: string): Promise<string> {
  const { data, error } = await supabaseAdmin().from("sources").select("id").eq("slug", slug).maybeSingle();
  if (error) throw erreurBase(error);
  if (!data) throw new ErreurApi(400, "unknown_reference", `Source inconnue : ${slug}.`);
  return data.id as string;
}

export interface ChampsDonnee {
  titre?: Record<string, string>;
  description?: Record<string, string> | null;
  readme?: string | null;
  categorie_slug?: string | null;
  source_slug?: string;
  licence_code?: string | null;
  licence_details?: string | null;
  url_source?: string | null;
  mots_cles?: string[];
  wilayas?: string[];
  frequence_maj?: string | null;
  infos_source?: Record<string, unknown> | null;
  statut?: Statut;
}

async function versLigne(champs: ChampsDonnee) {
  const { source_slug, ...colonnes } = champs;
  const ligne: Record<string, unknown> = Object.fromEntries(Object.entries(colonnes).filter(([, valeur]) => valeur !== undefined));
  if (source_slug) ligne.source_id = await idSource(source_slug);
  if (champs.statut === "publie") ligne.publie_le = new Date().toISOString();
  return ligne;
}

export async function creerDonnee(slug: string, champs: ChampsDonnee & { titre: Record<string, string> }, acteur: Acteur) {
  const ligne = await versLigne({ statut: "brouillon", ...champs });
  if (acteur.type === "admin") ligne.auteur_id = acteur.id;
  const { error } = await supabaseAdmin().from("datasets").insert({ slug, ...ligne });
  if (error) throw erreurBase(error);
  return chargerDonneeAdmin(slug);
}

export async function modifierDonnee(slug: string, champs: ChampsDonnee) {
  const actuelle = await chargerDonneeAdmin(slug);
  const ligne = await versLigne(champs);
  // `publie_le` garde la date de première publication.
  if (actuelle.statut === "publie" || actuelle.publie_le) delete ligne.publie_le;
  if (Object.keys(ligne).length > 0) {
    const { error } = await supabaseAdmin()
      .from("datasets")
      .update({ ...ligne, mis_a_jour_le: new Date().toISOString() })
      .eq("id", actuelle.id);
    if (error) throw erreurBase(error);
  }
  return chargerDonneeAdmin(slug);
}

/** Création ou mise à jour (script de synchronisation) : ne touche jamais au statut ni à l'illustration d'une donnée existante. */
/**
 * Champs qu'une synchro peut réécrire sur une donnée existante : jamais le statut, et jamais la licence
 * quand elle a été corrigée à la main (`licence_manuelle`, migration 20261031000011).
 */
export function champsSynchronises<T extends ChampsDonnee>(existante: Record<string, unknown>, champs: T) {
  const { statut: _statut, ...reste } = champs;
  if (existante.licence_manuelle === true) {
    delete reste.licence_code;
    delete reste.licence_details;
  }
  return reste;
}

export async function enregistrerDonnee(slug: string, champs: ChampsDonnee & { titre: Record<string, string> }, acteur: Acteur) {
  const existante = await donneeParSlug(slug);
  if (!existante) return { donnee: await creerDonnee(slug, { statut: "publie", ...champs }, acteur), creee: true };
  return { donnee: await modifierDonnee(slug, champsSynchronises(existante, champs)), creee: false };
}

/** Premier slug libre dans `datasets` ou `sources` : `base`, puis `base-2`, `base-3`… */
export async function slugLibre(table: "datasets" | "sources", base: string): Promise<string> {
  const racine = base || (table === "datasets" ? "donnee" : "source");
  const { data, error } = await supabaseAdmin().from(table).select("slug").like("slug", `${racine}%`);
  if (error) throw erreurBase(error);
  const pris = new Set((data ?? []).map((ligne) => ligne.slug as string));
  if (!pris.has(racine)) return racine;
  for (let n = 2; ; n++) {
    const candidat = `${racine.slice(0, 80 - String(n).length - 1)}-${n}`;
    if (!pris.has(candidat)) return candidat;
  }
}

/** Préfixe R2 propre à une donnée : les fichiers envoyés par l'API ne sont jamais partagés entre données. */
const PREFIXE_DONNEES = "datasets/";
export const prefixeDonnee = (slug: string) => `${PREFIXE_DONNEES}${slug}/`;

export async function supprimerDonnee(slug: string, supprimerFichiers: boolean) {
  const donnee = await chargerDonneeAdmin(slug);
  const cles: string[] = [];
  if (supprimerFichiers) {
    const { data: versions } = await supabaseAdmin().from("versions").select("fichiers ( cle_stockage )").eq("dataset_id", donnee.id);
    for (const version of (versions ?? []) as { fichiers: { cle_stockage: string }[] }[]) {
      // `datasets/` et pas `datasets/<slug>/` : après un renommage, les anciens fichiers restent sous l'ancien identifiant.
      // Les fichiers synchronisés (`json/`, `geojson/`), partagés, ne sont jamais supprimés.
      for (const fichier of version.fichiers) if (fichier.cle_stockage.startsWith(PREFIXE_DONNEES)) cles.push(fichier.cle_stockage);
    }
  }
  const { error } = await supabaseAdmin().from("datasets").delete().eq("id", donnee.id);
  if (error) {
    if (error.code === "23503") {
      throw new ErreurApi(409, "has_dependencies", "Cette donnée est référencée ailleurs (versions, votes, propositions) : archivez-la plutôt.");
    }
    throw erreurBase(error);
  }
  if (donnee.illustration_url) cles.push(...cleIllustration(donnee.illustration_url));
  // Nettoyage au mieux : la donnée est déjà supprimée, un fichier orphelin n'est pas bloquant.
  await Promise.allSettled(cles.map(supprimerObjet));
}

// ---------------------------------------------------------------- Identifiant (slug)

/**
 * Données qui utilisent `slug` : comme identifiant actuel, ou comme ancien identifiant redirigé
 * (`anciens_slugs`, migration 20261029000010 ; ignoré tant qu'elle n'est pas appliquée).
 */
async function usageSlug(slug: string): Promise<{ actuel: string | null; ancien: string | null }> {
  const { data: actuelle, error } = await supabaseAdmin().from("datasets").select("slug").eq("slug", slug).maybeSingle();
  if (error) throw erreurBase(error);
  const { data: ancienne, error: erreurAncien } = await supabaseAdmin()
    .from("datasets")
    .select("slug")
    .contains("anciens_slugs", [slug])
    .limit(1)
    .maybeSingle();
  if (erreurAncien && erreurAncien.code !== "42703") throw erreurBase(erreurAncien);
  return { actuel: (actuelle?.slug as string | undefined) ?? null, ancien: (ancienne?.slug as string | undefined) ?? null };
}

/** `utilise_par` : la donnée qui porte déjà cet identifiant (ou l'a porté et y redirige). */
export async function disponibiliteSlug(slug: string) {
  const { actuel, ancien } = await usageSlug(slug);
  return { slug, disponible: !actuel && !ancien, utilise_par: actuel ?? ancien, ancien_identifiant: !actuel && Boolean(ancien) };
}

/** Liens internes des notifications vers `/datasets/<ancien>` (avec ou sans `#…`, `?…`) réécrits vers le nouveau. */
export function lienRenomme(lien: string, ancien: string, nouveau: string): string | null {
  const prefixe = `/datasets/${ancien}`;
  if (!lien.startsWith(prefixe)) return null;
  const suite = lien.slice(prefixe.length);
  return suite === "" || /^[#?/]/.test(suite) ? `/datasets/${nouveau}${suite}` : null;
}

async function majLiensNotifications(ancien: string, nouveau: string) {
  try {
    const { data, error } = await supabaseAdmin().from("notifications").select("id, lien").like("lien", `/datasets/${ancien}%`);
    if (error) throw error;
    const modifications = (data ?? []).flatMap((ligne) => {
      const lien = lienRenomme(ligne.lien as string, ancien, nouveau);
      return lien ? [{ id: ligne.id as string, lien }] : [];
    });
    await Promise.all(modifications.map(({ id, lien }) => supabaseAdmin().from("notifications").update({ lien }).eq("id", id)));
  } catch (erreur) {
    // Au mieux : un lien de notification ancien reste redirigé par la fiche.
    console.error("renommage: liens des notifications non mis à jour", ancien, erreur);
  }
}

/**
 * Change l'identifiant d'une donnée. L'ancien est gardé dans `anciens_slugs` : la fiche et l'API y redirigent.
 * Refusé pour une donnée synchronisée (la synchronisation la retrouve par son identifiant).
 * `illustrationActuelle` : image par défaut affichée par le site (choisie d'après l'identifiant), gardée telle quelle.
 */
export async function renommerDonnee(ancien: string, nouveau: string, illustrationActuelle?: string) {
  const donnee = await chargerDonneeAdmin(ancien);
  if (nouveau === ancien) return { donnee, redirection: false };
  if ((donnee.sources as { type?: string } | null)?.type === "synchronisee") {
    throw new ErreurApi(409, "synchronized_source", "Une donnée synchronisée garde son identifiant : la synchronisation la retrouve grâce à lui.");
  }
  const usage = await usageSlug(nouveau);
  if (usage.actuel) throw new ErreurApi(409, "slug_taken", `L'identifiant « ${nouveau} » est déjà utilisé.`, { slug: usage.actuel });
  if (usage.ancien && usage.ancien !== ancien) {
    throw new ErreurApi(409, "slug_taken", `« ${nouveau} » est un ancien identifiant de « ${usage.ancien} » (ses anciens liens y redirigent).`, {
      slug: usage.ancien,
    });
  }

  const { data: lue, error: erreurLecture } = await supabaseAdmin().from("datasets").select("anciens_slugs").eq("id", donnee.id).maybeSingle();
  if (erreurLecture && erreurLecture.code !== "42703") throw erreurBase(erreurLecture);
  const anciens = erreurLecture ? null : (((lue?.anciens_slugs as string[] | null) ?? []) as string[]);

  const ligne: Record<string, unknown> = { slug: nouveau, mis_a_jour_le: new Date().toISOString() };
  // L'image par défaut du site dépend de l'identifiant : on fige celle qui était affichée (pack public uniquement).
  if (!donnee.illustration_url && illustrationActuelle?.startsWith(urlPublique("web-assets/"))) ligne.illustration_url = illustrationActuelle;
  // Revenir à un ancien identifiant le retire de la liste.
  if (anciens) ligne.anciens_slugs = [...new Set([...anciens.filter((slug) => slug !== nouveau), ancien])];
  const { error } = await supabaseAdmin().from("datasets").update(ligne).eq("id", donnee.id);
  if (error) {
    if (error.code === "23505") throw new ErreurApi(409, "slug_taken", `L'identifiant « ${nouveau} » est déjà utilisé.`);
    throw erreurBase(error);
  }
  await majLiensNotifications(ancien, nouveau);
  return { donnee: await chargerDonneeAdmin(nouveau), redirection: anciens !== null };
}

// ---------------------------------------------------------------- Fichiers et versions

export const FORMATS_ENVOI = ["json", "geojson", "csv", "ics"] as const;
const TYPES_ENVOI: Record<(typeof FORMATS_ENVOI)[number], string> = {
  json: "application/json",
  geojson: "application/geo+json",
  csv: "text/csv",
  ics: "text/calendar",
};
export const TAILLE_MAX_FICHIER = 100 * 1024 * 1024;

export async function preparerEnvoi(slug: string, nom: string, format: (typeof FORMATS_ENVOI)[number]) {
  await chargerDonneeAdmin(slug);
  const cle = `${prefixeDonnee(slug)}${Date.now()}/${nom}.${format}`;
  const typeContenu = TYPES_ENVOI[format];
  return { cle, url: await lienEnvoiSigne(cle, typeContenu), methode: "PUT", content_type: typeContenu, expire_dans: 900 };
}

function versionSuivante(numero: string | undefined): string {
  const morceaux = numero?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!morceaux) return "1.0.0";
  return `${morceaux[1]}.${Number(morceaux[2]) + 1}.0`;
}

function compterEvenementsICS(texte: string): number {
  const lignes = texte.replace(/\r?\n[ \t]/g, "");
  return lignes.match(/^BEGIN:VEVENT\s*$/gim)?.length ?? 0;
}

export interface FichierVersion {
  cle: string;
  nom: string;
  format: FormatSource | "ics";
  principal?: boolean;
}

/**
 * Publie une nouvelle version à partir de fichiers déjà envoyés sur R2 (`preparerEnvoi`).
 * Chaque fichier est relu et validé ; le principal fournit son nombre de lignes ou d'événements, ses colonnes et son aperçu.
 */
export async function publierVersion(
  slug: string,
  entree: { numero?: string; notes?: string | null; fichiers: FichierVersion[] },
  acteur: Acteur
) {
  const donnee = await chargerDonneeAdmin(slug);
  const fichiers = entree.fichiers.map((fichier, indice) => ({ ...fichier, principal: fichier.principal ?? indice === 0 }));
  if (fichiers.filter((fichier) => fichier.principal).length !== 1) {
    throw new ErreurApi(400, "invalid_files", "Exactement un fichier doit être principal.");
  }

  // Un fichier à la fois : jusqu'à 30 fichiers de 100 Mo ne tiendraient pas en mémoire ensemble.
  const analyses = [];
  for (const fichier of fichiers) {
    if (!fichier.cle.startsWith(prefixeDonnee(slug))) {
      throw new ErreurApi(400, "invalid_files", `Clé hors du dossier de la donnée : ${fichier.cle}.`);
    }
    const infos = await infosObjet(fichier.cle);
    if (!infos) throw new ErreurApi(400, "invalid_files", `Fichier non envoyé : ${fichier.nom}.${fichier.format}.`);
    if (infos.taille > TAILLE_MAX_FICHIER) throw new ErreurApi(413, "file_too_large", `${fichier.nom} dépasse 100 Mo.`);
    const reponse = await lireObjet(fichier.cle);
    const texte = await reponse!.text();
    const table = fichier.format === "ics" ? null : lireTable(texte, fichier.format);
    if (fichier.format === "ics" && (!/^(?:\uFEFF)?BEGIN:VCALENDAR(?:\r?\n|$)/.test(texte) || !/END:VCALENDAR\s*$/.test(texte))) {
      throw new ErreurApi(422, "invalid_file", `Fichier iCalendar invalide : ${fichier.nom}.ics.`);
    }
    analyses.push({
      fichier,
      taille: infos.taille,
      sha256: createHash("sha256").update(texte).digest("hex"),
      description: fichier.principal
        ? table
          ? decrireTable(table)
          : { colonnes: [], apercu: [], nbLignes: fichier.format === "ics" ? compterEvenementsICS(texte) : 0 }
        : null,
    });
  }
  const principal = analyses.find((analyse) => analyse.fichier.principal)!.description!;

  const { data: courante } = await supabaseAdmin()
    .from("datasets")
    .select("versions!datasets_version_courante_fk ( numero )")
    .eq("id", donnee.id)
    .maybeSingle();
  const numero = entree.numero ?? versionSuivante((courante?.versions as { numero?: string } | null)?.numero);

  const { data: version, error } = await supabaseAdmin()
    .from("versions")
    .insert({
      dataset_id: donnee.id,
      numero,
      notes: entree.notes ?? null,
      auteur_id: acteur.type === "admin" ? acteur.id : null,
      nb_lignes: principal.nbLignes,
      colonnes: principal.colonnes,
      apercu: principal.apercu,
      publie_le: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw erreurBase(error);

  const { error: erreurFichiers } = await supabaseAdmin()
    .from("fichiers")
    .insert(
      analyses.map(({ fichier, taille, sha256 }) => ({
        version_id: version.id,
        format: fichier.format,
        cle_stockage: fichier.cle,
        nom: fichier.nom,
        principal: fichier.principal,
        taille_octets: taille,
        sha256,
      }))
    );
  if (erreurFichiers) {
    await supabaseAdmin().from("versions").delete().eq("id", version.id);
    throw erreurBase(erreurFichiers);
  }

  const { error: erreurCourante } = await supabaseAdmin()
    .from("datasets")
    .update({ version_courante_id: version.id, mis_a_jour_le: new Date().toISOString() })
    .eq("id", donnee.id);
  if (erreurCourante) throw erreurBase(erreurCourante);

  return { numero, nb_lignes: principal.nbLignes, colonnes: principal.colonnes, fichiers: analyses.length };
}

// ---------------------------------------------------------------- Illustration

const PREFIXE_ILLUSTRATIONS = "web-assets/datasets/";
export const TAILLE_MAX_ILLUSTRATION = 2 * 1024 * 1024;

/** Type réel de l'image d'après ses premiers octets (on ne fait pas confiance au type annoncé). */
export function typeImage(octets: Uint8Array): { extension: string; type: string } | null {
  const debut = (n: number) => [...octets.slice(0, n)];
  if (debut(8).join() === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].join()) return { extension: "png", type: "image/png" };
  if (debut(3).join() === [0xff, 0xd8, 0xff].join()) return { extension: "jpg", type: "image/jpeg" };
  const texte = new TextDecoder().decode(octets.slice(0, 12));
  if (texte.startsWith("RIFF") && texte.slice(8, 12) === "WEBP") return { extension: "webp", type: "image/webp" };
  return null;
}

/** Clé R2 d'une illustration envoyée par l'API (les images du pack d'origine ne sont jamais supprimées). */
function cleIllustration(url: string): string[] {
  const indice = url.indexOf(PREFIXE_ILLUSTRATIONS);
  return indice >= 0 ? [url.slice(indice)] : [];
}

export async function enregistrerIllustration(slug: string, octets: Uint8Array) {
  const donnee = await chargerDonneeAdmin(slug);
  if (octets.byteLength > TAILLE_MAX_ILLUSTRATION) throw new ErreurApi(413, "file_too_large", "Image trop lourde (2 Mo maximum).");
  const type = typeImage(octets);
  if (!type) throw new ErreurApi(400, "invalid_image", "Formats acceptés : PNG, JPEG, WebP.");

  const cle = `${PREFIXE_ILLUSTRATIONS}${slug}-${Date.now()}.${type.extension}`;
  await ecrireObjet(cle, octets, type.type, "public, max-age=31536000, immutable");
  const url = urlPublique(cle);
  const { error } = await supabaseAdmin().from("datasets").update({ illustration_url: url }).eq("id", donnee.id);
  if (error) {
    await supprimerObjet(cle).catch(() => undefined);
    throw erreurBase(error);
  }
  if (donnee.illustration_url) await Promise.allSettled(cleIllustration(donnee.illustration_url).map(supprimerObjet));
  return { illustration_url: url };
}

export async function retirerIllustration(slug: string) {
  const donnee = await chargerDonneeAdmin(slug);
  const { error } = await supabaseAdmin().from("datasets").update({ illustration_url: null }).eq("id", donnee.id);
  if (error) throw erreurBase(error);
  if (donnee.illustration_url) await Promise.allSettled(cleIllustration(donnee.illustration_url).map(supprimerObjet));
}

// ---------------------------------------------------------------- Sources

const COLONNES_SOURCE = "slug, nom, url, type, verifiee, description";
/** Source servant de modèle au type des nouvelles sources (les valeurs possibles de `type` dépendent de la base). */
const SOURCE_MODELE = "communaute";

/** Toutes les sources, sans cache : une source créée apparaît tout de suite dans l'administration. */
export async function listerSourcesAdmin() {
  const { data, error } = await supabaseAdmin().from("sources").select(COLONNES_SOURCE).order("nom");
  if (error) throw erreurBase(error);
  return data ?? [];
}

/** Nom comparé sans casse, accents, ponctuation ni espaces : « Banque Mondiale » = « banque-mondiale ». */
export const cleNomSource = (nom: string) => slugDepuisTitre(nom).replace(/-/g, "");

export async function creerSource(champs: { nom: string; url?: string | null; description?: string | null }) {
  const sources = await listerSourcesAdmin();
  const existante = sources.find((source) => cleNomSource(source.nom as string) === cleNomSource(champs.nom));
  if (existante) throw new ErreurApi(409, "source_exists", `La source « ${existante.nom} » existe déjà.`, { slug: existante.slug });

  const slug = await slugLibre("sources", slugDepuisTitre(champs.nom));
  const modele = sources.find((source) => source.slug === SOURCE_MODELE);
  const ligne: Record<string, unknown> = { slug, nom: champs.nom, url: champs.url ?? null };
  if (champs.description) ligne.description = champs.description;
  // Sans modèle, la base applique sa valeur par défaut.
  if (modele?.type) ligne.type = modele.type;
  const { data, error } = await supabaseAdmin().from("sources").insert(ligne).select(COLONNES_SOURCE).single();
  if (error) throw erreurBase(error);
  return data;
}
