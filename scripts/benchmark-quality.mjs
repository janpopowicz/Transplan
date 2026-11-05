// Reproducible synthetic benchmark; no external downloads or saved projects.
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const directory = await mkdtemp(join(tmpdir(), "transplan-quality-benchmark-"));
try {
  const baseline = process.argv.includes("--baseline");
  if (baseline) {
    const contents = execFileSync("git", ["show", "HEAD:src/lib/isochrones.ts"], { encoding: "utf8" });
    await build({ stdin: { contents, resolveDir: resolve("src/lib"), loader: "ts" },
      bundle: true, platform: "node", format: "esm", outfile: join(directory, "baseline.mjs") });
  }
  const script = `
import assert from "node:assert/strict";
import { calculateIsochrones } from ${JSON.stringify(resolve("src/lib/isochrones.ts"))};
import { calculateNetworkQuality } from ${JSON.stringify(resolve("src/lib/networkQuality.ts"))};
import { calculateAccessibility, prepareAccessibilityBatch } from ${JSON.stringify(resolve("src/lib/pedestrianRouting.ts"))};
import { DEFAULT_TAKT } from ${JSON.stringify(resolve("src/constants.ts"))};
${baseline ? `import { calculateIsochrones as before } from ${JSON.stringify(join(directory, "baseline.mjs"))};` : ""}
const side = 41, coords = [], edges = [], spacing = 200;
for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
  coords.push([19.88 + x * spacing / 71300, 50.015 + y * spacing / 111195]);
  const node = y * side + x;
  if (x) edges.push({ from: node - 1, to: node, meters: spacing, forward: true, backward: true });
  if (y) edges.push({ from: node - side, to: node, meters: spacing, forward: true, backward: true });
}
const network = { coords, edges, fetchedAt: 0 };
const indices = Array.from({ length: side }, (_, x) => 20 * side + x);
const stops = indices.map((node, i) => ({ id: 's' + i, name: 's' + i, lon: coords[node][0], lat: coords[node][1], modes: ['bus'], source: 'local' }));
const line = { id: 'bus', number: '1', name: '1', mode: 'bus', vehicle: '12m', color: '#123456', visible: false,
  outboundStopIds: stops.map(s => s.id), inboundStopIds: [], terminus1Id: stops[0].id, terminus2Id: stops.at(-1).id,
  takt: { ...DEFAULT_TAKT, wd_am: 10 }, layoverMin: 5,
  segments: stops.slice(1).map((s, i) => ({ id: 'leg' + i, fromStopId: stops[i].id, toStopId: s.id, direction: 'outbound', travelMin: 1, geometry: [] })) };
const places = Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, name: 'p' + i, category: 'fixture', weight: 1,
  points: [{ name: 'p' + i, source: 'synthetic', coord: coords[(4 + (i % 4) * 10) * side + 4 + Math.floor(i / 4) * 14] }] }));
const origins = places.map(p => p.points[0].coord), request = { stops, lines: [line], period: 'wd_am', network, places };
function measure(fn, count = 3) {
  fn(); const samples = [];
  for (let i = 0; i < count; i++) { const start = performance.now(); fn(); samples.push(performance.now() - start); }
  return samples.sort((a,b) => a-b)[Math.floor(count / 2)];
}
const output = { fixture: { vertices: coords.length, edges: edges.length, origins: places.length, departureSamples: 120 } };
const after = calculateIsochrones({ ...request, origin: origins[0] });
${baseline ? `
const original = before({ ...request, origin: origins[0] });
assert.deepEqual(after, original);
// A sparse, disconnected fixture also exercises unknown-cell contour boundaries.
const sparse = { ...request, lines: [], network: { coords: [coords[0], coords.at(-1), [20.2, 50.15], [20.21, 50.15]], edges: [
  { from: 0, to: 1, meters: 17000, forward: true, backward: true },
  { from: 2, to: 3, meters: 750, forward: true, backward: true }], fetchedAt: 0 }, origin: coords[0] };
assert.deepEqual(calculateIsochrones(sparse), before(sparse));
output.geometryParity = 'identical GeoJSON, bands and metadata (dense and sparse fixtures)';
output.isochroneBeforeMs = measure(() => before({ ...request, origin: origins[0] }));
` : ""}
output.isochroneAfterMs = measure(() => calculateIsochrones({ ...request, origin: origins[0] }));
output.separateSearchesMs = measure(() => origins.forEach(origin => calculateAccessibility({ ...request, origin })));
output.batchedSearchesMs = measure(() => { const batch = prepareAccessibilityBatch(request, origins); origins.forEach((_, i) => batch.calculate(i)); });
output.fullIsochronesForAllOriginsMs = measure(() => origins.forEach(origin => calculateIsochrones({ ...request, origin })), 1);
output.qualityBatchMs = measure(() => calculateNetworkQuality(request));
output.qualityVsFullIsochronesSpeedup = output.fullIsochronesForAllOriginsMs / output.qualityBatchMs;
if (output.isochroneBeforeMs) output.contourSpeedup = output.isochroneBeforeMs / output.isochroneAfterMs;
for (const key of Object.keys(output)) if (typeof output[key] === 'number') output[key] = Math.round(output[key] * 100) / 100;
console.log(JSON.stringify(output, null, 2));
`;
  const entry = join(directory, "benchmark.mjs");
  await writeFile(entry, script);
  const outfile = join(directory, "benchmark-bundled.mjs");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile });
  await import(outfile);
} finally { await rm(directory, { recursive: true, force: true }); }
