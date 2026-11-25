# Synchronisation du commerce extérieur (BACI, CEPII)

Publie la donnée `commerce-exterieur-algerie` : exportations et importations de biens de l'Algérie depuis 1995, par
partenaire, par produit (SH à 6 chiffres) et par section du Système harmonisé, d'après la base BACI du CEPII.

- **Source** : `https://www.cepii.fr/DATA_DOWNLOAD/baci/data/BACI_HS92_V<version>.zip` (environ 2,4 Go, un CSV par
  année `t,i,j,k,v,q` : année, exportateur, importateur, produit, valeur en milliers de dollars, quantité en tonnes),
  sans compte. La version (`V202601`…) est lue sur la page de BACI (`versionDepuisPage()`).
- **Licence** : Licence Ouverte Etalab 2.0 (indiquée sur la page de BACI), citer le CEPII (Gaulier et Zignago, 2010).
- **Synchronisation** : ligne `commerce-exterieur` de `synchronisations` (mode `interne`, 30 jours), migration data-dz
  `20261129000038_synchro_commerce_exterieur_baci.sql`. Workflow `.github/workflows/commerce-exterieur-sync.yml`
  (chaque dimanche, délai 60 min). L'étape « Échéance » (`publier.ts --verifier`) compare la version annoncée par le
  CEPII à `infos_source.version_baci` de la donnée en ligne : l'archive n'est téléchargée qu'en cas de nouvelle version
  (une par an, en général en janvier) ou si « forcer ». Le contrôle des PR ne tourne que si ce robot change.

## Fichiers publiés

- `echanges-annuels` (principal) : format long `annee`, `indicateur`, `valeur`, `unite` (milliards de dollars) :
  exportations, importations, solde, exportations d'hydrocarbures (chapitre 27) et hors hydrocarbures, importations
  alimentaires (sections I à IV).
- `echanges-par-section` : 21 sections du SH, noms français (`SECTIONS`), valeur et part.
- `partenaires` : tous les partenaires, chaque année et dans chaque sens, noms français et arabes tirés du code ISO
  (`Intl.DisplayNames`), anglais de BACI en secours.
- `produits-principaux` : 50 premiers produits par année et par sens ; noms français des produits fréquents dans
  `PRODUITS_FR`, sinon la description anglaise de BACI.

## À savoir

Données miroir réconciliées (UN Comtrade) : l'Algérie déclare peu, ses flux viennent souvent des déclarations de ses
partenaires. Valeurs FAB, biens seulement : elles diffèrent des chiffres des Douanes algériennes (importations CAF).

## Lancer en local

```bash
npx tsx scripts/commerce-exterieur/calculer.ts --sortie /tmp/baci            # télécharge l'archive (2,4 Go)
npx tsx scripts/commerce-exterieur/calculer.ts --archive BACI_HS92_V202601.zip --sortie /tmp/baci
npx tsx scripts/commerce-exterieur/publier.ts --essai --sortie /tmp/baci
```
