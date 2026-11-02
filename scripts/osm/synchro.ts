// Synchronisation OpenStreetMap → data-dz. Lancée chaque jour par .github/workflows/osm-sync.yml ;
// ne travaille qu'à l'échéance réglée dans l'administration (/admin/sync, sinon OSM_SYNC_INTERVAL_DAYS).
//
//   npx tsx scripts/osm/synchro.ts [--essai] [--forcer] [--seulement=sante,gas-stations] [--extrait=algeria.osm.pbf] [--dossier=.osm]
//
// Variables : API_URL (défaut https://api.data-dz.com), CLE_SYNCHRO (sans clé : lecture publique et essai seulement),
// OSM_SYNC_INTERVAL_DAYS (repli tant que l'administration n'a pas ses réglages ; ensuite c'est /admin/sync qui décide).
// --essai : tout est calculé et rapporté, rien n'est publié. --forcer : ignore l'échéance.

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { ClientApi, ErreurAppel, type DonneeApi } from "./api.js";
import { FLUX, NOUVELLES_DONNEES, type Flux } from "./categories.js";
import { dateExtrait, extraireFlux, telechargerExtrait } from "./extraire.js";
import { baisseAnormale, fusionner, numeroComplement, rapprocher, serialiser, type Objet, type RapportFusion } from "./fusion.js";

const CODE = "openstreetmap";
const SOURCE = "openstreetmap";
const LICENCE = "ODbL-1.0";
const RAYON_PAR_DEFAUT_M = 150;

// Options en ligne de commande, ou variables SYNCHRO_<NOM> (la GitHub Action passe ainsi ses champs, sans les
// injecter dans la commande).
const variable = (nom: string) => process.env[`SYNCHRO_${nom.toUpperCase()}`]?.trim() || undefined;
const option = (nom: string) =>
  process.argv.some((arg) => arg === `--${nom}` || arg.startsWith(`--${nom}=`)) || variable(nom) === "true";
const valeur = (nom: string) =>
  process.argv.find((arg) => arg.startsWith(`--${nom}=`))?.split("=").slice(1).join("=") || variable(nom);

const sha256 = (texte: string) => createHash("sha256").update(texte).digest("hex");

interface RapportFichier extends Partial<RapportFusion> {
  extraits: number;
  geoalgeria?: number;
  change: boolean;
}

interface RapportDonnee {
  creee?: boolean;
  complement: boolean;
  fichiers: Record<string, RapportFichier>;
  publiee: boolean;
  version?: string;
  anomalie?: string;
  erreur?: string;
}

function lireObjets(texte: string | null): Objet[] {
  if (!texte) return [];
  const json = JSON.parse(texte) as { features?: Objet[] };
  return (json.features ?? []).filter((objet) => objet?.geometry?.type === "Point");
}

/** Métadonnées d'une nouvelle donnée OpenStreetMap (créée publiée par `PUT`, comme le fait la synchro GeoAlgeria). */
function champsNouvelleDonnee(slug: string) {
  const nouvelle = NOUVELLES_DONNEES.find((donnee) => donnee.slug === slug);
  if (!nouvelle) return null;
  const filtres = FLUX.filter((flux) => flux.slug === slug).flatMap((flux) => flux.filtres.map((filtre) => `\`${filtre.replace(/^nwr\//, "")}\``));
  return {
    titre: nouvelle.titre,
    description: nouvelle.description,
    categorie_slug: nouvelle.categorie_slug,
    source_slug: SOURCE,
    licence_code: LICENCE,
    licence_details: "© contributeurs OpenStreetMap",
    url_source: "https://www.openstreetmap.org/copyright",
    mots_cles: [...nouvelle.mots_cles, "openstreetmap", "osm"],
    frequence_maj: "mensuelle",
    readme:
      `## Origine\n\nObjets OpenStreetMap de l'Algérie portant ${filtres.join(", ")}, extraits de l'extrait Geofabrik ` +
      `(https://download.geofabrik.de/africa/algeria.html) par la synchronisation mensuelle de data-dz.\n\n` +
      `## Mises à jour\n\nChaque passage ajoute les nouveaux objets et met à jour les autres ; un objet disparu d'OpenStreetMap ` +
      `n'est jamais retiré : il porte \`osm_absent_depuis\`. \`osm_ajoute_le\` donne la date à laquelle data-dz l'a vu pour la première fois.\n\n` +
      `## Licence\n\n© contributeurs OpenStreetMap, ODbL 1.0 (https://www.openstreetmap.org/copyright). Toute réutilisation doit citer OpenStreetMap ` +
      `et partager les améliorations sous la même licence.`,
  };
}

