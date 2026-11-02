import { ErreurApi } from "./erreurs.js";
import { supabaseAdmin } from "./supabase.js";

/**
 * Permissions qu'un rôle personnalisé peut porter (table `roles`, migration 20261102000016 de data-dz).
 * Un administrateur les a toutes. La même liste est vérifiée par la base (contrainte de `roles.permissions`).
 */
export const PERMISSIONS = ["donnees.gerer", "membres.gerer", "synchro.gerer", "djazai.illimite"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permission exigée par une route d'administration : les synchronisations à part, tout le reste gère les données. */
export function permissionRequise(chemin: string): Permission {
  return /^\/v1\/admin\/sync(\/|$)/.test(chemin) ? "synchro.gerer" : "donnees.gerer";
}

export interface DroitsMembre {
  admin: boolean;
  permissions: Permission[];
}

export const aLaPermission = (droits: DroitsMembre, permission: Permission) => droits.admin || droits.permissions.includes(permission);

/**
 * Rôle et permissions d'un membre. Tant que la migration des rôles n'est pas appliquée
 * (relation `roles` absente), seuls les administrateurs ont des droits.
 */
export async function droitsMembre(id: string): Promise<DroitsMembre> {
  const { data, error } = await supabaseAdmin().from("profils").select("role, roles ( permissions )").eq("id", id).maybeSingle();
  if (error) {
    if (error.code !== "PGRST200" && error.code !== "42703") {
      console.error("supabase:", error.code, error.message);
      throw new ErreurApi(502, "database_error", "Erreur de la base de données.");
    }
    const { data: profil, error: erreurProfil } = await supabaseAdmin().from("profils").select("role").eq("id", id).maybeSingle();
    if (erreurProfil) {
      console.error("supabase:", erreurProfil.code, erreurProfil.message);
      throw new ErreurApi(502, "database_error", "Erreur de la base de données.");
    }
    return { admin: profil?.role === "admin", permissions: [] };
  }
  const role = data as { role?: string; roles?: { permissions?: string[] | null } | null } | null;
  const permissions = (role?.roles?.permissions ?? []).filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p));
  return { admin: role?.role === "admin", permissions };
}
