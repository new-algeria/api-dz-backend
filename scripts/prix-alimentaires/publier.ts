import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientApi, ErreurAppel } from "../osm/api.js";

const CODE="prix-alimentaires";
const SLUG="prix-alimentaires-wilayas";
const FICHIER="prix-alimentaires-wilayas";
const args=process.argv.slice(2);
const option=(nom:string)=>args.includes(nom);
const essai=option("--essai")||process.env.SYNCHRO_ESSAI==="true";
const value=(nom:string)=>{const i=args.indexOf(nom);return i>=0?args[i+1]:undefined};
const cle=process.env.CLE_SYNCHRO?.trim()||null;
const api=new ClientApi((process.env.API_URL?.trim()||"https://api.data-dz.com").replace(/\/+$/,""),cle);
const debut=process.env.SYNCHRO_DEBUT||new Date().toISOString();
const declencheur=process.env.SYNCHRO_FORCER==="true"?"forcer":process.env.GITHUB_EVENT_NAME==="workflow_dispatch"?"manuel":"planifie";
async function rapporter(statut:"reussie"|"echec"|"essai",resume:string,rapport:Record<string,unknown>={}) {
 console.log(`[${statut}] ${resume}`);
 if(cle) await api.rapporter(CODE,{statut,declencheur,debut,fin:new Date().toISOString(),resume,rapport});
}
if(option("--verifier")){
 let aFaire=true,raison="calcul local";
 if(cle&&process.env.SYNCHRO_FORCER!=="true"&&!essai){
  try {const s=await api.lireSynchro(CODE);aFaire=s.a_faire;raison=aFaire?"échéance atteinte":s.actif?`prochain passage le ${s.prochaine_execution}`:"synchronisation désactivée";}
  catch(e){if(e instanceof ErreurAppel&&(e.statut===404||e.statut===503)){aFaire=false;raison="migration SQL absente : aucun lancement automatique";}else throw e;}
 }
 console.log(`${aFaire?"À faire":"Rien à faire"} : ${raison}`);
 if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,`a_faire=${aFaire}\n`);
 process.exit(0);
}
if(option("--echec")){await rapporter("echec",value("--echec")||"Échec de collecte.");process.exit(0);}
const dossier=value("--sortie")||join(import.meta.dirname,"sortie");
const lignes=JSON.parse(await readFile(join(dossier,FICHIER+".json"),"utf8")) as Record<string,unknown>[];
const rapport=JSON.parse(await readFile(join(dossier,"rapport.json"),"utf8")) as {nb_observations:number;wilayas:string[];dates:string[];erreurs:unknown[]};
if(!lignes.length||lignes.length!==rapport.nb_observations) throw new Error("Sortie vide ou incohérente.");
for(const l of lignes){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(l.date_observation))||!/^\d{2}$/.test(String(l.code_wilaya))||!String(l.produit||"").trim()) throw new Error("Observation sans date, code wilaya ou produit.");
 for(const k of ["prix_gros_da","prix_detail_da"]) if(l[k]!==null&&(typeof l[k]!=="number"||!Number.isFinite(l[k])||Number(l[k])<0)) throw new Error(`Prix invalide : ${k}`);
}
const dates=rapport.dates;
const wilayas=rapport.wilayas;
const champs={
 titre:{fr:"Prix des produits alimentaires par wilaya",en:"Food prices by province",ar:"أسعار المواد الغذائية حسب الولاية"},
 description:{fr:"Relevés publics des Directions du commerce de wilaya : prix de gros et de détail en dinars algériens, avec date, produit, unité et source. La couverture est partielle et dépend de la publication de relevés publics ; une wilaya absente ne signifie pas un prix nul.",en:"Public price bulletins from provincial trade directorates: wholesale and retail prices in Algerian dinars, with date, product, unit and source. Coverage is partial and depends on public bulletin availability; a missing province does not mean a zero price.",ar:"كشوف الأسعار المنشورة من مديريات التجارة الولائية، بأسعار الجملة والتجزئة بالدينار الجزائري مع التاريخ والمنتج والوحدة والمصدر. التغطية جزئية حسب توفر النشرات المنشورة."},
 categorie_slug:"economie",
 source_slug:"directions-commerce-wilayas",
 licence_code:null,
 licence_details:"Les pages sources consultées ne précisent pas de licence ouverte de réutilisation. Les données sont reproduites avec attribution et lien vers chaque source ; conditions de réutilisation à confirmer auprès des organismes émetteurs.",
 url_source:"https://www.commerce.gov.dz/fr/observation-des-prix",
 mots_cles:["prix","alimentation","alimentaire","wilaya","inflation","marché","gros","détail","أسعار","غذاء"],
 frequence_maj:"quotidienne",
 infos_source:{wilayas_couvertes:wilayas,nb_wilayas:wilayas.length,dates,nb_observations:lignes.length,couverture:"partielle",sources_en_erreur:rapport.erreurs.length},
 readme:[
 "# Prix des produits alimentaires par wilaya",
 "",
 "Une ligne représente un produit observé dans une wilaya à une date donnée. Les prix sont exprimés en DZD, sans conversion ni normalisation d'unités.",
 "",
 "## Champs",
 "- `date_observation` : date du relevé publiée par la source (pas la date de collecte).",
 "- `code_wilaya`, `wilaya`, `wilaya_ar` : localisation administrative.",
 "- `produit`, `categorie`, `unite` : libellé tel que publié ; les variantes ne sont pas fusionnées.",
 "- `prix_gros_da`, `prix_detail_da` : prix en DZD ; null lorsque la source affiche un tiret ou ne fournit pas le prix.",
 "- `source`, `source_url`, `collecte_le` : traçabilité.",
 "",
 "## Couverture et limites",
 `Couverture initiale : ${wilayas.length} wilaya(s), codes ${wilayas.join(", ")}. Dates observées : ${dates.join(", ")}.`,
 "La plateforme nationale d'observation des prix du ministère du Commerce est annoncée comme accessible via l'intranet MCIRMN ; elle n'est pas utilisée. Les bulletins nationaux du ministère de l'Agriculture ne sont pas ventilés par wilaya et sont exclus.",
 "Une absence de ligne ne vaut jamais zéro et aucune valeur n'est imputée. Les libellés et unités sources sont conservés ; les comparaisons entre unités différentes ne sont pas valides.",
 "",
 "## Sources",
 ...["https://dcwjijel.dz/index.php/moy-prix/prix-journ","https://www.commerce.gov.dz/fr/observation-des-prix"].map(u=>"- "+u),
 "",
 "## Licence",
 "Les sites sources ne précisent pas de licence ouverte dans les pages collectées. Réutilisation à confirmer auprès des organismes émetteurs ; attribution et liens conservés."
 ].join("\n")
};
if(essai||!cle){console.log("Essai : aucune écriture API.");await rapporter("essai",`${lignes.length} observations, ${wilayas.length} wilaya(s).`,{[SLUG]:{nb_observations:lignes.length,wilayas,dates}});process.exit(0);}
const existante=await api.lireDonnee(SLUG);
await api.enregistrerDonnee(SLUG,{...champs,...(existante?{}:{statut:"brouillon"})});
const ancien=existante?await api.lireFichier(SLUG,FICHIER,"json"):null;
if(ancien&&JSON.stringify(JSON.parse(ancien))===JSON.stringify(lignes)){await rapporter("reussie","Données inchangées.",{[SLUG]:{publiee:false,nb_observations:lignes.length}});process.exit(0);}
const [json,csv]=await Promise.all([
 api.envoyerFichier(SLUG,FICHIER,JSON.stringify(lignes),"json"),
 api.envoyerFichier(SLUG,FICHIER,await readFile(join(dossier,FICHIER+".csv"),"utf8"),"csv")
]);
const version=await api.publierVersion(SLUG,{notes:`Relevés publics : ${wilayas.length} wilaya(s), ${lignes.length} observations, dates ${dates.join(", ")}. Couverture partielle.`,fichiers:[{cle:json,nom:FICHIER,format:"json",principal:true},{cle:csv,nom:FICHIER,format:"csv",principal:false}]});
await rapporter("reussie",`Version ${version.numero} : ${lignes.length} observations, ${wilayas.length} wilaya(s).`,{[SLUG]:{publiee:true,version:version.numero,nb_observations:lignes.length,wilayas,dates}});
