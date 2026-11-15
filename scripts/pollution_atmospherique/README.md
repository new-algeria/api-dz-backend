# Pollution atmosphérique en Algérie — CAMS EAC4

Séries mensuelles de fond régional de la composition atmosphérique en Algérie, extraites de la réanalyse mondiale CAMS EAC4 du Copernicus Atmosphere Monitoring Service.

## Source et périmètre

- Jeu de données : [CAMS global reanalysis (EAC4) monthly averaged fields](https://ads.atmosphere.copernicus.eu/datasets/cams-global-reanalysis-eac4-monthly).
- Identifiant API : \`cams-global-reanalysis-eac4-monthly\`.
- DOI : [10.24381/fd75fff2](https://doi.org/10.24381/fd75fff2).
- Licence : CC BY 4.0.
- Couverture publiée par ADS : 2003–2025 ; résolution 0,75° × 0,75° (environ 80 km) ; moyenne mensuelle ; actualisation annoncée deux fois par an avec 4 à 6 mois de délai.
- Le territoire est découpé à l'aide de l'union des 69 contours administratifs GeoAlgeria pour retenir les centres de mailles situés en Algérie. Les contours ne sont pas redistribués.

## Polluants et unités

| Polluant | Variable CAMS | Unité publiée |
|---|---|---|
| PM2.5 | Particulate matter d < 2.5 µm | µg/m³ |
| PM10 | Particulate matter d < 10 µm | µg/m³ |
| CO | Carbon monoxide | ppbv |
| NO2 | Nitrogen dioxide | ppbv |
| O3 | Ozone | ppbv |
| SO2 | Sulphur dioxide | ppbv |

Les champs PM sont convertis de kg/m³ vers µg/m³ (× 10⁹). Les gaz CAMS sont fournis comme rapports massiques kg/kg ; ils sont convertis en rapports volumiques ppbv par le rapport des masses molaires (air sec 28,9647 g/mol / polluant). La conversion ne fait pas intervenir une densité d'air estimée.

## Fichiers

- \`pollution-atmospherique-algerie.json/.csv\` : moyenne nationale mensuelle, une série par polluant, pondérée par cos(latitude).
- \`pollution-atmospherique-grille-recente.csv\` : dernière période mensuelle disponible, centres des mailles, coordonnées, polluant, valeur et unité ; destiné à la carte.
- \`pollution-atmospherique-grille.csv\` : historique détaillé par date, cellule, coordonnées et polluant.
- \`pollution-atmospherique-indicateurs.json/.csv\` : moyennes annuelles pondérées par le nombre de jours, minimum et maximum mensuels.
- \`rapport.json\` : période, résolution, nombre de mailles et de lignes, méthode de conversion et empreinte SHA-256 des NetCDF.

## Méthode de calcul

Les requêtes ADS sont découpées en blocs de cinq ans. Les champs PM2.5/PM10 sont demandés comme diagnostics de surface ; les gaz CO/NO2/O3/SO2 sont demandés au niveau modèle le plus bas (niveau 60), conformément à la disponibilité des moyennes mensuelles. Les données sont conservées sur la grille native. Les centres de mailles couverts par les contours de l'Algérie sont retenus ; la moyenne nationale est pondérée par cos(latitude), approximation de la surface des cellules d'une grille longitude/latitude régulière. Les indicateurs annuels pondèrent les moyennes mensuelles par le nombre de jours du mois.

## Limites et interprétation

- CAMS EAC4 est une réanalyse atmosphérique modélisée qui assimile des observations ; ce n'est pas une mesure directe de station, un capteur individuel ou une prévision en temps réel.
- La grille d'environ 80 km est bien plus grossière que la maille ERA5-Land (~9 km) utilisée par le dataset sécheresse. Elle ne permet pas de distinguer les différences entre quartiers, villes proches ou communes.
- Aucune valeur n'est calculée ou annoncée par wilaya. La carte représente les centres de mailles CAMS et non un réseau de stations.
- Les concentrations et rapports de mélange de la réanalyse ne constituent pas un indice AQI réglementaire, une comparaison de conformité à un seuil sanitaire local ou une alerte.
- Une moyenne mensuelle ne décrit ni les pics horaires/journaliers ni l'exposition individuelle. Les émissions désertiques, les conditions météorologiques, la saison et les biais du modèle peuvent influencer les résultats.
- La couverture CAMS EAC4 publiée sur ADS se termine en 2025 ; les révisions et la prochaine année disponible dépendent du calendrier de mise à jour du service.

## Accès ADS et synchronisation

1. Disposer d'un compte Atmosphere Data Store et générer un jeton API personnel sur [la page d'accès API ADS](https://ads.atmosphere.copernicus.eu/how-to-api).
2. Accepter les conditions d'utilisation du jeu CAMS EAC4 monthly averaged fields sur sa page ADS (étape manuelle, une fois par compte).
3. Ajouter le jeton au secret GitHub Actions \`ADS_API_KEY\`. Le workflow accepte également \`CDS_API_KEY\` comme repli si le jeton existant de la sécheresse est également autorisé sur l'ADS.
4. Les secrets \`API_URL\` et \`CLE_SYNCHRO\` existants servent à publier sur data-dz.

L'endpoint du fichier \`~/.cdsapirc\` est \`https://ads.atmosphere.copernicus.eu/api\`. Ne jamais committer ni afficher le jeton.

Le workflow s'exécute deux fois par an et vérifie l'intervalle de 180 jours dans \`/admin/sync\`. Une nouvelle fiche est créée en brouillon ; une fiche existante conserve son statut.

## Sources et attribution

- Copernicus Atmosphere Monitoring Service (CAMS), *CAMS global reanalysis (EAC4) monthly averaged fields*, DOI 10.24381/fd75fff2, licence CC BY 4.0.
- Contient des informations modifiées du Copernicus Atmosphere Monitoring Service (CAMS). Ni la Commission européenne ni l'ECMWF ne sont responsables de l'usage qui pourrait être fait des informations ou données Copernicus contenues dans cette publication.
- Référentiel de contours : GeoAlgeria / data-dz, divisions administratives et wilayas, licence ODbL-1.0 ; utilisé uniquement pour filtrer les centres de mailles.
