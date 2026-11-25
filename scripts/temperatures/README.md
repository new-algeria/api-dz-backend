# Températures et chaleur par wilaya — NASA POWER

Donnée `temperatures-wilayas` : températures quotidiennes estimées depuis 1981 au chef-lieu des 69 wilayas, et leurs
synthèses mensuelles, annuelles et nationales (moyennes, records, jours ≥ 35 °C et ≥ 40 °C, nuits ≥ 20 °C, écart à
la normale 1991–2020).

## Source et licence
- NASA Langley Research Center (LaRC), [POWER Project](https://power.larc.nasa.gov/), API
  [daily point](https://power.larc.nasa.gov/docs/services/api/temporal/daily/) : température à 2 m (`T2M_MAX`,
  `T2M_MIN`, `T2M`), réanalyse MERRA-2 puis GEOS-IT pour les jours récents, valeur absente `-999`.
- Données ouvertes de la NASA, sans clé ni restriction de réutilisation. Citation demandée : « These data were obtained
  from the NASA Langley Research Center (LaRC) POWER Project funded through the NASA Earth Science/Applied Science
  Program. » Publiée sous `CC0-1.0`, comme les autres données de la NASA (FIRMS).
- Points de mesure : fichiers `wilayas` (chef-lieu `capital_commune_code`) et `postoffices` de la donnée data-dz
  `divisions-administratives` (GeoAlgeria par Yasser's studio).
- Open-Meteo a été écarté : son offre gratuite est limitée par adresse IP et les machines partagées (GitHub Actions)
  atteignent vite la limite quotidienne.

## Calcul
Node.js 22, sans clé :

    npx tsx scripts/temperatures/calculer.ts --cache /tmp/temperatures/cache --sortie /tmp/temperatures/sortie
    npx tsx scripts/temperatures/publier.ts --essai --sortie /tmp/temperatures/sortie

1. **Points** (`choisirPoints()`) : bureau de poste principal de la commune chef-lieu (nom en « RP » ou code postal en
   « 000 »), sinon médiane des bureaux de cette commune (wilayas 49 à 69 aujourd'hui).
2. **Séries** (`lirePower()`) : un appel NASA POWER par wilaya (1981 → aujourd'hui, environ 1,5 s chacun, 0,5 s de pause
   entre deux, 4 essais avec attente croissante). Les jours encore absents en fin de série sont retirés ; une température
   hors de [-30, 60] °C arrête le calcul.
3. **Synthèses** (`agreger()`) : un mois ou une année n'est synthétisé que si 95 % de ses jours ont une maximale ; normale
   1991–2020 calculée si 27 années au moins sont complètes ; synthèse nationale seulement pour les années complètes dans
   les 69 wilayas.
4. **Contrôles** (`verifier()`) : 69 points, chaque série commence le 1981-01-01, au moins 40 années nationales.

Fonctions pures testées dans `test/temperatures.test.ts`.

## Fichiers publiés
- `temperatures-annuelles` (**principal**, JSON et CSV) : `code_wilaya`, `wilaya`, `annee`, `tmoy`, `tmax_moy`,
  `tmin_moy`, `tmax_record`, `jours_35`, `jours_40`, `nuits_20`, `ecart_normale`. Colonnes code + nom + année + mesures :
  la fiche affiche une carte des wilayas colorée avec sélecteurs d'année et de mesure.
- `temperatures-mensuelles` (JSON et CSV) : les mêmes mesures par mois (`mois`).
- `synthese-nationale` (JSON et CSV) : moyenne des 69 chefs-lieux, écart moyen, jours à 40 °C cumulés, wilayas avec au
  moins un jour à 40 °C, record de l'année.
- `points-de-mesure` (JSON et CSV) : chef-lieu, coordonnées, méthode.
- `temperatures-journalieres` (**CSV seulement**, environ 1,16 million de lignes, 36 Mo) : `tmax`, `tmin`, `tmoy` par jour.

## Limites
- **Estimations de réanalyse, pas des relevés de stations** : maille d'environ 50 km, extrêmes lissés, surtout sur la
  côte (maille terre-mer). Toujours parler de températures « estimées ».
- Un point par wilaya (le chef-lieu) : il ne représente pas toute la wilaya, surtout dans le Sud.
- Les jours récents peuvent être révisés.

## Publication
`publier.ts` crée la donnée en brouillon (catégorie `environnement`, source `nasa-power`, licence `CC0-1.0`), ne publie une
version que si les fichiers annuel ou mensuel ont changé, et rapporte à `/admin/sync` (synchronisation `temperatures`,
migration data-dz `20261125000033`). Workflow : `.github/workflows/temperatures-sync.yml`, chaque mardi.
