import { encodeStoredState, decodeStoredState } from "./storageCodec";
import type { OsmKind } from "./osmQueries";
import type { Stop, TramTrack, Coord } from "../types";
import { haversine, normalizeStopName } from "./geo";

const OSM_CACHE_KEY = "transplan-base-cache-v6";
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
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OsmRelation {
  type: "relation";
  id: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

type OsmElement = OsmNode | OsmWay | OsmRelation;

interface OsmCache {
  at: number;
  stops: Stop[];
  tracks: TramTrack[];
  legacyStops?: Stop[];
}

export function readOsmCache(): OsmCache | null {
  try {
    const current = localStorage.getItem(OSM_CACHE_KEY);
    // Reimport stops after a parser change, retaining the independent track cache.
    const raw = current ?? localStorage.getItem("transplan-osm-cache-v5") ?? localStorage.getItem("transplan-osm-cache-v4") ?? localStorage.getItem("transplan-osm-cache-v3");
    if (!raw) return null;
    const data = decodeStoredState(raw) as OsmCache;
    if (!data?.stops || !data?.tracks) return null;
    if (Date.now() - data.at > OSM_CACHE_MS) return null;
    return current ? data : { ...data, stops: [], legacyStops: data.stops };
  } catch {
    return null;
  }
}

export function writeOsmCache(stops: Stop[], tracks: TramTrack[]): void {
  try {
    localStorage.setItem(
      OSM_CACHE_KEY,
      encodeStoredState({ at: Date.now(), stops, tracks } satisfies OsmCache),
    );
  } catch {
    /* quota */
  }
}

async function overpass(kind: OsmKind): Promise<{ elements: OsmElement[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 210000);
  try {
    const res = await fetch("/overpass", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ kind }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Nie udało się wczytać danych OSM (${res.status}).`);
    const json = (await res.json()) as { elements?: OsmElement[]; remark?: string };
    if (!json.elements) throw new Error(json.remark || "Pusta odpowiedź Overpass");
    if (json.remark) throw new Error(json.remark);
    return { elements: json.elements };
  } finally { clearTimeout(timer); }
}

export async function fetchTramTracks(): Promise<TramTrack[]> {
  const data = await overpass("tram");
  const tracks: TramTrack[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const construction = tags.railway === "construction" || tags.construction === "tram" || tags["disused:railway"] === "tram" || tags.railway === "disused" || tags.disused === "yes";
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

export async function fetchOsmRoads(): Promise<TramTrack[]> {
  const data = await overpass("roads");
  const roads: TramTrack[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    // An area's perimeter is not a carriageway. Snapping to it can strand a
    // nearby bus stop on a disconnected ring (e.g. Bonarka 01).
    if (tags.area === "yes") continue;
    if (tags.highway === "pedestrian") {
      const access = tags.bus ?? tags.psv ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
      if (!access || !["yes", "designated", "permissive", "destination"].includes(access)) continue;
    }
    const construction = tags.highway === "construction" || tags.construction === "yes";
    // The routing graph joins ways at shared vertices. Distance-only
    // simplification can remove a junction and disconnect otherwise valid roads.
    const geometry: Coord[] = el.geometry.map((g) => [g.lon, g.lat]);
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
