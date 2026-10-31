import test from "node:test";
import assert from "node:assert/strict";
import { fetchWalkingNetwork, loadWalkingNetwork } from "../src/lib/walkingNetwork";

const response = () => new Response(JSON.stringify({ elements: [{
  type: "way", id: 1, nodes: [1, 2], tags: { highway: "footway" },
  geometry: [{ lon: 19.94, lat: 50.06 }, { lon: 19.941, lat: 50.06 }],
}] }), { status: 200 });

test("walking downloads use only the shared server cache without racing a public OSM provider", async () => {
  const signals: AbortSignal[] = [];
  const fetcher = (async (url, init) => {
    signals.push(init!.signal as AbortSignal);
    assert.equal(url, "/overpass");
    return response();
  }) as typeof fetch;
  const network = await fetchWalkingNetwork(fetcher, 1000);
  assert.equal(network.edges.length, 1);
  assert.equal(signals.length, 1);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("OSM deadline also covers a stalled response body and cancels all requests", async () => {
  const signals: AbortSignal[] = [];
  const fetcher = (async (_url, init) => {
    signals.push(init!.signal as AbortSignal);
    return { ok: true, json: () => new Promise(() => {}) } as Response;
  }) as typeof fetch;
  await assert.rejects(fetchWalkingNetwork(fetcher, 20), /Serwery OSM/);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("an incomplete OSM response cannot replace the full walking graph", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ elements: [], remark: "timeout" }))) as typeof fetch;
  await assert.rejects(fetchWalkingNetwork(fetcher, 1000), /Serwery OSM/);
});

test("simultaneous clicks share one download and later clicks reuse its graph", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return response(); }) as typeof fetch;
  try {
    const [first, second] = await Promise.all([loadWalkingNetwork(), loadWalkingNetwork()]);
    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(await loadWalkingNetwork(), first);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
