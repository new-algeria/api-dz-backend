// Ce que la synchronisation OpenStreetMap extrait, et où elle le range.
// Ajouter une catégorie = ajouter un flux ici (et, pour une nouvelle donnée, son entrée dans NOUVELLES_DONNEES).
//
// - `filtres` : expressions `osmium tags-filter` (`cle=valeur`, `cle=v1,v2`) ; un objet qui en vérifie une est pris.
// - `exige` : conditions en plus, vérifiées ensuite (valeur exacte, ou l'une des valeurs d'une liste « a;b »).
// - `slug` : donnée cible. Si sa source est OpenStreetMap, ce fichier en est le fichier principal ;
//   sinon (donnée GeoAlgeria…) c'est un fichier « complément OpenStreetMap » proposé à côté.
// - `fichier` : nom du fichier dans la donnée (unique dans la donnée).
// - `rayon_m` : distance sous laquelle un objet est rapproché d'un objet GeoAlgeria au nom proche.

export interface Flux {
  code: string;
  slug: string;
  fichier: string;
  filtres: string[];
  exige?: Record<string, string[]>;
  rayon_m?: number;
}

export interface NouvelleDonnee {
  slug: string;
  categorie_slug: string;
  titre: { fr: string; en: string; ar: string };
  description: { fr: string; en: string; ar: string };
  mots_cles: string[];
}

export const FLUX: Flux[] = [
  // ------------------------------------------------ Données OpenStreetMap existantes (fichier principal)
  { code: "stations-service", slug: "gas-stations", fichier: "gas_station", filtres: ["nwr/amenity=fuel"] },
  { code: "barrages", slug: "dams", fichier: "waterway_dam", filtres: ["nwr/waterway=dam"], rayon_m: 1000 },
  { code: "plages", slug: "plages", fichier: "beaches", filtres: ["nwr/natural=beach"], rayon_m: 500 },
  { code: "bibliotheques", slug: "bibliotheques", fichier: "libraries", filtres: ["nwr/amenity=library"] },
  { code: "terrains-football", slug: "terrains-de-football", fichier: "football_fields", filtres: ["nwr/leisure=pitch"], exige: { sport: ["soccer"] } },

  // ------------------------------------------------ Compléments OpenStreetMap de données GeoAlgeria
  { code: "hopitaux", slug: "sante", fichier: "hospitals-osm", filtres: ["nwr/amenity=hospital", "nwr/healthcare=hospital"], rayon_m: 300 },
  { code: "cliniques", slug: "cliniques", fichier: "clinics-osm", filtres: ["nwr/amenity=clinic", "nwr/healthcare=clinic"] },
  { code: "pharmacies", slug: "pharmacies", fichier: "pharmacies-osm", filtres: ["nwr/amenity=pharmacy", "nwr/healthcare=pharmacy"] },
  { code: "ecoles", slug: "ecoles", fichier: "schools-osm", filtres: ["nwr/amenity=school"] },
  { code: "universites", slug: "enseignement-superieur", fichier: "universities-osm", filtres: ["nwr/amenity=university,college"], rayon_m: 500 },
  { code: "banques", slug: "banques", fichier: "banks-osm", filtres: ["nwr/amenity=bank"] },
  { code: "distributeurs", slug: "banques", fichier: "atms-osm", filtres: ["nwr/amenity=atm"], rayon_m: 50 },
  { code: "mosquees", slug: "mosquees", fichier: "mosques-osm", filtres: ["nwr/amenity=place_of_worship"], exige: { religion: ["muslim"] } },
  { code: "gares-routieres", slug: "gares-routieres", fichier: "bus-stations-osm", filtres: ["nwr/amenity=bus_station"], rayon_m: 300 },
  { code: "gares", slug: "ferroviaire", fichier: "train-stations-osm", filtres: ["nwr/railway=station,halt"], rayon_m: 300 },
  { code: "aerodromes", slug: "aviation", fichier: "aerodromes-osm", filtres: ["nwr/aeroway=aerodrome"], rayon_m: 3000 },
  { code: "hebergements", slug: "tourisme", fichier: "lodging-osm", filtres: ["nwr/tourism=hotel,motel,guest_house,hostel"] },
  { code: "lieux-culturels", slug: "culture", fichier: "cultural-venues-osm", filtres: ["nwr/tourism=museum", "nwr/amenity=cinema,theatre,arts_centre"] },
  { code: "equipements-sportifs", slug: "sports", fichier: "sports-facilities-osm", filtres: ["nwr/leisure=stadium,sports_centre"], rayon_m: 300 },

  // ------------------------------------------------ Nouvelles données (créées au premier passage, voir NOUVELLES_DONNEES)
  { code: "mairies", slug: "town-halls", fichier: "town_halls", filtres: ["nwr/amenity=townhall"] },
  { code: "police", slug: "police-stations", fichier: "police_stations", filtres: ["nwr/amenity=police"] },
  { code: "tribunaux", slug: "courthouses", fichier: "courthouses", filtres: ["nwr/amenity=courthouse"] },
  { code: "administrations", slug: "government-offices", fichier: "government_offices", filtres: ["nwr/office=government"] },
  { code: "medecins", slug: "medical-practices", fichier: "doctors", filtres: ["nwr/amenity=doctors"] },
  { code: "dentistes", slug: "medical-practices", fichier: "dentists", filtres: ["nwr/amenity=dentist", "nwr/healthcare=dentist"] },
  { code: "laboratoires", slug: "medical-practices", fichier: "laboratories", filtres: ["nwr/healthcare=laboratory"] },
  { code: "creches", slug: "kindergartens", fichier: "kindergartens", filtres: ["nwr/amenity=kindergarten"] },
  { code: "marches", slug: "markets-supermarkets", fichier: "marketplaces", filtres: ["nwr/amenity=marketplace"], rayon_m: 200 },
  { code: "supermarches", slug: "markets-supermarkets", fichier: "supermarkets", filtres: ["nwr/shop=supermarket"] },
  { code: "parcs", slug: "parks", fichier: "parks", filtres: ["nwr/leisure=park"], rayon_m: 300 },
  { code: "chateaux-eau", slug: "water-towers", fichier: "water_towers", filtres: ["nwr/man_made=water_tower"] },
  { code: "centrales", slug: "power-plants", fichier: "power_plants", filtres: ["nwr/power=plant"], rayon_m: 2000 },
  { code: "ports", slug: "ports-marinas", fichier: "ports", filtres: ["nwr/harbour=yes", "nwr/leisure=marina", "nwr/landuse=port"], rayon_m: 2000 },
];

