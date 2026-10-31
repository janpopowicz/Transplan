import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importGtfsNetwork } from "../src/lib/gtfsNetwork.ts";
import { atomicWrite, getGtfsArchives, gtfsFeeds as feeds } from "./gtfsArchives.mjs";

const unzip = promisify(execFile);
const tables = ["stops", "routes", "trips", "calendar", "calendar_dates", "feed_info", "shapes", "stop_times"];
export const warsawDate = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date()).replaceAll("-", "");

export async function readGtfsArchives(archives) {
  const result = [];
  for (const feed of feeds) {
    const data = {};
    for (const table of tables) {
      try { data[`${table}.txt`] = (await unzip("unzip", ["-p", archives[feed.id], `${table}.txt`], { maxBuffer: 256 * 1024 * 1024 })).stdout; }
      catch (error) { if (!["calendar", "calendar_dates", "feed_info", "shapes"].includes(table)) throw error; }
    }
    result.push({ ...feed, tables: data });
  }
  return result;
}

export async function downloadGtfsNetwork(date = warsawDate(), options = {}) {
  const archives = await getGtfsArchives(options);
  return importGtfsNetwork(await readGtfsArchives(archives), date);
}

export function createGtfsHandler({ directory = process.env.TRANSPLAN_GTFS_CACHE_DIR || "data/gtfs", download = downloadGtfsNetwork,
  now = Date.now, date = warsawDate, maxAge = 24 * 3600000, minRefreshAge = 3600000, retryMs = 15 * 60000 } = {}) {
  let pending, cached, cachedDate, loadedDate, loading, retryAt = 0;
  async function load(today) {
    if (loadedDate === today) return;
    loading ??= (async () => {
      // Yesterday's successful import is still useful if today's upstream is down.
      const files = (await readdir(directory).catch(() => [])).filter((name) => /^\d{8}\.json$/.test(name)
        && name.slice(0, 8) <= today).sort().reverse();
      for (const name of files) {
        try {
          const value = JSON.parse(await readFile(join(directory, name), "utf8"));
          if (value.version !== 1 || !Number.isFinite(value.at) || !Array.isArray(value.lines) || !Array.isArray(value.stops)) continue;
          cached = value; cachedDate = name.slice(0, 8); break;
        } catch { /* Try the previous intact daily snapshot. */ }
      }
      loadedDate = today;
    })().finally(() => { loading = undefined; });
    await loading;
  }
  function refresh(today, forced) {
    pending ??= download(today, { directory, refresh: forced }).then(async (value) => {
      await mkdir(directory, { recursive: true });
      await atomicWrite(join(directory, `${today}.json`), JSON.stringify(value));
      cached = value; cachedDate = today; retryAt = 0;
    }).catch((error) => { retryAt = now() + retryMs; throw error; }).finally(() => { pending = undefined; });
    return pending;
  }
  return async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/api/gtfs") { next(); return; }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    const today = date();
    try {
      await load(today);
      const forced = url.searchParams.get("refresh") === "1";
      const stale = !cached || cachedDate !== today || now() - cached.at >= maxAge;
      const mayRefresh = now() >= retryAt;
      if ((stale || (forced && now() - cached.at >= minRefreshAge)) && mayRefresh) {
        const work = refresh(today, forced);
        if (!cached || forced) await work;
        else void work.catch(() => {});
      }
      if (!cached) throw new Error("GTFS retry cooldown");
      res.setHeader("X-Transplan-Cache", cachedDate !== today || now() - cached.at >= maxAge ? "stale" : "hit");
      res.writeHead(200).end(JSON.stringify(cached));
    } catch (error) {
      console.error("GTFS import:", error);
      if (cached) { res.setHeader("X-Transplan-Cache", "stale"); res.writeHead(200).end(JSON.stringify(cached)); return; }
      res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
      res.writeHead(502).end(JSON.stringify({ error: "Nie udało się pobrać bieżącego GTFS z ZTP. Spróbuj ponownie za chwilę." }));
    }
  };
}
