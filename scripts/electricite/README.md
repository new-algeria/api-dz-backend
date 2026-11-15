# Électricité en Algérie — Ember Yearly Electricity Data

Extraction du fichier mondial annuel d'Ember pour le code pays ISO 3166-1 alpha-3 `DZA`.

## Source et licence

- Source : Ember, [Yearly Electricity Data](https://ember-energy.org/data/yearly-electricity-data/).
- Fichier : [CSV global](https://files.ember-energy.org/public-downloads/generation/outputs/release_generation_yearly_global.csv).
- Licence : [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
- Crédit : « Ember, Yearly Electricity Data ».
- Ember indique que le fichier annuel est actualisé deux fois par mois. La dernière année disponible dépend toutefois du pays ; le script détecte la couverture algérienne réelle au lieu de supposer que toutes les années mondiales sont présentes.

## Calcul

Depuis la racine du dépôt :

```bash
npx tsx scripts/electricite/calculer.ts \
  --cache "$RUNNER_TEMP/electricite/cache" \
  --sortie "$RUNNER_TEMP/electricite/sortie"
```

Options :
- `--cache DOSSIER` : CSV Ember téléchargé et métadonnées HTTP.
- `--sortie DOSSIER` : fichiers normalisés (défaut `scripts/electricite/sortie/`).
- `--sans-cache` : télécharge une nouvelle version, même si un fichier est en cache.

Sorties :
- `electricite-algerie.json` / `.csv` : une ligne par année et par source/agrégat Ember.
- `electricite-algerie-indicateurs.json` / `.csv` : une ligne par année, indicateurs de production, demande, échanges, capacité et émissions.
- `rapport.json` : période détectée, empreinte SHA-256, ETag / date HTTP, effectifs et contrôle historique 2024.

Les colonnes du fichier principal sont en français et en `snake_case`. Les libellés des sources énergétiques restent ceux d'Ember pour préserver le vocabulaire du producteur.

## Contrôles

- Schéma CSV et colonnes nécessaires vérifiés.
- Filtre strict sur `ISO 3 code = DZA`.
- Une ligne au plus par année et par source électrique ; années et valeurs numériques contrôlées.
- L'année 2000 et les données de référence 2024 doivent être présentes.
- Contrôle anti-erreur de pays/unité pour 2024 : production totale proche de 96,36 TWh et demande proche de 93,84 TWh (tolérance de révision documentée dans le code).
- Les valeurs non publiées restent `null`, jamais zéro.

## Interprétation et limites

- Il s'agit de séries **annuelles nationales**. Pas de ventilation par wilaya, ni de données horaires, de puissance de pointe, de coupures ou de consommation individuelle.
- La ligne `Demand` est la demande telle que définie et publiée par Ember ; elle ne doit pas être assimilée sans précaution aux seules ventes facturées aux ménages.
- `Capacity (GW)` est une capacité de puissance installée, distincte de l'énergie produite en TWh.
- Les agrégats `Clean`, `Fossil`, `Renewables` et `Total generation` peuvent recouper les sources élémentaires. Le champ `source_agregee` permet de les exclure des sommes de filières.
- Les dernières années peuvent être provisoires ou estimées selon la méthodologie d'Ember. Les données mondiales n'ont pas toutes la même couverture temporelle ; seule la période réellement disponible pour DZA est conservée.
- Les valeurs d'émissions et d'intensité sont reprises selon les définitions Ember ; elles ne sont pas recalculées localement.

## Publication

Le script `publier.ts` utilise le client `scripts/osm/api.ts` :
- `--verifier` lit l'échéance `electricite` dans `synchronisations`.
- `--essai` calcule les métadonnées et rapporte l'exécution sans publier.
- Une nouvelle fiche est créée en brouillon ; une fiche existante conserve son statut.
- Une version n'est créée que si l'un des deux fichiers JSON a changé.
- Les fichiers sources sont déposés en JSON et CSV sur R2.

La synchronisation est déclenchée deux fois par mois, mais respecte l'intervalle de la ligne `electricite` dans `/admin/sync`. Secrets nécessaires à la publication : `API_URL` et `CLE_SYNCHRO`.

## Références

- Ember, [Yearly Electricity Data](https://ember-energy.org/data/yearly-electricity-data/), CC BY 4.0.
- [Fichier mondial CSV](https://files.ember-energy.org/public-downloads/generation/outputs/release_generation_yearly_global.csv).
- [Méthodologie Ember](https://files.ember-energy.org/public-downloads/ember_electricity_data_methodology.pdf).
- Contrôles 2024 publiés : [World Power Monitor — Algeria](https://worldpowermonitor.com/countries/algeria/history/) et [IndexBox — Electricity demand / generation](https://app.indexbox.io/indicators/symbol/electricity-demand-algeria/).
