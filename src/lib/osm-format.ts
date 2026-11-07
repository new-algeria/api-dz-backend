// Format des expressions de flux OpenStreetMap, partagé par l'API et le robot (scripts/osm), sans dépendance.

export const FORMAT_CLE = /^[a-z][a-z0-9_:]{0,59}$/;
export const FORMAT_VALEUR = /^[A-Za-z0-9_:.+-]+(?: [A-Za-z0-9_:.+-]+)*$/;
/** Expression acceptée par le robot : clé et valeurs obligatoires (une clé seule, comme `building`, prendrait des millions d'objets). */
export const FORMAT_FILTRE = /^nwr\/[a-z][a-z0-9_:]{0,59}=[A-Za-z0-9_:.+-]+(?: [A-Za-z0-9_:.+-]+)*(?:,[A-Za-z0-9_:.+-]+(?: [A-Za-z0-9_:.+-]+)*)*$/;

export const filtreDepuis = (cle: string, valeurs: string[]) => `nwr/${cle}=${valeurs.join(",")}`;

/** Clé et valeurs d'une expression « nwr/cle=v1,v2 ». */
export function lireFiltre(filtre: string): { cle: string; valeurs: string[] } | null {
  if (!FORMAT_FILTRE.test(filtre)) return null;
  const [cle, valeurs] = filtre.slice(4).split("=");
  return { cle, valeurs: valeurs.split(",") };
}
