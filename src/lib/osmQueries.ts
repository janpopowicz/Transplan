import { BBOX } from "../constants";
const bbox = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
export const WALKING_HIGHWAYS = "footway|path|pedestrian|steps|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway";
const roads = "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|busway|bus_guideway|construction|pedestrian)$";
export const OSM_QUERIES = {
  tram: `[out:json][timeout:120];(way["railway"="tram"](${bbox});way["disused:railway"="tram"](${bbox});way["railway"="disused"]["disused"="tram"](${bbox});way["railway"="disused"]["tram"="yes"](${bbox});way["railway"="construction"]["construction"="tram"](${bbox}););out geom;`,
  roads: `[out:json][timeout:180];(way["highway"~"${roads}"](${bbox}););out geom;`,
  walking: `[out:json][timeout:25];way["highway"~"^(${WALKING_HIGHWAYS})$"]["area"!="yes"]["indoor"!="yes"]["foot"!~"^(no|private|use_sidepath)$"](${bbox})->.paths;(.paths;node(w.paths)["barrier"];node(w.paths)["access"];node(w.paths)["foot"];);out body geom qt;`,
} as const;
export type OsmKind = keyof typeof OSM_QUERIES;
