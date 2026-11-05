// Run after npm run build. Exercises the actual production bundle in two processes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { once } from "node:events";
const directory = await mkdtemp(join(tmpdir(), "transplan-production-smoke-")), processes = [];
async function start() {
  const child = spawn(process.execPath, ["dist-server/index.mjs"], { env: { ...process.env, NODE_OPTIONS: "", HOST: "127.0.0.1", PORT: "0",
    TRANSPLAN_DATA_DIR: join(directory, "networks"), TRANSPLAN_MAX_NETWORKS: "1", TRANSPLAN_MAX_STORAGE_BYTES: "1048576",
    TRANSPLAN_GTFS_CACHE_DIR: join(directory, "gtfs"), TRANSPLAN_OSM_CACHE_DIR: join(directory, "osm") }, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Production startup timeout")), 5000);
    let output = "", errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => { output += chunk; const match = /localhost:(\d+)/.exec(output); if (match) { clearTimeout(timer); accept(Number(match[1])); } });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Production exited: ${code}, ${errors}`)); });
  });
}
const proposal = { lines: [], localStops: [], localTracks: [], constructionOverrides: {} }, headers = { "Content-Type": "application/json" };
try {
  // Seed a tiny valid walking extract. The bundled quality worker must work
  // without contacting external OSM services or compiling itself at runtime.
  const compiled = await build({ entryPoints: ["src/lib/osmQueries.ts"], bundle: true, platform: "node", format: "esm", write: false });
  const { OSM_QUERIES } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
  const key = createHash("sha256").update(`data=${encodeURIComponent(OSM_QUERIES.walking)}`).digest("hex");
  await mkdir(join(directory, "osm"));
  await writeFile(join(directory, "osm", `${key}.json.gz`), gzipSync(JSON.stringify({ elements: [{
    type: "way", id: 1, nodes: [1, 2], tags: { highway: "footway" },
    geometry: [{ lon: 19.9507208, lat: 50.0279769 }, { lon: 19.955, lat: 50.0279769 }],
  }] })));
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date()).replaceAll("-", "");
  await mkdir(join(directory, "gtfs"));
  await writeFile(join(directory, "gtfs", `${today}.json`), JSON.stringify({ version: 1, at: Date.now(), lines: [], stops: [], feeds: [] }));
  const ports = await Promise.all([start(), start()]);
  const responses = await Promise.all(ports.map((port) => fetch(`http://127.0.0.1:${port}/api/networks`, { method: "POST", headers, body: JSON.stringify({ proposal }) })));
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 507]);
  const created = await responses.find((r) => r.status === 201).json();
  const url = `http://127.0.0.1:${ports[1]}/api/networks/${created.id}`;
  assert.equal((await fetch(url)).status, 200);
  const rotated = await (await fetch(`${url}/access`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${created.ownerToken}` }, body: '{"action":"rotate"}' })).json();
  const save = (token) => fetch(url, { method: "PUT", headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify({ proposal, revision: 1 }) });
  assert.equal((await save(created.writeToken)).status, 403); assert.equal((await save(rotated.writeToken)).status, 200);
  const socket = connect(ports[0], "127.0.0.1"); let raw = "";
  socket.on("data", (chunk) => { raw += chunk; });
  socket.on("connect", () => socket.end("GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
  await once(socket, "close"); assert.match(raw, /^HTTP\/1\.1 400/);
  const workers = (await readdir("dist/assets")).filter((name) => /^maplibre-gl-worker-[\w-]+\.js$/.test(name));
  assert.equal(workers.length, 1, "The MapLibre worker must be emitted with the production build");
  for (const port of ports) {
    const response = await fetch(`http://127.0.0.1:${port}/`); assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-frame-options"), "DENY"); assert.equal(response.headers.get("referrer-policy"), "strict-origin");
    const html = await response.text(), script = /src="([^"]+\.js)"/.exec(html)?.[1]; assert.ok(script);
    assert.match(html, /name="referrer" content="strict-origin"/);
    const main = await fetch(`http://127.0.0.1:${port}${script}`);
    assert.equal(main.status, 200);
    assert.ok((await main.text()).includes(workers[0]), "The application must reference its emitted worker");
    const worker = await fetch(`http://127.0.0.1:${port}/assets/${workers[0]}`);
    assert.equal(worker.status, 200); assert.match(worker.headers.get("content-type"), /javascript/);
    const catalog = await (await fetch(`http://127.0.0.1:${port}/api/network-quality/places`)).json();
    assert.equal(catalog.places.length, 88);
  }
  const qualityUrl = `http://127.0.0.1:${ports[0]}/api/network-quality`;
  const startQuality = await fetch(qualityUrl, { method: "POST", headers, body: JSON.stringify({ proposal, period: "wd_am" }) });
  assert.equal(startQuality.status, 202);
  const started = await startQuality.json();
  let result;
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${qualityUrl}/${started.id}`);
    if (response.status === 200) { result = await response.json(); break; }
    assert.equal(response.status, 202);
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(result?.status, "done"); assert.equal(result.completedOrigins, 93);
  assert.equal(result.result.places.length, 88); assert.ok(result.result.scoreKm2 > 0);
  const cachedQuality = await fetch(qualityUrl, { method: "POST", headers, body: JSON.stringify({ proposal, period: "wd_am" }) });
  assert.equal(cachedQuality.status, 200);
  const scaledResponse = await fetch(qualityUrl, { method: "POST", headers, body: JSON.stringify({ proposal, period: "wd_am", scale: "gtfs" }) });
  assert.equal(scaledResponse.status, 202);
  const scaledJob = await scaledResponse.json();
  let scaled;
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${qualityUrl}/${scaledJob.id}`);
    if (response.status === 200) { scaled = await response.json(); break; }
    assert.equal(response.status, 202);
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(scaled?.status, "done");
  assert.equal(scaled.result.normalization.baselineDate, today);
  // This intentionally empty test GTFS has no gain over walking.
  assert.equal(scaled.result.normalization.score, null);
  assert.equal(scaled.result.normalization.reason, "baseline-has-no-transit-gain");
  console.log(JSON.stringify({ node: process.version, productionProcesses: 2, startup: "pass", sharedQuota: "pass", rotationAndSave: "pass", malformedUrlSurvival: "pass", securityHeadersAndAssets: "pass", mapWorkerAsset: "pass", qualityCatalogAndEmbeddedWorker: "pass", qualityCache: "pass", qualityGtfsScale: "pass" }, null, 2));
} finally {
  await Promise.all(processes.map(async (child) => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; } }));
  await rm(directory, { recursive: true, force: true });
}
