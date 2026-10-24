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
| `GET /v1/datasets?q=&category=&source=&wilaya=&sort=top\|recent\|name&page=&limit=` | Catalogue publié, paginé | 15 s | 120/min |
| `GET /v1/datasets/:slug` | Fiche : métadonnées, version, colonnes, aperçu, `ressources` (fichiers et liens) | 15 s | 120/min |
| `GET /v1/datasets/:slug/data?file=&offset=&limit=&fields=&wilaya=&geometry=none\|wkt` | Enregistrements en JSON paginé (≤ 1000, ≤ 4 Mo) | 30 min | 30/min |
| `GET /v1/datasets/:slug/sample?file=&n=&random=` | Échantillon | 30 min | 30/min |
| `GET /v1/datasets/:slug/download?format=csv\|xlsx\|json\|geojson&file=&inline=` | 302 vers un lien R2 signé (10 min) | 60 s | 20/min |
| `GET /v1/categories`, `/v1/licences`, `/v1/sources`, `/v1/stats` | Référentiels | 1 h | 120/min |
| `/v1/admin/*` | Administration (voir plus bas) | aucun | 60/min |

Les réponses servies par le CDN ne comptent pas dans les limites. Les erreurs suivent la RFC 9457 (`application/problem+json`, avec `code` et `requestId`).

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
| `PUT /v1/admin/datasets/:slug` | Créer ou mettre à jour (synchro) : ne change jamais le statut ni l'illustration d'une donnée existante |
| `DELETE /v1/admin/datasets/:slug?files=true` | Suppression définitive (409 si la base refuse : archiver alors) |
| `POST /v1/admin/datasets/:slug/uploads` | URL `PUT` signée (15 min) pour envoyer un fichier directement à R2 |
| `POST /v1/admin/datasets/:slug/versions` | Publie une version à partir des fichiers envoyés (lignes, colonnes, aperçu calculés) |
| `POST` / `DELETE /v1/admin/datasets/:slug/illustration` | Illustration (multipart `image`, PNG / JPEG / WebP, 2 Mo) dans `web-assets/datasets/` |

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

1. **Vercel** (projet déjà relié à `api.data-dz.com`) : Settings → Build & Deployment → Framework Preset **Hono** (aussi fixé par `vercel.json`), sans commande de build ni dossier de sortie personnalisés. Settings → Functions → **région** = celle de la base Supabase. Ajouter les variables de `.env.example`.
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
