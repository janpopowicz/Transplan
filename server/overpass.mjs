import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
export const overpassCacheKey = (body) => createHash("sha256").update(body).digest("hex");

export async function cacheOverpassResponse(body, json, directory = process.env.TRANSPLAN_OSM_CACHE_DIR || "data/overpass") {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed.elements) || parsed.remark) throw new Error("Incomplete Overpass response");
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const file = join(root, `${overpassCacheKey(body)}.json.gz`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, await compress(json));
  await rename(temporary, file);
  return file;
}

/** Same fixed Overpass proxy as development, with a persistent cache for large OSM extracts. */
export function createOverpassHandler({ directory = process.env.TRANSPLAN_OSM_CACHE_DIR || "data/overpass", fetcher = fetch,
  now = Date.now, maxAge = MAX_AGE, retryMs = 15 * 60 * 1000 } = {}) {
  const root = resolve(directory);
  const pending = new Map();
  const retryAfter = new Map();
  return async (req, res, next) => {
    if (new URL(req.url || "/", "http://localhost").pathname !== "/overpass") { next(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 64 * 1024) { res.writeHead(413).end(); return; }
      }
      const query = new URLSearchParams(body).get("data");
      if (!query) { res.writeHead(400).end(); return; }
      body = `data=${encodeURIComponent(query)}`;
      const key = overpassCacheKey(body);
      const file = join(root, `${key}.json.gz`);
      const info = await stat(file).catch(() => null);
      const stale = !info || now() - info.mtimeMs > maxAge;
      if (stale) {
        if (!pending.has(key) && now() >= (retryAfter.get(key) || 0)) pending.set(key, (async () => {
          const controller = new AbortController();
          // Road/tram extracts request more time than the small walking query.
          const seconds = Math.max(25, Math.min(180, Number(/\[timeout:(\d+)\]/.exec(query)?.[1] || 25)));
          const timer = setTimeout(() => controller.abort(), (seconds + 5) * 1000);
          try {
            for (const endpoint of endpoints) {
              try {
                const response = await fetcher(endpoint, { method: "POST", body, signal: controller.signal,
                  headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json",
                    "User-Agent": "Transplan/1.0 (local public transport planner)" } });
                if (!response.ok) throw new Error(`Overpass ${response.status}`);
                const saved = await cacheOverpassResponse(body, await response.text(), root);
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
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip",
        "Content-Length": cached.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "X-Transplan-Cache": now() - cached.mtimeMs > maxAge ? "stale" : "hit" });
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(Math.ceil(retryMs / 1000)) })
        .end("Nie udało się pobrać danych OSM. Serwer ponowi pobieranie za chwilę.");
    }
  };
}
