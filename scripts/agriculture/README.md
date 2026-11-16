# Agriculture en Algérie — production végétale et animale

Séries nationales annuelles FAOSTAT pour l'Algérie, extraites du domaine QCL « Crops and livestock products ».

## Source et méthode

- Source : https://www.fao.org/faostat/en/#data/QCL
- Téléchargement public : https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_All_Data_(Normalized).zip
- Domaine : QCL — cultures et produits de l'élevage.
- Filtre : Area = Algeria.
- Le CSV normalisé conserve une ligne par année, produit, élément et unité.
- Les indicateurs FAOSTAT sont conservés tels quels : production, superficie récoltée, rendement et autres éléments disponibles dans le domaine.
- Les unités et les indicateurs ne sont jamais additionnés entre produits ou catégories incompatibles.
- Les codes et descriptions de qualité FAOSTAT sont conservés.

## Fichiers

- agriculture-algerie-series.json/.csv : observations nationales par année, produit, indicateur, valeur, unité et qualité source.
- agriculture-algerie-indicateurs.json/.csv : période couverte, nombre d'observations, produits et types d'indicateurs.
- agriculture-algerie-qualite.json/.csv : décompte des observations par code et description de qualité.
- rapport.json : source, filtre, période et empreinte SHA-256 de l'archive.

## Limites géographiques et temporelles

Ce pipeline publie uniquement les séries nationales FAOSTAT. Il ne répartit pas les chiffres par wilaya. Pour une couche territoriale, les publications Série A/B du ministère de l'Agriculture et l'enquête communale ONS devront être collectées et validées séparément ; aucune valeur nationale n'est ventilée artificiellement.

Les années et la disponibilité des produits varient selon l'indicateur. Une absence de valeur ne signifie pas une production nulle. Les données peuvent être révisées par FAOSTAT entre deux synchronisations.

## Licence et attribution

FAOSTAT — FAO. Licence CC BY 4.0 IGO, sous réserve des mentions d'attribution applicables à la base et à ses métadonnées. Consulter les conditions affichées par FAOSTAT avant toute réutilisation.
