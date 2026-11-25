# Synchronisation pêche et aquaculture (FAO FishStat)

Publie la donnée `peche-aquaculture-algerie` : production annuelle de la pêche et de l'aquaculture de l'Algérie depuis 1950,
d'après le fichier « Global production » de la FAO.

- **Source** : `https://www.fao.org/fishery/static/Data/GlobalProduction_<édition>.zip` (CSV, sans clé). Le robot essaie
  les éditions de l'année suivante à deux ans en arrière (`editionsCandidates()`) et prend la première qui existe.
- **Licence** : CC BY 4.0 (conditions d'utilisation des bases statistiques de la FAO), attribution à la FAO.
- **Synchronisation** : ligne `peche-aquaculture` de `synchronisations` (mode `interne`, 30 jours), migration data-dz
  `20261126000035_synchro_peche_aquaculture_fao.sql`. Workflow `.github/workflows/peche-aquaculture-sync.yml` (chaque jeudi,
  ne travaille qu'à l'échéance ou si « forcer »). La FAO publie une à deux éditions par an : la plupart des passages ne
  publient rien.

## Fichiers publiés

- `production-annuelle` (principal) : format long `annee`, `indicateur`, `valeur` (tonnes), `part_officielle_pct`.
  7 indicateurs : total, pêche en mer, pêche en eaux continentales, aquaculture (totale, marine, eau saumâtre, eau douce).
- `production-par-espece` : une ligne par année, espèce, milieu et zone, avec le statut de la valeur (officiel, estimation FAO…).
- `especes-principales` : les 30 premières espèces de la dernière année, part du total, moyenne sur 10 ans.

## Points d'attention

- **Statut des valeurs** : la FAO estime les années non déclarées (statut « I »). Dans l'édition 2026.1.0, 1980–1985,
  1990–1994 et 2024 sont surtout estimées (2024 : 5,8 % officiel). `part_officielle_pct` le dit pour chaque valeur,
  et le README de la donnée liste ces années. Ne jamais présenter une année estimée comme un chiffre officiel.
- Statistiques nationales : la FAO ne publie rien par wilaya ni par port.
- Seules les quantités en tonnes de poids vif (`Q_tlw`) sont lues.

## Lancer en local

```bash
npx tsx scripts/peche-aquaculture/calculer.ts --sortie /tmp/peche   # unzip doit être installé
npx tsx scripts/peche-aquaculture/publier.ts --essai --sortie /tmp/peche
```
