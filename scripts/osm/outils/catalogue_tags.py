"""Construit scripts/osm/tags-algerie.md : tous les key=value (>= 30 objets) de l'extrait,
classés en « pris » (déjà dans FLUX), « à étudier » ou « écarté » (bruit cartographique)."""
import re, sys

tsv, categories, sortie, date = sys.argv[1:5]

src = open(categories, encoding="utf-8").read()
pris = {}
for m in re.finditer(r'\{ code: "([^"]+)", slug: "([^"]+)"[^}]*?filtres: \[([^\]]*)\]', src):
    code, slug, filtres = m.groups()
    for f in re.findall(r'"([^"]+)"', filtres):
        cle, valeurs = f.split("/", 1)[1].split("=", 1)
        for v in valeurs.split(","):
            pris[(cle, v)] = slug

# Clés entières sans intérêt comme « établissement ».
CLES_BRUIT = {"landuse", "natural", "waterway", "building", "power", "railway", "sport", "public_transport"}
# Valeurs utiles malgré une clé « bruit ».
GARDER = {
    ("natural", "beach"), ("natural", "spring"), ("natural", "cave_entrance"), ("natural", "peak"),
    ("natural", "wetland"), ("natural", "volcano"), ("power", "plant"), ("power", "substation"),
    ("power", "generator"), ("railway", "station"), ("railway", "halt"), ("railway", "tram_stop"),
    ("waterway", "dam"), ("waterway", "weir"), ("landuse", "cemetery"), ("landuse", "military"),
    ("landuse", "industrial"), ("landuse", "quarry"), ("landuse", "landfill"), ("landuse", "greenhouse_horticulture"),
    ("building", "mosque"), ("building", "hospital"), ("building", "school"), ("building", "university"),
    ("building", "stadium"), ("building", "train_station"), ("building", "church"), ("building", "government"),
    ("public_transport", "station"),
}
BRUIT = {
    "amenity": {"parking", "bench", "waste_basket", "toilets", "drinking_water", "shelter", "parking_space",
                "waste_disposal", "recycling", "fountain", "vending_machine", "bicycle_parking", "motorcycle_parking",
                "parking_entrance", "water_point", "telephone", "clock", "loading_dock", "grave_yard"},
    "man_made": {"pipeline", "tower", "mast", "embankment", "pier", "breakwater", "groyne", "cutline", "chimney",
                 "storage_tank", "silo", "flagpole", "street_cabinet", "survey_point", "bridge", "dyke", "manhole",
                 "utility_pole", "petroleum_well", "pumping_station", "water_tap", "monitoring_station", "clearcut"},
    "leisure": {"pitch", "garden", "playground", "swimming_pool", "track", "picnic_table", "common", "outdoor_seating"},
    "tourism": {"viewpoint", "information", "picnic_site", "artwork", "attraction"},
    "historic": {"memorial", "ruins", "boundary_stone", "milestone", "wayside_shrine", "tomb"},
    "aeroway": {"taxiway", "runway", "apron", "gate", "parking_position", "holding_position", "windsock",
                "navigationaid", "taxilane", "stopway", "hangar", "helipad"},
    "emergency": {"fire_hydrant", "assembly_point", "phone", "defibrillator"},
}

lignes = []
for ligne in open(tsv, encoding="utf-8"):
    parties = ligne.rstrip("\n").split("\t")
    if len(parties) != 3:
        continue
    n, cle, val = int(parties[0]), parties[1].strip('"'), parties[2].strip('"')
    if (cle, val) in pris:
        etat = "pris"
    elif (cle, val) in GARDER:
        etat = "a_etudier"
    elif cle in CLES_BRUIT or val in BRUIT.get(cle, set()) or val in {"yes", "no"}:
        etat = "ecarte"
    else:
        etat = "a_etudier"
    lignes.append((n, cle, val, etat))

def tableau(etat, avec_slug=False):
    out = ["| Tag | Objets |" + (" Donnée |" if avec_slug else ""), "|---|---:|" + ("---|" if avec_slug else "")]
    for n, cle, val, e in lignes:
        if e == etat:
            out.append(f"| `{cle}={val}` | {n:,} |".replace(",", " ") + (f" {pris[(cle, val)]} |" if avec_slug else ""))
    return "\n".join(out)

nb = {e: sum(1 for l in lignes if l[3] == e) for e in ("pris", "a_etudier", "ecarte")}
md = f"""# Tags OpenStreetMap présents en Algérie

Inventaire du {date} : extrait Geofabrik `algeria-latest.osm.pbf`, tous les `clé=valeur` d'au moins 30 objets
pour les clés d'équipements (amenity, shop, office, healthcare, leisure, tourism, man_made, power, historic, craft,
emergency, aeroway, railway, military, government, education, telecom, industrial, landuse, natural, waterway,
building, sport, public_transport). Le nombre compte nœuds + chemins + relations.

Refaire l'inventaire : `osmium tags-count -m 30 -s count-desc -o tags.tsv algeria.osm.pbf 'amenity=*' 'shop=*' …`
puis `python3 scripts/osm/outils/catalogue_tags.py tags.tsv scripts/osm/categories.ts scripts/osm/tags-algerie.md AAAA-MM-JJ`.
Vue en ligne, mise à jour chaque jour : https://taginfo.geofabrik.de/africa:algeria/

- **Pris** ({nb['pris']}) : déjà extraits par un flux de `categories.ts`.
- **À étudier** ({nb['a_etudier']}) : candidats pour un nouveau flux (ajouter une ligne dans `categories.ts`).
- **Écartés** ({nb['ecarte']}) : bruit cartographique (poteaux, arbres, bâtiments sans type, parkings…).

Les tags absents de cette liste (moins de 30 objets ou autre clé) se cherchent sur taginfo.

## Pris
{tableau("pris", True)}

## À étudier
{tableau("a_etudier")}

## Écartés
{tableau("ecarte")}
"""
open(sortie, "w", encoding="utf-8").write(md)
print(nb)
