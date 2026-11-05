import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "transplan-tests-"));
try {
  const outfile = join(dir, "interline.test.mjs");
  await build({ stdin: { contents: 'import "./tests/gtfsNetwork.test.ts"; import "./tests/gtfsApi.test.ts"; import "./tests/journey.test.ts"; import "./tests/geocode.test.ts"; import "./tests/timetable.test.ts"; import "./tests/gtfsTimes.test.ts"; import "./tests/overpass.test.ts"; import "./tests/gtfsStops.test.ts"; import "./tests/interline.test.ts"; import "./tests/editor.test.ts"; import "./tests/routing.test.ts"; import "./tests/isochrones.test.ts"; import "./tests/networkQuality.test.ts"; import "./tests/waypoints.test.ts"; import "./tests/planning.test.ts"; import "./tests/walkingDownload.test.ts"; import "./tests/sharing.test.ts"; import "./tests/security.test.ts";', resolveDir: process.cwd(), loader: "ts" }, outfile, banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, bundle: true, platform: "node", format: "esm" });
  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
