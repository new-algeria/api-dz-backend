# Synchronisation pétrole et gaz naturel (EIA)

Publie la donnée `petrole-gaz-algerie` : séries annuelles du pétrole et du gaz naturel de l'Algérie,
d'après les statistiques internationales de l'U.S. Energy Information Administration (EIA).

- **Source** : fichier groupé « International » (`https://api.eia.gov/bulk/INTL.zip`, environ 25 Mo, une série JSON
  par ligne), sans clé. L'API v2 de l'EIA, elle, demande une clé : elle n'est pas utilisée.
- **Licence** : domaine public (travaux du gouvernement fédéral des États-Unis), code `PDM-1.0` dans data-dz.
  L'EIA demande d'être citée.
- **Synchronisation** : ligne `petrole-gaz` de `synchronisations` (mode `interne`, 30 jours), migration data-dz
  `20261126000034_synchro_petrole_gaz_eia.sql`. Workflow `.github/workflows/petrole-gaz-sync.yml` (chaque mercredi,
  ne travaille qu'à l'échéance ou si « forcer »).

## Séries retenues (`INDICATEURS` dans `calculer.ts`)

| Série EIA | Indicateur | Unité |
|---|---|---|
| `INTL.57-1-DZA-TBPD.A` | Pétrole brut : production | milliers de barils par jour |
| `INTL.53-1-DZA-TBPD.A` | Pétrole et autres liquides : production | milliers de barils par jour |
| `INTL.58-1-DZA-TBPD.A` | Liquides de gaz naturel : production | milliers de barils par jour |
| `INTL.5-2-DZA-TBPD.A` | Pétrole et autres liquides : consommation | milliers de barils par jour |
| `INTL.57-4-DZA-TBPD.A` | Pétrole brut : exportations (jusqu'en 2018) | milliers de barils par jour |
| `INTL.26-1-DZA-BCM.A` | Gaz naturel : production | milliards de m³ |
| `INTL.26-2-DZA-BCM.A` | Gaz naturel : consommation | milliards de m³ |
| `INTL.26-4-DZA-BCM.A` | Gaz naturel : exportations (depuis 1990) | milliards de m³ |

Écartée : la production totale d'énergie (`INTL.44-1`), dont la part pétrole vaut 0 avant 1984 (trou de la source).

## Fichiers publiés

- `series-annuelles` (principal) : format long `annee`, `indicateur`, `valeur`, `unite`, `code_serie_eia` (courbe avec
  sélecteur de série sur la fiche, chiffre « 8 indicateurs, 1973 → … » sur la carte du catalogue).
- `bilan-annuel` : une ligne par année, une colonne par indicateur, plus `part_gaz_exportee_pct`.

## Contrôles

- Valeurs « NA », « -- », « (s) »… laissées vides, jamais à zéro.
- Plage plausible par indicateur (`PLAGES`) : une valeur hors plage arrête le robot (erreur d'unité ou de série).
- Début en 1980 au plus tard, au moins 40 années, et production de brut, de gaz, exportations de gaz et consommation
  de pétrole jusqu'à l'année en cours moins 3.
- Le brut, les condensats et les LGN ne sont pas découpés de la même façon selon les périodes chez l'EIA
  (1992–2002 : condensats avec les LGN) : c'est expliqué dans le README de la donnée, rien n'est corrigé.

## Lancer en local

```bash
npx tsx scripts/petrole-gaz/calculer.ts --sortie /tmp/petrole-gaz   # unzip doit être installé
npx tsx scripts/petrole-gaz/publier.ts --essai --sortie /tmp/petrole-gaz
```
