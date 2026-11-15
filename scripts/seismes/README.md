# Synchronisation du catalogue sismique

Cette synchronisation interroge l'API USGS FDSN pour le catalogue NEIC/PDE (catalog=us, contributor=us), puis filtre les épicentres dans les 69 contours GeoAlgeria.

## Calcul
Node.js 22, sans clé USGS :

    npx tsx scripts/seismes/calculer.ts --cache /tmp/seismes/cache --sortie /tmp/seismes/sortie
    npx tsx scripts/seismes/publier.ts --essai --sortie /tmp/seismes/sortie

Le script met en cache les réponses GeoJSON, utilise un User-Agent dédié et des fichiers temporaires .part. Les réponses atteignant 20 000 événements sont redécoupées dans le temps afin d'éviter toute troncature silencieuse.

## Fichiers et licences
- seismes-usgs (JSON/CSV) : événements NEIC/PDE sans affectation administrative, CC0-1.0.
- seismes-annuels (JSON/CSV) : série annee / valeur / unite, CC0-1.0.
- seismes-algerie (JSON/CSV/GeoJSON) : événements enrichis avec les codes et noms des wilayas, GeoAlgeria ODbL-1.0.
- seismes-wilayas (JSON/CSV) : 69 comptes par année, GeoAlgeria ODbL-1.0.
- rapport.json : période, nombres par année et wilaya, min/max magnitude, détections hors wilayas et nombres de lignes.

## Limites
Magnitude minimale 2,5 ; période depuis 1973 ; année courante incomplète. La couverture et la complétude dépendent du catalogue NEIC/PDE. Cette donnée n'est pas un inventaire exhaustif CRAAG. Les événements absents du catalogue ou sous M 2,5 ne sont pas présents ; une profondeur absente reste null.

Le CRAAG publie ses propres catalogues historiques (notamment 1365–1992 et 1992–2001) et une carte en ligne. Les pages consultées n'indiquent pas de licence ouverte ; ces contenus ne sont pas redistribués :
- https://www.craag.dz/index.php/catalogues-de-sismicite/
- https://www.craag.dz/index.php/seisme_g/

## Sources
- USGS ComCat : https://earthquake.usgs.gov/data/comcat/
- USGS NEIC/PDE catalog : https://earthquake.usgs.gov/data/comcat/catalog/us/
- API FDSN : https://earthquake.usgs.gov/fdsnws/event/1/
- USGS data licensing : https://www.usgs.gov/data-management/data-licensing
- GeoAlgeria : https://geoalgeria.com (ODbL-1.0)
