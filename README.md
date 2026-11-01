# API data-dz

API publique de [data-dz.com](https://data-dz.com), servie sur **https://api.data-dz.com**.
Hono + TypeScript, déployée sur Vercel (Fluid compute), documentation interactive sur `/docs`, spécification sur `/openapi.json`.

```
Navigateur / applications ──► api.data-dz.com (cette API)
                                 ├── Supabase   clé publishable (RLS) pour les lectures,
                                 │              clé secrète seulement après vérification admin
                                 └── R2 (data-dz) par l'API S3 : liens signés de 10 min,
                                                  conversions rangées dans exports/
Script de synchronisation GeoAlgeria ──► /v1/admin/* (CLE_SYNCHRO)
```

## Démarrer

Node 22 (`.nvmrc`). Copier `.env.example` en `.env` et le remplir.

```bash
npm install
npm run dev        # http://localhost:3000, docs sur /docs
npm test           # vitest (aucun appel réseau)
npm run typecheck
```

## Routes

| Route | Rôle | Cache CDN | Limite / IP |
|---|---|---|---|
| `GET /v1/datasets?q=&category=&source=&wilaya=&sort=top\|recent\|name&page=&limit=` | Catalogue publié, paginé. Chaque donnée porte aussi `infos_source`, `version.colonnes` et `ressources` (fichiers et liens de téléchargement, comme la fiche) pour les cartes du site | 15 s | 120/min |
| `GET /v1/datasets/:slug/share?lng=` | Page d'aperçu pour les réseaux sociaux (balises Open Graph / Twitter, puis renvoi vers la fiche). Servie aux robots (WhatsApp, Facebook, X, LinkedIn, Slack, Discord, Telegram…) par `vercel.json` du site | 1 h / 1 j | 120/min |
| `GET /v1/datasets/:slug/preview.png?lng=&v=` | Image d'aperçu 1200 × 630 (satori + resvg ; illustration WebP convertie par sharp ; polices Inter et logo dans `assets/`). Code dans `src/lib/image-apercu.ts`, **chargé à la demande** (`await import`) : jamais importé au démarrage, sinon un module natif absent fait tomber toute l'API (`test/resilience.test.ts`). En cas d'échec : 302 vers l'image générale du site | 1 h / 1 j | 120/min |
| `GET /v1/datasets/:slug` | Fiche : métadonnées, version, colonnes, aperçu, `ressources` (fichiers et liens) | 15 s | 120/min |
| `GET /v1/datasets/:slug/data?file=&offset=&limit=&fields=&wilaya=&geometry=none\|wkt` | Enregistrements en JSON paginé (≤ 1000, ≤ 4 Mo) | 30 min | 30/min |
| `GET /v1/datasets/:slug/sample?file=&n=&random=` | Échantillon | 30 min | 30/min |
| `GET /v1/datasets/:slug/download?format=csv\|xlsx\|json\|geojson&file=&inline=` | 302 vers un lien R2 signé (10 min) | 60 s | 30/min |
| `GET /v1/categories`, `/v1/licences`, `/v1/sources`, `/v1/stats` | Référentiels | 1 h | 120/min |
| `GET /v1/assistant/quota` | Quota quotidien DjazAI du compte connecté | aucun | 10/min/IP |\n| `POST /v1/assistant/query` | DjazAI : réponse Markdown et sources structurées à partir du catalogue publié et des aperçus (connexion requise) | aucun | 10/min/IP |
| `/v1/admin/*` | Administration (voir plus bas) | aucun | 60/min |

Les réponses servies par le CDN ne comptent pas dans les limites. Les erreurs suivent la RFC 9457 (`application/problem+json`, avec `code` et `requestId`).

### DjazAI

Les routes DjazAI nécessitent `Authorization: Bearer <jeton de session Supabase>`. `GET /v1/assistant/quota` renvoie le quota actuel. `POST /v1/assistant/query` accepte une question et jusqu'à 8 messages récents; la réponse contient `answer_markdown`, `sources[]` et `quota`.

Les comptes membres ont droit à **5 questions par jour civil, selon l'heure d'Alger**. Le rôle `admin` est lu depuis `profils.role` côté serveur et n'a pas de quota journalier. Une limite de débit de 10 requêtes par minute et par IP demeure comme protection contre les rafales. Le compteur journalier est atomique dans Supabase; si la migration manque ou si le compteur est indisponible, l'API refuse la requête sans appeler le fournisseur.

**Migration requise avant le déploiement** : appliquer `supabase/migrations/20261101000012_djazai_quota.sql` du dépôt `data-dz`. Elle crée le compteur et une fonction RPC accessible uniquement à `service_role`. L'API doit avoir `SUPABASE_SECRET_KEY` configurée pour vérifier les rôles et appeler cette fonction.

Configurer `OPENAI_API_KEY` dans les variables d'environnement du projet Vercel de l'API. Ne jamais exposer cette clé dans le site. `DJAZAI_MODEL` est facultatif (défaut : `gpt-6-luna`). Le fournisseur est appelé via l'API Responses, sans stockage des réponses (`store: false`).

La recherche prend en compte les termes de la question, les titres, mots-clés et descriptions des jeux publiés. Les jeux de données déjà cités ne sont gardés que pour une relance courte ou référentielle; une question sur un nouveau thème lance une recherche neuve. L'assistant reçoit les métadonnées et aperçus disponibles, mais ne lit pas les fichiers complets et ne calcule pas de totaux sur toutes les lignes. Il doit le dire quand l'aperçu ne suffit pas.
  
### Données non redistribuables
Colonne `datasets.diffusion_restreinte` (migration `20261031000011_diffusion_restreinte.sql` du dépôt data-dz, **à appliquer avant de déployer**), écrite à la main dans le SQL Editor (aujourd'hui : `poste`, `protection-civile`). La fiche reste publique (métadonnées, colonnes, nombre de lignes), mais `ressources` est vide, `version.apercu` vaut `null`, et `/data`, `/sample`, `/download` répondent **403 `not_redistributable`** sans jamais lire R2. Le catalogue et la fiche portent `diffusion_restreinte` et `lien_paquet` (paquet npm de la source, tiré de `infos_source.paquet`, sinon de `url_source` si c'est une page npm) : le site l'affiche à la place du téléchargement.

`datasets.licence_manuelle` (même migration) : une licence corrigée à la main n'est plus réécrite par la synchro (`PUT /v1/admin/datasets/:slug` ignore alors `licence_code` et `licence_details`, `champsSynchronises()`). Sans la migration, ces deux colonnes sont lues comme `false` (`avecColonnesRecentes()`).

### Conversions
Un fichier existe sur R2 dans un ou plusieurs formats d'origine (JSON, GeoJSON, CSV). Un autre format est produit **une seule fois par version** du fichier, rangé dans `exports/<empreinte>/<nom>.<format>`, puis servi par lien signé. Une nouvelle version change l'empreinte, donc les exports se renouvellent seuls.

- GeoJSON → CSV / XLSX / JSON : propriétés à plat + `longitude` / `latitude` pour les points, `geometry_wkt` pour les autres géométries.
- JSON / CSV → GeoJSON : seulement avec des colonnes latitude / longitude (`lat`, `lng`, `lon`, `latitude`, `longitude`), sinon 422.
- CSV avec BOM UTF-8 (arabe lisible dans Excel), protection contre l'injection de formules (les numéros `+213…` restent intacts).
- XLSX : feuille `data` + feuille `about` (titre, source, licence, lien vers la fiche).

## Administration et synchronisation

`Authorization: Bearer <jeton>` : session Supabase d'un membre `admin`, ou `CLE_SYNCHRO` pour le script GeoAlgeria.

| Route | Rôle |
|---|---|
| `GET /v1/admin/datasets?q=&statut=` | Toutes les données, tous statuts |
| `POST /v1/admin/datasets` | Créer (brouillon par défaut) |
| `PATCH /v1/admin/datasets/:slug` | Modifier ; masquer = `{"statut": "archive"}` ou `"brouillon"` |
| `PUT /v1/admin/datasets/:slug` | Créer ou mettre à jour (synchro) : ne change jamais le statut ni l'illustration d'une donnée existante, ni sa licence si `licence_manuelle` |
| `GET /v1/admin/slugs/:slug` | L'identifiant est-il libre ? (`utilise_par` : donnée qui le porte ou l'a porté) |
| `POST /v1/admin/datasets/:slug/rename` | Changer l'identifiant `{"slug", "illustration_actuelle"?}` : l'ancien est gardé dans `anciens_slugs` (migration `20261029000010`), la fiche et ses sous-routes y redirigent en 307, les liens des notifications sont réécrits ; 409 `slug_taken` ou `synchronized_source` (la synchro retrouve ses données par leur identifiant) |
| `DELETE /v1/admin/datasets/:slug?files=true` | Suppression définitive (409 si la base refuse : archiver alors) |
| `POST /v1/admin/datasets/:slug/uploads` | URL `PUT` signée (15 min) pour envoyer un fichier directement à R2 |
| `POST /v1/admin/datasets/:slug/versions` | Publie une version à partir des fichiers envoyés (lignes, colonnes, aperçu calculés) |
| `POST` / `DELETE /v1/admin/datasets/:slug/illustration` | Illustration (multipart `image`, PNG / JPEG / WebP, 2 Mo) dans `web-assets/datasets/` |
| `GET /v1/admin/sources` | Toutes les sources, sans cache (le public `/v1/sources` est en cache 1 h) |
| `POST /v1/admin/sources` | Créer une source `{"nom", "url"?, "description"?}` : slug tiré du nom, type repris de la source `communaute` ; 409 `source_exists` (`details.slug`) si le nom existe déjà (casse et accents ignorés) |
| `POST /v1/admin/submissions/:id/publish` | Met en ligne une proposition `acceptee` (session admin uniquement, pas `CLE_SYNCHRO`), voir ci-dessous |

