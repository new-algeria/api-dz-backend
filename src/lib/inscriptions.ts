import type { User } from "@supabase/supabase-js";

/**
 * Email envoyé à l'équipe (EMAIL_ADMIN, admin@newalgeria.org par défaut) à chaque nouvelle inscription,
 * sur data-dz comme sur New Algeria (même projet Supabase).
 *
 * Le site appelle POST /v1/members/registered au premier passage d'un nouveau membre connecté ; l'API vérifie le JWT,
 * envoie l'email une seule fois (marqueur `app_metadata.inscription_signalee`, que seule la clé secrète peut écrire)
 * et ignore les comptes plus anciens que DELAI_INSCRIPTION_JOURS (pas d'email pour les membres d'avant cette fonction).
 */

export const SITES_INSCRIPTION = ["data-dz", "new-algeria"] as const;
export type SiteInscription = (typeof SITES_INSCRIPTION)[number];

const SITES: Record<SiteInscription, { nom: string; url: string }> = {
  "data-dz": { nom: "data-dz", url: "https://data-dz.com" },
  "new-algeria": { nom: "New Algeria", url: "https://newalgeria.org" },
};

export const DELAI_INSCRIPTION_JOURS = 7;

/** Vrai si ce compte est récent et n'a pas encore été signalé à l'équipe. */
export function doitSignalerInscription(utilisateur: Pick<User, "created_at" | "app_metadata">, maintenant = Date.now()): boolean {
  if (utilisateur.app_metadata?.inscription_signalee === true) return false;
  const creation = Date.parse(utilisateur.created_at);
  if (Number.isNaN(creation)) return false;
  return maintenant - creation <= DELAI_INSCRIPTION_JOURS * 24 * 60 * 60 * 1000;
}

const NOMS_FOURNISSEURS: Record<string, string> = {
  email: "email et mot de passe",
  google: "Google",
  github: "GitHub",
  facebook: "Facebook",
};

export interface InfosInscription {
  site: SiteInscription;
  email: string | null;
  pseudo: string | null;
  nomAffiche: string | null;
  fournisseur: string | null;
  creeLe: string;
}

const echapper = (texte: string) =>
  texte.replace(/[&<>"']/g, (caractere) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[caractere]!);

/** Date lisible à l'heure d'Alger. */
function dateAlger(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Africa/Algiers" }).format(date);
}

/** Sujet, HTML et texte de l'email « nouvel inscrit ». Toutes les valeurs venues du compte sont échappées. */
export function construireEmailInscription(infos: InfosInscription): { sujet: string; html: string; texte: string } {
  const site = SITES[infos.site];
  const qui = infos.nomAffiche || infos.pseudo || infos.email || "Un nouveau membre";
  const lienProfil = infos.pseudo ? `${site.url}/members/${encodeURIComponent(infos.pseudo)}` : null;
  const lignes: [string, string][] = [
    ["Site", `${site.nom} (${site.url.replace("https://", "")})`],
    ["Nom", infos.nomAffiche ?? "—"],
    ["Pseudo", infos.pseudo ? `@${infos.pseudo}` : "—"],
    ["Email", infos.email ?? "—"],
    ["Inscription via", infos.fournisseur ? (NOMS_FOURNISSEURS[infos.fournisseur] ?? infos.fournisseur) : "—"],
    ["Date", dateAlger(infos.creeLe)],
  ];

  const sujet = `🎉 Nouvel inscrit sur ${site.nom} : ${qui}`;
  const texte = [
    `Nouvelle inscription sur ${site.nom} !`,
    "",
    ...lignes.map(([cle, valeur]) => `${cle} : ${valeur}`),
    ...(lienProfil ? ["", `Profil public : ${lienProfil}`] : []),
  ].join("\n");

  const html = `<!doctype html>
<html lang="fr">
<body style="margin:0;padding:24px;background:#f4f6ef;font-family:Arial,Helvetica,sans-serif;color:#14171a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px">
    <tr><td style="padding:24px 28px;background:#0d8a59;border-radius:16px 16px 0 0;color:#ffffff;font-size:20px;font-weight:bold">
      🎉 Nouvelle inscription sur ${echapper(site.nom)}
    </td></tr>
    <tr><td style="padding:20px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px">
        ${lignes
          .map(
            ([cle, valeur]) =>
              `<tr><td style="padding:6px 12px 6px 0;color:#5b6470;white-space:nowrap;vertical-align:top">${echapper(cle)}</td><td style="padding:6px 0;font-weight:bold">${echapper(valeur)}</td></tr>`
          )
          .join("\n        ")}
      </table>
      ${
        lienProfil
          ? `<p style="margin:20px 0 0"><a href="${echapper(lienProfil)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#0d8a59;color:#ffffff;text-decoration:none;font-weight:bold">Voir son profil</a></p>`
          : ""
      }
    </td></tr>
  </table>
</body>
</html>`;

  return { sujet, html, texte };
}
