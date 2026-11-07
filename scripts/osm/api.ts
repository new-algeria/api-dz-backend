// Appels à l'API data-dz depuis la synchronisation : routes /v1/admin avec CLE_SYNCHRO,
// ou routes publiques seulement (`lecturePublique`, pour un essai sans clé).

export interface FichierDonnee {
  nom: string | null;
  format: string;
  principal: boolean;
  sha256?: string | null;
  sources?: { slug: string } | null;
}

export interface DonneeApi {
  slug: string;
  statut?: string;
  source_slug: string | null;
  numero: string | null;
  fichiers: FichierDonnee[];
}

export interface TagCompte {
  cle: string;
  valeur: string;
  nb: number;
}

/** Ligne de `osm_flux` telle que la renvoie l'API. */
export interface FluxBase {
  code: string;
  dataset_slug: string;
  fichier: string;
  filtres: string[];
  exige: Record<string, string[]> | null;
  rayon_m: number | null;
  actif: boolean;
  ordre: number;
}

export class ErreurAppel extends Error {
  constructor(
    readonly statut: number,
    message: string
  ) {
    super(message);
  }
}

const attendre = (ms: number) => new Promise((resoudre) => setTimeout(resoudre, ms));

/**
 * `fetch` qui respecte la limite de débit de l'API (60 appels admin par minute) : sur 429, attend `Retry-After`
 * (10 s par défaut) puis réessaie, 6 fois au plus.
 */
async function appelPatient(url: string, init: RequestInit): Promise<Response> {
  for (let essai = 0; ; essai++) {
    const reponse = await fetch(url, init);
    if (reponse.status !== 429 || essai >= 6) return reponse;
    const secondes = Number(reponse.headers.get("retry-after")) || 10;
    console.log(`Limite de débit de l'API : pause de ${secondes} s.`);
    await attendre(Math.min(secondes, 60) * 1000 + 250);
  }
}

export class ClientApi {
  constructor(
    private readonly base: string,
    private readonly cle: string | null
  ) {}

  get lecturePublique() {
    return !this.cle;
  }

  private async appel<T>(chemin: string, init: RequestInit = {}): Promise<T> {
    const reponse = await appelPatient(`${this.base}${chemin}`, {
      ...init,
      headers: { "content-type": "application/json", ...(this.cle ? { authorization: `Bearer ${this.cle}` } : {}), ...init.headers },
    });
    if (!reponse.ok) {
      const probleme = (await reponse.json().catch(() => null)) as { detail?: string; title?: string; code?: string } | null;
      throw new ErreurAppel(reponse.status, `${init.method ?? "GET"} ${chemin} : ${reponse.status} ${probleme?.detail ?? probleme?.title ?? ""}`.trim());
    }
    return (reponse.status === 204 ? null : await reponse.json()) as T;
  }

  /** Réglages et échéance de la synchronisation (`a_faire`). */
  lireSynchro(code: string) {
    return this.appel<{ actif: boolean; a_faire: boolean; intervalle_jours: number; forcer: boolean; derniere_execution: string | null; prochaine_execution: string | null }>(
      `/v1/admin/sync/${code}`
    );
  }

  async lireDonnee(slug: string): Promise<DonneeApi | null> {
    try {
      if (this.lecturePublique) {
        const fiche = await this.appel<{
          slug: string;
          source?: { slug: string } | null;
          version?: { numero?: string } | null;
          ressources: { nom: string; principal: boolean; fichiers: { format: string }[] }[];
        }>(`/v1/datasets/${slug}`);
        return {
          slug: fiche.slug,
          source_slug: fiche.source?.slug ?? null,
          numero: fiche.version?.numero ?? null,
          fichiers: fiche.ressources.flatMap((r) => r.fichiers.map((f) => ({ nom: r.nom, format: f.format, principal: r.principal }))),
        };
      }
      const donnee = await this.appel<{
        slug: string;
        statut: string;
        sources?: { slug: string } | null;
        versions?: { numero?: string; fichiers?: FichierDonnee[] } | null;
      }>(`/v1/admin/datasets/${slug}`);
      return {
        slug: donnee.slug,
        statut: donnee.statut,
        source_slug: donnee.sources?.slug ?? null,
        numero: donnee.versions?.numero ?? null,
        fichiers: donnee.versions?.fichiers ?? [],
      };
    } catch (erreur) {
      if (erreur instanceof ErreurAppel && erreur.statut === 404) return null;
      throw erreur;
    }
  }

