# Biodiversité en Algérie — observations et répartition des espèces

Agrégation statistique des occurrences d'espèces publiées dans le réseau GBIF pour l'Algérie (country=DZ). Le pipeline ne télécharge et ne republie pas les fiches individuelles : il utilise les facettes de l'API Occurrence avec limit=0.

## Source, licence et périmètre

- Source : [GBIF — occurrences en Algérie](https://www.gbif.org/occurrence/search?country=DZ).
- API : [GBIF Occurrence API](https://techdocs.gbif.org/en/openapi/).
- Seules les occurrences présentes (occurrenceStatus=PRESENT), munies de coordonnées (hasCoordinate=true), sans anomalie géospatiale (hasGeospatialIssue=false) et sous licence CC0_1_0 ou CC_BY_4_0 sont comptées.
- Les occurrences sous d'autres licences ne sont pas comprises dans ces totaux. Aucun nom d'observateur, identifiant d'occurrence ou jeu de coordonnées précis n'est exporté.
- Attribution : GBIF.org et les éditeurs des jeux de données accessibles via GBIF. Le fichier publié est une synthèse statistique agrégée ; il n'est pas un export des enregistrements GBIF.

## Calcul

Depuis la racine du dépôt :

    npx tsx scripts/biodiversite/calculer.ts --sortie "$RUNNER_TEMP/biodiversite/sortie"

Le calcul :
1. Interroge les facettes globales : règne, année, région déclarée et type d'enregistrement.
2. Relance une requête de comptage par règne pour récupérer la série annuelle de chaque groupe.
3. Vérifie que les comptes par règne et par année ne dépassent pas les totaux GBIF.
4. Calcule explicitement les résidus pour les occurrences sans règne, sans année ou sans région exploitable.
5. Écrit les fichiers JSON et CSV, plus un rapport de requête et une empreinte SHA-256 des réponses.

Les requêtes sont séquentielles et espacées ; le client réessaie en cas de limitation temporaire (HTTP 429) ou d'erreur serveur.

## Fichiers produits

- biodiversite-algerie.json / .csv : série temporelle longue Data-DZ (annee, filiere, valeur, unite), avec le total et les règnes taxonomiques.
- biodiversite-algerie-details.json / .csv : comptages agrégés par règne, année, région déclarée et type d'enregistrement.
- biodiversite-algerie-indicateurs.json / .csv : indicateurs de synthèse et valeurs de couverture.
- rapport.json : date de calcul, filtres, période, nombre d'occurrences, empreinte et métadonnées HTTP.

## Interprétation et limites

- Une occurrence GBIF est un signalement ou un enregistrement biologique, pas une mesure d'abondance de population. Plusieurs occurrences peuvent concerner la même espèce ; le nombre d'occurrences ne correspond donc ni au nombre d'individus ni à la richesse spécifique.
- Les données comprennent des observations, des spécimens conservés, des fossiles et d'autres types d'enregistrements ; le fichier de détail conserve basisOfRecord.
- stateProvince est une valeur textuelle déclarée par le jeu de données source (province, région, wilaya ou autre libellé). Elle n'est pas harmonisée avec les wilayas algériennes, et ses modalités peuvent être incomplètes, multilingues, ou comporter des variantes orthographiques. Il ne faut pas l'interpréter comme un découpage administratif normalisé.
- La facette régionale est limitée aux 200 modalités les plus fréquentes. La ligne résiduelle regroupe les enregistrements sans région et les valeurs non renvoyées par cette facette.
- La couverture géographique et temporelle dépend des éditeurs et des efforts de collecte ; les données sont plus abondantes dans les zones et groupes les mieux observés.
- Les occurrences sans coordonnées, avec anomalie géospatiale, marquées absentes ou sous licences autres que CC0 et CC BY 4.0 sont exclues. Les résultats ne constituent donc pas l'inventaire exhaustif de la biodiversité algérienne.
- La recherche GBIF limite la pagination des fiches individuelles. Ce projet évite cette limite en ne demandant que des comptes et des facettes (limit=0) ; aucun échantillon de 100 000 fiches n'est présenté comme l'ensemble des données.

## Publication

Le script publier.ts suit le client scripts/osm/api.ts :
- --verifier contrôle l'échéance de la synchronisation biodiversite.
- --essai rapporte les statistiques sans écrire de version.
- Une nouvelle fiche est créée en brouillon ; une fiche existante conserve son statut.
- Une version n'est déposée que si les fichiers calculés ont changé.
- Les fichiers JSON et CSV sont stockés sur l'espace de fichiers Data-DZ.

Déclenchement planifié deux fois par mois, avec contrôle de l'intervalle de 15 jours dans /admin/sync. Secrets requis pour publier : API_URL et CLE_SYNCHRO.

## Références

- GBIF, [Occurrence API — documentation technique](https://techdocs.gbif.org/en/openapi/).
- GBIF, [Occurrences observées en Algérie](https://www.gbif.org/occurrence/search?country=DZ).
- GBIF, [Rapport pays Algérie, généré en janvier 2026](https://analytics-files.gbif.org/country/DZ/GBIF_CountryReport_DZ.pdf) — statistiques nationales de mobilisation, qui ne sont pas identiques au périmètre filtré par ce pipeline.
- Licences retenues : [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) et [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
