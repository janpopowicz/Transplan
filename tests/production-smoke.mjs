// Run after npm run build. Exercises the actual production bundle in two processes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
  }
  console.log(JSON.stringify({ node: process.version, productionProcesses: 2, startup: "pass", sharedQuota: "pass", rotationAndSave: "pass", malformedUrlSurvival: "pass", securityHeadersAndAssets: "pass", mapWorkerAsset: "pass" }, null, 2));
} finally {
  await Promise.all(processes.map(async (child) => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; } }));
  await rm(directory, { recursive: true, force: true });
}
