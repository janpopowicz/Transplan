import { readFile, readdir, mkdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { importGtfsNetwork } from "../src/lib/gtfsNetwork.ts";
import { atomicWrite, getGtfsArchives, gtfsFeeds as feeds } from "./gtfsArchives.mjs";
import { noBody, queryParams, rateLimit, safeHandler, badRequest } from "./security.mjs";
import { parseProposal } from "../src/lib/proposal.ts";

const unzip = promisify(execFile);
const tables = ["stops", "routes", "trips", "calendar", "calendar_dates", "feed_info", "shapes", "stop_times"];
export const warsawDate = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date()).replaceAll("-", "");

export async function readGtfsArchives(archives) {
  const result = [];
  for (const feed of feeds) {
    const data = {};
    for (const table of tables) {
      try { data[`${table}.txt`] = (await unzip("unzip", ["-p", archives[feed.id], `${table}.txt`], { maxBuffer: 256 * 1024 * 1024, timeout: 30000 })).stdout; }
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

export function createGtfsSource({ directory = process.env.TRANSPLAN_GTFS_CACHE_DIR || "data/gtfs", download = downloadGtfsNetwork,
  now = Date.now, date = warsawDate, maxAge = 24 * 3600000, minRefreshAge = 3600000, retryMs = 15 * 60000 } = {}) {
  let pending, cached, cachedDate, loadedDate, loading, retryAt = 0;
  function validate(value) {
    if (!value || value.version !== 1 || !Number.isFinite(value.at) || value.at < 0 || !Array.isArray(value.stops)) throw new Error("Invalid GTFS snapshot");
    parseProposal({ lines: value.lines, movedStops: value.stops, localStops: [], localTracks: [], constructionOverrides: {} });
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 * 1024) throw new Error("GTFS snapshot too large");
    return value;
  }
  async function load(today) {
    if (loadedDate === today) return;
    loading ??= (async () => {
      // Yesterday's successful import is still useful if today's upstream is down.
      const files = (await readdir(directory).catch(() => [])).filter((name) => /^\d{8}\.json$/.test(name)
        && name.slice(0, 8) <= today).sort().reverse();
      for (const name of files) {
        try {
          if ((await stat(join(directory, name))).size > 64 * 1024 * 1024) continue;
          const value = validate(JSON.parse(await readFile(join(directory, name), "utf8")));
          cached = value; cachedDate = name.slice(0, 8); break;
        } catch { /* Try the previous intact daily snapshot. */ }
      }
      loadedDate = today;
    })().finally(() => { loading = undefined; });
    await loading;
  }
  function refresh(today, forced) {
    pending ??= download(today, { directory, refresh: forced }).then(async (value) => {
      validate(value);
      await mkdir(directory, { recursive: true });
      await atomicWrite(join(directory, `${today}.json`), JSON.stringify(value));
      cached = value; cachedDate = today; retryAt = 0;
      const files = (await readdir(directory)).filter((name) => /^\d{8}\.json$/.test(name)).sort().reverse();
      for (const name of files.slice(3)) await rm(join(directory, name), { force: true });
    }).catch((error) => { retryAt = now() + retryMs; throw error; }).finally(() => { pending = undefined; });
    return pending;
  }
  return async ({ refresh: forced = false, requireToday = false } = {}) => {
    const today = date();
    if (typeof today !== "string" || !/^\d{8}$/.test(today)) throw new Error("Invalid GTFS date");
    await load(today);
    try {
      const stale = !cached || cachedDate !== today || now() - cached.at >= maxAge;
      if ((stale || (forced && now() - cached.at >= minRefreshAge)) && now() >= retryAt) {
        const work = refresh(today, forced);
        if (!cached || forced || requireToday) await work;
        else void work.catch(() => {});
      }
      if (!cached) throw new Error("GTFS retry cooldown");
    } catch (error) {
      console.error("GTFS import:", error);
      if (!cached || requireToday) throw error;
    }
    if (requireToday && cachedDate !== today) throw new Error("Today's GTFS is unavailable");
    return { snapshot: cached, date: cachedDate, stale: cachedDate !== today || now() - cached.at >= maxAge };
  };
}

export function createGtfsHandler({ source, now = Date.now, retryMs = 15 * 60000, ...options } = {}) {
  const getSnapshot = source ?? createGtfsSource({ ...options, now, retryMs });
  const limit = rateLimit({ perClient: 60, global: 300, now });
  return safeHandler(async (req, res, next, url) => {
    if (url.pathname !== "/api/gtfs") return next();
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    const params = queryParams(url, { refresh: (value) => value === "1" });
    noBody(req); limit(req);
    if (req.headers["sec-fetch-site"] === "cross-site") throw badRequest(403);
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    try {
      const { snapshot, stale } = await getSnapshot({ refresh: params.refresh === "1" });
      res.setHeader("X-Transplan-Cache", stale ? "stale" : "hit");
      res.writeHead(200).end(JSON.stringify(snapshot));
    } catch {
      res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
      res.writeHead(502).end(JSON.stringify({ error: "Nie udało się pobrać bieżącego GTFS z ZTP. Spróbuj ponownie za chwilę." }));
    }
  });
}
