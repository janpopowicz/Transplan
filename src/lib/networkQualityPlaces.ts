import type { Coord } from "../types";

export interface QualityPlace {
  id: string;
  name: string;
  category: string;
  weight: number;
  note?: string;
  points: { name: string; coord: Coord; source: string }[];
}

/** Catalog based on miejsca.txt. Coordinates: OSM via Photon, retrieved 2026-11-04.
 * These are representative points, not surveyed entrances. Review with the KMZ.
 * Weights: ordinary = 1, important = 2, very important = 3; anchors share a weight.
 * © OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright
 * Bump this version whenever coordinates, weights or membership change.
 */
export const NETWORK_QUALITY_CATALOG_VERSION = "2026-11-04.v2";
export const NETWORK_QUALITY_PLACES: readonly QualityPlace[] = [
  {
    id: "poi-01", name: "Galeria Bonarka", category: "Galerie handlowe", weight: 3,
    points: [
      { name: "Bonarka City Center", coord: [19.9507208, 50.0279769],
        source: "https://www.openstreetmap.org/way/48306888" },
    ],
  },
  {
    id: "poi-02", name: "Galeria Krakowska", category: "Galerie handlowe", weight: 3,
    points: [
      { name: "Galeria Krakowska", coord: [19.9461443, 50.0676545],
        source: "https://www.openstreetmap.org/way/87527970" },
    ],
  },
  {
    id: "poi-03", name: "Galeria Kazimierz", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "Galeria Kazimierz", coord: [19.9560442, 50.0534938],
        source: "https://www.openstreetmap.org/way/1042023157" },
    ],
  },
  {
    id: "poi-04", name: "Serenada", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "Centrum Serenada", coord: [19.9856889, 50.0880157],
        source: "https://www.openstreetmap.org/way/294702945" },
    ],
  },
  {
    id: "poi-05", name: "Galeria Bronowice", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "Galeria Bronowice", coord: [19.8982842, 50.0920871],
        source: "https://www.openstreetmap.org/way/212501809" },
    ],
  },
  {
    id: "poi-06", name: "M1", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "M1 Kraków", coord: [19.9997557, 50.0644278],
        source: "https://www.openstreetmap.org/relation/8786154" },
    ],
  },
  {
    id: "poi-07", name: "Park Handlowy Zakopianka", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "Park Handlowy Zakopianka", coord: [19.9318454, 50.0155503],
        source: "https://www.openstreetmap.org/way/155048674" },
    ],
  },
  {
    id: "poi-08", name: "CH Nowe Czyżyny", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "Centrum Nowe Czyżyny", coord: [20.0164164, 50.0771915],
        source: "https://www.openstreetmap.org/way/179465887" },
    ],
  },
  {
    id: "poi-09", name: "Factory / Futura Park w Modlniczce", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "Futura Park Kraków", coord: [19.8457974, 50.1095946],
        source: "https://www.openstreetmap.org/way/127376668" },
    ],
    note: "Factory / Futura Park w Modlniczce to ten sam kompleks; jeden punkt i jedna waga. Futura z wpisu „Ikea i galeria Futura” nie jest liczona drugi raz.",
  },
  {
    id: "poi-10", name: "CH Krokus", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "CH Krokus", coord: [19.9836676, 50.0875532],
        source: "https://www.openstreetmap.org/way/25486688" },
    ],
  },
  {
    id: "poi-11", name: "IKEA Kraków", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "IKEA", coord: [19.8975635, 50.0894806],
        source: "https://www.openstreetmap.org/way/231346739" },
    ],
    note: "IKEA przy ul. Conrada. Futura jest ujęta osobno razem z Factory w Modlniczce.",
  },
  {
    id: "poi-12", name: "Solvay Park", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "Solvay Park", coord: [19.9275472, 50.0141843],
        source: "https://www.openstreetmap.org/way/128241895" },
    ],
  },
  {
    id: "poi-13", name: "Mozaika", category: "Galerie handlowe", weight: 1,
    points: [
      { name: "Galeria Mozaika Kraków", coord: [19.9942749, 50.0146012],
        source: "https://www.openstreetmap.org/way/26258895" },
    ],
  },
  {
    id: "poi-14", name: "Bonarka 4 Business", category: "Centra biurowe i miejsca pracy", weight: 2,
    points: [
      { name: "Budynek A", coord: [19.9500595, 50.0262504],
        source: "https://www.openstreetmap.org/way/150077028" },
    ],
  },
  {
    id: "poi-15", name: "Quattro Business Park", category: "Centra biurowe i miejsca pracy", weight: 1,
    points: [
      { name: "Quattro Business Park", coord: [19.9758052, 50.08662],
        source: "https://www.openstreetmap.org/way/294602822" },
    ],
  },
  {
    id: "poi-16", name: "Krakowski Park Technologiczny na Czerwonych Makach", category: "Centra biurowe i miejsca pracy", weight: 3,
    points: [
      { name: "Krakowski Park Technologiczny", coord: [19.8862574, 50.0211784],
        source: "https://www.openstreetmap.org/way/289986808" },
    ],
  },
  {
    id: "poi-17", name: "O3 Business Campus", category: "Centra biurowe i miejsca pracy", weight: 1,
    points: [
      { name: "O3 Business Campus I", coord: [19.9545132, 50.0872785],
        source: "https://www.openstreetmap.org/way/337757651" },
    ],
  },
  {
    id: "poi-18", name: "Podium Park", category: "Centra biurowe i miejsca pracy", weight: 1,
    points: [
      { name: "Podium Park A", coord: [19.9985614, 50.0748156],
        source: "https://www.openstreetmap.org/way/509233292" },
    ],
  },
  {
    id: "poi-19", name: "High5ive", category: "Centra biurowe i miejsca pracy", weight: 1,
    points: [
      { name: "High5ive - Budynek 1", coord: [19.9455008, 50.0698776],
        source: "https://www.openstreetmap.org/way/522355527" },
    ],
  },
  {
    id: "poi-20", name: "Unity Centre / Unity Tower", category: "Centra biurowe i miejsca pracy", weight: 1,
    points: [
      { name: "Unity Tower", coord: [19.9578181, 50.0681876],
        source: "https://www.openstreetmap.org/way/672306446" },
    ],
  },
  {
    id: "poi-21", name: "Fabryczna Office Park", category: "Centra biurowe i miejsca pracy", weight: 1,
    points: [
      { name: "Fabryczna Office Park", coord: [19.973941, 50.0619934],
        source: "https://www.openstreetmap.org/way/544719968" },
    ],
  },
  {
    id: "poi-22", name: "Klaster Innowacji Gospodarczych na Zabłociu", category: "Centra biurowe i miejsca pracy", weight: 2,
    points: [
      { name: "Klaster Innowacji Społeczno-Gospodarczych Zabłocie 22a", coord: [19.9661637, 50.0504068],
        source: "https://www.openstreetmap.org/way/1315397810" },
    ],
  },
  {
    id: "poi-23", name: "Tischnera Office", category: "Centra biurowe i miejsca pracy", weight: 1,
    points: [
      { name: "Tischnera Office", coord: [19.9382295, 50.028172],
        source: "https://www.openstreetmap.org/way/773572324" },
    ],
  },
  {
    id: "poi-24", name: "Szpital Uniwersytecki", category: "Szpitale", weight: 1,
    points: [
      { name: "Szpital Uniwersytecki", coord: [20.0003779, 50.0082247],
        source: "https://www.openstreetmap.org/way/534118934" },
    ],
    note: "Główna siedziba w Prokocimiu, ul. Jakubowskiego; nie dawne budynki przy Kopernika.",
  },
  {
    id: "poi-25", name: "Szpital Dziecięcy w Prokocimiu", category: "Szpitale", weight: 1,
    points: [
      { name: "Uniwersytecki Szpital Dziecięcy", coord: [20.0015069, 50.011527],
        source: "https://www.openstreetmap.org/way/316891627" },
    ],
  },
  {
    id: "poi-26", name: "Szpital Rydygiera", category: "Szpitale", weight: 1,
    points: [
      { name: "Szpital Specjalistyczny im. Ludwika Rydygiera w Krakowie", coord: [20.0184785, 50.0930833],
        source: "https://www.openstreetmap.org/way/65368983" },
    ],
  },
  {
    id: "poi-27", name: "Szpital Żeromskiego", category: "Szpitale", weight: 1,
    points: [
      { name: "Szpital specjalistyczny imienia Stefana Żeromskiego", coord: [20.0463144, 50.0651543],
        source: "https://www.openstreetmap.org/way/276803150" },
    ],
  },
  {
    id: "poi-28", name: "5 Wojskowy Szpital", category: "Szpitale", weight: 1,
    points: [
      { name: "5. Wojskowy Szpital Kliniczny z Polikliniką SP ZOZ w Krakowie", coord: [19.93399, 50.0773814],
        source: "https://www.openstreetmap.org/way/234723781" },
    ],
  },
  {
    id: "poi-29", name: "Szpital Narutowicza", category: "Szpitale", weight: 1,
    points: [
      { name: "Szpital Miejski Specjalistyczny imienia Gabriela Narutowicza", coord: [19.9392911, 50.0831522],
        source: "https://www.openstreetmap.org/way/24377001" },
    ],
  },
  {
    id: "poi-30", name: "Szpital JP2", category: "Szpitale", weight: 1,
    points: [
      { name: "Krakowski Szpital Specjalistyczny imienia świętego Jana Pawła II", coord: [19.9356805, 50.0900855],
        source: "https://www.openstreetmap.org/way/234706960" },
    ],
  },
  {
    id: "poi-31", name: "Szpital Babińskiego w Kobierzynie", category: "Szpitale", weight: 1,
    points: [
      { name: "Szpital Kliniczny im. doktora Józefa Babińskiego SP ZOZ", coord: [19.8836642, 50.0036628],
        source: "https://www.openstreetmap.org/way/108399363" },
    ],
  },
  {
    id: "poi-32", name: "Szpital Św. Rafała", category: "Szpitale", weight: 1,
    points: [
      { name: "Szpital Świętego Rafała w Krakowie", coord: [19.9753289, 50.0105567],
        source: "https://www.openstreetmap.org/relation/9766853" },
    ],
  },
  {
    id: "poi-33", name: "AGH", category: "Kampusy", weight: 3,
    points: [
      { name: "AGH — gmach główny, wschód", coord: [19.9232975, 50.064547],
        source: "https://www.openstreetmap.org/relation/3111004" },
      { name: "AGH — biblioteka, środek", coord: [19.921503, 50.0656968],
        source: "https://www.openstreetmap.org/way/231815478" },
      { name: "AGH — D-7, zachód", coord: [19.9123361, 50.0668886],
        source: "https://www.openstreetmap.org/way/231815579" },
    ],
    note: "Trzy punkty w kampusie: wschód, środek i zachód. Łączna waga AGH = 3.",
  },
  {
    id: "poi-34", name: "UJ Ruczaj", category: "Kampusy", weight: 3,
    points: [
      { name: "UJ Ruczaj — matematyka i informatyka", coord: [19.9071722, 50.0305176],
        source: "https://www.openstreetmap.org/node/5160346296" },
      { name: "UJ Ruczaj — fizyka", coord: [19.9054965, 50.0289664],
        source: "https://www.openstreetmap.org/node/5160368451" },
      { name: "UJ Ruczaj — biochemia i biotechnologia", coord: [19.9003936, 50.0263355],
        source: "https://www.openstreetmap.org/node/5160317166" },
    ],
    note: "Trzy punkty kampusu UJ na Ruczaju. Łączna waga kampusu = 3.",
  },
  {
    id: "poi-35", name: "Politechnika Krakowska na Czyżynach", category: "Kampusy", weight: 1,
    points: [
      { name: "Politechnika Krakowska - Kampus Czyżyny", coord: [19.9984154, 50.0756451],
        source: "https://www.openstreetmap.org/way/158296948" },
    ],
  },
  {
    id: "poi-36", name: "AKF", category: "Kampusy", weight: 1,
    points: [
      { name: "Akademia Kultury Fizycznej", coord: [20.0006803, 50.0711436],
        source: "https://www.openstreetmap.org/way/40751142" },
    ],
  },
  {
    id: "poi-37", name: "Frycz", category: "Kampusy", weight: 1,
    points: [
      { name: "Uniwersytet Andrzeja Frycza Modrzewskiego", coord: [19.9646769, 50.0508202],
        source: "https://www.openstreetmap.org/way/288247005" },
    ],
  },
  {
    id: "poi-38", name: "Uniwersytet Pedagogiczny", category: "Kampusy", weight: 1,
    points: [
      { name: "Uniwersytet Komisji Edukacji Narodowej", coord: [19.9087002, 50.0735382],
        source: "https://www.openstreetmap.org/way/656324576" },
    ],
  },
  {
    id: "poi-39", name: "JP2 Ruczaj", category: "Kampusy", weight: 1,
    points: [
      { name: "Biblioteka Główna Uniwersytetu Papieskiego Jana Pawła II", coord: [19.8981261, 50.0213845],
        source: "https://www.openstreetmap.org/way/233371390" },
    ],
  },
  {
    id: "poi-40", name: "UEK", category: "Kampusy", weight: 1,
    points: [
      { name: "Uniwersytet Ekonomiczny w Krakowie", coord: [19.9554822, 50.0685491],
        source: "https://www.openstreetmap.org/way/371465818" },
    ],
  },
  {
    id: "poi-41", name: "Politechnika Krakowska ul. Warszawska", category: "Kampusy", weight: 1,
    points: [
      { name: "Politechnika Krakowska - Kampus Warszawska", coord: [19.9421184, 50.0718656],
        source: "https://www.openstreetmap.org/way/87527963" },
    ],
  },
  {
    id: "poi-42", name: "Uniwersytet Rolniczy (przy AGHu i na Al. 29 Listopada)", category: "Kampusy", weight: 1,
    points: [
      { name: "UR — kampus Mickiewicza", coord: [19.9248542, 50.0647781],
        source: "https://www.openstreetmap.org/way/653795425" },
      { name: "UR — kampus 29 Listopada", coord: [19.950566, 50.0830344],
        source: "https://www.openstreetmap.org/way/566131083" },
    ],
    note: "Dwa kampusy z jednego wpisu: Mickiewicza i al. 29 Listopada. Łączna waga = 1.",
  },
  {
    id: "poi-43", name: "Uniwersytet Ignatanium", category: "Kampusy", weight: 1,
    points: [
      { name: "Uniwersytet Ignatianum w Krakówie", coord: [19.9485377, 50.0625357],
        source: "https://www.openstreetmap.org/way/295086803" },
    ],
  },
  {
    id: "poi-44", name: "UJ Collegium Medicum", category: "Kampusy", weight: 1,
    points: [
      { name: "Collegium Nowodworskiego", coord: [19.9329797, 50.0619131],
        source: "https://www.openstreetmap.org/relation/2066562" },
    ],
  },
  {
    id: "poi-45", name: "UJ na starym mieście - Collegium Novum", category: "Kampusy", weight: 1,
    points: [
      { name: "Collegium Novum", coord: [19.9332351, 50.0608642],
        source: "https://www.openstreetmap.org/relation/214262" },
    ],
  },
  {
    id: "poi-46", name: "V LO", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "V Liceum Ogólnokształcące", coord: [19.9288024, 50.0621978],
        source: "https://www.openstreetmap.org/way/692533811" },
    ],
  },
  {
    id: "poi-47", name: "ZSŁ", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Zespół Szkół Łączności w Krakowie", coord: [19.9222327, 50.0464205],
        source: "https://www.openstreetmap.org/way/233371503" },
    ],
  },
  {
    id: "poi-48", name: "ZSM nr 1", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Zespół Szkół Mechanicznych nr 1 im. Szczepana Humberta", coord: [19.9245553, 50.061499],
        source: "https://www.openstreetmap.org/node/3037869176" },
    ],
  },
  {
    id: "poi-49", name: "ZSM nr 3", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Zespół Szkół Mechanicznych nr 3", coord: [20.0508779, 50.0766755],
        source: "https://www.openstreetmap.org/way/1030848998" },
    ],
  },
  {
    id: "poi-50", name: "ZS Energetyczne Loretańska", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Zespół Szkół Energetycznych w Krakowie", coord: [19.9308169, 50.0616209],
        source: "https://www.openstreetmap.org/way/126718958" },
    ],
  },
  {
    id: "poi-51", name: "I LO", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "I Liceum Ogólnokształcące", coord: [19.9333599, 50.0571662],
        source: "https://www.openstreetmap.org/way/692834133" },
    ],
  },
  {
    id: "poi-52", name: "II LO", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "II Liceum Ogólnokształcące im. Króla Jana III Sobieskiego w Krakowie", coord: [19.9317816, 50.0683955],
        source: "https://www.openstreetmap.org/way/690962950" },
    ],
  },
  {
    id: "poi-53", name: "VI LO", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "VI Liceum Ogólnokształcące im. Adama Mickiewicza", coord: [19.9474361, 50.0504766],
        source: "https://www.openstreetmap.org/way/1251331909" },
    ],
  },
  {
    id: "poi-54", name: "VII LO", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "VII Liceum Ogólnokształcące im. Zofii Nałkowskiej", coord: [19.9082868, 50.0705954],
        source: "https://www.openstreetmap.org/way/213083704" },
    ],
  },
  {
    id: "poi-55", name: "IV LO", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Liceum Ogólnokształcące nr 4 im. Tadeusza Kościuszki", coord: [19.9463623, 50.0409878],
        source: "https://www.openstreetmap.org/way/309837020" },
    ],
  },
  {
    id: "poi-56", name: "VIII LO", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "VIII Liceum Ogólnokształcące im. Stanisława Wyspiańskiego", coord: [19.9555525, 50.0589724],
        source: "https://www.openstreetmap.org/way/83636100" },
    ],
  },
  {
    id: "poi-57", name: "13 LO", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "XIII Liceum Ogólnokształcące", coord: [19.9637323, 50.0634436],
        source: "https://www.openstreetmap.org/way/184239026" },
    ],
  },
  {
    id: "poi-58", name: "ZS Huty", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Osiedle Złotej Jesieni 2", coord: [20.0230455, 50.0906995],
        source: "https://www.openstreetmap.org/way/54569711" },
    ],
    note: "Przyjęto ZSZ Huty im. Tadeusza Sendzimira, os. Złotej Jesieni 2.",
  },
  {
    id: "poi-59", name: "ZSE nr 1 Kamieńskiego", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Zespół Szkół Elektrycznych nr 1", coord: [19.9762133, 50.0249133],
        source: "https://www.openstreetmap.org/way/150636559" },
    ],
  },
  {
    id: "poi-60", name: "Technikum Komunikacyjne (Mogilska)", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Technikum Komunikacyjne nr 25", coord: [19.9864518, 50.074597],
        source: "https://www.openstreetmap.org/node/3463533020" },
    ],
    note: "Przyjęto Technikum Komunikacyjne nr 25, ul. Ułanów 3 przy al. Jana Pawła II; wpis „Mogilska” wskazuje okolicę.",
  },
  {
    id: "poi-61", name: "ZS Ekonomicznych (Kapucyńska)", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Zespół Szkół Ekonomicznych nr 1", coord: [19.9315516, 50.0617188],
        source: "https://www.openstreetmap.org/way/126718948" },
    ],
  },
  {
    id: "poi-62", name: "ZS Inżynieri Środowiska i Melioracji Ułanów", category: "Duże szkoły średnie", weight: 1,
    points: [
      { name: "Ułanów 9", coord: [19.9865849, 50.0758648],
        source: "https://www.openstreetmap.org/way/108846202" },
    ],
    note: "Adres Ułanów 9; geokoder zwraca też nazwę Zespołu Szkół Techniczno-Kreatywnych.",
  },
  {
    id: "poi-63", name: "Rynek Główny", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Rynek Główny", coord: [19.9371133, 50.0614956],
        source: "https://www.openstreetmap.org/way/201133718" },
    ],
  },
  {
    id: "poi-64", name: "Dworzec Główny", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Kraków Główny", coord: [19.9478862, 50.0684238],
        source: "https://www.openstreetmap.org/node/206270454" },
    ],
  },
  {
    id: "poi-65", name: "Dworzec Płaszów", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Kraków Płaszów", coord: [19.9747852, 50.0350214],
        source: "https://www.openstreetmap.org/node/206270914" },
    ],
  },
  {
    id: "poi-66", name: "Bronowice SKA", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Kraków Bronowice", coord: [19.8926145, 50.0830061],
        source: "https://www.openstreetmap.org/node/8190667258" },
    ],
  },
  {
    id: "poi-67", name: "Teatr Bagatela", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Teatr Bagatela", coord: [19.9322489, 50.0636628],
        source: "https://www.openstreetmap.org/way/125207200" },
    ],
  },
  {
    id: "poi-68", name: "Teatr Słowackiego", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Teatr im. Juliusza Słowackiego", coord: [19.9430659, 50.0639468],
        source: "https://www.openstreetmap.org/way/153942974" },
    ],
  },
  {
    id: "poi-69", name: "Poczta Główna", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Wielopole 2", coord: [19.9426888, 50.0594606],
        source: "https://www.openstreetmap.org/node/2989667370" },
    ],
  },
  {
    id: "poi-70", name: "Rondo Grunwaldzkie", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Rondo Grunwaldzkie", coord: [19.931578, 50.0488728],
        source: "https://www.openstreetmap.org/way/199084017" },
    ],
  },
  {
    id: "poi-71", name: "Rondo Grzegórzeckie", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Rondo Grzegórzeckie", coord: [19.95832, 50.0576863],
        source: "https://www.openstreetmap.org/way/216789263" },
    ],
  },
  {
    id: "poi-72", name: "Rondo Mogilskie", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Rondo Mogilskie", coord: [19.9594586, 50.0666229],
        source: "https://www.openstreetmap.org/way/533275337" },
    ],
  },
  {
    id: "poi-73", name: "Plac Centralny", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Plac Centralny imienia Ronalda Reagana", coord: [20.037814, 50.0714582],
        source: "https://www.openstreetmap.org/way/19803388" },
    ],
  },
  {
    id: "poi-74", name: "Rondo Czyżyńskie", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Rondo Czyżyńskie", coord: [20.0169682, 50.0735342],
        source: "https://www.openstreetmap.org/way/148469685" },
    ],
  },
  {
    id: "poi-75", name: "Czerwone Maki pętla", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Czerwone Maki P+R", coord: [19.8894199, 50.0184823],
        source: "https://www.openstreetmap.org/node/4431180541" },
    ],
  },
  {
    id: "poi-76", name: "Borek Fałęcki pętla", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Borek Fałęcki", coord: [19.9265683, 50.0143005],
        source: "https://www.openstreetmap.org/relation/3198787" },
    ],
  },
  {
    id: "poi-77", name: "Plac Inwalidów", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Plac Inwalidów", coord: [19.9255255, 50.0695159],
        source: "https://www.openstreetmap.org/way/25506182" },
    ],
  },
  {
    id: "poi-78", name: "Nowy Kleparz", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Nowy Kleparz", coord: [19.9359045, 50.0745649],
        source: "https://www.openstreetmap.org/node/264336170" },
    ],
  },
  {
    id: "poi-79", name: "Mały Płaszów P+R", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Mały Płaszów P+R", coord: [20.0006189, 50.040189],
        source: "https://www.openstreetmap.org/node/2431520659" },
    ],
  },
  {
    id: "poi-80", name: "Wzgórza Krzesławickie Pętla", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Wzgórza Krzesławickie", coord: [20.0528016, 50.0983672],
        source: "https://www.openstreetmap.org/node/2078743080" },
    ],
    note: "Wybrano pętlę przy ul. Kocmyrzowskiej, a nie geograficzne centrum osiedla.",
  },
  {
    id: "poi-81", name: "Mistrzejowice Pętla", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Mistrzejowice", coord: [20.0137673, 50.0966423],
        source: "https://www.openstreetmap.org/node/5617407402" },
    ],
    note: "Wybrano pętlę, a nie geograficzne centrum Mistrzejowic.",
  },
  {
    id: "poi-82", name: "Podgórze SKA", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Kraków Podgórze", coord: [19.9592209, 50.0411604],
        source: "https://www.openstreetmap.org/node/4977292604" },
    ],
  },
  {
    id: "poi-83", name: "Rondo Matecznego", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Rondo Antoniego Matecznego", coord: [19.9404758, 50.0366658],
        source: "https://www.openstreetmap.org/way/25031552" },
    ],
  },
  {
    id: "poi-84", name: "Górka Narodowa P+R", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Górka Narodowa P+R", coord: [19.9625026, 50.1046598],
        source: "https://www.openstreetmap.org/node/11498423076" },
    ],
  },
  {
    id: "poi-85", name: "Krowodrza Górka P+R", category: "Ogólne ważne punkty w mieście", weight: 1,
    points: [
      { name: "Krowodrza Górka P+R", coord: [19.9313122, 50.0885866],
        source: "https://www.openstreetmap.org/way/113503454" },
    ],
  },
  {
    id: "poi-86", name: "Stadion Wisły", category: "Obiekty sportowe i wydarzenia", weight: 1,
    points: [
      { name: "Synerise Arena - Stadion Miejski im. Henryka Reymana", coord: [19.9116239, 50.0635558],
        source: "https://www.openstreetmap.org/way/1321900718" },
    ],
  },
  {
    id: "poi-87", name: "Stadion Cracovii", category: "Obiekty sportowe i wydarzenia", weight: 1,
    points: [
      { name: "Stadion Cracovii im. Józefa Piłsudskiego", coord: [19.9215223, 50.0579154],
        source: "https://www.openstreetmap.org/relation/3178493" },
    ],
  },
  {
    id: "poi-88", name: "TAURON Arena Kraków", category: "Obiekty sportowe i wydarzenia", weight: 1,
    points: [
      { name: "Tauron Arena Kraków", coord: [19.991549, 50.0677202],
        source: "https://www.openstreetmap.org/way/292867512" },
    ],
  },
];
