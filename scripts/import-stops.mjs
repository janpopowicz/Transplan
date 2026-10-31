import { build } from "esbuild";
import { readFile, writeFile, mkdtemp, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getGtfsArchives } from "../server/gtfsArchives.mjs";

const unzip = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "transplan-gtfs-"));
const sources = [
  { id: "A", mode: "bus" }, { id: "M", mode: "bus" }, { id: "T", mode: "tram" },
];
try {
  const outfile = join(dir, "gtfs.mjs");
  await build({ stdin: { contents: 'export * from "./src/lib/gtfsStops"; export * from "./src/lib/gtfsTravelTimes";', resolveDir: process.cwd(), loader: "ts" }, outfile, bundle: true, platform: "node", format: "esm" });
  const { importGtfsStops, parseGtfsCsv, gtfsCsvRows, attachLegacyStopIds, createGtfsTravelTimeCollector } = await import(pathToFileURL(outfile).href);
  const archives = sources.some((_, i) => !process.argv[i + 2]) ? await getGtfsArchives() : null;
  const feeds = await Promise.all(sources.map(async (source, i) => {
    const url = `https://gtfs.ztp.krakow.pl/GTFS_KRK_${source.id}.zip`;
    const file = process.argv[i + 2] || archives[source.id];
    const [stops, info] = await Promise.all(["stops.txt", "feed_info.txt"].map(async (name) =>
      (await unzip("unzip", ["-p", file, name], { maxBuffer: 16 * 1024 * 1024 })).stdout));
    const rows = parseGtfsCsv(stops);
    if (!rows.length) throw new Error(`Empty feed ${source.id}; catalogue retained`);
    return { ...source, file, rows, url, version: parseGtfsCsv(info)[0]?.feed_version };
  }));
  // OSM contributes aliases for old projects, never extra catalogue entries or positions.
  const legacy = [];
  for (const path of ["public/osm-stops.json", "public/stops.json", process.argv[5]].filter(Boolean)) {
    try {
      const data = JSON.parse(await readFile(path, "utf8"));
      for (const stop of data.stops ?? []) {
        legacy.push(stop, ...(stop.aliases ?? []).map((id) => ({ id, name: stop.name })));
      }
      for (const element of data.elements ?? []) {
        const name = element.tags?.name;
        if (name) legacy.push({ id: element.type === "node" ? `osm-${element.id}` : `osm-${element.type}-${element.id}`, name });
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const stops = attachLegacyStopIds(importGtfsStops(feeds), legacy);
  if (!stops.length) throw new Error("No stops; catalogue retained");
  const collector = createGtfsTravelTimeCollector(stops);
  for (const feed of feeds) {
    console.log(`Indexing GTFS ${feed.id} stop_times…`);
    const tables = {};
    for (const name of ["routes.txt", "trips.txt", "stop_times.txt"]) {
      tables[name] = (await unzip("unzip", ["-p", feed.file, name], { maxBuffer: 256 * 1024 * 1024 })).stdout;
    }
    collector.addFeed({ ...feed, routes: parseGtfsCsv(tables["routes.txt"]), trips: parseGtfsCsv(tables["trips.txt"]),
      stopTimes: gtfsCsvRows(tables["stop_times.txt"]) });
  }
  const entries = collector.entries();
  if (!entries.length) throw new Error("No GTFS travel-time relations; existing data retained");
  const at = Date.now();
  const metadata = feeds.map(({ id, url, version, rows }) => ({ id, url, version, rows: rows.length }));
  const timesTarget = "public/gtfs-times.json";
  await writeFile(`${timesTarget}.tmp`, JSON.stringify({ version: 1, at, feeds: metadata, entries }));
  const target = "public/stops.json";
  await writeFile(`${target}.tmp`, JSON.stringify({ version: 1, at, source: "GTFS ZTP Kraków",
    feeds: metadata, stops }));
  await rename(`${timesTarget}.tmp`, timesTarget);
  await rename(`${target}.tmp`, target);
  console.log(`Imported ${stops.length} platforms and ${entries.length} directed GTFS travel-time relations`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