### Mise en ligne d'une proposition

Bouton « Mettre en ligne » de la page de revue du site (`/moderation/submissions/:id`, admins). Corps facultatif : `{"slug": "…", "source_slug": "…"}` (slug tiré du titre sinon, `-2`, `-3`… s'il est pris ; source choisie par l'admin sur le site, `communaute` par défaut).
1. **Nouvelle donnée** : créée en brouillon avec le contenu de la proposition (source `source_slug`, `url_source` = page de la source, `infos_source` : `soumission_id`, `source_nom`, `periode`). Titre français repris de l'anglais ou de l'arabe s'il manque.
   **Mise à jour** : nouvelle version de la donnée visée (métadonnées inchangées ; refusée pour une source synchronisée).
2. Fichiers lus dans le bucket privé Supabase `soumissions` et copiés dans `datasets/<slug>/<horodatage>/` : CSV, JSON, GeoJSON tels quels, Excel converti en CSV (première feuille) ; PDF, ZIP, XML ignorés (listés dans `fichiers_ignores`). Principal : le premier GeoJSON, sinon CSV, sinon JSON. Aucun fichier lisible : 422 `no_usable_file`.
3. Version publiée (`/versions`), donnée passée en `publie`, puis `rpc("marquer_soumission_publiee")` : la base notifie l'auteur (et l'email part si configuré).
En cas d'erreur, une nouvelle donnée à moitié créée est supprimée avec ses fichiers : on peut relancer.

