// Bounded, local-only security audit probes. No requests to upstream services.
// Run from any directory: node audit/2026-10-31/reproduce.mjs
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "transplan-security-"));
const servers = [], children = [];
const results = {};
async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
try {
  const apiFile = join(temporary, "api.mjs");
  await build({ stdin: { contents: `
    export { createNetworkHandler } from './server/networks.mjs';
    export { createOverpassHandler } from './server/overpass.mjs';
    export { parseProposal } from './src/lib/proposal.ts';
    export { buildDailyTimetable } from './src/lib/timetable.ts';
    export { DEFAULT_TAKT } from './src/constants.ts';
  `, resolveDir: root }, outfile: apiFile, bundle: true, platform: "node", format: "esm" });
  const api = await import(pathToFileURL(apiFile).href);

  const production = join(temporary, "server.mjs");
  await build({ entryPoints: [resolve(root, "server/index.mjs")], outfile: production,
    bundle: true, platform: "node", format: "esm" });
  const child = spawn(process.execPath, [production], { cwd: root,
    env: { ...process.env, NODE_OPTIONS: "", HOST: "127.0.0.1", PORT: "0",
      TRANSPLAN_DATA_DIR: join(temporary, "production-networks"),
      TRANSPLAN_GTFS_CACHE_DIR: join(temporary, "production-gtfs"),
      TRANSPLAN_OSM_CACHE_DIR: join(temporary, "production-osm") }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const port = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      const match = /localhost:(\d+)/.exec(String(chunk));
      if (match) { clearTimeout(timer); accept(Number(match[1])); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited early: ${code}`)); });
  });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  results.documentHeaders = Object.fromEntries(["content-security-policy", "x-frame-options",
    "referrer-policy", "cache-control"].map((key) => [key, response.headers.get(key)]));
  await response.arrayBuffer();
  const exited = once(child, "exit");
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  socket.on("connect", () => socket.end("GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
  const crashTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const [code, signal] = await exited;
  clearTimeout(crashTimer);
  socket.destroy();
  results.malformedUrl = { exitCode: code, signal, invalidUrlError: stderr.includes("ERR_INVALID_URL") };
  assert.equal(code, 1);
  assert.ok(results.malformedUrl.invalidUrlError);

  const dataDir = join(temporary, "networks");
  const url = await listen(api.createNetworkHandler({ dataDir }));
  const proposal = { lines: [], localStops: Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`,
    name: "x".repeat(8000), lon: 19.94, lat: 50.06, modes: ["bus"], source: "local" })),
    localTracks: [], constructionOverrides: {} };
  const create = () => fetch(`${url}/api/networks`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposal }) });
  const created = [];
  for (let i = 0; i < 5; i++) {
    const response = await create(); assert.equal(response.status, 201); created.push(await response.json());
  }
  const access = created[0];
  for (let revision = 1; revision <= 5; revision++) {
    const response = await fetch(`${url}/api/networks/${access.id}`, { method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.writeToken}` },
      body: JSON.stringify({ proposal, revision }) });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  let bytes = 0;
  for (const id of await readdir(dataDir)) for (const file of await readdir(join(dataDir, id)))
    bytes += (await stat(join(dataDir, id, file))).size;
  results.storage = { anonymousCreates: created.length, revisionsRetained: (await readdir(join(dataDir, access.id)))
    .filter((name) => /^\d+\.json$/.test(name)).length, bytes };

  let inFlight = 0, peak = 0, upstreamCalls = 0;
  const overpassDir = join(temporary, "overpass");
  const proxy = await listen(api.createOverpassHandler({ directory: overpassDir, fetcher: async () => {
    upstreamCalls++; inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((accept) => setTimeout(accept, 40));
    inFlight--; return new Response('{"elements":[]}');
  } }));
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`${proxy}/overpass`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "cross-site" },
    body: new URLSearchParams({ data: `[out:json];node(1);out;/* ${i} */` }) })));
  for (const response of responses) { assert.equal(response.status, 200); await response.arrayBuffer(); }
  results.overpass = { requests: 12, upstreamCalls, peakConcurrency: peak,
    cacheFiles: (await readdir(overpassDir)).length, crossSiteAccepted: true };

  const malicious = { ...proposal, localStops: [], lines: [{ id: "test", number: "1", name: "Test", mode: "bus",
    color: "#000000", vehicle: "12m", visible: true, outboundStopIds: ["a", "b"], inboundStopIds: [],
    terminus1Id: "a", terminus2Id: "b", layoverMin: 0,
    segments: [{ id: "s", fromStopId: "a", toStopId: "b", direction: "outbound", travelMin: 1, geometry: [[19.9, 50], [19.91, 50]] }],
    takt: { ...api.DEFAULT_TAKT, wd_night: 1e-14 } }] };
  api.parseProposal(malicious);
  const maliciousResponse = await fetch(`${url}/api/networks`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposal: malicious }) });
  assert.equal(maliciousResponse.status, 201);
  await maliciousResponse.arrayBuffer();
  const payloadFile = join(temporary, "payload.json");
  const runner = join(temporary, "timetable.mjs");
  await writeFile(payloadFile, JSON.stringify(malicious));
  await writeFile(runner, `import { readFileSync } from 'node:fs';
    import { parseProposal, buildDailyTimetable } from ${JSON.stringify(pathToFileURL(apiFile).href)};
    const proposal = parseProposal(JSON.parse(readFileSync(${JSON.stringify(payloadFile)}, 'utf8')));
    console.log('accepted-and-starting');
    buildDailyTimetable(proposal.lines, 'weekday'); console.log('finished');`);
  const bounded = spawnSync(process.execPath, [runner], { timeout: 200, killSignal: "SIGKILL", encoding: "utf8" });
  results.timetable = { accepted: true, apiStatus: maliciousResponse.status, started: bounded.stdout.includes("accepted-and-starting"),
    timedOut: bounded.error?.code === "ETIMEDOUT", headway: 1e-14,
    floatingPointDoesNotAdvance: 1380 + 1e-14 === 1380 };
  assert.ok(results.timetable.started && results.timetable.timedOut);
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(servers.map((server) => new Promise((accept) => {
    server.close(accept); server.closeAllConnections();
  })));
  await rm(temporary, { recursive: true, force: true });
}
