import { AwsClient } from "aws4fetch";
import { lireConfig } from "../config.js";
import { ErreurApi } from "./erreurs.js";

/**
 * Accès au bucket R2 par l'API S3 (jamais par le domaine public).
 * Les liens donnés aux clients sont des URL pré-signées à durée courte : la clé de stockage
 * n'apparaît que dans ces URL, et elles expirent.
 */
let client: AwsClient | undefined;

function clientR2(): AwsClient {
  if (client) return client;
  const config = lireConfig();
  client = new AwsClient({
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  return client;
}

function urlObjet(cle: string): URL {
  const config = lireConfig();
  const chemin = cle.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${config.R2_BUCKET}/${chemin}`);
}

/** Refuse toute clé qui tenterait de sortir du bucket ou de viser un dossier inattendu. */
export function verifierCle(cle: string): string {
  if (!/^[a-z0-9][a-z0-9._/-]{0,250}$/i.test(cle) || cle.includes("..") || cle.includes("//")) {
    throw new ErreurApi(400, "invalid_key", "Clé de stockage invalide.");
  }
  return cle;
}

export interface OptionsLien {
  /** Durée de validité en secondes (10 minutes par défaut, 7 jours maximum côté S3). */
  expiration?: number;
  /** Nom proposé au navigateur ; `inline` affiche le fichier au lieu de le télécharger. */
  nomFichier?: string;
  inline?: boolean;
  typeContenu?: string;
}

/** URL GET pré-signée (lecture directe sur R2, sans passer par la fonction : pas de limite de 4,5 Mo). */
export async function lienSigne(cle: string, options: OptionsLien = {}): Promise<string> {
  const url = urlObjet(verifierCle(cle));
  url.searchParams.set("X-Amz-Expires", String(options.expiration ?? 600));
  if (options.nomFichier) {
    const nom = options.nomFichier.replace(/[^\w.-]/g, "_");
    url.searchParams.set("response-content-disposition", `${options.inline ? "inline" : "attachment"}; filename="${nom}"`);
  }
  if (options.typeContenu) url.searchParams.set("response-content-type", options.typeContenu);
  const requete = await clientR2().sign(url.toString(), { method: "GET", aws: { signQuery: true } });
  return requete.url;
}

/** URL PUT pré-signée : le navigateur envoie le fichier directement à R2 (même type de contenu obligatoire). */
export async function lienEnvoiSigne(cle: string, typeContenu: string, expiration = 900): Promise<string> {
  const url = urlObjet(verifierCle(cle));
  url.searchParams.set("X-Amz-Expires", String(expiration));
  const requete = await clientR2().sign(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": typeContenu },
    aws: { signQuery: true, allHeaders: true },
  });
  return requete.url;
}

export async function lireObjet(cle: string): Promise<Response | null> {
  const reponse = await clientR2().fetch(urlObjet(verifierCle(cle)).toString());
  if (reponse.status === 404) return null;
  if (!reponse.ok) throw new Error(`R2 GET ${reponse.status} pour ${cle}`);
  return reponse;
}

export async function infosObjet(cle: string): Promise<{ taille: number; typeContenu: string | null } | null> {
  const reponse = await clientR2().fetch(urlObjet(verifierCle(cle)).toString(), { method: "HEAD" });
  if (reponse.status === 404) return null;
  if (!reponse.ok) throw new Error(`R2 HEAD ${reponse.status} pour ${cle}`);
  return { taille: Number(reponse.headers.get("content-length") ?? 0), typeContenu: reponse.headers.get("content-type") };
}

export async function ecrireObjet(
  cle: string,
  corps: ArrayBuffer | Uint8Array | string,
  typeContenu: string,
  cacheControl = "public, max-age=3600"
): Promise<void> {
  const reponse = await clientR2().fetch(urlObjet(verifierCle(cle)).toString(), {
    method: "PUT",
    body: corps as BodyInit,
    headers: { "Content-Type": typeContenu, "Cache-Control": cacheControl },
  });
  if (!reponse.ok) throw new Error(`R2 PUT ${reponse.status} pour ${cle}`);
}

export async function supprimerObjet(cle: string): Promise<void> {
  const reponse = await clientR2().fetch(urlObjet(verifierCle(cle)).toString(), { method: "DELETE" });
  if (!reponse.ok && reponse.status !== 404) throw new Error(`R2 DELETE ${reponse.status} pour ${cle}`);
}

/** URL publique (domaine files.data-dz.com) : réservée aux images de `web-assets/`. */
export function urlPublique(cle: string): string {
  return `${lireConfig().R2_PUBLIC_URL.replace(/\/+$/, "")}/${verifierCle(cle)}`;
}
