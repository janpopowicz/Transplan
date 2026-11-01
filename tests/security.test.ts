import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../server/index.mjs";
import { createNetworkHandler } from "../server/networks.mjs";
import { createOverpassHandler } from "../server/overpass.mjs";
import { createGeocodeHandler } from "../server/geocode.mjs";
import { createGtfsHandler } from "../server/gtfs.mjs";
import { json, limitedBytes, rateLimit, readJson, safeHandler } from "../server/security.mjs";
import { parseProposal, PROPOSAL_LIMITS, type Proposal } from "../src/lib/proposal";
import { DEFAULT_TAKT } from "../src/constants";
import { buildDailyTimetable, shiftDeparture, timetableDepartures } from "../src/lib/timetable";
import { browserAccess, networkAccess, networkLinks, rememberAccess } from "../src/lib/sharing";
import { OSM_QUERIES } from "../src/lib/osmQueries";
import { useStore } from "../src/store";

const empty: Proposal = { lines: [], localStops: [], localTracks: [], constructionOverrides: {} };
const fixture: Proposal = { ...empty, localStops: ["a", "b"].map((id, i) => ({ id, name: id, lon: 19.94 + i * .001, lat: 50.06, source: "local", modes: ["bus"] })),
  lines: [{ id: "line", number: "1", name: "Test", mode: "bus", vehicle: "12m", color: "#000000", visible: true,
    outboundStopIds: ["a", "b"], inboundStopIds: [], terminus1Id: "a", terminus2Id: "b", layoverMin: 5, takt: { ...DEFAULT_TAKT },
    segments: [{ id: "leg", fromStopId: "a", toStopId: "b", direction: "outbound", geometry: [[19.94, 50.06], [19.941, 50.06]], travelMin: 1 }] }] };
const headers = { "Content-Type": "application/json" };
const post = (url: string, body: unknown, extra = {}) => fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
async function service(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
async function directory() { return mkdtemp(join(tmpdir(), "transplan-security-test-")); }
async function raw(port: number, target: string, hostHeaders = "Host: localhost") {
  const socket = connect(port, "127.0.0.1"); let response = "";
  socket.on("data", (chunk) => { response += chunk; });
  socket.on("connect", () => socket.end(`GET ${target} HTTP/1.1\r\n${hostHeaders}\r\nConnection: close\r\n\r\n`));
  await once(socket, "close"); return response;
}

test("malformed request targets return 400 and the production app keeps serving requests", async () => {
  const root = await directory(); await writeFile(join(root, "index.html"), "<h1>ok</h1>");
  const server = createAppServer({ root, networkOptions: { dataDir: join(root, "networks") } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = server.address().port;
  try {
    for (const target of ["//", "//[", "/%FF", "/%00", "/%2e%2e/secret", "/a%2fb", "/foo\\bar", "/api/networks?x=%0A"])
      assert.match(await raw(port, target), /^HTTP\/1\.1 400/);
    assert.match(await raw(port, "/", "Host: localhost\r\nHost: evil.example"), /^HTTP\/1\.1 400/);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200); assert.match(await response.text(), /ok/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin");
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true }); }
});

test("unexpected asynchronous middleware failures are contained without exposing request data", async () => {
  const app = await service(safeHandler(async () => { throw new Error("private credential"); }));
  try { const response = await fetch(app.url); assert.equal(response.status, 500); assert.ok(!(await response.text()).includes("private")); }
  finally { await app.close(); }
});

test("all API routes reject unknown or duplicate query parameters before contacting upstream", async () => {
  const dir = await directory(); let calls = 0;
  const handlers = [createGeocodeHandler({ fetchImpl: async () => { calls++; throw new Error("must not fetch"); } }),
    createGtfsHandler({ directory: dir, download: async () => { calls++; throw new Error("must not fetch"); } }),
    createOverpassHandler({ directory: dir, fetcher: async () => { calls++; throw new Error("must not fetch"); } }),
    createNetworkHandler({ dataDir: join(dir, "networks") })];
  const app = await service((req, res) => {
    function next(i: number): unknown { return i === handlers.length ? res.writeHead(404).end() : handlers[i](req, res, () => next(i + 1)); }
    void next(0);
  });
  try {
    for (const path of ["/geocode?q=Rynek&q=Wawel", "/geocode?q=Rynek&url=http://evil", "/api/gtfs?refresh=2", "/api/gtfs?refresh=1&refresh=1",
      "/overpass?data=query", "/api/networks?admin=1", "/api/networks/00000000-0000-4000-8000-000000000000?revision=-1",
      "/api/networks/00000000-0000-4000-8000-000000000000?revision=1&revision=2"])
      assert.equal((await fetch(app.url + path)).status, 400, path);
    assert.equal(calls, 0);
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("strict project schema rejects malicious nested data, unknown fields, duplicate IDs and excessive complexity", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseProposal(fixture))), fixture);
  const mutations: ((v: any) => void)[] = [
    (v) => { v.admin = true; }, (v) => { v.lines[0].takt.wd_night = 1e-14; }, (v) => { v.lines[0].takt.wd_am = 1e308; },
    (v) => { v.lines[0].takt.unexpected = 10; }, (v) => { v.lines[0].color = "url(javascript:alert(1))"; },
    (v) => { v.lines[0].departureOffsets = { wd_am: { sideways: 2 } }; }, (v) => { v.lines[0].departureOffsetMin = 1e308; },
    (v) => { v.lines[0].serviceWindows = { wd_am: { outbound: [10, 5] } }; }, (v) => { v.lines[0].segments[0].travelMin = 1e308; },
    (v) => { v.lines[0].segments[0].fromStopId = "unreferenced"; }, (v) => { v.lines.push(v.lines[0]); },
    (v) => { v.localStops[0].id = "__proto__"; }, (v) => { v.localStops[0].modes = ["bus", "bus"]; },
    (v) => { v.localStops[0].lat = 1e308; }, (v) => { v.localStops[0].name = "a\u0000b"; },
    (v) => { v.localStops[0].name = "x".repeat(513); }, (v) => { v.localStops[0].payload = { nested: true }; },
    (v) => { v.lines[0].vehicle = "33m"; }, (v) => { v.lines[0].coordinatedLineIds = ["missing"]; },
    (v) => { v.lines[0].segments[0].geometry = [[-179, 0], [179, 0]]; },
    (v) => { v.lines[0].segments[0].geometry = Array(PROPOSAL_LIMITS.geometry + 1).fill([19.94, 50.06]); },
    (v) => { v.constructionOverrides = JSON.parse('{"__proto__":true}'); },
  ];
  for (const mutation of mutations) { const value = structuredClone(fixture); mutation(value); assert.throws(() => parseProposal(value)); }
});

