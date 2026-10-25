/**
 * Recherche du catalogue : la colonne `recherche` (tsvector, config `simple`) ne fait ni racinisation ni préfixe,
 * donc « pharmacie » ne trouvait pas « pharmacies » et un mot partiel ne trouvait rien.
 * Chaque mot doit maintenant figurer (préfixe plein texte, ou sous-chaîne du titre ou de la description en fr / en / ar).
 */

const LANGUES = ["fr", "en", "ar"] as const;
const MOTS_MAX = 6;

/** Mots de la recherche : lettres (y compris les signes diacritiques arabes) et chiffres seulement, sans doublon. */
export function motsRecherche(terme: string): string[] {
  const mots = terme.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return [...new Set(mots.map(racine))].slice(0, MOTS_MAX);
}

/** Retire un « s » ou un « x » final (pluriel) sur les mots latins assez longs : « pharmacies » → « pharmacie ». */
function racine(mot: string): string {
  return mot.length > 4 && /^[a-z0-9àâäçéèêëîïôöùûüÿœ]+$/.test(mot) && /[sx]$/.test(mot) ? mot.slice(0, -1) : mot;
}

/**
 * Un filtre PostgREST `or=(…)` par mot (les filtres successifs se combinent en ET).
 * Les mots ne contiennent que des lettres et des chiffres : rien ne peut casser la syntaxe du filtre.
 */
export function filtresRecherche(terme: string): string[] {
  return motsRecherche(terme).map((mot) =>
    [
      `recherche.fts(simple).${mot}:*`,
      ...LANGUES.flatMap((langue) => [`titre->>${langue}.ilike.*${mot}*`, `description->>${langue}.ilike.*${mot}*`]),
    ].join(",")
  );
}
