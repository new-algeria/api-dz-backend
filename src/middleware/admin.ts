import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { lireConfig } from "../config.js";
import { ErreurApi, erreurSupabase } from "../lib/erreurs.js";
import { supabaseAdmin, supabasePublic } from "../lib/supabase.js";
import type { EnvApp } from "../types.js";

const nonAutorise = () => new ErreurApi(401, "unauthorized", "Authentification requise.");

function egaliteSure(a: string, b: string): boolean {
  const tamponA = Buffer.from(a);
  const tamponB = Buffer.from(b);
  return tamponA.length === tamponB.length && timingSafeEqual(tamponA, tamponB);
}

/**
 * Routes d'administration : `Authorization: Bearer <jeton>` où le jeton est
 * - soit la session Supabase d'un membre dont `profils.role = 'admin'` (vérifiée auprès de Supabase Auth),
 * - soit `CLE_SYNCHRO`, réservée au script de synchronisation GeoAlgeria.
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

  const { data: profil, error: erreurProfil } = await supabaseAdmin()
    .from("profils")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (erreurProfil) throw erreurSupabase(erreurProfil);
  if (profil?.role !== "admin") throw new ErreurApi(403, "forbidden", "Réservé aux administrateurs.");

  c.set("acteur", { type: "admin", id: data.user.id });
  await next();
});
