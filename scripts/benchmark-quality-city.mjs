// Full-city timing on supplied real OSM + GTFS inputs; never downloads data.
// --walking extract.json[.gz] --gtfs snapshot.json [--period wd_am] [--runs 1]
// Alternatively: --tram T.zip --bus A.zip --mobilis M.zip imports the GTFS first.
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--walking", "--gtfs", "--period", "--runs", "--output", "--tram", "--bus", "--mobilis", "--baseline-result", "--workers", "--compare-result"].includes(args[i]) || !args[i + 1]) throw new Error("Unknown or missing argument: " + args[i]);
  options[args[i].slice(2)] = args[i + 1];
}
if (!options.walking || !options["baseline-result"] && !options.gtfs && ![options.tram, options.bus, options.mobilis].every(Boolean))
  throw new Error("Provide --walking extract.json[.gz] and --gtfs snapshot.json, --baseline-result result.json, or --tram T.zip --bus A.zip --mobilis M.zip");
const runs = Number(options.runs ?? 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error("--runs must be 1–5");
const directory = await mkdtemp(join(tmpdir(), "transplan-city-benchmark-"));
try {
  const script = `
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { parseWalkingNetwork } from ${JSON.stringify(resolve("src/lib/walkingNetwork.ts"))};
import { runNetworkQuality } from ${JSON.stringify(resolve("server/networkQualityRunner.mjs"))};
import { calculateNetworkQualityAsync, normalizeNetworkQuality } from ${JSON.stringify(resolve("src/lib/networkQuality.ts"))};
import { NETWORK_QUALITY_PLACES, NETWORK_QUALITY_CATALOG_VERSION } from ${JSON.stringify(resolve("src/lib/networkQualityPlaces.ts"))};
import { PERIODS, BBOX } from ${JSON.stringify(resolve("src/constants.ts"))};
import { readGtfsArchives } from ${JSON.stringify(resolve("server/gtfs.mjs"))};
import { importGtfsNetwork } from ${JSON.stringify(resolve("src/lib/gtfsNetwork.ts"))};
import { setImmediate } from "node:timers/promises";
const options = ${JSON.stringify(options)}, period = options.period ?? 'wd_am';
if (!PERIODS.some(p => p.id === period)) throw new Error('Unknown period');
const preparationStart = performance.now();
let gtfs;
if (options["baseline-result"]) gtfs = { lines: [], stops: [] };
else if (options.gtfs) gtfs = JSON.parse(await readFile(options.gtfs, 'utf8'));
else {
  console.error('Importing all three GTFS feeds…');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date()).replaceAll('-', '');
  gtfs = importGtfsNetwork(await readGtfsArchives({ T: options.tram, A: options.bus, M: options.mobilis }), today);
}
console.error('Reading and parsing full OSM walking extract…');
const bytes = await readFile(options.walking), raw = bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes;
const osm = JSON.parse(raw.toString('utf8'));
if (osm.remark || !Array.isArray(osm.elements)) throw new Error('Incomplete OSM extract: ' + (osm.remark ?? 'no elements'));
const network = parseWalkingNetwork(osm.elements);
if (!network.edges.length || !options["baseline-result"] && (!gtfs.lines?.length || !gtfs.stops?.length)) throw new Error('Missing real city network data');
let baselineResult;
if (options["baseline-result"]) {
  baselineResult = JSON.parse(await readFile(options["baseline-result"], 'utf8'));
  network.fetchedAt = baselineResult.walkingFetchedAt;
}
let expected;
if (options["compare-result"]) {
  expected = JSON.parse(await readFile(options["compare-result"], 'utf8'));
  network.fetchedAt = expected.walkingFetchedAt;
}
const preparationMs = performance.now() - preparationStart;
const timings = []; let result;
for (let run = 0; run < ${runs}; run++) {
  const start = performance.now(); let last = start;
  console.error('Calculation ' + (run + 1) + ': ' + NETWORK_QUALITY_PLACES.length + ' places, ' + network.coords.length + ' walking vertices, ' + gtfs.lines.length + ' lines');
  const calculate = options.workers ? (input, yieldFn, progress) => runNetworkQuality(input, yieldFn, progress, { workers: Number(options.workers) }) : calculateNetworkQualityAsync;
  result = await calculate({ network, stops: gtfs.stops, lines: gtfs.lines, period }, () => setImmediate(), (done, total) => {
    const now = performance.now();
    if (now - last > 5000 || done === total) { console.error(done + '/' + total + ' origins, ' + ((now - start) / 1000).toFixed(1) + ' s'); last = now; }
  });
  timings.push(performance.now() - start);
}
const report = { measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model,
  catalogVersion: NETWORK_QUALITY_CATALOG_VERSION, period, bbox: BBOX, places: NETWORK_QUALITY_PLACES.length,
  origins: NETWORK_QUALITY_PLACES.reduce((n,p) => n + p.points.length,0), vertices: network.coords.length, edges: network.edges.length,
  lines: gtfs.lines.length, activeLines: result.activeLines, stops: gtfs.stops.length, departureSamples: 120,
  preparationMs: Math.round(preparationMs), calculationMs: timings.map(Math.round),
  firstCalculationIncludesGraphAndRasterPreparation: true, resultCacheUsed: false,
  scoreKm2: result.scoreKm2, complete: result.complete, totalWeight: result.totalWeight, connectedWeight: result.connectedWeight,
  connectedOrigins: result.places.reduce((n,p) => n + p.anchors.filter(a => a.connected).length,0),
  unconnectedStops: result.unconnectedStops, unconnectedPlaces: result.places.filter(p => p.anchors.some(a => !a.connected)).map(p => ({ id:p.id,name:p.name })),
  gtfsFeeds: gtfs.feeds, osmTimestamp: osm.osm3s?.timestamp_osm_base ?? null,
  calculationKind: baselineResult ? "walking-reference-with-normalization" : "gtfs-network",
  inputs: { walking: options.walking, baselineResult: options["baseline-result"] ?? null, gtfs: options.gtfs ?? { tram: options.tram, bus: options.bus, mobilis: options.mobilis } } };
if (expected) {
  let maxAreaError = 0;
  if (expected.catalogVersion !== result.catalogVersion || expected.places.length !== result.places.length) throw new Error('Mismatched comparison catalog');
  for (let p = 0; p < result.places.length; p++) {
    if (expected.places[p].id !== result.places[p].id) throw new Error('Mismatched comparison places');
    for (let i = 0; i < result.places[p].areasKm2.length; i++) maxAreaError = Math.max(maxAreaError, Math.abs(expected.places[p].areasKm2[i] - result.places[p].areasKm2[i]));
  }
  if (maxAreaError > 1e-9 || Math.abs(result.scoreKm2 - expected.scoreKm2) > 1e-9) throw new Error('Optimized score differs from reference: ' + maxAreaError);
  report.comparison = { reference: options["compare-result"], maxPlaceAreaErrorKm2: maxAreaError, scoreErrorKm2: Math.abs(result.scoreKm2 - expected.scoreKm2) };
}
report.workers = options.workers ? Number(options.workers) : 1;
if (baselineResult) {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date()).replaceAll('-', '');
  const normalizedBaseline = normalizeNetworkQuality(baselineResult, baselineResult, result, date);
  report.normalization = { baselineDate: date, baselineScore: normalizedBaseline.normalization.score,
    noTransitScore: normalizeNetworkQuality(result, baselineResult, result, date).normalization.score,
    baselineScoreKm2: baselineResult.scoreKm2, walkingOnlyScoreKm2: result.scoreKm2,
    walkingOnlyCalculationMs: timings.map(Math.round) };
  result = normalizedBaseline;
}
if (options.output) {
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\\n');
  await writeFile(options.output.replace(/\\.json$/, '') + '.result.json', JSON.stringify(result, null, 2) + '\\n');
}
console.log(JSON.stringify(report,null,2));
`;
  const outfile = join(directory, "city.mjs");
  await build({ stdin: { contents: script, resolveDir: process.cwd(), loader: "js" }, outfile,
    bundle: true, platform: "node", format: "esm" });
  await import(outfile);
} finally { await rm(directory, { recursive: true, force: true }); }
