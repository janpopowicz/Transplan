import { test } from "node:test";
import { createHash } from "node:crypto";
import { MEAN_ROUTING_WASM } from "../src/lib/meanRoutingWasm";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, inflateRawSync } from "node:zlib";
import { calculateNetworkQuality, calculateNetworkQualityAsync, normalizeNetworkQuality, combineNetworkQualityParts } from "../src/lib/networkQuality";
import { NETWORK_QUALITY_PLACES, type QualityPlace } from "../src/lib/networkQualityPlaces";
import { calculateAccessibility, prepareAccessibilityBatch, projection } from "../src/lib/pedestrianRouting";
import { prepareAreaRaster } from "../src/lib/accessibilityRaster";
import { prepareMeanAccessibilityBatch } from "../src/lib/meanAccessibility";
import { haversine } from "../src/lib/geo";
import { DEFAULT_TAKT, BBOX } from "../src/constants";
import type { Coord, Stop, TransitLine } from "../src/types";
import type { WalkingNetwork } from "../src/lib/walkingNetwork";
import { runNetworkQuality } from "../server/networkQualityRunner.mjs";
import { createNetworkQualityHandler } from "../server/networkQuality.mjs";

const origin: Coord = [19.94, 50.06];
const coords: Coord[] = [origin, [19.945, 50.06], [20.02, 50.06], [20.025, 50.06]];
const network: WalkingNetwork = { coords, fetchedAt: 1000,
  edges: [{ from: 0, to: 1, meters: 357, forward: true, backward: true },
    { from: 2, to: 3, meters: 357, forward: true, backward: true }] };
const stops: Stop[] = [0, 2].map((node, i) => ({ id: `s${i}`, name: `s${i}`, lon: coords[node][0], lat: coords[node][1], modes: ["bus"], source: "local" }));
const route: TransitLine = { id: "bus", number: "1", name: "1", mode: "bus", vehicle: "12m", color: "#123456", visible: true,
  outboundStopIds: ["s0", "s1"], inboundStopIds: [], terminus1Id: "s0", terminus2Id: "s1", layoverMin: 5,
  takt: { ...DEFAULT_TAKT, wd_am: 10, wd_pm: null },
  segments: [{ id: "leg", fromStopId: "s0", toStopId: "s1", travelMin: 3, geometry: [], direction: "outbound" }] };
const place = (id: string, points: Coord[], weight = 1): QualityPlace => ({ id, name: id, category: "test", weight,
  points: points.map((coord) => ({ name: id, coord, source: "fixture" })) });
const places = [place("first", [origin], 3), place("second", [coords[2]])];
const request = { stops, lines: [route], network, period: "wd_am" as const, places };

test("batch matches independent origins, directionality, scenarios and edge splits without changing topology", () => {
  const origins: Coord[] = [origin, [19.942, 50.06], coords[2], [19.944, 50.0602]];
  const before = JSON.stringify(network);
  for (const scenario of ["mean", "best", "worst", "p90"] as const) {
    const batch = prepareAccessibilityBatch({ ...request, scenario }, [...origins, [19.7, 50.17]]);
    for (const [i, coord] of origins.entries()) {
      const expected = calculateAccessibility({ ...request, origin: coord, scenario });
      const actual = batch.calculate(i)!;
      for (let node = 0; node < network.coords.length; node++) {
        assert.ok(actual.times[node] === expected.times[node] || Math.abs(actual.times[node] - expected.times[node]) < 1e-8);
      }
      for (const [id, time] of expected.stopTimes) assert.ok(time === actual.stopTimes.get(id) || Math.abs(time - actual.stopTimes.get(id)!) < 1e-8);
    }
    assert.equal(batch.calculate(origins.length), null);
  }
  assert.equal(JSON.stringify(network), before);
});

test("quality is an exact weighted mean of place areas and equally weighted thresholds", () => {
  const result = calculateNetworkQuality(request);
  const singles = places.map((p) => calculateNetworkQuality({ ...request, places: [p] }));
  assert.equal(result.totalWeight, 4);
  assert.ok(Math.abs(result.scoreKm2 - (singles[0].scoreKm2 * 3 + singles[1].scoreKm2) / 4) < 1e-12);
  result.weightedAreasKm2.forEach((value, i) => assert.ok(Math.abs(value - (singles[0].weightedAreasKm2[i] * 3 + singles[1].weightedAreasKm2[i]) / 4) < 1e-12));
  assert.equal(result.scoreKm2, result.weightedAreasKm2.reduce((sum, a) => sum + a, 0) / 4);
  assert.ok(result.scoreKm2 > 0);
  assert.equal(result.complete, true);
  assert.equal(result.direction, "from-places");
  assert.equal(result.resolutionMeters, 100);
  assert.deepEqual(result.bbox, BBOX);
});

