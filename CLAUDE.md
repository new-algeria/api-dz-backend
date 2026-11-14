# data-dz-api

API publique de data-dz (https://api.data-dz.com). Hono + TypeScript sur Vercel (zéro config, entrée `src/index.ts`).
Le front est le dépôt `data-dz` (React) ; ce dépôt remplace l'ancienne API Express (api-dz-backend).
Référence complète des routes, de la mise en production et du script de synchronisation : `README.md`.

Commandes : `npm run dev` (Node 22, `.env` copié de `.env.example`), `npm test`, `npm run typecheck`.
Node 22 obligatoire, y compris en local : sous Node 20, supabase-js plante à la création du client (WebSocket natif absent).

## Règles
- **Aucun secret dans le dépôt.** `.env*` est ignoré sauf `.env.example`. La clé secrète Supabase ne sert que dans `supabaseAdmin()`, après `exigerAdmin`.
- **Données non redistribuables** (`datasets.diffusion_restreinte`) : jamais de fichier, de ligne ni d'aperçu (`ressources` vide, 403 `not_redistributable` dans `fichiersDe()`), seulement `lien_paquet`. Toute nouvelle route qui lit R2 doit passer par `fichiersDe()` ou vérifier `estRestreinte()`.
- **Jamais de clé de stockage R2 dans une réponse** : les fichiers sortent par `lienSigne()` (lien de 10 min) derrière `/download`. Le domaine public `files.data-dz.com` est réservé à `web-assets/`.
- Lectures publiques avec `supabasePublic()` (clé publishable) : la RLS décide de ce qui est visible.
- Toute réponse publique pose sa politique de cache (`mettreEnCache`) ; toute route admin est `no-store`.
- Erreurs : lever `ErreurApi` (message sûr à afficher, sans détail interne) ; `onError` répond en `application/problem+json`.
- Paramètres validés par zod dans `createRoute` ; une nouvelle route publique doit être documentée (OpenAPI) et testée dans `test/app.test.ts` si elle a une logique propre.
- Réponses < 4 Mo (limite Vercel 4,5 Mo) : au-delà, passer par un lien signé.
- Noms métier en français (`listerDonnees`, `lienTelechargement`), routes et champs d'URL en anglais, comme le front.
- Erreur de base : `erreurBase()` (admin) et `erreurSupabase()` (public) écrivent toujours le code Postgres dans les logs Vercel ; dans `erreurBase()`, 42703 (colonne inconnue = migration non appliquée) répond 503 `schema_outdated`. Une colonne ajoutée par une migration récente se lit avec `avecColonnesRecentes()` (liste `COLONNES_RECENTES`, ancien nom `avecIllustration()`) tant que la migration peut manquer.

- **Droits d'administration** : `exigerAdmin` accepte `CLE_SYNCHRO` ou un membre admin / dont le rôle porte la permission de la route (`permissionRequise()` : `synchro.gerer` pour `/v1/admin/sync`, sinon `donnees.gerer`). Liste des permissions dans `src/lib/permissions.ts`, identique à la contrainte `roles.permissions` de la base et à `src/lib/roles.ts` du site : les trois changent ensemble.
- **Fichiers par source** : `fichiers.source_id` / `licence_code` (migration 20261102000017), lus via le marqueur `SOURCE_FICHIERS` des `select` (retiré tant que la migration manque) ; chaque ressource sort avec `source` et `licence_code`.
- **Synchronisation population** : `scripts/population/` (calcul Python sur les grilles WorldPop, publication et rapport en TypeScript avec le client de `scripts/osm/api.ts`) et `.github/workflows/population-sync.yml` ; ligne `population` de `synchronisations`, mêmes routes `/v1/admin/sync/:code` que la synchro OSM. Voir le README.
- **Synchronisation OpenStreetMap** : `scripts/osm/` (README, section dédiée) et `.github/workflows/osm-sync.yml`. Jamais Overpass dans le robot (seul le bouton « tester » de l'admin fait un `out count`). Les fichiers OSM s'ajoutent aux précédents, rien n'est supprimé. Les flux (tag → donnée → fichier) sont en base (`osm_flux`, `src/lib/osm-flux.ts`) ; `categories.ts` est le secours. Format d'une expression : `src/lib/osm-format.ts`, partagé avec le robot.

- **Synchronisation NASA FIRMS** : `scripts/wildfires/` collecte les produits NRT MODIS / VIIRS sur sept jours UTC, associe les points aux 69 wilayas GeoAlgeria, puis publie les fichiers NASA sous CC0-1.0 et les fichiers enrichis GeoAlgeria sous ODbL-1.0 ; clé `FIRMS_MAP_KEY` dans les secrets GitHub, workflow `.github/workflows/wildfires-sync.yml` et ligne `wildfires` de `synchronisations`.

## Tests (à étendre)
Vitest couvre la conversion, la validation des paramètres, la limite de débit et quelques erreurs. À prévoir : routes publiques et admin avec un Supabase et un R2 simulés (liste, fiche, `/data`, `/download`, création, version, illustration), et un contrôle du schéma de la base cible (chaque colonne lue par l'API existe) avant chaque déploiement.
