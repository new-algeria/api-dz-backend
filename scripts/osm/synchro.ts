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
import { FORMAT_FILTRE } from "../../src/lib/osm-format.js";
import { ClientApi, ErreurAppel, type DonneeApi, type TagCompte } from "./api.js";
import { FLUX, NOUVELLES_DONNEES, type Flux } from "./categories.js";
import { CLES_INVENTAIRE, dateExtrait, extraireCommunes, extraireFlux, inventaireTags, telechargerExtrait } from "./extraire.js";
import { baisseAnormale, fichierReference, fusionner, numeroComplement, rapprocher, serialiser, type Objet, type RapportFusion } from "./fusion.js";
import { construireIndex, correspondancesGeoAlgeria, localiserObjets, type IndexLieux } from "./localisation.js";

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
  /** Aucun objet trouvé et rien de publié avant : fichier ignoré (tag mal écrit, ou absent d'Algérie). */
  vide?: boolean;
  geoalgeria?: number;
  /** Objets placés dans une commune (wilaya_code, commune_code). */
  localises?: number;
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
function champsNouvelleDonnee(slug: string, tousLesFlux: Flux[]) {
  const nouvelle = NOUVELLES_DONNEES.find((donnee) => donnee.slug === slug);
  if (!nouvelle) return null;
  const filtres = tousLesFlux.filter((flux) => flux.slug === slug).flatMap((flux) => flux.filtres.map((filtre) => `\`${filtre.replace(/^nwr\//, "")}\``));
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

  // 2. Flux réglés dans l'administration (/admin/sync) ; ceux du code (categories.ts) tant que la base ne les a pas.
  let origineFlux = "administration";
  let tousLesFlux: Flux[];
  try {
    if (api.lecturePublique) throw new ErreurAppel(401, "lecture publique");
    tousLesFlux = (await api.listerFlux())
      .filter((f) => f.actif)
      .sort((a, b) => a.ordre - b.ordre || a.code.localeCompare(b.code))
      .map((f) => ({ code: f.code, slug: f.dataset_slug, fichier: f.fichier, filtres: f.filtres, exige: f.exige ?? undefined, rayon_m: f.rayon_m ?? undefined }));
  } catch (erreur) {
    if (!(erreur instanceof ErreurAppel) || ![401, 404, 503].includes(erreur.statut)) throw erreur;
    origineFlux = "code (categories.ts)";
    tousLesFlux = FLUX;
  }
  const invalides = tousLesFlux.filter((f) => !f.filtres.every((filtre) => FORMAT_FILTRE.test(filtre)));
  for (const f of invalides) console.error(`Flux ${f.code} ignoré : expression invalide (${f.filtres.join(" ; ")}).`);
  const flux = tousLesFlux.filter((f) => !invalides.includes(f) && (!seulement || seulement.includes(f.slug)));
  await mkdir(dossier, { recursive: true });
  const extraitDu = await dateExtrait();
  console.log(`Extrait Geofabrik du ${extraitDu} — ${flux.length} flux (${origineFlux})${essai ? " (essai : rien ne sera publié)" : ""}.`);
  const extrait = await telechargerExtrait(dossier, valeur("extrait"));
  const parFlux = await extraireFlux(extrait, dossier, flux);

  // Wilaya et commune de chaque objet : frontières OSM des communes + codes de GeoAlgeria (divisions-administratives).
  // Sans elles, les objets gardent les codes du passage précédent ; la publication n'est jamais bloquée.
  let lieux: IndexLieux | null = null;
  try {
    const texte = await api.lireFichier("divisions-administratives", "algeria", "json");
    const correspondances = correspondancesGeoAlgeria(texte ? JSON.parse(texte) : null);
    if (correspondances.size === 0) throw new Error("fichier « algeria » de divisions-administratives introuvable ou vide");
    lieux = construireIndex(await extraireCommunes(extrait, dossier), correspondances);
    console.log(`Communes : ${lieux.nbZones} frontières reconnues sur ${correspondances.size} communes GeoAlgeria.`);
  } catch (erreur) {
    console.error(`Wilaya et commune non calculées : ${erreur instanceof Error ? erreur.message : erreur}`);
  }

  // 3. Inventaire des tags : signale ceux apparus depuis le passage précédent (sans jamais bloquer la publication).
  let nouveauxTags: TagCompte[] = [];
  let inventaire: string | undefined;
  if (!api.lecturePublique && !seulement) {
    try {
      const cles = [...new Set([...CLES_INVENTAIRE, ...flux.flatMap((f) => f.filtres.map((filtre) => filtre.slice(4).split("=")[0]))])];
      const tags = await inventaireTags(extrait, dossier, cles);
      const comptes = flux.map((f) => ({ code: f.code, nb: parFlux.get(f.code)?.length ?? 0 }));
      if (essai) {
        const connus = new Set((await api.lireInventaire()).map((tag) => `${tag.cle}=${tag.valeur}`));
        nouveauxTags = connus.size === 0 ? [] : tags.filter((tag) => !connus.has(`${tag.cle}=${tag.valeur}`));
      } else {
        nouveauxTags = await api.deposerInventaire(tags, comptes);
      }
      inventaire = `${tags.length} tags inventoriés, ${nouveauxTags.length} nouveau(x)`;
      console.log(`Inventaire : ${inventaire}${nouveauxTags.length ? ` : ${nouveauxTags.slice(0, 20).map((tag) => `${tag.cle}=${tag.valeur} (${tag.nb})`).join(", ")}` : ""}.`);
    } catch (erreur) {
      inventaire = `inventaire impossible : ${erreur instanceof Error ? erreur.message : erreur}`;
      console.error(inventaire);
    }
  }

  const parDonnee = new Map<string, Flux[]>();
  for (const f of flux) parDonnee.set(f.slug, [...(parDonnee.get(f.slug) ?? []), f]);

  const donnees: Record<string, RapportDonnee> = {};
  for (const [slug, fluxDonnee] of parDonnee) {
    const rapport: RapportDonnee = { complement: false, fichiers: {}, publiee: false };
    donnees[slug] = rapport;
    try {
      const donnee: DonneeApi | null = await api.lireDonnee(slug);
      const nouvelle = donnee ? null : champsNouvelleDonnee(slug, tousLesFlux);
      if (!donnee && !nouvelle) throw new Error("donnée introuvable (ni existante, ni dans NOUVELLES_DONNEES)");
      rapport.creee = !donnee;
      rapport.complement = Boolean(donnee && donnee.source_slug !== SOURCE);

      // Donnée OpenStreetMap : ses fichiers doivent tous venir des flux, sinon on en perdrait à la publication.
      if (donnee && !rapport.complement) {
        const connus = new Set(fluxDonnee.map((f) => f.fichier));
        const inconnus = [...new Set(donnee.fichiers.map((f) => f.nom).filter((nom): nom is string => Boolean(nom) && !connus.has(nom!)))];
        if (inconnus.length > 0) throw new Error(`fichiers hors synchronisation dans la donnée (${inconnus.join(", ")}) : publication manuelle`);
      }

      // Fichier GeoAlgeria de référence (rapprochement) : celui qui a le plus de points, lu une fois par donnée.
      let geoalgeria: Objet[] | null = null;
      if (rapport.complement && donnee) {
        const candidats = [];
        for (const fichier of donnee.fichiers.filter((f) => f.format === "geojson" && !f.sources && f.nom)) {
          const objets = lireObjets(await api.lireFichier(slug, fichier.nom!, "geojson"));
          candidats.push({ principal: fichier.principal, nbPoints: objets.length, objets });
        }
        geoalgeria = fichierReference(candidats)?.objets ?? [];
      }

      const textes: { flux: Flux; texte: string }[] = [];
      for (const f of fluxDonnee) {
        const extraits = parFlux.get(f.code) ?? [];
        const ancienTexte = donnee ? await api.lireFichier(slug, f.fichier, "geojson") : null;
        const precedents = lireObjets(ancienTexte);
        if (extraits.length === 0 && precedents.length === 0) {
          rapport.fichiers[f.fichier] = { extraits: 0, vide: true, change: false };
          continue;
        }
        if (baisseAnormale(precedents, extraits)) {
          rapport.anomalie = `${f.fichier} : ${extraits.length} objets extraits pour ${precedents.length} publiés (baisse de plus de 10 %)`;
          break;
        }
        const { objets, rapport: fusion } = fusionner(precedents, extraits, date);
        const localises = lieux ? localiserObjets(objets, lieux) : undefined;
        const rapproches = geoalgeria ? rapprocher(objets, geoalgeria, f.rayon_m ?? RAYON_PAR_DEFAUT_M) : undefined;
        const texte = serialiser(objets);
        const ancienSha = donnee?.fichiers.find((fichier) => fichier.nom === f.fichier && fichier.format === "geojson")?.sha256 ?? (ancienTexte ? sha256(ancienTexte) : null);
        const change = sha256(texte) !== ancienSha;
        rapport.fichiers[f.fichier] = { extraits: extraits.length, ...fusion, ...(rapproches !== undefined ? { geoalgeria: rapproches } : {}), ...(localises !== undefined ? { localises } : {}), change };
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
  const resumeComplet = inventaire ? `${resume} ${inventaire[0].toUpperCase()}${inventaire.slice(1)}.` : resume;
  console.log(resumeComplet);
  for (const [slug, r] of Object.entries(donnees)) {
    const fichiers = Object.entries(r.fichiers)
      .map(([nom, f]) => f.vide ? `${nom} : aucun objet` : `${nom} ${f.total ?? 0} (+${f.ajoutes ?? 0}/~${f.mis_a_jour ?? 0}/-${f.absents ?? 0}${f.geoalgeria !== undefined ? `, ${f.geoalgeria} chez GeoAlgeria` : ""}${f.localises !== undefined ? `, ${f.localises} localisés` : ""})${f.change ? " *" : ""}`)
      .join(", ");
    console.log(`  ${slug}${r.creee ? " [nouvelle]" : ""}${r.complement ? " [complément]" : ""} : ${fichiers}${r.version ? ` → ${r.version}` : ""}${r.anomalie ? ` ⚠ ${r.anomalie}` : ""}${r.erreur ? ` ✗ ${r.erreur}` : ""}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lignes = Object.entries(donnees).map(
      ([slug, r]) =>
        `| ${slug} | ${Object.entries(r.fichiers)
          .map(([nom, f]) => (f.vide ? `${nom} : aucun objet trouvé` : `${nom} : ${f.total ?? 0} (+${f.ajoutes ?? 0}, ~${f.mis_a_jour ?? 0}, −${f.absents ?? 0})`))
          .join("<br>")} | ${r.publiee ? `✅ ${r.version}` : r.erreur ? `❌ ${r.erreur}` : r.anomalie ? `⚠️ ${r.anomalie}` : "—"} |`
    );
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Synchro OpenStreetMap\n\n${resumeComplet}\n\n${
      nouveauxTags.length ? `Nouveaux tags (à classer dans /admin/sync) : ${nouveauxTags.map((tag) => `\`${tag.cle}=${tag.valeur}\` (${tag.nb})`).join(", ")}\n\n` : ""
    }| Donnée | Fichiers (+ajoutés, ~mis à jour, −absents) | Publication |\n|---|---|---|\n${lignes.join("\n")}\n`);
  }
  if (!api.lecturePublique) {
    // Un rapport perdu (base pas à jour) ne doit pas faire échouer un passage qui a publié.
    await api
      .rapporter(CODE, { statut, declencheur, debut: debut.toISOString(), fin: new Date().toISOString(), resume: resumeComplet, rapport: { extrait_du: extraitDu, origine_flux: origineFlux, nouveaux_tags: nouveauxTags, donnees } })
      .catch((erreur) => console.error(`Rapport non enregistré : ${erreur instanceof Error ? erreur.message : erreur}`));
  }
  if (statut === "echec") process.exitCode = 1;
}

main().catch((erreur) => {
  console.error(erreur);
  process.exitCode = 1;
});
