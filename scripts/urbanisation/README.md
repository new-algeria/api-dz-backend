# Synchronisation de l'étalement urbain (GHSL, JRC)

Publie la donnée `surface-batie-wilayas` : surface bâtie de chacune des 69 wilayas tous les 5 ans de 1975 à 2030,
d'après GHS-BUILT-S R2023A (Global Human Settlement Layer, Centre commun de recherche de la Commission européenne).

- **Source** : tuiles `GHS_BUILT_S_E<époque>_GLOBE_R2023A_4326_3ss_V1_0_R<ligne>_C<colonne>.zip` sur
  `jeodpp.jrc.ec.europa.eu` (10° × 10°, 3 secondes d'arc ≈ 90 m, valeur = m² bâtis dans la cellule), sans compte.
  Seules les tuiles qui recouvrent une wilaya sont lues (`tuiles_utiles()` : R6_C18, R6_C19, R7_C18, R7_C19, R7_C20,
  R8_C19), environ 600 Mo pour les 12 époques.
- **Licence** : CC BY 4.0, « © Union européenne, 1995-2026 » (fichier `copyright.txt` du JRC). Citer Pesaresi et
  Politis (2023), https://doi.org/10.2905/9F06F36F-4B11-47EC-ABB0-4F8B7B1D72EA.
- **Synchronisation** : ligne `urbanisation` de `synchronisations` (mode `interne`, 365 jours), migration data-dz
  `20261130000039_synchro_urbanisation_ghsl.sql`. Workflow `.github/workflows/urbanisation-sync.yml` (le 7 de chaque mois,
  ne travaille qu'à l'échéance ou si « forcer »). Pas de contrôle à chaque PR (téléchargements trop lourds).

## Calcul (`calculer.py`, Python : rasterio, numpy)

1. Contours et noms des 69 wilayas depuis l'API de data-dz (`divisions-administratives`), population depuis
   `population-wilayas` (facultative : seulement pour le m² bâti par habitant, 2015–2030).
2. Pour chaque tuile, les wilayas sont « rastérisées » une fois sur la grille de la tuile, puis chaque époque est
   additionnée par code de wilaya (`np.bincount`), bloc par bloc. Valeurs > 10 000 m² par cellule ignorées (absentes).
3. Superficie de chaque wilaya : somme des surfaces de ses cellules (`surface_cellules()`, selon la latitude).
4. Contrôle : surface bâtie nationale entre 300 et 20 000 km² à chaque époque.

1975–2020 : estimations tirées des images Landsat et Sentinel-2 (`type` = `estimation`) ; 2025 et 2030 : projections
du JRC (`type` = `projection`, en pointillés sur la courbe du site).

## Fichiers publiés

- `surface-batie-wilayas` (principal) : `code_wilaya`, `wilaya`, `wilaya_ar`, `annee`, `type`, `surface_batie_km2`,
  `part_territoire_pct`, `m2_bati_par_habitant`, `indice_1975_100` (carte des wilayas colorée sur la fiche).
- `surface-batie-nationale` : totaux nationaux en format long.

## Lancer en local

```bash
python -m venv .venv && .venv/bin/pip install -r scripts/urbanisation/requirements.txt
.venv/bin/python -m unittest discover -s scripts/urbanisation
.venv/bin/python scripts/urbanisation/calculer.py --epoques 2020 --sortie /tmp/bati     # une seule époque
npx tsx scripts/urbanisation/publier.ts --essai --sortie /tmp/bati
```
