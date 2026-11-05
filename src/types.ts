import type { RequestIdVariables } from "hono/request-id";
import type { Permission } from "./lib/permissions.js";

/**
 * Auteur d'une requête d'administration : un membre connecté (JWT Supabase) admin ou dont le rôle porte
 * la permission de la route, ou un script de synchronisation (`CLE_SYNCHRO`).
 */
export type Acteur = { type: "admin"; id: string; admin: boolean; permissions: Permission[] } | { type: "synchro" };

export interface EnvApp {
  Variables: RequestIdVariables & {
    acteur: Acteur;
  };
}
