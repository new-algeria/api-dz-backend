import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { lireConfig } from "../config.js";
import { ErreurApi } from "../lib/erreurs.js";
import { construireEmailInscription, doitSignalerInscription, SITES_INSCRIPTION } from "../lib/inscriptions.js";
import { supabaseAdmin, supabasePublic } from "../lib/supabase.js";
import { limiteDebit } from "../middleware/limite-debit.js";
import { reponsesErreur } from "../schemas.js";
import type { EnvApp } from "../types.js";
import { crochetValidation } from "../validation.js";

export const routesMembres = new OpenAPIHono<EnvApp>({ defaultHook: crochetValidation });

routesMembres.use("/v1/members/registered", limiteDebit("compte"));

const DemandeSignalement = z
  .object({ site: z.enum(SITES_INSCRIPTION).openapi({ example: "new-algeria" }) })
  .openapi("SignalementInscription");

const ResultatSignalement = z
  .object({
    sent: z.boolean(),
    reason: z.enum(["already_reported", "not_recent", "unconfigured"]).optional(),
  })
  .openapi("ResultatSignalementInscription");

/** Envoie l'email par l'API Resend ; la clé d'idempotence empêche un doublon si deux onglets appellent en même temps. */
async function envoyerParResend(cle: string, expediteur: string, destinataire: string, email: ReturnType<typeof construireEmailInscription>, idempotence: string) {
  const reponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json", "Idempotency-Key": idempotence },
    body: JSON.stringify({ from: expediteur, to: [destinataire], subject: email.sujet, html: email.html, text: email.texte }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!reponse.ok) {
    console.error("inscriptions: Resend a refusé l'envoi", reponse.status, await reponse.text().catch(() => ""));
    throw new ErreurApi(502, "email_failed", "L'email n'a pas pu être envoyé.");
  }
}

routesMembres.openapi(
  createRoute({
    method: "post",
    path: "/v1/members/registered",
    tags: ["Membres"],
    summary: "Signaler une nouvelle inscription à l'équipe",
    description:
      "Appelée par data-dz et New Algeria au premier passage d'un nouveau membre connecté (JWT Supabase). " +
      "Envoie une seule fois un email à l'équipe (site, nom, pseudo, email, mode de connexion). Sans effet pour un compte déjà signalé ou ancien.",
    request: { body: { required: true, content: { "application/json": { schema: DemandeSignalement } } } },
    responses: {
      200: { description: "Résultat", content: { "application/json": { schema: ResultatSignalement } } },
      ...reponsesErreur(400, 401, 429),
    },
  }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    const jeton = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!jeton) throw new ErreurApi(401, "authentication_required", "Connexion requise.");
    const { site } = c.req.valid("json");

    // getUser relit le compte dans Supabase Auth (pas seulement le contenu du jeton) : app_metadata est à jour.
    const { data, error } = await supabasePublic().auth.getUser(jeton);
    if (error || !data.user) throw new ErreurApi(401, "authentication_required", "Session expirée.");
    const utilisateur = data.user;

    if (utilisateur.app_metadata?.inscription_signalee === true) return c.json({ sent: false, reason: "already_reported" as const }, 200);
    if (!doitSignalerInscription(utilisateur)) return c.json({ sent: false, reason: "not_recent" as const }, 200);

    const config = lireConfig();
    if (!config.RESEND_API_KEY || !config.SUPABASE_SECRET_KEY) return c.json({ sent: false, reason: "unconfigured" as const }, 200);

    const admin = supabaseAdmin();
    const { data: profil } = await admin.from("profils").select("pseudo, nom_affiche").eq("id", utilisateur.id).maybeSingle();

    const email = construireEmailInscription({
      site,
      email: utilisateur.email ?? null,
      pseudo: profil?.pseudo ?? null,
      nomAffiche: profil?.nom_affiche ?? null,
      fournisseur: typeof utilisateur.app_metadata?.provider === "string" ? utilisateur.app_metadata.provider : null,
      creeLe: utilisateur.created_at,
    });
    await envoyerParResend(config.RESEND_API_KEY, config.EMAIL_EXPEDITEUR, config.EMAIL_ADMIN, email, `inscription-${utilisateur.id}`);

    // Marqueur écrit avec la clé secrète : le membre ne peut ni l'effacer ni le falsifier.
    const { error: erreurMarqueur } = await admin.auth.admin.updateUserById(utilisateur.id, {
      app_metadata: { ...utilisateur.app_metadata, inscription_signalee: true, inscription_site: site },
    });
    if (erreurMarqueur) console.error("inscriptions: marqueur non enregistré", utilisateur.id, erreurMarqueur.message);

    return c.json({ sent: true }, 200);
  }
);
