# data-dz-api

API publique de data-dz (https://api.data-dz.com). Hono + TypeScript sur Vercel (zéro config, entrée `src/index.ts`).
Le front est le dépôt `data-dz` (React) ; ce dépôt remplace l'ancienne API Express (api-dz-backend).
Référence complète des routes, de la mise en production et du script de synchronisation : `README.md`.

Commandes : `npm run dev` (Node 22, `.env` copié de `.env.example`), `npm test`, `npm run typecheck`.

## Règles
- **Aucun secret dans le dépôt.** `.env*` est ignoré sauf `.env.example`. La clé secrète Supabase ne sert que dans `supabaseAdmin()`, après `exigerAdmin`.
- **Jamais de clé de stockage R2 dans une réponse** : les fichiers sortent par `lienSigne()` (lien de 10 min) derrière `/download`. Le domaine public `files.data-dz.com` est réservé à `web-assets/`.
- Lectures publiques avec `supabasePublic()` (clé publishable) : la RLS décide de ce qui est visible.
- Toute réponse publique pose sa politique de cache (`mettreEnCache`) ; toute route admin est `no-store`.
- Erreurs : lever `ErreurApi` (message sûr à afficher, sans détail interne) ; `onError` répond en `application/problem+json`.
- Paramètres validés par zod dans `createRoute` ; une nouvelle route publique doit être documentée (OpenAPI) et testée dans `test/app.test.ts` si elle a une logique propre.
- Réponses < 4 Mo (limite Vercel 4,5 Mo) : au-delà, passer par un lien signé.
- Noms métier en français (`listerDonnees`, `lienTelechargement`), routes et champs d'URL en anglais, comme le front.
