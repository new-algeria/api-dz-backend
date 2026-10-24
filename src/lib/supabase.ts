import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { lireConfig } from "../config.js";
import { ErreurApi } from "./erreurs.js";

const optionsServeur = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let clientPublic: SupabaseClient | undefined;
let clientAdmin: SupabaseClient | undefined;

/**
 * Lectures publiques : clé publishable, donc la RLS s'applique exactement comme pour un visiteur
 * (seules les données publiées sont visibles). À utiliser par défaut.
 */
export function supabasePublic(): SupabaseClient {
  const config = lireConfig();
  clientPublic ??= createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, optionsServeur);
  return clientPublic;
}

/**
 * Clé secrète (contourne la RLS) : uniquement dans les routes d'administration,
 * après vérification du rôle par `exigerAdmin`.
 */
export function supabaseAdmin(): SupabaseClient {
  const config = lireConfig();
  if (!config.SUPABASE_SECRET_KEY) {
    throw new ErreurApi(503, "admin_disabled", "L'administration n'est pas configurée sur ce serveur.");
  }
  clientAdmin ??= createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, optionsServeur);
  return clientAdmin;
}