test("campus anchors share one weight and duplicating an identical anchor does not increase its score", () => {
  const single = calculateNetworkQuality({ ...request, places: [places[0]] });
  const campus = calculateNetworkQuality({ ...request, places: [place("campus", [origin, origin, origin], 3)] });
  assert.equal(campus.totalWeight, 3);
  assert.ok(Math.abs(single.scoreKm2 - campus.scoreKm2) < 1e-12);
  const mixed = calculateNetworkQuality({ ...request, places: [place("campus", [origin, coords[2]], 3)] });
  const second = calculateNetworkQuality({ ...request, places: [places[1]] });
  assert.ok(Math.abs(mixed.scoreKm2 - (single.scoreKm2 + second.scoreKm2) / 2) < 1e-12);
});

test("missing origins retain their weight as zero and expose connection diagnostics", () => {
  const disconnected: Coord = [19.7, 50.17];
  const single = calculateNetworkQuality({ ...request, places: [places[0]] });
  const mixed = calculateNetworkQuality({ ...request, places: [places[0], place("missing", [disconnected], 3)] });
  assert.equal(mixed.complete, false);
  assert.equal(mixed.totalWeight, 6);
  assert.equal(mixed.connectedWeight, 3);
  assert.equal(mixed.scoreKm2, single.scoreKm2 / 2);
  assert.deepEqual(mixed.places[1].anchors[0], { coord: disconnected, connected: false, snapMeters: null });
  assert.equal(calculateNetworkQuality({ ...request, places: [place("missing", [disconnected])] }).scoreKm2, 0);
});

test("transit improves geometry, hidden lines keep running and an inactive period returns walking-only quality", () => {
  const walk = calculateNetworkQuality({ ...request, lines: [] });
  const transit = calculateNetworkQuality(request);
  const hidden = calculateNetworkQuality({ ...request, lines: [{ ...route, visible: false }] });
  const inactive = calculateNetworkQuality({ ...request, period: "wd_pm" });
  assert.ok(transit.scoreKm2 > walk.scoreKm2);
  assert.equal(hidden.scoreKm2, transit.scoreKm2);
  assert.equal(inactive.scoreKm2, walk.scoreKm2);
  for (const p of transit.places) for (let i = 1; i < p.areasKm2.length; i++) assert.ok(p.areasKm2[i] >= p.areasKm2[i - 1]);
  assert.equal(transit.activeLines, 1);
});

test("area raster deduplicates overlapping streets and respects walking direction and unreachable components", () => {
  const project = projection(origin), xy = coords.map(project.toXY);
  const edge = { ...network.edges[0], backward: false };
  const raster = prepareAreaRaster(xy, [edge], project, 100);
  const duplicate = prepareAreaRaster(xy, [edge, edge, edge], project, 100);
  const forward = new Float64Array([0, Infinity, Infinity, Infinity]);
  assert.deepEqual(duplicate.areasKm2(forward, [1, 10]), raster.areasKm2(forward, [1, 10]));
  assert.ok(raster.areasKm2(forward, [10])[0] > 0);
  assert.deepEqual(raster.areasKm2(new Float64Array([Infinity, 0, Infinity, Infinity]), [10]), [0]);
});

test("asynchronous engine agrees with synchronous score and reports each anchor exactly once", async () => {
  const progress: number[] = []; let yields = 0;
  const asyncResult = await calculateNetworkQualityAsync(request, async () => { yields++; }, (done) => progress.push(done));
  assert.deepEqual(asyncResult, calculateNetworkQuality(request));
  assert.deepEqual(progress, [1, 2]); assert.equal(yields, 2);
  assert.throws(() => calculateNetworkQuality({ ...request, places: [] }), /katalog/);
  assert.throws(() => calculateNetworkQuality({ ...request, places: [place("bad", [origin], 0)] }), /katalog/);
});

