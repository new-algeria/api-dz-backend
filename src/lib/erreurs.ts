import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Erreur métier renvoyée au client au format RFC 9457 (application/problem+json).
 * Le message doit être sûr à afficher : jamais de détail interne (clé de stockage, requête SQL…).
 */
export class ErreurApi extends Error {
  constructor(
    readonly statut: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export const introuvable = (quoi = "Ressource") => new ErreurApi(404, "not_found", `${quoi} introuvable.`);

export function reponseProbleme(c: Context, erreur: ErreurApi) {
  return c.json(
    {
      type: `https://api.data-dz.com/docs#errors-${erreur.code}`,
      title: erreur.message,
      status: erreur.statut,
      code: erreur.code,
      ...(erreur.details !== undefined ? { details: erreur.details } : {}),
      requestId: c.get("requestId"),
    },
    erreur.statut,
    { "Content-Type": "application/problem+json; charset=utf-8", "Cache-Control": "no-store" }
  );
}
