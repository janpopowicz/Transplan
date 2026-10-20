import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "transplan-tests-"));
try {
  const outfile = join(dir, "interline.test.mjs");
  await build({ stdin: { contents: 'import "./tests/interline.test.ts"; import "./tests/editor.test.ts"; import "./tests/routing.test.ts"; import "./tests/isochrones.test.ts"; import "./tests/waypoints.test.ts";', resolveDir: process.cwd(), loader: "ts" }, outfile, bundle: true, platform: "node", format: "esm" });
  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