test("catalog contains all seven categories and KMZ contains exactly its coordinates and weights", async () => {
  const entries = NETWORK_QUALITY_PLACES;
  assert.equal(entries.length, 88); assert.equal(new Set(entries.map((p) => p.id)).size, entries.length);
  assert.equal(new Set(entries.map((p) => p.category)).size, 7);
  for (const p of entries) for (const point of p.points) {
    assert.ok(point.coord[0] >= BBOX.west && point.coord[0] <= BBOX.east && point.coord[1] >= BBOX.south && point.coord[1] <= BBOX.north);
    assert.match(point.source, /^https:\/\/www.openstreetmap.org\/(node|way|relation)\/\d+$/);
  }
  for (const name of ["Stadion Wisły", "Stadion Cracovii", "TAURON Arena Kraków"]) assert.equal(entries.find((p) => p.name === name)?.weight, 1);
  assert.equal(entries.find((p) => p.name === "AGH")!.points.length, 3);
  assert.equal(entries.find((p) => p.name === "UJ Ruczaj")!.weight, 3);
  const zip = await readFile("artifacts/network-quality/miejsca.kmz");
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const offset = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  const kml = inflateRawSync(zip.subarray(offset, offset + zip.readUInt32LE(18))).toString("utf8");
  assert.equal(kml, await readFile("artifacts/network-quality/miejsca.kml", "utf8"));
  assert.equal((kml.match(/<Placemark /g) ?? []).length, entries.reduce((n, p) => n + p.points.length, 0));
  for (const p of entries) for (const [i, point] of p.points.entries()) {
    const placemark = kml.split(`<Placemark id="${p.id}-${i + 1}">`)[1].split("</Placemark>")[0];
    assert.ok(placemark.includes(`<coordinates>${point.coord.join(",")},0</coordinates>`));
    assert.ok(placemark.includes(`<Data name="anchorWeight"><value>${p.weight / p.points.length}</value>`));
  }
});

