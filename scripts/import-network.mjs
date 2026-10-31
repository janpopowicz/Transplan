import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = await mkdtemp(join(tmpdir(), "transplan-import-"));
try {
  const file = join(dir, "import.mjs");
  await build({ entryPoints: ["server/gtfs.mjs"], outfile: file, bundle: true, platform: "node", format: "esm" });
  const { downloadGtfsNetwork, warsawDate } = await import(file);
  const result = await downloadGtfsNetwork();
  const directory = process.env.TRANSPLAN_GTFS_CACHE_DIR || "data/gtfs";
  await mkdir(directory, { recursive: true });
  const output = join(directory, `${warsawDate()}.json`);
  await writeFile(`${output}.tmp`, JSON.stringify(result)); await rename(`${output}.tmp`, output);
  console.log(JSON.stringify({ feeds: result.feeds, lines: result.lines.length, tram: result.lines.filter(l=>l.mode==="tram").length, stops: result.stops.length, ...result.report }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
