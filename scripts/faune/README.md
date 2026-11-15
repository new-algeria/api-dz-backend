# Faune d'Algérie — catalogue GBIF agrégé

Catalogue des espèces animales identifiées dans les occurrences GBIF pour l'Algérie (country=DZ).

## Source et extraction

- Source : https://www.gbif.org/occurrence/search?country=DZ
- API : https://techdocs.gbif.org/en/data-use/api-downloads
- Format : Darwin Core Archive (DWCA), téléchargement asynchrone authentifié.
- Taxonomie : Catalogue of Life Extended Release (checklistKey=7ddf754f-d193-4cc9-b351-99906754a03b).
- Filtres : pays DZ, occurrenceStatus=PRESENT, licences CC0_1_0 et CC_BY_4_0.
- Les coordonnées ne sont pas obligatoires pour le catalogue des espèces. Les champs géographiques ne servent qu'aux statistiques agrégées de répartition.

Le téléchargement GBIF nécessite un compte personnel et les secrets GitHub GBIF_USERNAME, GBIF_PASSWORD et GBIF_EMAIL. Le DOI du téléchargement est enregistré dans rapport.json et dans les métadonnées du dataset.

## Fichiers produits

- faune-algerie-especes.json/.csv : une ligne par espèce GBIF, taxonomie, statut IUCN transmis par GBIF, occurrences fossiles et non fossiles, types de preuve, indicateur « fossile uniquement », première/dernière année et régions GADM.
- faune-algerie-regions.json/.csv : nombre d'occurrences géolocalisées et nombre d'espèces/familles distinctes par région GADM de niveau 1.
- faune-algerie-conservation.json/.csv : nombre d'espèces par catégorie IUCN.
- faune-algerie-historique.json/.csv : occurrences et espèces distinctes par année et type d'enregistrement.
- faune-algerie-sources.json/.csv : principaux jeux de données contributeurs.
- faune-algerie-indicateurs.json/.csv : chiffres de couverture.
- faune-algerie-qualite.json/.csv : contrôles de complétude.
- rapport.json : téléchargement, DOI, filtres et empreinte SHA-256.

## Interprétation et limites

- Les occurrences de type `FOSSIL_SPECIMEN` sont identifiées séparément. Une espèce avec uniquement ces occurrences est marquée `fossile_uniquement=true` ; cela ne doit pas être interprété comme une observation actuelle.

- Une occurrence GBIF est un enregistrement de présence, pas un nombre d'animaux. Le dataset n'est pas une estimation de population ou de tendance démographique.
- Seules les occurrences dont GBIF fournit une clé et un nom d'espèce alimentent le catalogue taxonomique ; les enregistrements moins précis restent visibles dans les indicateurs de qualité.
- Les catégories IUCN sont celles présentes dans les champs interprétés par GBIF. Elles peuvent être absentes ou contradictoires entre occurrences ; un conflit est affiché comme MULTIPLE.
- Les répartitions sont établies à partir des régions GADM de niveau 1 fournies dans le DWCA. Ce référentiel n'est pas garanti comme équivalent aux 69 wilayas administratives actuelles.
- Les coordonnées exactes, localités détaillées, identifiants d'occurrence et noms d'observateurs ne sont jamais exportés.
- L'historique des signalements dépend de l'effort d'observation, de la numérisation des collections et des jeux de données versés. Un pic ou une baisse ne démontre pas une évolution de population.
- Le pipeline ne conserve que les licences CC0 et CC BY 4.0, afin de pouvoir publier la synthèse sous CC BY 4.0. Les autres licences sont exclues.
- L'inventaire est un sous-ensemble de la biodiversité algérienne mobilisée par GBIF ; l'absence de signalement n'implique pas l'absence d'une espèce.

## Synchronisation

Workflow : .github/workflows/faune-sync.yml.

1. Créer un compte GBIF et ajouter son nom d'utilisateur (pas l'adresse e-mail) dans le secret GBIF_USERNAME.
2. Ajouter GBIF_PASSWORD et GBIF_EMAIL dans les secrets du dépôt.
3. Conserver les secrets Data-DZ existants API_URL et CLE_SYNCHRO.
4. Première exécution : Actions → Synchro faune algérienne → Run workflow, essai=true, forcer=true.
5. Après vérification de l'artefact et du rapport : relancer avec essai=false, forcer=true.

L'essai télécharge et calcule les agrégats, mais ne crée ni ne met à jour de version Data-DZ.

## Attribution

GBIF exige de citer le DOI de chaque téléchargement et les éditeurs des jeux de données contributeurs. Le DOI et la citation retournés par GBIF sont consignés dans rapport.json. La source publiée est une synthèse agrégée sous CC BY 4.0, issue des occurrences source CC0 et CC BY 4.0.
