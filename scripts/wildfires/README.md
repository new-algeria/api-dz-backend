# Détections de points chauds NASA FIRMS

Ce dossier calcule et publie les détections d'anomalies thermiques satellitaires observées au-dessus des 69 wilayas algériennes.

## Prérequis

- Node.js 22 (version du dépôt).
- Une clé MAP_KEY gratuite NASA FIRMS, fournie par la variable d'environnement FIRMS_MAP_KEY.
- Accès réseau à firms.modaps.eosdis.nasa.gov et api.data-dz.com.

Demander une clé depuis NASA FIRMS : https://firms.modaps.eosdis.nasa.gov/api/area/

La clé doit être ajoutée dans les secrets GitHub sous le nom FIRMS_MAP_KEY. Elle n'est jamais écrite dans le dépôt.

## Calcul

Depuis la racine du dépôt :

```bash
FIRMS_MAP_KEY=… npx tsx scripts/wildfires/calculer.ts
```

Options :
- --cache DOSSIER : cache des réponses FIRMS (défaut : scripts/wildfires/cache/).
- --sortie DOSSIER : sortie du calcul (défaut : scripts/wildfires/sortie/).
- --sans-cache : force le nouveau téléchargement des tranches FIRMS.

La période est une fenêtre glissante de sept jours UTC. L'API Area accepte au plus cinq jours par requête ; le calcul interroge donc une tranche de cinq jours puis une tranche de deux jours. Les produits dont la disponibilité ne couvre pas la période sont ignorés et signalés dans rapport.json.

## Fichiers générés

| Fichier | Contenu | Licence |
|---|---|---|
| wildfires-raw.json / wildfires-raw.csv | Enregistrements FIRMS reçus dans l'emprise puis retenus à l'intérieur des wilayas, champs source conservés | CC0-1.0 |
| wildfires-enriched.json / wildfires-enriched.csv | Même ensemble avec identifiant technique et noms de wilaya | ODbL-1.0 |
| wildfires.geojson | Points géographiques, propriétés du fichier enrichi | ODbL-1.0 |
| rapport.json | Fenêtre, disponibilité des produits, nombres par wilaya et par produit, détections hors contours | — |

## Contrôles et limites

- Le calcul vérifie la présence de 69 contours et 69 noms, codes 01 à 69, les colonnes et dates FIRMS, les coordonnées, l'affectation spatiale et le nombre de lignes.
- Les données NASA et les fichiers enrichis sont publiés séparément : la source et la licence ODbL sont attachées aux fichiers enrichis par le mécanisme multi-sources de l'API.
- Une détection thermique ne prouve pas à elle seule un incendie. Les points ne représentent pas un périmètre de feu ni une surface brûlée.
- Les quatre produits NRT MODIS / VIIRS sont conservés séparément. Une même activité peut produire plusieurs détections ; elles ne sont pas dédupliquées entre satellites.
- Les produits NRT peuvent être remplacés par des produits standard après traitement. La fenêtre publiée ne constitue pas un historique scientifique définitif.

Sources :
- NASA FIRMS Area API : https://firms.modaps.eosdis.nasa.gov/api/area/
- NASA FIRMS disponibilité des produits : https://firms.modaps.eosdis.nasa.gov/api/data_availability/
- Politique NASA sur les licences de données : https://www.earthdata.nasa.gov/about/science-data-licenses
- Limites et nomenclature des wilayas : GeoAlgeria, données publiées sur data-dz, https://geoalgeria.com (ODbL-1.0).
