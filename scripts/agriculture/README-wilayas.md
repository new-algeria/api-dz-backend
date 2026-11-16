# Agriculture par wilaya — extraction Série B 2019

Cette première extraction territoriale porte sur le tableau **Total céréales d'hiver** du rapport officiel Série B 2019 du Ministère de l'Agriculture.

- Source : https://madr.gov.dz/wp-content/uploads/2022/04/SERIE-B-2019.pdf
- Campagne : 2018/2019 (rapport statistique 2019)
- Découpage source : 48 wilayas historiques
- Indicateurs : superficie emblavée, superficie récoltée, taux de récolte, production et rendement.
- Unités : hectares, pourcentage, quintaux, quintaux/hectare.

## Calcul et contrôles

`calculer_wilayas.py` télécharge le PDF officiel (ou accepte `--pdf`), extrait la table par son intitulé, puis exige :
- exactement 48 wilayas reconnues et 48 codes uniques ;
- des valeurs numériques valides ;
- une somme des productions égale au total national publié : **56 259 902 quintaux**.

Le script échoue si l'extraction n'est pas complète ou si le total ne concorde pas. Il produit JSON, CSV et un rapport avec l'empreinte SHA-256 du PDF.

## Limite géographique

Ces observations sont rattachées au découpage de 48 wilayas du rapport. Elles ne sont **pas** redistribuées sur les 69 wilayas actuelles. Les zones des nouvelles wilayas restent sans valeur tant qu'une source officielle ne permet pas une ventilation fiable.

## Lancer

```bash
python -m pip install -r scripts/agriculture/requirements-wilayas.txt
python scripts/agriculture/calculer_wilayas.py --sortie /tmp/agriculture-wilayas
```