const proposal = { lines: [], localStops: [], localTracks: [], constructionOverrides: {} };
async function apiFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "transplan-quality-api-"));
  const file = join(directory, "walking.json.gz"), stopsFile = join(directory, "stops.json");
  const elements = (options as any).walkingElements ?? [{ type: "way", id: 1, nodes: [1, 2], geometry: coords.slice(0, 2).map(([lon, lat]) => ({ lon, lat })), tags: { highway: "footway" } }];
  await writeFile(file, gzipSync(JSON.stringify({ elements })));
  await writeFile(stopsFile, JSON.stringify({ version: 1, stops: [] }));
  let loads = 0;
  const handler = createNetworkQualityHandler({ stopsFile, source: async () => { loads++; return { file, stale: false }; }, places: [places[0]], ...options });
  const server = createServer((req, res) => { void handler(req, res); }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/network-quality`;
  return { url, file, loads: () => loads, post: (value: unknown, extraHeaders = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(value) }),
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rm(directory, { recursive: true, force: true }); } };
}
async function poll(url: string) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(url), job = await response.json();
    if (response.status !== 202) return { response, job };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Analysis did not finish");
}

test("quality HTTP API runs a real worker, exposes catalog/progress, caches snapshots and invalidates changed OSM", async () => {
  const api = await apiFixture();
  try {
    const catalog = await (await fetch(`${api.url}/places`)).json(); assert.equal(catalog.places[0].id, places[0].id);
    const started = await api.post({ proposal, period: "wd_am" }); assert.equal(started.status, 202);
    assert.match(started.headers.get("location")!, /^\/api\/network-quality\/[a-f0-9]{64}$/);
    const job = await started.json(); const done = await poll(`${api.url}/${job.id}`);
    assert.equal(done.response.status, 200); assert.equal(done.job.status, "done");
    assert.ok(done.job.result.scoreKm2 > 0); assert.equal(done.job.completedOrigins, 1);
    const cached = await api.post({ proposal, period: "wd_am" }); assert.equal(cached.status, 200); assert.equal((await cached.json()).id, job.id);
    const info = await import("node:fs/promises").then((fs) => fs.stat(api.file));
    await utimes(api.file, info.atime, new Date(info.mtimeMs + 2000));
    const changed = await api.post({ proposal, period: "wd_am" }); assert.equal(changed.status, 202);
    const next = await changed.json(); assert.notEqual(next.id, job.id); assert.equal((await poll(`${api.url}/${next.id}`)).response.status, 200);
    assert.equal((await fetch(`${api.url}/${"0".repeat(64)}`)).status, 404);
  } finally { await api.close(); }
});

test("quality API validates input before loading OSM and rejects cross-origin requests", async () => {
  const api = await apiFixture();
  try {
    for (const body of [{ proposal, period: "bad" }, { proposal, period: "wd_am", extra: true }, { proposal: { ...proposal, extra: true }, period: "wd_am" }]) {
      assert.equal((await api.post(body)).status, 400);
    }
    assert.equal((await api.post({ proposal, period: "wd_am" }, { Origin: "https://foreign.example" })).status, 403);
    assert.equal((await fetch(`${api.url}/places?extra=1`)).status, 400);
    assert.equal((await fetch(`${api.url}/places?x=1&x=2`)).status, 400);
    assert.equal((await fetch(api.url, { method: "PUT" })).status, 405);
    assert.equal(api.loads(), 0);
  } finally { await api.close(); }
});

test("in-flight identical requests share work, other jobs are bounded and failed jobs release capacity", async () => {
  let release: (() => void) | undefined, calls = 0;
  const gate = new Promise<void>((r) => { release = r; });
  const api = await apiFixture({ calculate: async () => { calls++; await gate; throw new Error("private internal details"); } });
  try {
    const first = await (await api.post({ proposal, period: "wd_am" })).json();
    const same = await api.post({ proposal, period: "wd_am" }); assert.equal(same.status, 202); assert.equal((await same.json()).id, first.id);
    assert.equal((await api.post({ proposal, period: "wd_pm" })).status, 429);
    assert.equal(api.loads(), 1); assert.equal(calls, 1);
    release!();
    const failed = await poll(`${api.url}/${first.id}`); assert.equal(failed.response.status, 502); assert.ok(!JSON.stringify(failed.job).includes("private"));
    assert.equal((await api.post({ proposal, period: "wd_pm" })).status, 202);
    // Let the injected failure settle before removing its temporary context.
    await new Promise((r) => setTimeout(r, 10));
  } finally { release!(); await api.close(); }
});


test("normalization anchors walking at 0, today's GTFS at 100 and permits scores above 100", () => {
  const walking = calculateNetworkQuality({ ...request, lines: [] });
  const baseline = calculateNetworkQuality(request);
  assert.equal(normalizeNetworkQuality(walking, baseline, walking, "20261104").normalization!.score, 0);
  assert.equal(normalizeNetworkQuality(baseline, baseline, walking, "20261104").normalization!.score, 100);
  const gain = baseline.scoreKm2 - walking.scoreKm2;
  for (const factor of [0.5, 1.5, 2]) {
    const candidate = { ...baseline, scoreKm2: walking.scoreKm2 + gain * factor };
    assert.ok(Math.abs(normalizeNetworkQuality(candidate, baseline, walking, "20261104").normalization!.score! - factor * 100) < 1e-9);
  }
  const degenerate = normalizeNetworkQuality(walking, walking, walking, "20261104");
  assert.equal(degenerate.normalization!.score, null);
  assert.equal(degenerate.normalization!.reason, "baseline-has-no-transit-gain");
  assert.throws(() => normalizeNetworkQuality({ ...baseline, period: "wd_pm" }, baseline, walking, "20261104"), /Niezgodne/);
  assert.throws(() => normalizeNetworkQuality({ ...baseline, walkingFetchedAt: 2000 }, baseline, walking, "20261104"), /Niezgodne/);
  assert.throws(() => normalizeNetworkQuality(baseline, baseline, walking, "bad"), /Niezgodne/);
});

test("scaled API uses today's GTFS, shares reference results, and computes zero for no transit", async () => {
  let baselineLoads = 0;
  const snapshot = { version: 1, at: 1000, lines: [route], stops };
  const api = await apiFixture({ date: () => "20261104", gtfsSource: async (options: { requireToday: boolean }) => {
    baselineLoads++; assert.equal(options.requireToday, true); return { snapshot, date: "20261104", stale: false };
  }, walkingElements: [{ type: "way", id: 1, nodes: [1, 2], geometry: [coords[0], coords[2]].map(([lon, lat]) => ({ lon, lat })), tags: { highway: "footway" } }] });
  const imported = { ...proposal, lines: [route], localStops: stops };
  try {
    const first = await api.post({ proposal: imported, period: "wd_am", scale: "gtfs" }); assert.equal(first.status, 202);
    const firstJob = await first.json(), baseline = await poll(`${api.url}/${firstJob.id}`);
    assert.equal(baseline.response.status, 200);
    assert.equal(baseline.job.result.normalization.score, 100);
    assert.equal(baseline.job.result.normalization.baselineDate, "20261104");
    assert.equal(baseline.job.totalOrigins, 3); assert.equal(baseline.job.completedOrigins, 3);
    const weaker = await (await api.post({ proposal: { ...imported, lines: [{ ...route, takt: { ...route.takt, wd_am: 20 } }] }, period: "wd_am", scale: "gtfs" })).json();
    const worse = await poll(`${api.url}/${weaker.id}`);
    assert.equal(worse.response.status, 200);
    assert.equal(worse.job.totalOrigins, 1);
    assert.ok(worse.job.result.normalization.score < 100);
    assert.ok(worse.job.result.normalization.score >= 0);
    const empty = await (await api.post({ proposal, period: "wd_am", scale: "gtfs" })).json();
    const noTransit = await poll(`${api.url}/${empty.id}`);
    assert.equal(noTransit.response.status, 200); assert.equal(noTransit.job.result.normalization.score, 0);
    assert.equal(baselineLoads, 3);
  } finally { await api.close(); }
});

test("scaled API never substitutes yesterday's GTFS for today's baseline", async () => {
  const api = await apiFixture({ date: () => "20261104", gtfsSource: async () => ({ date: "20261103", snapshot: { lines: [], stops: [] } }) });
  try {
    assert.equal((await api.post({ proposal, period: "wd_am", scale: "gtfs" })).status, 502);
    assert.equal((await api.post({ proposal, period: "wd_am", scale: "percent" })).status, 400);
  } finally { await api.close(); }
});


test("contracted mean routing restores every geometry vertex, including changing approach ends", () => {
  const path: Coord[] = Array.from({ length: 61 }, (_, i) => [19.94 + i * 0.001, 50.06]);
  const source: Coord = [19.93, 50.045];
  const coords: Coord[] = [...path, source, [source[0] + .001, source[1]]];
  const walking: WalkingNetwork = { coords, fetchedAt: 0, edges: [
    ...path.slice(1).map((p, i) => ({ from: i, to: i + 1, meters: haversine(path[i], p), forward: true, backward: true })),
    { from: 61, to: 62, meters: 71.5, forward: true, backward: true },
  ] };
  const stop = (id: string, point: Coord): Stop => ({ id, name: id, lon: point[0], lat: point[1], modes: ["bus"], source: "local" });
  const platforms = [stop("o", source), stop("a", path[0]), stop("b", path[60])];
  const line = (id: string, target: string, phase: number): TransitLine => ({ ...route, id, departureOffsetMin: phase,
    outboundStopIds: ["o", target], inboundStopIds: [], terminus1Id: "o", terminus2Id: target,
    segments: [{ ...route.segments[0], id: id + "leg", fromStopId: "o", toStopId: target, travelMin: 2 }] });
  const lines = [line("left", "a", 0), line("right", "b", 5)];
  const origins: Coord[] = [source, path[0], path[17], [path[31][0] + .0004, path[31][1] + .0001]];
  for (const bidirectional of [true, false]) {
    const network = { ...walking, edges: walking.edges.map((e, i) => i < 60 ? { ...e, backward: bidirectional } : e) };
    const input = { ...request, stops: platforms, lines, network };
    const batch = prepareMeanAccessibilityBatch(input, origins);
    assert.ok(batch.searchNodeCount < coords.length / 2);
    for (const [i, origin] of origins.entries()) {
      const actual = batch.calculate(i)!, expected = calculateAccessibility({ ...input, origin });
      for (let node = 0; node < coords.length; node++) assert.ok(actual.times[node] === expected.times[node]
        || Math.abs(actual.times[node] - expected.times[node]) < 1e-8, `direction ${bidirectional}, origin ${i}, node ${node}: ${actual.times[node]} vs ${expected.times[node]}`);
      if (i === 0 && bidirectional) {
        const midpointWalking = walking.edges.slice(0, 30).reduce((sum, e) => sum + e.meters / 80, 0);
        assert.ok(actual.times[30] < Math.min(actual.times[0], actual.times[60]) + midpointWalking - 0.5);
      }
    }
  }
});

test("contracted routing preserves cycles, direction changes, disconnected components and inactive services", () => {
  const coords: Coord[] = Array.from({ length: 16 }, (_, i) => [19.94 + (i % 4) * .002, 50.06 + Math.floor(i / 4) * .002]);
  const pairs = [[0,1],[1,2],[2,3],[3,7],[7,6],[6,5],[5,4],[4,0],[8,9],[9,10],[10,11],[11,15],[15,14],[14,13],[13,12],[12,8]];
  for (let variant = 0; variant < 4; variant++) {
    const network: WalkingNetwork = { coords, fetchedAt: 0, edges: pairs.map(([from, to], i) => ({ from, to, meters: haversine(coords[from], coords[to]),
      forward: variant !== 3 || i % 3 !== 0, backward: variant === 0 || variant === 2 && i % 2 === 0 })) };
    const origins = [coords[0], coords[5], coords[8], [19.7, 50.17] as Coord];
    const input = { ...request, stops: [], lines: [], network };
    const batch = prepareMeanAccessibilityBatch(input, origins);
    for (let i = 0; i < 3; i++) {
      const expected = calculateAccessibility({ ...input, origin: origins[i] });
      const actual = batch.calculate(i)!;
      for (let node = 0; node < coords.length; node++) assert.ok(expected.times[node] === actual.times[node]
        || Math.abs(expected.times[node] - actual.times[node]) < 1e-8, `variant ${variant}, origin ${i}, node ${node}`);
    }
    assert.equal(batch.calculate(3), null);
  }
});


test("pruned walking trees retain access directions, interior origins, stop attachments and mean times", () => {
  const coords: Coord[] = Array.from({ length: 25 }, (_, i) => [19.94 + i * .001, 50.06]);
  const edges = coords.slice(1).map((p, i) => ({ from: i, to: i + 1, meters: haversine(coords[i], p), forward: true, backward: true }));
  for (let branch = 0; branch < 8; branch++) {
    let parent = 2 + branch * 3;
    for (let depth = 1; depth <= 5; depth++) {
      const child = coords.length, point: Coord = [coords[parent][0], coords[parent][1] + .001];
      coords.push(point); edges.push({ from: parent, to: child, meters: haversine(coords[parent], point), forward: branch !== 3, backward: branch !== 5 }); parent = child;
    }
  }
  const network: WalkingNetwork = { coords, edges, fetchedAt: 0 };
  const platforms: Stop[] = [0, 24].map((node, i) => ({ ...stops[i], lon: coords[node][0], lat: coords[node][1] }));
  const origins = [coords[0], coords[40], coords[64], [coords[35][0], coords[35][1] + .0003] as Coord];
  for (const lines of [[], [route], [{ ...route, takt: { ...route.takt, wd_am: 240 }, departureOffsetMin: 7.25 }]]) {
    const input = { ...request, stops: platforms, lines, network }, batch = prepareMeanAccessibilityBatch(input, origins);
    assert.ok(batch.searchNodeCount < coords.length / 2);
    const previous = batch.calculate(0)!; const saved = previous.times.slice();
    for (const [i, origin] of origins.entries()) {
      const expected = calculateAccessibility({ ...input, origin }), actual = batch.calculate(i)!;
      for (let node = 0; node < coords.length; node++) assert.ok(expected.times[node] === actual.times[node]
        || Math.abs(expected.times[node] - actual.times[node]) < 1e-8, `origin ${i}, node ${node}`);
    }
    assert.deepEqual(previous.times, saved, "later origins must not mutate earlier WASM results");
  }
});

test("parallel origin partitions preserve the full raster and reject missing or duplicate origins", async () => {
  const input = { ...request, places: [place("campus", [origin, coords[2]], 3), place("other", [coords[1]])] };
  const expected = calculateNetworkQuality(input);
  const indices = [[0, 2], [1]];
  const parts = await Promise.all(indices.map(async (indices) => ({ indices,
    result: await calculateNetworkQualityAsync(input, async () => {}, () => {}, indices) })));
  assert.deepEqual(combineNetworkQualityParts(parts), expected);
  assert.throws(() => combineNetworkQualityParts(parts.slice(0, 1)), /Niepełny/);
  assert.throws(() => combineNetworkQualityParts([parts[0], parts[0], parts[1]]), /podział/);
  let completed = 0;
  const parallel = await runNetworkQuality(input, async () => {}, (done: number, total: number) => { completed = done; assert.equal(total, 3); }, { workers: 2 });
  assert.deepEqual(parallel, expected); assert.equal(completed, 3);
});


test("portable routing kernel matches its C source and imports only isolated memory", async () => {
  const source = await readFile("src/lib/native/meanRouting.c");
  const generated = await readFile("src/lib/meanRoutingWasm.ts", "utf8");
  assert.ok(generated.includes("Source SHA-256: " + createHash("sha256").update(source).digest("hex")));
  const module = new WebAssembly.Module(Buffer.from(MEAN_ROUTING_WASM, "base64"));
  assert.deepEqual(WebAssembly.Module.imports(module), [{ module: "env", name: "memory", kind: "memory" }]);
});
