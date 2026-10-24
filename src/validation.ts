import type { Hook } from "@hono/zod-openapi";
import { ErreurApi } from "./lib/erreurs.js";

/** Paramètres invalides : 400 au format problem+json, avec le chemin et le message de chaque erreur. */
export const crochetValidation: Hook<unknown, any, any, unknown> = (resultat) => {
  if (!resultat.success) {
    throw new ErreurApi(
      400,
      "invalid_parameters",
      "Paramètres invalides.",
      resultat.error.issues.map((probleme) => ({ champ: probleme.path.join("."), message: probleme.message }))
    );
  }
};