/** Ordre des fichiers dans une donnée : le premier flux d'une donnée OpenStreetMap en est le fichier principal. */
export const fluxDe = (slug: string) => FLUX.filter((flux) => flux.slug === slug);

const ODBL =
  "\n\nDonnées © contributeurs OpenStreetMap, sous licence ODbL 1.0 (https://www.openstreetmap.org/copyright). " +
  "Extraites chaque mois de l'extrait Geofabrik de l'Algérie ; les objets disparus d'OpenStreetMap sont gardés et signalés (`osm_absent_depuis`).";

export const NOUVELLES_DONNEES: NouvelleDonnee[] = [
  {
    slug: "town-halls",
    categorie_slug: "administratif",
    titre: { fr: "Sièges d'APC (mairies) d'Algérie", en: "Algeria town halls (APC)", ar: "مقرات البلديات في الجزائر" },
    description: {
      fr: "Sièges des assemblées populaires communales (mairies) cartographiés dans OpenStreetMap : nom, adresse, coordonnées." + ODBL,
      en: "Communal people's assembly (APC) town halls mapped in OpenStreetMap: name, address, coordinates.",
      ar: "مقرات المجالس الشعبية البلدية كما هي في خريطة الشارع المفتوحة: الاسم والعنوان والإحداثيات.",
    },
    mots_cles: ["apc", "mairie", "commune", "bladiya", "administration"],
  },
  {
    slug: "police-stations",
    categorie_slug: "securite",
    titre: { fr: "Commissariats et gendarmeries d'Algérie", en: "Algeria police and gendarmerie stations", ar: "مراكز الشرطة والدرك في الجزائر" },
    description: {
      fr: "Commissariats de police (DGSN) et brigades de gendarmerie cartographiés dans OpenStreetMap." + ODBL,
      en: "Police stations (DGSN) and gendarmerie posts mapped in OpenStreetMap.",
      ar: "مراكز الشرطة وفرق الدرك الوطني كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["police", "gendarmerie", "commissariat", "securite", "dgsn"],
  },
  {
    slug: "courthouses",
    categorie_slug: "administratif",
    titre: { fr: "Tribunaux et cours d'Algérie", en: "Algeria courthouses", ar: "المحاكم والمجالس القضائية في الجزائر" },
    description: {
      fr: "Tribunaux, cours et juridictions cartographiés dans OpenStreetMap." + ODBL,
      en: "Courts and courthouses mapped in OpenStreetMap.",
      ar: "المحاكم والمجالس القضائية كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["tribunal", "justice", "cour", "juridiction"],
  },
  {
    slug: "government-offices",
    categorie_slug: "administratif",
    titre: { fr: "Administrations publiques d'Algérie", en: "Algeria government offices", ar: "الإدارات العمومية في الجزائر" },
    description: {
      fr: "Wilayas, daïras, directions et services de l'État cartographiés dans OpenStreetMap (office=government)." + ODBL,
      en: "Wilaya and daira headquarters, directorates and state offices mapped in OpenStreetMap (office=government).",
      ar: "مقرات الولايات والدوائر والمديريات ومصالح الدولة كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["administration", "wilaya", "daira", "direction", "service public"],
  },
  {
    slug: "medical-practices",
    categorie_slug: "sante",
    titre: { fr: "Cabinets médicaux, dentaires et laboratoires", en: "Doctors, dentists and laboratories", ar: "العيادات الطبية وطب الأسنان والمخابر" },
    description: {
      fr: "Cabinets de médecins, de dentistes et laboratoires d'analyses cartographiés dans OpenStreetMap (un fichier par type)." + ODBL,
      en: "Doctors' and dentists' practices and medical laboratories mapped in OpenStreetMap (one file per type).",
      ar: "عيادات الأطباء وأطباء الأسنان ومخابر التحاليل كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["medecin", "dentiste", "laboratoire", "cabinet", "sante"],
  },
  {
    slug: "kindergartens",
    categorie_slug: "education",
    titre: { fr: "Crèches et jardins d'enfants d'Algérie", en: "Algeria kindergartens", ar: "دور الحضانة ورياض الأطفال في الجزائر" },
    description: {
      fr: "Crèches et jardins d'enfants cartographiés dans OpenStreetMap." + ODBL,
      en: "Nurseries and kindergartens mapped in OpenStreetMap.",
      ar: "دور الحضانة ورياض الأطفال كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["creche", "jardin d'enfants", "prescolaire", "petite enfance"],
  },
  {
    slug: "markets-supermarkets",
    categorie_slug: "services",
    titre: { fr: "Marchés et supérettes d'Algérie", en: "Algeria markets and supermarkets", ar: "الأسواق والمساحات التجارية في الجزائر" },
    description: {
      fr: "Marchés couverts et de plein air, supermarchés et supérettes cartographiés dans OpenStreetMap (un fichier par type)." + ODBL,
      en: "Covered and open-air markets, supermarkets mapped in OpenStreetMap (one file per type).",
      ar: "الأسواق المغطاة والمفتوحة والمساحات التجارية كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["marche", "souk", "supermarche", "superette", "commerce"],
  },
  {
    slug: "parks",
    categorie_slug: "environnement",
    titre: { fr: "Parcs et jardins publics d'Algérie", en: "Algeria parks and public gardens", ar: "الحدائق والمنتزهات العمومية في الجزائر" },
    description: {
      fr: "Parcs, jardins publics et espaces verts cartographiés dans OpenStreetMap (leisure=park)." + ODBL,
      en: "Parks, public gardens and green spaces mapped in OpenStreetMap (leisure=park).",
      ar: "الحدائق والمنتزهات والمساحات الخضراء كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["parc", "jardin", "espace vert", "loisirs"],
  },
  {
    slug: "water-towers",
    categorie_slug: "energie",
    titre: { fr: "Châteaux d'eau d'Algérie", en: "Algeria water towers", ar: "خزانات المياه في الجزائر" },
    description: {
      fr: "Châteaux d'eau et réservoirs surélevés cartographiés dans OpenStreetMap." + ODBL,
      en: "Water towers and elevated reservoirs mapped in OpenStreetMap.",
      ar: "خزانات المياه المرتفعة كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["chateau d'eau", "eau", "reservoir", "ade"],
  },
  {
    slug: "power-plants",
    categorie_slug: "energie",
    titre: { fr: "Centrales électriques d'Algérie", en: "Algeria power plants", ar: "محطات توليد الكهرباء في الجزائر" },
    description: {
      fr: "Centrales thermiques, solaires et autres sites de production d'électricité cartographiés dans OpenStreetMap (power=plant)." + ODBL,
      en: "Thermal, solar and other power plants mapped in OpenStreetMap (power=plant).",
      ar: "محطات توليد الكهرباء الحرارية والشمسية وغيرها كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["centrale", "electricite", "solaire", "sonelgaz", "energie"],
  },
  {
    slug: "ports-marinas",
    categorie_slug: "transport",
    titre: { fr: "Ports et marinas d'Algérie", en: "Algeria ports and marinas", ar: "الموانئ والمرافئ في الجزائر" },
    description: {
      fr: "Ports de commerce, de pêche et de plaisance cartographiés dans OpenStreetMap." + ODBL,
      en: "Commercial, fishing ports and marinas mapped in OpenStreetMap.",
      ar: "موانئ التجارة والصيد والنزهة كما هي في خريطة الشارع المفتوحة.",
    },
    mots_cles: ["port", "marina", "peche", "maritime"],
  },
];