  /** Contenu d'un fichier de la version courante (texte), ou `null` s'il n'existe pas. */
  async lireFichier(slug: string, nom: string, format = "geojson"): Promise<string | null> {
    // `inline=1` : une lecture de la synchro ne compte pas comme un téléchargement (nb_telechargements).
    const chemin = this.lecturePublique
      ? `/v1/datasets/${slug}/download?format=${format}&file=${encodeURIComponent(nom)}&inline=1`
      : `/v1/admin/datasets/${slug}/files/${encodeURIComponent(nom)}?format=${format}`;
    // Redirection suivie à la main : le lien signé de R2 ne doit pas recevoir l'en-tête Authorization.
    const reponse = await appelPatient(`${this.base}${chemin}`, { redirect: "manual", headers: this.cle ? { authorization: `Bearer ${this.cle}` } : {} });
    if (reponse.status === 404 || reponse.status === 422) return null;
    const lien = reponse.headers.get("location");
    if (reponse.status < 300 || reponse.status >= 400 || !lien) throw new ErreurAppel(reponse.status, `GET ${chemin} : ${reponse.status}`);
    const fichier = await fetch(lien);
    if (!fichier.ok) throw new ErreurAppel(fichier.status, `Lecture de ${slug}/${nom} : ${fichier.status}`);
    return fichier.text();
  }

  enregistrerDonnee(slug: string, champs: Record<string, unknown>) {
    return this.appel<{ creee: boolean }>(`/v1/admin/datasets/${slug}`, { method: "PUT", body: JSON.stringify(champs) });
  }

  /** URL d'envoi signée puis envoi direct à R2. Renvoie la clé à citer dans la version. */
  async envoyerFichier(slug: string, nom: string, texte: string): Promise<string> {
    const envoi = await this.appel<{ cle: string; url: string; content_type: string }>(`/v1/admin/datasets/${slug}/uploads`, {
      method: "POST",
      body: JSON.stringify({ nom, format: "geojson" }),
    });
    const reponse = await fetch(envoi.url, { method: "PUT", headers: { "content-type": envoi.content_type }, body: texte });
    if (!reponse.ok) throw new ErreurAppel(reponse.status, `Envoi de ${slug}/${nom} vers R2 : ${reponse.status}`);
    return envoi.cle;
  }

  publierVersion(slug: string, corps: Record<string, unknown>) {
    return this.appel<{ numero: string; nb_lignes: number }>(`/v1/admin/datasets/${slug}/versions`, { method: "POST", body: JSON.stringify(corps) });
  }

  /** Flux réglés dans l'administration (`osm_flux`). */
  async listerFlux() {
    return (await this.appel<{ data: FluxBase[] }>("/v1/admin/sync/openstreetmap/flux")).data;
  }

  /** Inventaire actuel (pour un essai : comparer sans écrire). */
  async lireInventaire() {
    return (await this.appel<{ data: { cle: string; valeur: string }[] }>("/v1/admin/sync/openstreetmap/tags")).data;
  }

  /** Dépose l'inventaire du passage ; renvoie les tags apparus. */
  async deposerInventaire(tags: TagCompte[], flux: { code: string; nb: number }[]) {
    return (await this.appel<{ nouveaux: TagCompte[] }>("/v1/admin/sync/openstreetmap/tags", { method: "POST", body: JSON.stringify({ tags, flux }) })).nouveaux;
  }

  rapporter(code: string, execution: Record<string, unknown>) {
    return this.appel<{ id: string }>(`/v1/admin/sync/${code}/runs`, { method: "POST", body: JSON.stringify(execution) });
  }
}
