import { BBOX } from "../constants";
import type { Stop, TramTrack, Coord } from "../types";
import { haversine, normalizeStopName } from "./geo";

const OVERPASS_ENDPOINTS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "/overpass",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const OSM_CACHE_KEY = "transplan-osm-cache-v2";
const OSM_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OsmWay {
  type: "way";
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

interface OsmCache {
  at: number;
  stops: Stop[];
  tracks: TramTrack[];
}

export function readOsmCache(): OsmCache | null {
  try {
    const raw = localStorage.getItem(OSM_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as OsmCache;
    if (!data?.stops || !data?.tracks) return null;
    if (Date.now() - data.at > OSM_CACHE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeOsmCache(stops: Stop[], tracks: TramTrack[]): void {
  try {
    localStorage.setItem(
      OSM_CACHE_KEY,
      JSON.stringify({ at: Date.now(), stops, tracks } satisfies OsmCache),
    );
  } catch {
    /* quota */
  }
}

async function overpass(query: string): Promise<{ elements: (OsmNode | OsmWay)[] }> {
  let lastError: Error | null = null;
  const body = `data=${encodeURIComponent(query)}`;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Overpass ${res.status} (${url})`);
      const json = (await res.json()) as { elements?: (OsmNode | OsmWay)[]; remark?: string };
      if (!json.elements) throw new Error(json.remark || "Pusta odpowiedź Overpass");
      return { elements: json.elements };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("Overpass niedostępny");
}

function bboxStr(): string {
  return `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
}

function isBus(tags: Record<string, string> = {}): boolean {
  if (tags.bus === "yes" || tags.highway === "bus_stop" || tags.amenity === "bus_station")
    return true;
  if (tags.trolleybus === "yes") return true;
  if (tags.public_transport && tags.tram !== "yes" && tags.train !== "yes" && tags.railway !== "tram_stop")
    return tags.highway === "bus_stop" || tags.public_transport === "platform" || tags.public_transport === "stop_position";
  return false;
}

function isTram(tags: Record<string, string> = {}): boolean {
  return (
    tags.tram === "yes" ||
    tags.railway === "tram_stop" ||
    tags.station === "tram" ||
    (tags.public_transport === "stop_position" && tags.tram === "yes") ||
    (tags.public_transport === "platform" && tags.tram === "yes")
  );
}

export async function fetchOsmStops(): Promise<Stop[]> {
  const b = bboxStr();
  const query = `
[out:json][timeout:90];
(
  node["highway"="bus_stop"](${b});
  node["amenity"="bus_station"](${b});
  node["railway"="tram_stop"](${b});
  node["public_transport"="platform"]["highway"!="bus_stop"](${b});
);
out body;
`;
  const data = await overpass(query);
  const raw: Stop[] = [];
  for (const el of data.elements) {
    if (el.type !== "node") continue;
    const tags = el.tags ?? {};
    const bus = isBus(tags) || tags.highway === "bus_stop" || tags.public_transport === "platform";
    const tram = isTram(tags);
    if (!bus && !tram) continue;
    const name = tags.name || tags.ref || "Bez nazwy";
    const modes: Stop["modes"] = [];
    if (bus) modes.push("bus");
    if (tram) modes.push("tram");
    if (!modes.length) modes.push("bus");
    raw.push({
      id: `osm-${el.id}`,
      name,
      lat: el.lat,
      lon: el.lon,
      modes,
      source: "osm",
      osmId: el.id,
    });
  }
  return dedupeStops(raw);
}

function dedupeStops(stops: Stop[]): Stop[] {
  const used = new Set<string>();
  const result: Stop[] = [];
  const scored = [...stops].sort((a, b) => {
    const an = a.name === "Bez nazwy" ? 1 : 0;
    const bn = b.name === "Bez nazwy" ? 1 : 0;
    return an - bn;
  });

  for (const s of scored) {
    if (used.has(s.id)) continue;
    const cluster = [s];
    for (const o of scored) {
      if (o.id === s.id || used.has(o.id)) continue;
      if (haversine([s.lon, s.lat], [o.lon, o.lat]) < 8) {
        cluster.push(o);
      }
    }
    const named = cluster.filter((c) => c.name !== "Bez nazwy");
    const pick = named[0] ?? cluster[0];
    const modes = [...new Set(cluster.flatMap((c) => c.modes))] as Stop["modes"];
    result.push({
      ...pick,
      modes,
      name: pick.name || cluster.find((c) => c.name !== "Bez nazwy")?.name || "Bez nazwy",
    });
    for (const c of cluster) used.add(c.id);
  }
  return result;
}

export async function fetchTramTracks(): Promise<TramTrack[]> {
  const b = bboxStr();
  const query = `
[out:json][timeout:120];
(
  way["railway"="tram"](${b});
  way["railway"="construction"]["construction"="tram"](${b});
);
out geom;
`;
  const data = await overpass(query);
  const tracks: TramTrack[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const construction = tags.railway === "construction" || tags.construction === "tram";
    const geometry: Coord[] = el.geometry.map((g) => [g.lon, g.lat]);
    tracks.push({
      id: `osm-way-${el.id}`,
      geometry,
      construction,
      source: "osm",
      kind: "tram",
      osmId: el.id,
    });
  }
  return tracks;
}

const ROAD_HIGHWAY =
  "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|busway|bus_guideway|construction|pedestrian)$";

export async function fetchOsmRoads(): Promise<TramTrack[]> {
  const b = bboxStr();
  const query = `
[out:json][timeout:180];
(
  way["highway"~"${ROAD_HIGHWAY}"](${b});
);
out geom;
`;
  const data = await overpass(query);
  const roads: TramTrack[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const construction = tags.highway === "construction" || tags.construction === "yes";
    const geometry = simplifyLine(
      el.geometry.map((g) => [g.lon, g.lat] as Coord),
      14,
    );
    if (geometry.length < 2) continue;
    roads.push({
      id: `osm-road-${el.id}`,
      geometry,
      construction,
      source: "osm",
      kind: "road",
      osmId: el.id,
    });
  }
  return roads;
}

function simplifyLine(geom: Coord[], minM: number): Coord[] {
  if (geom.length < 3) return geom;
  const out: Coord[] = [geom[0]];
  for (let i = 1; i < geom.length - 1; i++) {
    if (haversine(out[out.length - 1], geom[i]) >= minM) out.push(geom[i]);
  }
  const last = geom[geom.length - 1];
  if (haversine(out[out.length - 1], last) > 0.5) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

export function findOppositeStops(stop: Stop, all: Stop[], headingFrom?: Coord): Stop[] {
  const key = normalizeStopName(stop.name);
  if (!key || key === "bez nazwy") return [];
  const origin: Coord = [stop.lon, stop.lat];
  return all
    .filter((s) => s.id !== stop.id && s.modes.some((m) => stop.modes.includes(m)))
    .filter((s) => normalizeStopName(s.name) === key)
    .filter((s) => {
      const d = haversine(origin, [s.lon, s.lat]);
      return d > 8 && d < 120;
    })
    .sort((a, b) => {
      if (headingFrom) {
        const sa = Math.sign(
          (headingFrom[0] - origin[0]) * (a.lat - stop.lat) -
            (headingFrom[1] - origin[1]) * (a.lon - stop.lon),
        );
        const sb = Math.sign(
          (headingFrom[0] - origin[0]) * (b.lat - stop.lat) -
            (headingFrom[1] - origin[1]) * (b.lon - stop.lon),
        );
        if (sa !== sb) return sa - sb;
      }
      return (
        haversine(origin, [a.lon, a.lat]) - haversine(origin, [b.lon, b.lat])
      );
    });
}
