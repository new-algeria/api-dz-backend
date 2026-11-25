# Synchronisation des indicateurs de la Banque mondiale (WDI)

Publie la donnée `indicateurs-developpement-algerie` : 36 indicateurs annuels de la Banque mondiale sur l'Algérie
(population, santé, éducation, économie, emploi, numérique et infrastructures, environnement), depuis 1960.

- **Source** : API v2 de la Banque mondiale, `https://api.worldbank.org/v2/country/DZA/indicator/<code>?format=json`,
  sans clé, un appel par indicateur (4 essais avec attente en cas d'erreur réseau).
- **Licence** : CC BY 4.0, attribution à la Banque mondiale. Source data-dz existante `banque-mondiale`.
- **Synchronisation** : ligne `banque-mondiale` de `synchronisations` (mode `interne`, 30 jours), migration data-dz
  `20261127000036_synchro_banque_mondiale.sql`. Workflow `.github/workflows/banque-mondiale-sync.yml` (chaque vendredi,
  ne travaille qu'à l'échéance ou si « forcer »).

## Indicateurs

Liste, unités, thèmes et plages plausibles dans `INDICATEURS` (`calculer.ts`). PIB et réserves sont convertis en milliards
de dollars (`diviseur`). Les estimations modélisées (`modelise` : chômage OIT, mortalité maternelle, eau potable…) sont
signalées dans le dictionnaire et le README de la donnée. Écartés : l'alphabétisation des adultes (4 valeurs, la dernière
en 2008) et `EN.ATM.CO2E.PC` (supprimé par la Banque mondiale, remplacé par `EN.GHG.CO2.PC.CE.AR5`).

Pour ajouter un indicateur : une ligne dans `INDICATEURS` (code, libellé, unité, thème, plage), au plus 50 au total
(au-delà, la fiche n'affiche plus de sélecteur de série).

## Fichiers publiés

- `indicateurs-annuels` (principal) : format long `annee`, `indicateur`, `valeur`, `unite`, **sans autre colonne texte**
  (la fiche fait une série par combinaison de colonnes texte).
- `bilan-annuel` : une ligne par année, une colonne par code de la Banque mondiale.
- `dictionnaire` : code, libellé, unité, thème, estimation modélisée, années couvertes.

## Lancer en local

```bash
npx tsx scripts/banque-mondiale/calculer.ts --sortie /tmp/bm
npx tsx scripts/banque-mondiale/publier.ts --essai --sortie /tmp/bm
```
