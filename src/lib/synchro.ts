import type { PostgrestError } from "@supabase/supabase-js";
import { erreurBase } from "./admin.js";
import { ErreurApi, introuvable } from "./erreurs.js";
import { supabaseAdmin } from "./supabase.js";

// Synchronisations (tables `synchronisations` et `synchro_executions`, migration 20261102000017 de data-dz).
// Mode « interne » : lancée par la GitHub Action de ce dépôt (scripts/osm), qui demande ici si elle doit travailler
// et y dépose son rapport. Mode « externe » (GeoAlgeria) : script d'un partenaire, seulement affiché.

export const STATUTS_EXECUTION = ["reussie", "partielle", "echec", "essai"] as const;
export type StatutExecution = (typeof STATUTS_EXECUTION)[number];
export const DECLENCHEURS = ["planifie", "manuel", "forcer"] as const;

/** L'Action quotidienne ne part jamais à la même seconde : une échéance atteinte à 2 h près compte. */
const MARGE_MS = 2 * 60 * 60 * 1000;
const JOUR_MS = 24 * 60 * 60 * 1000;
const EXECUTIONS_GARDEES = 60;
const EXECUTIONS_AFFICHEES = 10;

const COLONNES =
  "code, nom, mode, actif, intervalle_jours, forcer, derniere_execution, dernier_statut, dernier_rapport, config, description, mis_a_jour_le, source_id, sources ( slug, nom )";

interface LigneSynchro {
  code: string;
  mode: "interne" | "externe";
  actif: boolean;
  intervalle_jours: number;
  forcer: boolean;
  derniere_execution: string | null;
  source_id: string | null;
  [cle: string]: unknown;
}

/** Prochaine exécution (dernière réussie + intervalle) et décision du jour pour une synchronisation interne. */
export function etatSynchro(synchro: Pick<LigneSynchro, "mode" | "actif" | "intervalle_jours" | "forcer" | "derniere_execution">, maintenant = new Date()) {
  const echeance = synchro.derniere_execution ? Date.parse(synchro.derniere_execution) + synchro.intervalle_jours * JOUR_MS : null;
  const aFaire = synchro.mode === "interne" && synchro.actif && (synchro.forcer || echeance === null || echeance - MARGE_MS <= maintenant.getTime());
  return { prochaine_execution: echeance === null ? null : new Date(echeance).toISOString(), a_faire: aFaire };
}

/** Tables absentes (migration non appliquée) : 503 lisible plutôt qu'une erreur de base. */
export function erreurSynchro(erreur: PostgrestError): ErreurApi {
  if (erreur.code === "PGRST205" || erreur.code === "42P01") {
    console.error("supabase:", erreur.code, erreur.message);
    return new ErreurApi(503, "schema_outdated", "La base n'est pas à jour : une migration Supabase reste à appliquer.");
  }
  return erreurBase(erreur);
}

async function executionsDe(code: string) {
  const { data, error } = await supabaseAdmin()
    .from("synchro_executions")
    .select("id, debut, fin, statut, declencheur, resume, rapport")
    .eq("synchro_code", code)
    .order("debut", { ascending: false })
    .limit(EXECUTIONS_AFFICHEES);
  if (error) throw erreurSynchro(error);
  return data ?? [];
}

/** Dernières versions publiées des données de cette source (suivi d'une synchronisation externe). */
async function dernieresVersions(sourceId: string) {
  const { data, error } = await supabaseAdmin()
    .from("datasets")
    .select("slug, titre, versions!datasets_version_courante_fk ( numero, publie_le )")
    .eq("source_id", sourceId)
    .order("mis_a_jour_le", { ascending: false })
    .limit(8);
  if (error) throw erreurBase(error);
  return (data ?? []).map((ligne) => ({ slug: ligne.slug, titre: ligne.titre, version: ligne.versions ?? null }));
}

async function completer(ligne: LigneSynchro) {
  const { source_id: sourceId, ...reste } = ligne;
  return {
    ...reste,
    ...etatSynchro(ligne),
    executions: await executionsDe(ligne.code),
    dernieres_versions: sourceId ? await dernieresVersions(sourceId) : [],
  };
}

export async function listerSynchros() {
  const { data, error } = await supabaseAdmin().from("synchronisations").select(COLONNES).order("mode").order("nom");
  if (error) throw erreurSynchro(error);
  return Promise.all(((data ?? []) as unknown as LigneSynchro[]).map(completer));
}

async function ligneSynchro(code: string): Promise<LigneSynchro> {
  const { data, error } = await supabaseAdmin().from("synchronisations").select(COLONNES).eq("code", code).maybeSingle();
  if (error) throw erreurSynchro(error);
  if (!data) throw introuvable("Synchronisation");
  return data as unknown as LigneSynchro;
}

export async function chargerSynchro(code: string) {
  return completer(await ligneSynchro(code));
}

export async function modifierSynchro(code: string, champs: { actif?: boolean; intervalle_jours?: number; forcer?: boolean }) {
  await ligneSynchro(code);
  const ligne = Object.fromEntries(Object.entries(champs).filter(([, valeur]) => valeur !== undefined));
  if (Object.keys(ligne).length > 0) {
    const { error } = await supabaseAdmin()
      .from("synchronisations")
      .update({ ...ligne, mis_a_jour_le: new Date().toISOString() })
      .eq("code", code);
    if (error) throw erreurSynchro(error);
  }
  return chargerSynchro(code);
}

export interface Execution {
  statut: StatutExecution;
  declencheur?: (typeof DECLENCHEURS)[number];
  debut?: string;
  fin?: string;
  resume?: string | null;
  rapport?: Record<string, unknown>;
}

/**
 * Rapport d'une exécution. Réussie ou partielle : elle devient la dernière exécution (point de départ de l'échéance)
 * et « forcer » retombe. Échec : l'échéance ne bouge pas, l'Action réessaiera le lendemain. Essai : rien ne change.
 */
export async function enregistrerExecution(code: string, execution: Execution) {
  await ligneSynchro(code);
  const fin = execution.fin ?? new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from("synchro_executions")
    .insert({
      synchro_code: code,
      debut: execution.debut ?? fin,
      fin,
      statut: execution.statut,
      declencheur: execution.declencheur ?? "planifie",
      resume: execution.resume ?? null,
      rapport: execution.rapport ?? {},
    })
    .select("id")
    .single();
  if (error) throw erreurSynchro(error);

  const reussie = execution.statut === "reussie" || execution.statut === "partielle";
  const maj: Record<string, unknown> = { dernier_statut: execution.statut, dernier_rapport: execution.rapport ?? {}, mis_a_jour_le: fin };
  if (reussie) Object.assign(maj, { derniere_execution: fin, forcer: false });
  const { error: erreurMaj } = await supabaseAdmin().from("synchronisations").update(maj).eq("code", code);
  if (erreurMaj) throw erreurSynchro(erreurMaj);

  // Historique borné : au-delà, les plus anciennes exécutions sont effacées (au mieux).
  const { data: anciennes } = await supabaseAdmin()
    .from("synchro_executions")
    .select("id")
    .eq("synchro_code", code)
    .order("debut", { ascending: false })
    .range(EXECUTIONS_GARDEES, EXECUTIONS_GARDEES + 100);
  if (anciennes?.length) {
    await supabaseAdmin()
      .from("synchro_executions")
      .delete()
      .in("id", anciennes.map((ligne) => ligne.id));
  }
  return { id: data.id as string };
}
