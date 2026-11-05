import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile, readdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { OSM_QUERIES } from "../src/lib/osmQueries.ts";
import { badRequest, exactObject, limitedBytes, queryParams, rateLimit, readJson, safeHandler } from "./security.mjs";

const compress = promisify(gzip);
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const RESPONSE_LIMIT = 64 * 1024 * 1024;
// The full configured walking BBOX currently contains >1.2M geometry vertices
// and ~154 MiB of Overpass JSON. Other operations keep their smaller budget.
export const WALKING_RESPONSE_LIMIT = 192 * 1024 * 1024;
export const overpassCacheKey = (body) => createHash("sha256").update(body).digest("hex");

export async function cacheOverpassResponse(body, json, directory = process.env.TRANSPLAN_OSM_CACHE_DIR || "data/overpass") {
  const walking = body === `data=${encodeURIComponent(OSM_QUERIES.walking)}`;
  const parsed = JSON.parse(json);
  if (!parsed || !Array.isArray(parsed.elements) || parsed.elements.length > 300000 || parsed.remark) throw new Error("Incomplete Overpass response");
  let vertices = 0;
  for (const element of parsed.elements) {
    if (!element || !["node", "way", "relation"].includes(element.type) || !Number.isSafeInteger(element.id) || element.id <= 0)
      throw new Error("Invalid OSM element");
    if (element.type === "node" && (!Number.isFinite(element.lon) || !Number.isFinite(element.lat)
      || Math.abs(element.lon) > 180 || Math.abs(element.lat) > 85)) throw new Error("Invalid OSM node");
    if (element.geometry !== undefined) {
      if (!Array.isArray(element.geometry) || element.geometry.length > 20000) throw new Error("Invalid OSM geometry");
      vertices += element.geometry.length;
      if (vertices > (walking ? 2000000 : 1000000) || element.geometry.some((p) => !p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)
        || Math.abs(p.lon) > 180 || Math.abs(p.lat) > 85)) throw new Error("Invalid OSM coordinates");
    }
    if (element.nodes !== undefined && (!Array.isArray(element.nodes) || element.nodes.length > 20000
      || element.nodes.some((id) => !Number.isSafeInteger(id) || id <= 0))) throw new Error("Invalid OSM nodes");
    if (element.tags !== undefined && (!element.tags || typeof element.tags !== "object" || Array.isArray(element.tags)
      || Object.entries(element.tags).some(([k, v]) => k.length > 256 || typeof v !== "string" || v.length > 10000))) throw new Error("Invalid OSM tags");
  }
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const file = join(root, `${overpassCacheKey(body)}.json.gz`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, await compress(json));
  await rename(temporary, file);
  return file;
}

/** Shared bounded source used by the HTTP proxy and offline analyses. */
export function createOverpassSource({ directory = process.env.TRANSPLAN_OSM_CACHE_DIR || "data/overpass", fetcher = fetch,
  now = Date.now, maxAge = MAX_AGE, retryMs = 15 * 60 * 1000 } = {}) {
  const root = resolve(directory);
  const pending = new Map();
  const retryAfter = new Map();
  let cleaned;
  const allowedKeys = new Set(Object.values(OSM_QUERIES).map((query) => overpassCacheKey(`data=${encodeURIComponent(query)}`)));
  return async (kind) => {
    if (!Object.hasOwn(OSM_QUERIES, kind)) throw badRequest();
    const query = OSM_QUERIES[kind];
    const body = `data=${encodeURIComponent(query)}`;
    cleaned ??= (async () => {
      await mkdir(root, { recursive: true });
      for (const name of await readdir(root)) if (/^[a-f0-9]{64}\.json\.gz$/.test(name) && !allowedKeys.has(name.slice(0, 64)))
        await rm(join(root, name), { force: true });
    })().catch((error) => { cleaned = undefined; throw error; });
    await cleaned;
    const key = overpassCacheKey(body);
    const file = join(root, `${key}.json.gz`);
    const info = await stat(file).catch(() => null);
    const stale = !info || now() - info.mtimeMs > maxAge;
    if (stale) {
      if (!pending.has(key) && pending.size >= 2 && !info) throw badRequest(429);
      if (!pending.has(key) && pending.size < 2 && now() >= (retryAfter.get(key) || 0)) pending.set(key, (async () => {
        const controller = new AbortController();
        // Road/tram extracts request more time than the small walking query.
        const seconds = Math.max(25, Math.min(180, Number(/\[timeout:(\d+)\]/.exec(query)?.[1] || 25)));
        const timer = setTimeout(() => controller.abort(), (seconds + 5) * 1000);
        try {
          for (const endpoint of endpoints) {
            try {
              const response = await fetcher(endpoint, { method: "POST", body, signal: controller.signal, redirect: "error",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json",
                  "User-Agent": "Transplan/1.0 (local public transport planner)" } });
              if (!response.ok) throw new Error(`Overpass ${response.status}`);
              const saved = await cacheOverpassResponse(body, (await limitedBytes(response, kind === "walking" ? WALKING_RESPONSE_LIMIT : RESPONSE_LIMIT)).toString("utf8"), root);
              retryAfter.delete(key);
              return saved;
            } catch (error) { if (controller.signal.aborted) throw error; }
          }
          throw new Error("Overpass unavailable");
        } catch (error) {
          retryAfter.set(key, now() + retryMs);
          throw error;
        } finally { clearTimeout(timer); }
      })().finally(() => pending.delete(key)));
      const refresh = pending.get(key);
      if (!info) {
        if (!refresh) throw new Error("OSM retry cooldown");
        await refresh;
      } else void refresh?.catch(() => {}); // serve older extracts immediately during refresh
    }
    const cached = await stat(file);
    return { file, stale: now() - cached.mtimeMs > maxAge };
  };
}

/** Same fixed Overpass proxy in development, preview and production. */
export function createOverpassHandler({ source, now = Date.now, retryMs = 15 * 60 * 1000, ...options } = {}) {
  const getFile = source ?? createOverpassSource({ ...options, now, retryMs });
  const limit = rateLimit({ perClient: 60, global: 300, now });
  return safeHandler(async (req, res, next, url) => {
    if (url.pathname !== "/overpass") return next();
    queryParams(url);
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    limit(req);
    const input = exactObject(await readJson(req, 256), ["kind"]);
    if (typeof input.kind !== "string" || !Object.hasOwn(OSM_QUERIES, input.kind)) throw badRequest();
    try {
      const { file, stale } = await getFile(input.kind);
      const cached = await stat(file);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip",
        "Content-Length": cached.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "X-Transplan-Cache": stale ? "stale" : "hit" });
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      if (error.status === 429) throw error;
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(Math.ceil(retryMs / 1000)) })
        .end("Nie udało się pobrać danych OSM. Serwer ponowi pobieranie za chwilę.");
    }
  });
}
