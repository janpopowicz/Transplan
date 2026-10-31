import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGtfsHandler } from "../server/gtfs.mjs";
import { createGtfsArchiveCache } from "../server/gtfsArchives.mjs";

// A real ZIP containing stops.txt; the server checks integrity before publishing it.
const archiveBytes = Buffer.from("UEsDBBQAAAAIAL2hX10Om8VjGAAAABkAAAAJAAAAc3RvcHMudHh0Ky7JL4jPTNEpBtF5ibmpXIY6IanFJVwAUEsBAhQDFAAAAAgAvaFfXQ6bxWMYAAAAGQAAAAkAAAAAAAAAAAAAAIABAAAAAHN0b3BzLnR4dFBLBQYAAAAAAQABADcAAAA/AAAAAAA=", "base64");

test("GTFS API shares downloads, survives restarts and throttles explicit refreshes",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"transplan-gtfs-api-test-"));
  let downloads=0;
  let clock = Date.now();
  const download=async()=>{downloads++;await new Promise(resolve=>setTimeout(resolve,10));return {version:1,at:clock,lines:[],feeds:[],stops:[],test:downloads};};
  const options = {directory:dir,download,now:()=>clock};
  let handler=createGtfsHandler(options);
  const server=createServer((req,res)=>{void handler(req,res,()=>res.writeHead(404).end());});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/gtfs`;
  try {
    const responses=await Promise.all([fetch(url),fetch(url)]);
    assert.ok(responses.every(r=>r.status===200));assert.equal(downloads,1);
    assert.equal((await responses[0].json()).test,1);
    handler=createGtfsHandler(options);
    assert.equal((await(await fetch(url)).json()).test,1);assert.equal(downloads,1);
    assert.equal((await(await fetch(`${url}?refresh=1`)).json()).test,1);assert.equal(downloads,1);
    clock += 3600000;
    assert.equal((await(await fetch(`${url}?refresh=1`)).json()).test,2);assert.equal(downloads,2);
    clock += 7 * 3600000;
    assert.equal((await(await fetch(url)).json()).test,2);assert.equal(downloads,2);
    assert.equal((await fetch(url,{method:"POST"})).status,405);
    assert.equal((await fetch(`${url}/unsupported`)).status,404);
  } finally {await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});await rm(dir,{recursive:true,force:true});}
});

async function serve(handler: ReturnType<typeof createGtfsHandler>) {
  const server = createServer((req, res) => { void handler(req, res, () => res.writeHead(404).end()); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/gtfs`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("GTFS serves the last intact daily snapshot during an outage and backs off refresh attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transplan-gtfs-stale-"));
  let clock = Date.now(), calls = 0;
  const saved = { version: 1, at: clock - 25 * 3600000, lines: [], stops: [], test: "saved" };
  await writeFile(join(directory, "20261030.json"), JSON.stringify(saved));
  await writeFile(join(directory, "20261031.json"), "broken JSON");
  const handler = createGtfsHandler({ directory, now: () => clock, date: () => "20261031", download: async () => {
    calls++; throw new Error("test upstream unavailable");
  } });
  const service = await serve(handler);
  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${service.url}?refresh=1`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Transplan-Cache"), "stale");
      assert.deepEqual(await response.json(), saved);
    }
    assert.equal(calls, 1);
    clock += 15 * 60000;
    assert.equal((await fetch(service.url)).status, 200);
    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "20261030.json"), "utf8")), saved);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("GTFS cold-cache errors do not hammer the upstream on every browser retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transplan-gtfs-cold-"));
  let clock = Date.now(), calls = 0;
  const service = await serve(createGtfsHandler({ directory, now: () => clock, download: async () => {
    calls++; throw new Error("test offline");
  } }));
  try {
    const first = await fetch(service.url);
    assert.equal(first.status, 502);
    assert.equal(first.headers.get("Retry-After"), "900");
    assert.equal((await fetch(`${service.url}?refresh=1`)).status, 502);
    assert.equal(calls, 1);
    clock += 15 * 60000;
    assert.equal((await fetch(service.url)).status, 502);
    assert.equal(calls, 2);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("GTFS ZIP cache shares downloads, survives restarts, limits manual refresh and conditionally revalidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transplan-gtfs-archives-"));
  let clock = Date.now(), calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    const headers = init!.headers as Record<string, string>;
    if (calls <= 3) {
      assert.equal(headers["If-None-Match"], undefined);
      return new Response(archiveBytes, { headers: { ETag: '"v1"', "Last-Modified": "Fri, 30 Oct 2026 12:00:00 GMT" } });
    }
    assert.equal(headers["If-None-Match"], '"v1"');
    assert.equal(headers["If-Modified-Since"], "Fri, 30 Oct 2026 12:00:00 GMT");
    return new Response(null, { status: 304 });
  };
  const options = { directory, fetcher, now: () => clock };
  let archives = createGtfsArchiveCache(options);
  try {
    const [a, b] = await Promise.all([archives(), archives()]);
    assert.equal(calls, 3);
    assert.deepEqual(a, b);
    archives = createGtfsArchiveCache(options);
    assert.deepEqual(await archives({ refresh: true }), a);
    assert.equal(calls, 3);
    clock += 3600000;
    await Promise.all([archives({ refresh: true }), archives({ refresh: true })]);
    assert.equal(calls, 6);
    for (const path of Object.values(a) as string[]) assert.deepEqual(await readFile(path), archiveBytes);
    clock += 23 * 3600000;
    await archives();
    assert.equal(calls, 6); // TTL counts from the successful 304, not from the initial download.
    clock += 3600000;
    await archives();
    assert.equal(calls, 9);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("GTFS ZIP cache keeps good archives and persists failure cooldowns across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transplan-gtfs-archive-outage-"));
  let clock = Date.now(), calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(calls <= 3 ? archiveBytes : archiveBytes.subarray(0, 40));
  };
  const options = { directory, fetcher, now: () => clock };
  let archives = createGtfsArchiveCache(options);
  try {
    const original = await archives();
    clock += 24 * 3600000;
    assert.deepEqual(await archives(), original);
    assert.equal(calls, 6);
    archives = createGtfsArchiveCache(options);
    assert.deepEqual(await archives({ refresh: true }), original);
    assert.equal(calls, 6);
    for (const path of Object.values(original) as string[]) assert.deepEqual(await readFile(path), archiveBytes);
    clock += 15 * 60000;
    await archives();
    assert.equal(calls, 9);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
