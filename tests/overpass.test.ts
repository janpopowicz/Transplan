import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheOverpassResponse, createOverpassHandler } from "../server/overpass.mjs";
import { fetchOsmRoads, fetchTramTracks } from "../src/lib/overpass";

async function serve(directory: string, fetcher: typeof fetch, options = {}) {
  const handler = createOverpassHandler({ directory, fetcher, ...options });
  const server = createServer((req, res) => { void handler(req, res, () => res.writeHead(404).end()); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/overpass`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const payload = { elements: [{ type: "node", id: 1, lat: 50.06, lon: 19.94 }] };

test("production Overpass proxy identifies the app, shares downloads and reuses compressed cache after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transplan-overpass-"));
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    assert.match(String((init!.headers as Record<string, string>)["User-Agent"]), /Transplan/);
    assert.equal(init!.body, "data=query");
    return new Response(JSON.stringify(payload));
  };
  let service = await serve(directory, fetcher);
  try {
    const options = { method: "POST", body: "data=query" };
    const results = await Promise.all([fetch(service.url, options), fetch(service.url, options)]);
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.headers.get("content-encoding"), "gzip");
      assert.deepEqual(await result.json(), payload);
    }
    assert.equal(calls, 1);
    await service.close();
    service = await serve(directory, async () => { throw new Error("Network must not be used for a cached extract"); });
    assert.deepEqual(await (await fetch(service.url, options)).json(), payload);
    assert.equal((await fetch(service.url)).status, 405);
    assert.equal((await fetch(service.url, { method: "POST", body: "invalid" })).status, 400);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("incomplete OSM responses never poison the server cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transplan-overpass-error-"));
  const service = await serve(directory, async () => new Response(JSON.stringify({ elements: [], remark: "timeout" })));
  try {
    assert.equal((await fetch(service.url, { method: "POST", body: "data=query" })).status, 502);
    assert.deepEqual(await readdir(directory), []);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("expired OSM cache serves the last good extract during an outage without repeated upstream requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transplan-overpass-stale-"));
  let clock = Date.now(), calls = 0;
  const file = await cacheOverpassResponse("data=query", JSON.stringify(payload), directory);
  const old = new Date(clock - 8 * 24 * 3600000);
  await utimes(file, old, old);
  const service = await serve(directory, async () => { calls++; throw new Error("offline"); }, { now: () => clock });
  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(service.url, { method: "POST", body: "data=query&irrelevant=1" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Transplan-Cache"), "stale");
      assert.deepEqual(await response.json(), payload);
    }
    assert.equal(calls, 2); // One attempt across the server's two providers.
    clock += 15 * 60000;
    assert.deepEqual(await (await fetch(service.url, { method: "POST", body: "data=query" })).json(), payload);
    assert.equal(calls, 4);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".gz")).length, 1);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("OSM cold-cache failures respect the retry cooldown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transplan-overpass-cooldown-"));
  let clock = Date.now(), calls = 0;
  const service = await serve(directory, async () => { calls++; throw new Error("offline"); }, { now: () => clock });
  try {
    const options = { method: "POST", body: "data=query" };
    const first = await fetch(service.url, options);
    assert.equal(first.status, 502);
    assert.equal(first.headers.get("Retry-After"), "900");
    assert.equal((await fetch(service.url, options)).status, 502);
    assert.equal(calls, 2);
    clock += 15 * 60000;
    assert.equal((await fetch(service.url, options)).status, 502);
    assert.equal(calls, 4);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("road and tram downloads cannot bypass the server cache when the server fails", async () => {
  const original = globalThis.fetch;
  const urls: unknown[] = [];
  globalThis.fetch = async (url) => { urls.push(url); return new Response("unavailable", { status: 502 }); };
  try {
    await assert.rejects(fetchOsmRoads(), /OSM/);
    await assert.rejects(fetchTramTracks(), /OSM/);
    assert.deepEqual(urls, ["/overpass", "/overpass"]);
  } finally { globalThis.fetch = original; }
});
