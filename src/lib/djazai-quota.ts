import { ErreurApi } from "./erreurs.js";
import { supabaseAdmin, supabasePublic } from "./supabase.js";

export interface QuotaDjazAI {
  is_admin: boolean;
  daily_limit: number | null;
  remaining: number | null;
  resets_at: string | null;
}

type LigneQuota = {
  autorise: boolean;
  limite: number;
  restantes: number;
  reinitialisation: string;
};

/** Vérifie le JWT auprès de Supabase Auth et lit le rôle depuis la base, jamais depuis le client. */
export async function authentifierDjazAI(authorization: string | undefined) {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    throw new ErreurApi(401, "authentication_required", "Connectez-vous pour utiliser DjazAI.");
  }

  const { data, error } = await supabasePublic().auth.getUser(token);
  if (error || !data.user) {
    throw new ErreurApi(401, "authentication_required", "Votre session a expiré. Connectez-vous de nouveau.");
  }

  const { data: profil, error: erreurProfil } = await supabaseAdmin()
    .from("profils")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (erreurProfil) {
    console.error("DjazAI : lecture du rôle impossible", erreurProfil.code, erreurProfil.message);
    throw new ErreurApi(503, "assistant_quota_unavailable", "Le contrôle d’accès à DjazAI est temporairement indisponible.");
  }

  return { user_id: data.user.id, is_admin: profil?.role === "admin" };
}

/** Compte la question de façon atomique dans Supabase ; en cas de défaut du compteur, aucune requête IA ne part. */
export async function obtenirQuotaDjazAI(userId: string, isAdmin: boolean, consommer: boolean): Promise<QuotaDjazAI> {
  if (isAdmin) {
    return { is_admin: true, daily_limit: null, remaining: null, resets_at: null };
  }

  let donnees: unknown = null;
  let erreurBase: { code: string; message: string } | null = null;
  try {
    const resultat = await supabaseAdmin().rpc("compter_quota_djazai", {
      p_utilisateur_id: userId,
      p_consommer: consommer,
    });
    donnees = resultat.data;
    erreurBase = resultat.error;
  } catch (erreur) {
    console.error("DjazAI : compteur journalier indisponible", erreur);
    throw new ErreurApi(503, "assistant_quota_unavailable", "Le quota DjazAI n’est pas configuré. Réessayez après la mise à jour de la base.");
  }
  if (erreurBase) {
    console.error("DjazAI : compteur journalier indisponible", erreurBase.code, erreurBase.message);
    throw new ErreurApi(503, "assistant_quota_unavailable", "Le quota DjazAI n’est pas configuré. Réessayez après la mise à jour de la base.");
  }

  const ligne = (Array.isArray(donnees) ? donnees[0] : donnees) as LigneQuota | null;
  if (!ligne || typeof ligne.autorise !== "boolean") {
    throw new ErreurApi(503, "assistant_quota_unavailable", "Le quota DjazAI est temporairement indisponible.");
  }

  const quota: QuotaDjazAI = {
    is_admin: false,
    daily_limit: ligne.limite,
    remaining: ligne.restantes,
    resets_at: ligne.reinitialisation,
  };
  if (consommer && !ligne.autorise) {
    throw new ErreurApi(429, "assistant_daily_limit", "Vous avez utilisé vos 5 questions DjazAI pour aujourd’hui.", {
      daily_limit: quota.daily_limit,
      remaining: quota.remaining,
      resets_at: quota.resets_at,
    });
  }
  return quota;
}
