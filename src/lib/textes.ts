/** Texte d'un champ multilingue (`{fr, en, ar}`) : français, sinon la première langue disponible. */
export function texteMultilingue(valeur: unknown): string {
  if (typeof valeur === "string") return valeur;
  if (typeof valeur !== "object" || valeur === null) return "";
  const textes = valeur as Partial<Record<"fr" | "en" | "ar", string>>;
  return textes.fr ?? textes.en ?? textes.ar ?? "";
}
