# Sécheresse, précipitations et humidité des sols — ERA5-Land

Calcul mensuel des indicateurs climatiques pour les 69 wilayas algériennes, à partir de la réanalyse **ERA5-Land monthly averaged** du Copernicus Climate Change Service (C3S). La grille native est de 0,1° (environ 9 km). Le calcul conserve la série depuis janvier 1981 et utilise 1991–2020 comme période de référence.

## Jeux de données et indicateurs

Variables ERA5-Land utilisées :
- `total_precipitation` : précipitation totale (pluie et équivalent en eau de la neige) ; les moyennes mensuelles de moyennes journalières sont en mètres par jour et sont converties en millimètres par mois en multipliant par 1 000 puis par le nombre de jours du mois.
- `volumetric_soil_water_layer_1` à `_4` : humidité volumique des couches 0–7, 7–28, 28–100 et 100–289 cm (m³/m³).
- `2m_temperature` : température mensuelle moyenne à 2 m (kelvins, convertis en °C).

Indicateurs calculés :
- normales mensuelles de précipitations (même mois calendaire, 1991–2020) ;
- anomalies de précipitations en pourcentage par rapport à la normale ;
- SPI-3 et SPI-12 : cumuls glissants sur 3 et 12 mois, transformés en indice normal standard par ajustement Gamma avec masse en zéro, par wilaya et mois de fin, sur 1991–2020 ;
- humidité composite 0–100 cm, pondérée par l'épaisseur des couches (7, 21 et 72 cm), et composite 0–289 cm (ajout de la couche 100–289 cm) ;
- percentile de l'humidité 0–100 cm, comparé au même mois calendaire de 1991–2020 ;
- température moyenne mensuelle à 2 m.

Les indices SPI sont laissés à `null` si la référence est insuffisante (moins de 20 observations ou moins de 15 valeurs positives pour l'ajustement Gamma). Les mois absents ne sont jamais assimilés à zéro.

## Spatialisation

Les contours GeoJSON des 69 wilayas et leurs noms sont chargés depuis la donnée publique `divisions-administratives` de data-dz (`wilaya-boundaries` et `wilayas`). Chaque cellule ERA5-Land est affectée à la wilaya qui contient son centre. Les moyennes par wilaya sont pondérées par `cos(latitude)`, approximation de la surface des cellules d'une grille latitude/longitude régulière. Un mois est publié seulement si les 69 wilayas ont toutes une valeur valide pour toutes les variables brutes requises.

## Fichiers

- `secheresse-wilayas.json` / `.csv` : 60 derniers mois. Le JSON est volontairement compact (moins de 4,5 Mo) et sert à la carte choroplèthe et aux graphiques interactifs de data-dz.
- `secheresse-historique.json` / `.csv` : archive mensuelle complète depuis 1981. Ce JSON complet est aussi la base de reprise incrémentale pour le prochain calcul.
- `rapport.json` : période, référence, contrôle des 69 wilayas, taux de couverture des indices, cellules par wilaya, tailles des fichiers et conversions.

## Installation et accès Copernicus

1. Créer un compte Climate Data Store (CDS) et accepter manuellement les conditions d'utilisation du jeu ERA5-Land monthly means depuis sa page de téléchargement.
2. Créer un jeton personnel API Copernicus.
3. Ajouter le jeton dans les secrets GitHub Actions sous le nom `CDS_API_KEY`. Le workflow génère un `~/.cdsapirc` privé à l'exécution. Ne jamais placer le jeton dans le dépôt.
4. Les secrets `API_URL` et `CLE_SYNCHRO` existants de la synchronisation data-dz sont également nécessaires pour la publication et la reprise de l'historique.

Dépendances Python :

```bash
python -m pip install -r scripts/secheresse/requirements.txt
```

Exécution locale :

```bash
export CDS_API_KEY="<jeton personnel Copernicus>"
export API_URL="https://api.data-dz.com"
export CLE_SYNCHRO="<clé de synchronisation data-dz>"
python scripts/secheresse/calculer.py --cache /tmp/secheresse/cache --sortie /tmp/secheresse/sortie
npx tsx scripts/secheresse/publier.ts --essai --sortie /tmp/secheresse/sortie
```

La première exécution télécharge l'historique complet par tranches de cinq années. Les exécutions suivantes relisent `secheresse-historique.json` et ne demandent à Copernicus que les deux derniers mois déjà publiés et les nouveaux mois disponibles ; les valeurs de cette zone de recouvrement sont remplacées pour intégrer d'éventuelles révisions de la réanalyse.

Options : `--sans-cache` force le nouveau téléchargement des requêtes NetCDF du passage ; `--sortie DOSSIER` change le dossier de sortie. Le script `publier.ts --verifier` consulte l'échéance `secheresse` dans `/admin/sync` ; `--essai` calcule et contrôle sans écrire de métadonnées ou de fichiers ; `--echec` inscrit un rapport d'échec.

## Synchronisation

Le workflow `.github/workflows/secheresse-sync.yml` s'exécute chaque mois, mais ne calcule que si l'échéance configurée dans `/admin/sync` est atteinte. Le lancement manuel propose l'essai par défaut et une option de forçage. La publication crée une fiche en brouillon lors de la première exécution ; une fiche existante conserve son statut.

## Limites et interprétation

- ERA5-Land est une **réanalyse modélisée**, pas une mesure directe d'une station météorologique ou d'une sonde d'humidité. Elle combine modèle et forçages d'observation ; ses valeurs ont des incertitudes et des biais locaux.
- Une maille d'environ 9 km, puis une moyenne par wilaya, lisse les différences entre communes, reliefs, versants, vallées et parcelles agricoles.
- SPI mesure un déficit ou un excédent pluviométrique sur une fenêtre temporelle ; il ne mesure pas à lui seul l'eau disponible dans les sols, les barrages ou les nappes.
- Le percentile d'humidité est une comparaison historique saisonnière, pas un seuil agronomique universel.
- Le jeu mensuel Copernicus est publié avec un retard de plusieurs semaines à quelques mois. Pour éviter les périodes incomplètes, le calcul s'arrête trois mois avant le mois courant.
- Ces indicateurs sont informatifs ; ils ne constituent ni une alerte officielle ni une déclaration administrative de sécheresse.

## Sources et licences

- Copernicus Climate Change Service (C3S), *ERA5-Land monthly averaged data from 1950 to present*, DOI [10.24381/cds.68d2bb30](https://doi.org/10.24381/cds.68d2bb30), licence CC BY 4.0 : <https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-monthly-means>.
- Référence administrative : GeoAlgeria, divisions administratives de l'Algérie, contours des wilayas sous ODbL-1.0 : <https://geoalgeria.com>. Les géométries ne sont pas redistribuées dans les fichiers climatiques ; elles servent à associer les valeurs aux wilayas.
- Méthode SPI : standardisation des cumuls sur 3 et 12 mois par ajustement Gamma avec correction de la probabilité de précipitation nulle, calibrée par wilaya et mois de fin sur 1991–2020.