test("timetable calculation rejects tiny headways even when the project schema is bypassed", () => {
  const malicious = structuredClone(fixture); malicious.lines[0].takt.wd_night = 1e-14;
  assert.throws(() => buildDailyTimetable(malicious.lines, "weekday"), /takt/);
  assert.throws(() => timetableDepartures({ lineId: "x", direction: "outbound", headway: 1e-14, phase: 0, elapsed: [0], stops: ["a"], minutes: [] }, "wd_am"), /takt/);
});

test("JSON API validates envelopes, revisions, media types, origin, encoding, UTF-8 and nested proposal data", async () => {
  const dir = await directory(), app = await service(createNetworkHandler({ dataDir: dir }));
  const url = `${app.url}/api/networks`;
  try {
    assert.equal((await post(url, { proposal: empty, extra: true })).status, 400);
    assert.equal((await post(url, null)).status, 400);
    assert.equal((await post(url, { proposal: empty }, { "Content-Encoding": "gzip" })).status, 415);
    assert.equal((await post(url, { proposal: empty }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post(url, { proposal: empty }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    const invalid = structuredClone(fixture); invalid.lines[0].takt.wd_night = 1e-14;
    assert.equal((await post(url, { proposal: invalid })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers, body: new Uint8Array([0xff, 0xfe]) })).status, 400);
    const created = await (await post(url, { proposal: empty })).json();
    for (const revision of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await fetch(`${url}/${created.id}`, { method: "PUT", headers: { ...headers, Authorization: `Bearer ${created.writeToken}` }, body: JSON.stringify({ proposal: empty, revision }) });
      assert.equal(response.status, 400);
    }
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("network creation quotas are atomic across handlers and persist after restart", async () => {
  const dir = await directory(), options = { dataDir: dir, maxNetworks: 1 };
  const a = await service(createNetworkHandler(options)), b = await service(createNetworkHandler(options));
  try {
    const responses = await Promise.all([a, b].map((s) => post(`${s.url}/api/networks`, { proposal: empty })));
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 507]);
    await a.close();
    const restarted = await service(createNetworkHandler(options));
    try { assert.equal((await post(`${restarted.url}/api/networks`, { proposal: empty })).status, 507); }
    finally { await restarted.close(); }
    const budget = JSON.parse(await readFile(join(dir, ".budget.json"), "utf8")); assert.equal(budget.networks, 1);
  } finally { await a.close(); await b.close(); await rm(dir, { recursive: true }); }
});

test("global byte quota rejects writes without publishing partial networks", async () => {
  const dir = await directory(), app = await service(createNetworkHandler({ dataDir: dir, maxStorageBytes: 100 }));
  try {
    assert.equal((await post(`${app.url}/api/networks`, { proposal: empty })).status, 507);
    assert.deepEqual((await readdir(dir)).filter((name) => !name.startsWith(".")), []);
    assert.deepEqual(JSON.parse(await readFile(join(dir, ".budget.json"), "utf8")), { networks: 0, bytes: 0 });
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("revision retention is bounded and polling uses a durable latest pointer", async () => {
  const dir = await directory(), app = await service(createNetworkHandler({ dataDir: dir, retainedRevisions: 2 }));
  try {
    const created = await (await post(`${app.url}/api/networks`, { proposal: empty })).json();
    for (let revision = 1; revision <= 5; revision++) {
      const response = await fetch(`${app.url}/api/networks/${created.id}`, { method: "PUT", headers: { ...headers, Authorization: `Bearer ${created.writeToken}` }, body: JSON.stringify({ proposal: empty, revision }) });
      assert.equal(response.status, 200);
    }
    const names = await readdir(join(dir, created.id));
    assert.deepEqual(names.filter((n) => /^\d+\.json$/.test(n)).sort(), ["5.json", "6.json"]);
    assert.equal(JSON.parse(await readFile(join(dir, created.id, "current.json"), "utf8")).revision, 6);
    assert.equal((await fetch(`${app.url}/api/networks/${created.id}?revision=6`)).status, 204);
    let actual = 0;
    for (const name of names) actual += (await stat(join(dir, created.id, name))).size;
    assert.ok(JSON.parse(await readFile(join(dir, ".budget.json"), "utf8")).bytes >= actual);
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("legacy network snapshots acquire a pointer and count against the storage quota", async () => {
  const dir = await directory(), id = "00000000-0000-4000-8000-000000000000";
  await mkdir(join(dir, id));
  await writeFile(join(dir, id, "1.json"), JSON.stringify({ revision: 1, updatedAt: "today", proposal: empty }));
  const app = await service(createNetworkHandler({ dataDir: dir, maxNetworks: 1 }));
  try {
    assert.equal((await fetch(`${app.url}/api/networks/${id}`)).status, 200);
    assert.equal(JSON.parse(await readFile(join(dir, id, "current.json"), "utf8")).revision, 1);
    assert.equal((await post(`${app.url}/api/networks`, { proposal: empty })).status, 507);
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("only the owner can rotate/revoke edit tokens, tokens expire and read links remain usable", async () => {
  const dir = await directory(); let clock = Date.now();
  const app = await service(createNetworkHandler({ dataDir: dir, now: () => clock }));
  try {
    const created = await (await post(`${app.url}/api/networks`, { proposal: empty })).json();
    const url = `${app.url}/api/networks/${created.id}`;
    const manage = (token: string, action: string) => post(`${url}/access`, { action }, { Authorization: `Bearer ${token}` });
    const save = (token: string) => fetch(url, { method: "PUT", headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify({ proposal: empty, revision: 1 }) });
    assert.equal((await manage(created.writeToken, "rotate")).status, 403);
    assert.equal((await save(created.ownerToken)).status, 403);
    assert.equal((await manage(created.ownerToken, "unknown")).status, 400);
    const rotated = await (await manage(created.ownerToken, "rotate")).json();
    assert.ok(rotated.writeToken && rotated.writeToken !== created.writeToken);
    assert.equal((await save(created.writeToken)).status, 403);
    clock += 31 * 86400000;
    assert.equal((await save(rotated.writeToken)).status, 403);
    const renewed = await (await manage(created.ownerToken, "rotate")).json();
    assert.equal((await save(renewed.writeToken)).status, 200);
    assert.equal((await manage(created.ownerToken, "revoke")).status, 200);
    assert.equal((await save(renewed.writeToken)).status, 403);
    const read = await fetch(url); assert.equal(read.status, 200);
    const raw = await read.text(); assert.ok(!raw.includes(created.ownerToken) && !raw.includes("Hash"));
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("OSM accepts only predefined operations and cannot be used as an arbitrary cross-site proxy", async () => {
  const dir = await directory(); let calls = 0;
  const app = await service(createOverpassHandler({ directory: dir, fetcher: async (_url, init) => {
    calls++; assert.equal(init.body, `data=${encodeURIComponent(OSM_QUERIES.tram)}`); return new Response('{"elements":[]}');
  } }));
  try {
    const url = `${app.url}/overpass`;
    assert.equal((await post(url, { kind: "__proto__" })).status, 400);
    assert.equal((await post(url, { kind: "tram", data: "arbitrary" })).status, 400);
    assert.equal((await post(url, { data: "arbitrary" })).status, 400);
    assert.equal((await post(url, { kind: "tram" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post(url, { kind: "tram" }, { Origin: "https://evil.example" })).status, 403);
    assert.equal(calls, 0);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(url, { kind: "tram" })));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(calls, 1); assert.equal((await readdir(dir)).filter((n) => n.endsWith(".gz")).length, 1);
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("OSM limits distinct in-flight operations and cleans obsolete cache keys", async () => {
  const dir = await directory(); await writeFile(join(dir, `${"f".repeat(64)}.json.gz`), "obsolete");
  let calls = 0; const releases: (() => void)[] = [];
  const app = await service(createOverpassHandler({ directory: dir, fetcher: async () => {
    calls++; await new Promise<void>((resolve) => releases.push(resolve)); return new Response('{"elements":[]}');
  } }));
  try {
    const first = post(`${app.url}/overpass`, { kind: "tram" });
    const second = post(`${app.url}/overpass`, { kind: "roads" });
    for (let i = 0; releases.length < 2 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(releases.length, 2);
    assert.equal((await post(`${app.url}/overpass`, { kind: "walking" })).status, 429);
    releases.forEach((release) => release());
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    assert.equal(calls, 2); assert.equal((await readdir(dir)).filter((n) => n.endsWith(".gz")).length, 2);
  } finally { releases.forEach((release) => release()); await app.close(); await rm(dir, { recursive: true }); }
});

test("upstream response byte limits apply to chunked bodies and cancel the stream", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(50)); c.enqueue(new Uint8Array(60)); }, cancel() { cancelled = true; } }));
  await assert.rejects(limitedBytes(response, 100)); assert.equal(cancelled, true);
  await assert.rejects(limitedBytes(new Response("small", { headers: { "Content-Length": "101" } }), 100));
});

test("rate limits are bounded, reset with time and do not trust spoofed forwarding headers", () => {
  let clock = 0; const limit = rateLimit({ now: () => clock, perClient: 2, global: 3, maxClients: 2 });
  const req = (address: string, forwarded = "") => ({ socket: { remoteAddress: address }, headers: { "x-forwarded-for": forwarded } });
  limit(req("a")); limit(req("a", "new-ip")); assert.throws(() => limit(req("a", "another-ip")), { status: 429 });
  limit(req("b")); assert.throws(() => limit(req("c")), { status: 429 });
  clock += 60000; assert.doesNotThrow(() => limit(req("a")));
});

test("share secrets stay in fragments/session values and clean read links never inherit edit permissions", () => {
  const names = ["window", "sessionStorage"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const access = { id: "00000000-0000-4000-8000-000000000000", writeToken: "00000000-0000-4000-8000-000000000001", ownerToken: "00000000-0000-4000-8000-000000000002" };
  const links = networkLinks(access, "https://planner.example/?old=1");
  assert.ok(!new URL(links.write).search.includes(access.writeToken));
  assert.equal(networkAccess(new URL(links.write).search, new URL(links.write).hash)!.writeToken, access.writeToken);
  assert.ok(!links.write.includes(access.ownerToken)); assert.ok(!links.owner!.includes(access.writeToken));
  let location = new URL(links.write); const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get location() { return location; }, history: { replaceState(_a: unknown, _b: string, href: string) { location = new URL(href); } } } });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } });
  try {
    rememberAccess(access); assert.equal(location.hash, "#edit"); assert.ok(!location.href.includes(access.writeToken));
    assert.deepEqual(browserAccess(), access); assert.ok([...memory.keys()].every((key) => !key.includes(access.writeToken)));
    location = new URL(links.read); assert.equal(browserAccess()!.writeToken, null); assert.equal(browserAccess()!.ownerToken, undefined);
  } finally { names.forEach((name, i) => descriptors[i] ? Object.defineProperty(globalThis, name, descriptors[i]!) : Reflect.deleteProperty(globalThis, name)); }
});

test("oversized imports are rejected before reading their file contents", async () => {
  const before = useStore.getState(); let read = false;
  try {
    useStore.setState({ access: "local" });
    await assert.rejects(useStore.getState().importJson({ size: 10 * 1024 * 1024 + 1, text: async () => { read = true; return "{}"; } } as File), /10 MB/);
    assert.equal(read, false);
  } finally { useStore.setState(before); }
});

test("chunked JSON body size limits produce a controlled 413 response", async () => {
  const app = await service(safeHandler(async (req, res) => { json(res, 200, await readJson(req, 64)); }));
  try {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":"'));
      controller.enqueue(new TextEncoder().encode("x".repeat(100) + '"}')); controller.close();
    } });
    const response = await fetch(app.url, { method: "POST", headers, body, duplex: "half" } as RequestInit);
    assert.equal(response.status, 413);
    assert.equal((await post(app.url, {})).status, 200);
  } finally { await app.close(); }
});

test("legacy write links can acquire an owner exactly once without leaking credentials on reads", async () => {
  const dir = await directory(), id = "00000000-0000-4000-8000-000000000000", token = "00000000-0000-4000-8000-000000000001";
  await mkdir(join(dir, id));
  await writeFile(join(dir, id, "access.json"), JSON.stringify({ writeHash: createHash("sha256").update(token).digest("hex") }));
  await writeFile(join(dir, id, "1.json"), JSON.stringify({ revision: 1, updatedAt: "today", proposal: empty }));
  const app = await service(createNetworkHandler({ dataDir: dir }));
  try {
    const url = `${app.url}/api/networks/${id}/access`;
    const response = await post(url, { action: "rotate" }, { Authorization: `Bearer ${token}` });
    assert.equal(response.status, 200); const access = await response.json();
    assert.ok(access.ownerToken && access.writeToken);
    assert.equal((await post(url, { action: "rotate" }, { Authorization: `Bearer ${token}` })).status, 403);
    assert.equal((await post(url, { action: "rotate" }, { Authorization: `Bearer ${access.writeToken}` })).status, 403);
    assert.equal((await post(url, { action: "revoke" }, { Authorization: `Bearer ${access.ownerToken}` })).status, 200);
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("repeated phase edits remain within the server schema bounds", () => {
  let lines = structuredClone(fixture.lines);
  for (let i = 0; i < 10; i++) lines = shiftDeparture(lines, "line", 1440, "wd_am", "outbound");
  assert.doesNotThrow(() => parseProposal({ ...fixture, lines }));
});

test("invalid downloaded GTFS snapshots cannot poison the persistent cache", async () => {
  const dir = await directory();
  const invalid = structuredClone(fixture); invalid.lines[0].takt.wd_am = 1e-14;
  const app = await service(createGtfsHandler({ directory: dir, download: async () => ({ version: 1, at: Date.now(), lines: invalid.lines, stops: [] }) }));
  try {
    assert.equal((await fetch(`${app.url}/api/gtfs`)).status, 502);
    assert.deepEqual(await readdir(dir), []);
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});

test("repeated revocation and renewal do not leak storage budget", async () => {
  const dir = await directory(), app = await service(createNetworkHandler({ dataDir: dir }));
  try {
    const created = await (await post(`${app.url}/api/networks`, { proposal: empty })).json();
    const before = JSON.parse(await readFile(join(dir, ".budget.json"), "utf8")).bytes;
    for (const action of ["revoke", "rotate", "revoke", "rotate"]) {
      assert.equal((await post(`${app.url}/api/networks/${created.id}/access`, { action }, { Authorization: `Bearer ${created.ownerToken}` })).status, 200);
    }
    assert.equal(JSON.parse(await readFile(join(dir, ".budget.json"), "utf8")).bytes, before);
  } finally { await app.close(); await rm(dir, { recursive: true }); }
});