### Script de synchronisation : séquence

```bash
API=https://api.data-dz.com; AUTH="Authorization: Bearer $CLE_SYNCHRO"
# 1. Métadonnées (idempotent)
curl -X PUT "$API/v1/admin/datasets/pharmacies" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"titre":{"fr":"Pharmacies d'\''Algérie"},"source_slug":"geoalgeria","categorie_slug":"sante","licence_code":"ODbL-1.0"}'
# 2. Pour chaque fichier : URL d'envoi, puis PUT direct vers R2
curl -X POST "$API/v1/admin/datasets/pharmacies/uploads" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"nom":"pharmacies","format":"geojson"}'          # → { cle, url, content_type }
curl -X PUT "<url>" -H "Content-Type: application/geo+json" --data-binary @pharmacies.geojson
# 3. Version (le premier fichier est principal par défaut)
curl -X POST "$API/v1/admin/datasets/pharmacies/versions" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"numero":"2.4.0","notes":"Version 2.4.0 du paquet geoalgeria.","fichiers":[{"cle":"<cle>","nom":"pharmacies","format":"geojson","principal":true}]}'
```

## Mise en production (une fois)

1. **Vercel** (projet déjà relié à `api.data-dz.com`) : Settings → Build & Deployment → Framework Preset **Hono** (aussi fixé par `vercel.json`), sans commande de build ni dossier de sortie personnalisés. Settings → Functions → **région** = celle de la base Supabase. Ajouter les variables de `.env.example`, dont `OPENAI_API_KEY` pour activer DjazAI.
2. **Upstash** (recommandé) : Vercel → Storage → Upstash Redis, relié au projet.
3. **Vercel Firewall** → règle *Rate limit* (1 incluse en Hobby) : par IP, 300 requêtes / 60 s, action 429, devant toute l'API.
4. **R2 → bucket `data-dz` → Settings → CORS** :
   ```json
   [
     { "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400 },
     { "AllowedOrigins": ["https://data-dz.com", "https://www.data-dz.com", "http://localhost:5173"],
       "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }
   ]
   ```
   `*` en lecture est nécessaire : après la redirection de l'API, le navigateur envoie `Origin: null`. Les liens sont signés et expirent, rien n'est listable.
5. **Fermer l'accès public aux données** : Cloudflare → zone `data-dz.com` → Security → WAF → Custom rule
   `(http.host eq "files.data-dz.com" and not starts_with(http.request.uri.path, "/web-assets/"))` → **Block**.
   À faire **après** la mise en ligne du site qui passe par l'API. L'API, elle, passe par l'endpoint S3 et n'est pas concernée.
6. Supabase : appliquer la migration `20261025000009_illustrations.sql` du dépôt data-dz (colonne `datasets.illustration_url`).
