/** Texte d'un champ multilingue (`{fr, en, ar}`) : français, sinon la première langue disponible. */
export function texteMultilingue(valeur: unknown): string {
  if (typeof valeur === "string") return valeur;
  if (typeof valeur !== "object" || valeur === null) return "";
  const textes = valeur as Partial<Record<"fr" | "en" | "ar", string>>;
  return textes.fr ?? textes.en ?? textes.ar ?? "";
}

/** Slug d'URL tiré d'un titre ou d'un nom (comme dans le dialogue d'administration du site). */
export function slugDepuisTitre(titre: string): string {
  return titre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}
