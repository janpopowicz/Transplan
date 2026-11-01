import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { limitedBytes } from "./security.mjs";

const DAY = 24 * 60 * 60 * 1000;
const unzip = promisify(execFile);
export const gtfsFeeds = [{ id: "T", mode: "tram" }, { id: "A", mode: "bus" }, { id: "M", mode: "bus" }];

export async function atomicWrite(file, data, validate) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    if (validate) await validate(temp);
    await rename(temp, file);
  }
  finally { await rm(temp, { force: true }); }
}

/** Static timetable archives shared by network imports and catalogue generation. */
export function createGtfsArchiveCache({ directory = process.env.TRANSPLAN_GTFS_CACHE_DIR || "data/gtfs",
  fetcher = fetch, now = Date.now, maxAge = DAY, minRefreshAge = 60 * 60 * 1000, retryMs = 15 * 60 * 1000 } = {}) {
  const root = resolve(directory, "archives"), pending = new Map();
  async function archive(id, refresh) {
    const file = join(root, `${id}.zip`), metadataFile = join(root, `${id}.json`);
    const [info, metadata] = await Promise.all([
      stat(file).catch(() => null), readFile(metadataFile, "utf8").then(JSON.parse).catch(() => null),
    ]);
    const age = now() - (metadata?.checkedAt || 0);
    if (info && metadata && age < (refresh ? minRefreshAge : maxAge)) return file;
    if (now() < (metadata?.retryAt || 0)) {
      if (info) return file;
      throw new Error(`ZTP ${id}: pobieranie zostanie ponowione później.`);
    }
    if (!pending.has(id)) pending.set(id, (async () => {
      await mkdir(root, { recursive: true });
      const headers = { "User-Agent": "Transplan/1.0 (cached Krakow timetable import)" };
      if (info && metadata?.etag) headers["If-None-Match"] = metadata.etag;
      if (info && metadata?.lastModified) headers["If-Modified-Since"] = metadata.lastModified;
      try {
        const response = await fetcher(`https://gtfs.ztp.krakow.pl/GTFS_KRK_${id}.zip`, {
          headers, signal: AbortSignal.timeout(120000), redirect: "error",
        });
        if (response.status === 304 && info) {
          await atomicWrite(metadataFile, JSON.stringify({ ...metadata, checkedAt: now(), retryAt: 0 }));
          return file;
        }
        if (!response.ok) throw new Error(`ZTP ${id}: HTTP ${response.status}`);
        const bytes = await limitedBytes(response, 100 * 1024 * 1024);
        if (bytes.length > 100 * 1024 * 1024 || bytes[0] !== 80 || bytes[1] !== 75)
          throw new Error(`Nieprawidłowe archiwum ZTP ${id}.`);
        // Test ZIP integrity before replacing the last usable archive.
        await atomicWrite(file, bytes, (temp) => unzip("unzip", ["-tqq", temp], { timeout: 120000 }));
        await atomicWrite(metadataFile, JSON.stringify({ checkedAt: now(), etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified") }));
        return file;
      } catch (error) {
        await atomicWrite(metadataFile, JSON.stringify({ ...metadata, retryAt: now() + retryMs })).catch(() => {});
        if (info) return file;
        throw error;
      }
    })().finally(() => pending.delete(id)));
    return pending.get(id);
  }
  return async ({ refresh = false } = {}) => Object.fromEntries(await Promise.all(
    gtfsFeeds.map(async ({ id }) => [id, await archive(id, refresh)]),
  ));
}

const caches = new Map();
export function getGtfsArchives({ directory = process.env.TRANSPLAN_GTFS_CACHE_DIR || "data/gtfs", refresh = false } = {}) {
  const root = resolve(directory);
  if (!caches.has(root)) caches.set(root, createGtfsArchiveCache({ directory: root }));
  return caches.get(root)({ refresh });
}
