import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { lireConfig } from "../config.js";
import { ErreurApi } from "../lib/erreurs.js";
import { aLaPermission, droitsMembre, permissionRequise } from "../lib/permissions.js";
import { supabasePublic } from "../lib/supabase.js";
import type { EnvApp } from "../types.js";

const nonAutorise = () => new ErreurApi(401, "unauthorized", "Authentification requise.");

function egaliteSure(a: string, b: string): boolean {
  const tamponA = Buffer.from(a);
  const tamponB = Buffer.from(b);
  return tamponA.length === tamponB.length && timingSafeEqual(tamponA, tamponB);
}

/**
 * Routes d'administration : `Authorization: Bearer <jeton>` où le jeton est
 * - soit la session Supabase d'un membre (vérifiée auprès de Supabase Auth) qui est admin, ou dont le rôle porte
 *   la permission de la route (`permissionRequise` : `synchro.gerer` pour `/v1/admin/sync`, sinon `donnees.gerer`),
 * - soit `CLE_SYNCHRO`, réservée aux scripts de synchronisation (GeoAlgeria, OpenStreetMap).
 */
export const exigerAdmin = createMiddleware<EnvApp>(async (c, next) => {
  const jeton = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!jeton) throw nonAutorise();

  const { CLE_SYNCHRO } = lireConfig();
  if (CLE_SYNCHRO && egaliteSure(jeton, CLE_SYNCHRO)) {
    c.set("acteur", { type: "synchro" });
    return next();
  }

  const { data, error } = await supabasePublic().auth.getUser(jeton);
  if (error || !data.user) throw nonAutorise();

  const droits = await droitsMembre(data.user.id);
  if (!aLaPermission(droits, permissionRequise(c.req.path))) {
    throw new ErreurApi(403, "forbidden", "Réservé aux administrateurs.");
  }

  c.set("acteur", { type: "admin", id: data.user.id, ...droits });
  await next();
});
