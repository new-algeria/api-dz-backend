# Synchronisation de l'équipe d'Algérie de football (hommes)

Donnée `equipe-algerie-foot-m` : tous les matchs de l'équipe A masculine depuis 1963, et leurs bilans.

## Source
Mart Jürisoo, *International football results from 1872* (https://github.com/martj42/international_results),
**domaine public (CC0 1.0)**, mis à jour en continu. Trois CSV de la branche `master` : `results.csv`,
`goalscorers.csv` (buteurs, partiels) et `shootouts.csv` (tirs au but). L'Algérie n'a pas d'ancien nom dans
`former_names.csv` : on filtre simplement l'équipe « Algeria ».

Sources écartées (droits) : classement FIFA, Transfermarkt, API-Football, football-data.org, StatsBomb.

## Calcul
Node.js 22, sans clé :

    npx tsx scripts/football/calculer.ts --cache /tmp/football/cache --sortie /tmp/football/sortie
    npx tsx scripts/football/publier.ts --essai --sortie /tmp/football/sortie

`calculer.ts` télécharge les trois CSV (cache local, fichiers temporaires `.part`), garde les matchs joués de
l'Algérie (score « NA » = match à venir, écarté), puis vérifie la vraisemblance (plus de 500 matchs, premier en
1963, bilans cohérents) avant d'écrire les fichiers. Fonctions pures `analyser()` et `verifier()` testées dans
`test/football.test.ts`.

## Fichiers publiés (JSON et CSV)
- `bilan-annuel` (**principal**) : matchs, victoires, nuls, défaites, buts pour et contre, différence, par année.
  La fiche et la vignette du catalogue en tirent une courbe ; la carte du catalogue affiche le nombre de matchs
  grâce à `infos_source.nb_enregistrements`.
- `matchs` : un match par ligne, du point de vue algérien (buts, résultat, lieu domicile / extérieur / neutre).
- `bilan-adversaires`, `bilan-competitions`, `tirs-au-but`.
- `buteurs` : **partiel** (environ 30 % des buts), jamais un classement des buteurs.

## Publication
`publier.ts` crée la donnée en brouillon (catégorie `sport-jeunesse`, source `international-football-results`,
licence `CC0-1.0`), ne publie une version que si un fichier a changé, et rapporte à `/admin/sync`
(synchronisation `equipe-algerie-foot-m`, migration data-dz `20261120000031`).
Workflow : `.github/workflows/football-sync.yml`, chaque mardi (après les fenêtres de matchs internationaux).