async function main() {
  const essaiDemande = Boolean(option("essai"));
  const forcer = Boolean(option("forcer"));
  const seulement = valeur("seulement")?.split(",").map((slug) => slug.trim()).filter(Boolean);
  const dossier = valeur("dossier") ?? ".osm";
  const urlApi = (process.env.API_URL?.trim() || "https://api.data-dz.com").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+/.test(urlApi)) throw new Error(`API_URL invalide (« ${urlApi} ») : attendu https://api.data-dz.com`);
  const api = new ClientApi(urlApi, process.env.CLE_SYNCHRO?.trim() || null);
  const essai = essaiDemande || api.lecturePublique;
  const declencheur = forcer ? "forcer" : process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manuel" : "planifie";
  const debut = new Date();
  const date = debut.toISOString().slice(0, 10);

  // 1. Échéance réglée dans l'administration (/admin/sync). Tant que l'API ou la base ne l'ont pas (route absente,
  //    migration non appliquée) : OSM_SYNC_INTERVAL_DAYS, un passage tous les N jours depuis le 1er janvier 1970.
  if (!api.lecturePublique && !forcer && !essaiDemande) {
    try {
      const synchro = await api.lireSynchro(CODE);
      if (!synchro.a_faire) {
        console.log(`Rien à faire : ${synchro.actif ? `prochain passage le ${synchro.prochaine_execution}` : "synchronisation désactivée"}.`);
        return;
      }
    } catch (erreur) {
      if (!(erreur instanceof ErreurAppel) || (erreur.statut !== 503 && erreur.statut !== 404)) throw erreur;
      const intervalle = Math.min(365, Math.max(1, Number(process.env.OSM_SYNC_INTERVAL_DAYS) || 30));
      if (Math.floor(Date.now() / 86_400_000) % intervalle !== 0) {
        console.log(`Réglages de l'administration indisponibles (${erreur.statut}) : passage tous les ${intervalle} jours (OSM_SYNC_INTERVAL_DAYS), pas aujourd'hui.`);
        return;
      }
    }
  }

  const flux = FLUX.filter((f) => !seulement || seulement.includes(f.slug));
  await mkdir(dossier, { recursive: true });
  const extraitDu = await dateExtrait();
  console.log(`Extrait Geofabrik du ${extraitDu} — ${flux.length} flux${essai ? " (essai : rien ne sera publié)" : ""}.`);
  const extrait = await telechargerExtrait(dossier, valeur("extrait"));
  const parFlux = await extraireFlux(extrait, dossier, flux);

  const parDonnee = new Map<string, Flux[]>();
  for (const f of flux) parDonnee.set(f.slug, [...(parDonnee.get(f.slug) ?? []), f]);

  const donnees: Record<string, RapportDonnee> = {};
  for (const [slug, fluxDonnee] of parDonnee) {
    const rapport: RapportDonnee = { complement: false, fichiers: {}, publiee: false };
    donnees[slug] = rapport;
    try {
      const donnee: DonneeApi | null = await api.lireDonnee(slug);
      const nouvelle = donnee ? null : champsNouvelleDonnee(slug);
      if (!donnee && !nouvelle) throw new Error("donnée introuvable (ni existante, ni dans NOUVELLES_DONNEES)");
      rapport.creee = !donnee;
      rapport.complement = Boolean(donnee && donnee.source_slug !== SOURCE);

      // Donnée OpenStreetMap : ses fichiers doivent tous venir des flux, sinon on en perdrait à la publication.
      if (donnee && !rapport.complement) {
        const connus = new Set(fluxDonnee.map((f) => f.fichier));
        const inconnus = [...new Set(donnee.fichiers.map((f) => f.nom).filter((nom): nom is string => Boolean(nom) && !connus.has(nom!)))];
        if (inconnus.length > 0) throw new Error(`fichiers hors synchronisation dans la donnée (${inconnus.join(", ")}) : publication manuelle`);
      }

      // Fichier principal GeoAlgeria (rapprochement), lu une fois par donnée.
      let geoalgeria: Objet[] | null = null;
      if (rapport.complement && donnee) {
        const principal = donnee.fichiers.find((f) => f.principal && f.format === "geojson" && !f.sources);
        geoalgeria = principal?.nom ? lireObjets(await api.lireFichier(slug, principal.nom, "geojson")) : [];
      }

      const textes: { flux: Flux; texte: string }[] = [];
      for (const f of fluxDonnee) {
        const extraits = parFlux.get(f.code) ?? [];
        const ancienTexte = donnee ? await api.lireFichier(slug, f.fichier, "geojson") : null;
        const precedents = lireObjets(ancienTexte);
        if (baisseAnormale(precedents, extraits)) {
          rapport.anomalie = `${f.fichier} : ${extraits.length} objets extraits pour ${precedents.length} publiés (baisse de plus de 10 %)`;
          break;
        }
        const { objets, rapport: fusion } = fusionner(precedents, extraits, date);
        const rapproches = geoalgeria ? rapprocher(objets, geoalgeria, f.rayon_m ?? RAYON_PAR_DEFAUT_M) : undefined;
        const texte = serialiser(objets);
        const ancienSha = donnee?.fichiers.find((fichier) => fichier.nom === f.fichier && fichier.format === "geojson")?.sha256 ?? (ancienTexte ? sha256(ancienTexte) : null);
        const change = sha256(texte) !== ancienSha;
        rapport.fichiers[f.fichier] = { extraits: extraits.length, ...fusion, ...(rapproches !== undefined ? { geoalgeria: rapproches } : {}), change };
        textes.push({ flux: f, texte });
      }
      if (rapport.anomalie || !textes.some(({ flux: f }) => rapport.fichiers[f.fichier].change)) continue;
      if (essai) continue;

      if (nouvelle) await api.enregistrerDonnee(slug, nouvelle);
      const fichiers = [];
      for (const [indice, { flux: f, texte }] of textes.entries()) {
        fichiers.push({ cle: await api.envoyerFichier(slug, f.fichier, texte), nom: f.fichier, format: "geojson", principal: indice === 0 });
      }
      const notes = textes
        .map(({ flux: f }) => {
          const r = rapport.fichiers[f.fichier];
          return `${f.fichier} : ${r.total} objets (+${r.ajoutes} ajoutés, ${r.mis_a_jour} mis à jour, ${r.absents} absents d'OSM)`;
        })
        .join(" ; ");
      const version = await api.publierVersion(slug, {
        ...(rapport.complement ? { numero: numeroComplement(donnee?.numero ?? null, date) } : {}),
        source_slug: SOURCE,
        licence_code: LICENCE,
        notes: `OpenStreetMap, extrait Geofabrik du ${extraitDu?.slice(0, 10) ?? date}. ${notes}`.slice(0, 2000),
        fichiers,
      });
      rapport.publiee = true;
      rapport.version = version.numero;
    } catch (erreur) {
      rapport.erreur = erreur instanceof Error ? erreur.message : String(erreur);
      console.error(`${slug} : ${rapport.erreur}`);
    }
  }

  // Rapport : console, résumé de l'Action, administration.
  const liste = Object.values(donnees);
  const publiees = liste.filter((r) => r.publiee).length;
  const aPublier = liste.filter((r) => !r.publiee && !r.erreur && !r.anomalie && Object.values(r.fichiers).some((f) => f.change)).length;
  const problemes = liste.filter((r) => r.erreur || r.anomalie).length;
  const statut = essai ? "essai" : problemes === 0 ? "reussie" : publiees > 0 || problemes < liste.length ? "partielle" : "echec";
  const resume = essai
    ? `Essai : ${aPublier} donnée(s) à publier, ${liste.length - aPublier - problemes} inchangée(s), ${problemes} problème(s).`
    : `${publiees} donnée(s) publiée(s), ${liste.length - publiees - problemes} inchangée(s), ${problemes} problème(s).`;
  console.log(resume);
  for (const [slug, r] of Object.entries(donnees)) {
    const fichiers = Object.entries(r.fichiers)
      .map(([nom, f]) => `${nom} ${f.total ?? 0} (+${f.ajoutes ?? 0}/~${f.mis_a_jour ?? 0}/-${f.absents ?? 0}${f.geoalgeria !== undefined ? `, ${f.geoalgeria} chez GeoAlgeria` : ""})${f.change ? " *" : ""}`)
      .join(", ");
    console.log(`  ${slug}${r.creee ? " [nouvelle]" : ""}${r.complement ? " [complément]" : ""} : ${fichiers}${r.version ? ` → ${r.version}` : ""}${r.anomalie ? ` ⚠ ${r.anomalie}` : ""}${r.erreur ? ` ✗ ${r.erreur}` : ""}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lignes = Object.entries(donnees).map(
      ([slug, r]) =>
        `| ${slug} | ${Object.entries(r.fichiers)
          .map(([nom, f]) => `${nom} : ${f.total ?? 0} (+${f.ajoutes ?? 0}, ~${f.mis_a_jour ?? 0}, −${f.absents ?? 0})`)
          .join("<br>")} | ${r.publiee ? `✅ ${r.version}` : r.erreur ? `❌ ${r.erreur}` : r.anomalie ? `⚠️ ${r.anomalie}` : "—"} |`
    );
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Synchro OpenStreetMap\n\n${resume}\n\n| Donnée | Fichiers (+ajoutés, ~mis à jour, −absents) | Publication |\n|---|---|---|\n${lignes.join("\n")}\n`);
  }
  if (!api.lecturePublique) {
    // Un rapport perdu (base pas à jour) ne doit pas faire échouer un passage qui a publié.
    await api
      .rapporter(CODE, { statut, declencheur, debut: debut.toISOString(), fin: new Date().toISOString(), resume, rapport: { extrait_du: extraitDu, donnees } })
      .catch((erreur) => console.error(`Rapport non enregistré : ${erreur instanceof Error ? erreur.message : erreur}`));
  }
  if (statut === "echec") process.exitCode = 1;
}

main().catch((erreur) => {
  console.error(erreur);
  process.exitCode = 1;
});
