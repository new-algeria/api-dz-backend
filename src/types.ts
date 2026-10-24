import type { RequestIdVariables } from "hono/request-id";

/** Auteur d'une requête d'administration : un admin connecté (JWT Supabase) ou le script de synchronisation. */
export type Acteur = { type: "admin"; id: string } | { type: "synchro" };

export interface EnvApp {
  Variables: RequestIdVariables & {
    acteur: Acteur;
  };
}
