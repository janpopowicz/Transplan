import { BBOX } from "../constants";
import type { Coord } from "../types";
import { haversine } from "./geo";

export interface WalkingEdge { from: number; to: number; meters: number; forward: boolean; backward: boolean }
export interface WalkingNetwork { coords: Coord[]; edges: WalkingEdge[]; fetchedAt: number }
export interface WalkingElement {
  type: "way" | "node";
  id: number;
  nodes?: number[];
  geometry?: { lon: number; lat: number }[];
  tags?: Record<string, string>;
}

const HIGHWAYS = "footway|path|pedestrian|steps|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway";
const DENIED = new Set(["no", "private", "use_sidepath"]);

// https://wiki.openstreetmap.org/wiki/Key:foot and Key:sidewalk
export function isWalkable(tags: Record<string, string>): boolean {
  if (DENIED.has(tags.foot ?? tags.access ?? "")) return false;
  if (tags.area === "yes" || tags.highway === "construction" || tags.construction || tags.indoor === "yes") return false;
  if (tags.sidewalk === "separate" || tags["sidewalk:both"] === "separate" ||
    (tags["sidewalk:left"] === "separate" && tags["sidewalk:right"] === "separate")) return false;
  if (tags.highway === "cycleway" && !["yes", "designated", "permissive"].includes(tags.foot ?? "")) return false;
  return HIGHWAYS.split("|").includes(tags.highway);
}

/** Join only shared OSM node IDs, never geometric crossings (bridges/tunnels). */
export function parseWalkingNetwork(elements: WalkingElement[]): WalkingNetwork {
  const blocked = new Set<number>();
  for (const element of elements) {
    if (element.type !== "node") continue;
    const tags = element.tags ?? {};
    if (DENIED.has(tags.foot ?? tags.access ?? "") || tags.locked === "yes" ||
      (["wall", "fence", "retaining_wall"].includes(tags.barrier) && !["yes", "designated"].includes(tags.foot))) blocked.add(element.id);
  }
  const coords: Coord[] = [];
  const indices = new Map<number, number>();
  const edges: WalkingEdge[] = [];
  for (const way of elements) {
    if (way.type !== "way" || !isWalkable(way.tags ?? {}) || !way.nodes || !way.geometry || way.nodes.length !== way.geometry.length) continue;
    const tags = way.tags ?? {};
    const forward = tags["oneway:foot"] !== "-1";
    const backward = !["yes", "1", "true"].includes(tags["oneway:foot"]);
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.geometry[i - 1], b = way.geometry[i];
      if (!a || !b || blocked.has(way.nodes[i - 1]) || blocked.has(way.nodes[i])) continue;
      // Ways may extend outside the downloaded area; keep a finite analysis domain.
      if ([a, b].some((p) => p.lon < BBOX.west || p.lon > BBOX.east || p.lat < BBOX.south || p.lat > BBOX.north)) continue;
      const index = (id: number, point: typeof a) => {
        if (!indices.has(id)) { indices.set(id, coords.length); coords.push([point.lon, point.lat]); }
        return indices.get(id)!;
      };
      const from = index(way.nodes[i - 1], a), to = index(way.nodes[i], b);
      const meters = haversine(coords[from], coords[to]);
      if (meters > 0.01) edges.push({ from, to, meters, forward, backward });
    }
  }
  return { coords, edges, fetchedAt: Date.now() };
}

const CACHE_KEY = "krakow-walking-v1";
const CACHE_AGE = 7 * 24 * 60 * 60 * 1000;
let cached: WalkingNetwork | undefined;
let pending: Promise<WalkingNetwork> | undefined;

async function cacheStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("transplan-walking", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("networks");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCache(): Promise<WalkingNetwork | undefined> {
  try {
    const db = await cacheStore();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("networks").objectStore("networks").get(CACHE_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  } catch { return undefined; }
}

async function writeCache(network: WalkingNetwork) {
  try {
    const db = await cacheStore();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("networks", "readwrite");
        tx.objectStore("networks").put(network, CACHE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  } catch { /* Analysis still works when browser storage is unavailable. */ }
}

/** Race independent providers: a stalled primary must not block a healthy backup.
 * The deadline includes response-body download; unsuccessful requests are cancelled. */
export async function fetchWalkingNetwork(fetcher: typeof fetch = fetch, timeoutMs = 30_000): Promise<WalkingNetwork> {
  const bbox = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
  const query = `[out:json][timeout:25];way["highway"~"^(${HIGHWAYS})$"]["area"!="yes"]["indoor"!="yes"]["foot"!~"^(no|private|use_sidepath)$"](${bbox})->.paths;
    (.paths;node(w.paths)["barrier"];node(w.paths)["access"];node(w.paths)["foot"];);out body geom qt;`;
  // /overpass uses Kumi; do not send a second identical job to that provider.
  const controllers = [new AbortController(), new AbortController()];
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([deadline, Promise.any([
      "/overpass", "https://overpass-api.de/api/interpreter",
    ].map(async (endpoint, index) => {
      const response = await fetcher(endpoint, { method: "POST", signal: controllers[index].signal,
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: `data=${encodeURIComponent(query)}` });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      const data = await response.json() as { elements?: WalkingElement[]; remark?: string };
      if (!data.elements || data.remark) throw new Error("Incomplete OSM response");
      const network = parseWalkingNetwork(data.elements);
      if (!network.edges.length) throw new Error("Empty pedestrian network");
      return network;
    }))]);
  } catch {
    throw new Error("Serwery OSM nie odpowiedziały na czas lub są niedostępne. Spróbuj ponownie — pobieranie trwa najwyżej 30 sekund.");
  } finally {
    clearTimeout(timer!);
    controllers.forEach((controller) => controller.abort());
  }
}

let refreshing: Promise<WalkingNetwork> | undefined;
function refreshNetwork() {
  return refreshing ??= fetchWalkingNetwork().then((network) => {
    cached = network;
    void writeCache(network);
    return network;
  }).finally(() => { refreshing = undefined; });
}

/** Use even an older snapshot immediately; refresh expired data off the critical path. */
export function loadWalkingNetwork(): Promise<WalkingNetwork> {
  if (cached) {
    if (Date.now() - cached.fetchedAt >= CACHE_AGE) void refreshNetwork().catch(() => {});
    return Promise.resolve(cached);
  }
  if (pending) return pending;
  pending = (async () => {
    const stored = await readCache();
    if (stored?.edges.length) {
      cached = stored;
      if (Date.now() - stored.fetchedAt >= CACHE_AGE) void refreshNetwork().catch(() => {});
      return stored;
    }
    return refreshNetwork();
  })().finally(() => { pending = undefined; });
  return pending;
}
