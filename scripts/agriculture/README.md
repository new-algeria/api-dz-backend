# Synchronisation de la production agricole (FAOSTAT)

Publie la donnée `production-agricole-algerie` : production des cultures et de l'élevage, surfaces, rendements et cheptel
de l'Algérie depuis 1961, d'après FAOSTAT (domaine QCL, « Crops and livestock products »).

- **Source** : `https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_Africa.zip` (CSV en UTF-8, format
  large : une colonne par année et son statut), sans clé. Seules les lignes de l'Algérie (`Area Code` 4) sont lues.
- **Licence** : CC BY 4.0 (conditions des bases statistiques de la FAO), attribution à la FAO. Source data-dz existante `fao`.
- **Synchronisation** : ligne `agriculture-fao` de `synchronisations` (mode `interne`, 30 jours), migration data-dz
  `20261128000037_synchro_agriculture_fao.sql`. Workflow `.github/workflows/agriculture-sync.yml` (chaque samedi,
  ne travaille qu'à l'échéance ou si « forcer »). FAOSTAT met ce domaine à jour une à deux fois par an.

## Fichiers publiés

- `principales-productions` (principal) : 30 séries (`SELECTION` dans `calculer.ts`) en format long `annee`, `indicateur`,
  `valeur`, `unite`, `code_statut`. `code_statut` est ignoré par le graphique de la fiche (motif « code »).
- `production-detaillee` : toutes les valeurs de l'Algérie (production, surface récoltée, rendement, cheptel…), avec le statut lisible.
- `classement-produits` : 30 premières productions (hors agrégats) de la dernière année officielle et de la dernière année.

## Statut des valeurs

`A` officiel, `E` estimation FAO, `I` imputation FAO, `X` autre organisme ; `M` (absente) n'est pas gardée.
`part_officielle_par_annee` : part du tonnage des productions élémentaires déclarée officiellement ;
`derniere_annee_officielle` : dernière année où elle dépasse 50 %. Dans le fichier du 31/12/2025 : 92 à 96 % jusqu'en 2021,
0 % en 2022–2024 (blé à 3 000 000 t tout rond, venant d'un autre organisme). Toujours dire « estimation FAO » pour ces années.

## Lancer en local

```bash
npx tsx scripts/agriculture/calculer.ts --sortie /tmp/agri   # unzip doit être installé
npx tsx scripts/agriculture/publier.ts --essai --sortie /tmp/agri
```
