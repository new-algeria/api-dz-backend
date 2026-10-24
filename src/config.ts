import { z } from "zod";

/**
 * Variables d'environnement, validées au premier accès.
 * Les variables facultatives désactivent proprement la fonction concernée (voir `.env.example`).
 */
const schemaEnv = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1).default("data-dz"),
  R2_PUBLIC_URL: z.url().default("https://files.data-dz.com"),

  URL_API: z.url().default("https://api.data-dz.com"),
  ORIGINES_ADMIN: z
    .string()
    .default("https://data-dz.com,https://www.data-dz.com,http://localhost:5173")
    .transform((valeur) => valeur.split(",").map((origine) => origine.trim()).filter(Boolean)),
  CLE_SYNCHRO: z.string().min(32).optional(),

  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
});

export type Config = z.infer<typeof schemaEnv>;

let config: Config | undefined;

export function lireConfig(): Config {
  if (config) return config;
  // Les intégrations Upstash du marketplace Vercel exposent KV_REST_API_URL / KV_REST_API_TOKEN.
  const env: Record<string, string | undefined> = {
    ...process.env,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
  // Une variable vide vaut « absente » (évite qu'un `FOO=` du .env casse la validation).
  for (const [nom, valeur] of Object.entries(env)) if (valeur === "") delete env[nom];

  const resultat = schemaEnv.safeParse(env);
  if (!resultat.success) {
    const champs = resultat.error.issues.map((probleme) => probleme.path.join(".")).join(", ");
    throw new Error(`Configuration invalide ou incomplète : ${champs}`);
  }
  config = resultat.data;
  return config;
}

/** Pour les tests uniquement. */
export function reinitialiserConfig(): void {
  config = undefined;
}
