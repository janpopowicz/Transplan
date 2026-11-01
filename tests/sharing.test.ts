import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNetworkHandler } from "../server/networks.mjs";
import { parseProposal, type Proposal } from "../src/lib/proposal";
import { createNetwork, fetchNetwork, networkAccess, networkId, networkLinks, NETWORK_UUID, RevisionConflict, updateNetwork, type SharedAccess, type SharedDocument } from "../src/lib/sharing";
import { equal, mergeProposals, NetworkSync, type SyncStatus } from "../src/lib/networkSync";
import { loadState, saveState } from "../src/lib/persist";
import { createProjectSnapshotReader, projectSnapshot, useStore } from "../src/store";
import { SyncCheckpointWriter } from "../src/lib/syncCheckpoint";
import { serializeCheckpoint } from "../src/lib/syncCheckpointCodec";
import { decodeStoredState } from "../src/lib/storageCodec";
import { DEFAULT_TAKT } from "../src/constants";
import { openSharedNetwork, useSharedSession } from "../src/lib/sharedSession";

const proposal: Proposal = {
  lines: [{ id: "line", number: "100", name: "Test", mode: "bus", color: "#1f4e79", vehicle: "12m", visible: false,
    outboundStopIds: ["osm-1", "local-1"], inboundStopIds: [], terminus1Id: "osm-1", terminus2Id: "local-1",
    segments: [{ id: "segment", fromStopId: "osm-1", toStopId: "local-1", direction: "outbound", travelMin: 4,
      travelTimeSource: "manual", geometry: [[19.93, 50.06], [19.94, 50.06]], waypoints: [[19.935, 50.06]] }],
    takt: { ...DEFAULT_TAKT }, layoverMin: 5 }],
  localStops: [{ id: "local-1", name: "Local", lon: 19.94, lat: 50.06, source: "local", modes: ["bus"] }],
  movedStops: [{ id: "osm-1", name: "Moved", lon: 19.93, lat: 50.06, originalPosition: [19.92, 50.06],
    groupId: "group", source: "osm", modes: ["bus"] }],
  localTracks: [{ id: "track", source: "local", construction: false, kind: "tram", geometry: [[19.93, 50.06], [19.94, 50.06]] }],
  constructionOverrides: { track: true },
};

async function listen(dataDir: string) {
  const server = createServer(createNetworkHandler({ dataDir }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}

test("anonymous read/write links share one mutable network and survive server restarts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "transplan-networks-"));
  let server = await listen(dataDir);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (path, init) => originalFetch(new URL(String(path), server.url), init);
    const { access } = await createNetwork(proposal);
    const links = networkLinks(access, `${server.url}/?old=1#map`);
    const id = networkId(new URL(links.read).search)!;
    assert.match(id, NETWORK_UUID);
    assert.equal(new URL(links.read).hash, "");
    assert.equal(new URL(links.read).searchParams.has("old"), false);
    assert.equal(new URL(links.read).searchParams.has("write"), false);
    assert.equal(networkLinks({ ...access, writeToken: null }, links.write).write, "");
    assert.equal(networkAccess(new URL(links.write).search, new URL(links.write).hash)!.writeToken, access.writeToken);
    assert.deepEqual((await fetchNetwork(id)).proposal, proposal);
    await server.close();
    server = await listen(dataDir);
    assert.deepEqual((await fetchNetwork(id)).proposal, proposal);
    const edited = structuredClone(proposal);
    edited.lines[0].number = "200";
    const updated = await updateNetwork(access, 1, edited);
    assert.equal(updated.revision, 2);
    assert.equal((await fetchNetwork(id)).proposal.lines[0].number, "200");
    await assert.rejects(updateNetwork(access, 1, proposal), RevisionConflict);
    await assert.rejects(fetchNetwork("00000000-0000-4000-8000-000000000000"), /Nie znaleziono/);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("read links cannot write; API rejects malformed, oversized, cross-site and stale writes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "transplan-networks-"));
  const server = await listen(dataDir);
  try {
    const post = (body: string, headers = {}) => fetch(`${server.url}/api/networks`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
    });
    assert.equal((await post("{")).status, 400);
    assert.equal((await post(JSON.stringify({ proposal: { ...proposal, lines: [{}] } }))).status, 400);
    assert.equal((await post(JSON.stringify({ proposal: { ...proposal, localStops: proposal.movedStops } }))).status, 400);
    assert.equal((await post(JSON.stringify(proposal), { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post(JSON.stringify(proposal), { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post(" ".repeat(10 * 1024 * 1024 + 1))).status, 413);
    const created = await (await post(JSON.stringify({ proposal }))).json();
    const put = (token?: string, revision = 1) => fetch(`${server.url}/api/networks/${created.id}`, { method: "PUT",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ proposal, revision }) });
    assert.equal((await put()).status, 403);
    assert.equal((await put(created.id)).status, 403);
    assert.equal((await put("00000000-0000-4000-8000-000000000000")).status, 403);
    const publicData = await (await fetch(`${server.url}/api/networks/${created.id}`)).text();
    assert.ok(!publicData.includes(created.writeToken));
    assert.ok(!publicData.includes("writeHash"));
    assert.equal((await put(created.writeToken)).status, 200);
    assert.equal((await put(created.writeToken)).status, 409);
    const unchanged = await fetch(`${server.url}/api/networks/${created.id}?revision=2`);
    assert.equal(unchanged.status, 204);
    assert.equal(await unchanged.text(), "");
    assert.equal((await fetch(`${server.url}/api/networks/${created.id}?revision=1`)).status, 200);
    assert.equal((await fetch(`${server.url}/api/networks/not-a-uuid`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/networks/${created.id}/extra`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/networks`)).status, 405);
  } finally { await server.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("bad links, unavailable APIs and invalid responses give useful errors", async () => {
  assert.equal(networkId(""), null);
  assert.throws(() => networkId("?network=../foo"), /nieprawidłowy/);
  assert.throws(() => networkId("?network="), /nieprawidłowy/);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(createNetwork(proposal), /Brak połączenia/);
    globalThis.fetch = async () => new Response("<html>static host</html>", { status: 200 });
    await assert.rejects(createNetwork(proposal), /nie obsługuje/);
    globalThis.fetch = async () => Response.json({ id: "wrong" });
    await assert.rejects(createNetwork(proposal), /nieprawidłowy link/);
    globalThis.fetch = async () => Response.json({ revision: 1, updatedAt: "today", proposal: { lines: [{}] } });
    await assert.rejects(fetchNetwork("00000000-0000-4000-8000-000000000000"), /Nieprawidłowe dane/);
  } finally { globalThis.fetch = originalFetch; }
});

test("shared drafts stay separate from the original project and from other UUIDs", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const memory = new Map<string, string>();
  const location = { search: "" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value),
  } });
  try {
    saveState(proposal);
    location.search = "?network=00000000-0000-4000-8000-000000000000";
    assert.equal(loadState(), null);
    const draft = structuredClone(proposal);
    draft.lines[0].number = "edited";
    saveState(draft);
    assert.equal(loadState()!.lines[0].number, "edited");
    location.search = "?network=00000000-0000-4000-8000-000000000001";
    assert.equal(loadState(), null);
    location.search = "";
    assert.deepEqual(loadState(), proposal);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("opening a shared snapshot resets editor tools and preserves stops, geometry, times and track closures", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ stops: [], tracks: [], drawing: { lineId: "old", mode: "bus", phase: "outbound" },
      selectedLineId: "old", tool: "draw-bus", pendingStop: { lon: 19.9, lat: 50.06 } });
    useStore.getState().openProposal(proposal);
    const state = useStore.getState();
    assert.deepEqual(state.lines, proposal.lines);
    assert.equal(state.stops.find((s) => s.id === "osm-1")!.groupId, "group");
    assert.equal(state.tracks[0].construction, true);
    assert.equal(state.drawing, null);
    assert.equal(state.selectedLineId, null);
    assert.equal(state.pendingStop, null);
    assert.equal(state.tool, "select");
    useStore.setState({ stops: [...state.stops, { id: "referenced", name: "OSM", lon: 19.9, lat: 50.06, modes: ["bus"], source: "osm" }],
      lines: [{ ...state.lines[0], inboundStopIds: ["referenced"] }] });
    const snapshot = projectSnapshot(useStore.getState(), true);
    assert.deepEqual(snapshot.movedStops!.find((s) => s.id === "referenced")!.originalPosition, [19.9, 50.06]);
    assert.deepEqual(parseProposal(snapshot), snapshot);
  } finally { useStore.setState(previous); }
});

function client(access: SharedAccess, initial: SharedDocument) {
  let local = structuredClone(initial.proposal);
  let status: SyncStatus = { message: "", pending: false, conflict: false };
  let busy = false;
  let saved: unknown;
  const sync = new NetworkSync(access, initial, {
    read: () => structuredClone(local), apply: (value) => { local = structuredClone(value); }, busy: () => busy,
    status: (value) => { status = value; }, checkpoint: (base, value) => { saved = { base, local: structuredClone(value) }; },
  });
  return { sync, get local() { return local; }, get status() { return status; }, get saved() { return saved; },
    setBusy(value: boolean) { busy = value; } };
}

test("two simultaneous editors merge independent fields and a viewer sees live changes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "transplan-live-"));
  const server = await listen(dataDir);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (path, init) => originalFetch(new URL(String(path), server.url), init);
    const created = await createNetwork(proposal);
    const a = client(created.access, created.document), b = client(created.access, created.document);
    const viewer = client({ ...created.access, writeToken: null }, created.document);
    a.local.lines[0].number = "200";
    b.local.lines[0].name = "Wspólna praca";
    await Promise.all([a.sync.tick(), b.sync.tick()]);
    // Exactly one revision wins the first race. The other client rebases and retries.
    await a.sync.tick(); await b.sync.tick(); await a.sync.tick(); await viewer.sync.tick();
    const remote = await fetchNetwork(created.access.id);
    assert.equal(remote.proposal.lines[0].number, "200");
    assert.equal(remote.proposal.lines[0].name, "Wspólna praca");
    assert.deepEqual(viewer.local, remote.proposal);
    assert.equal(a.status.conflict, false); assert.equal(b.status.conflict, false);
    assert.equal(a.sync.pending, false); assert.equal(b.sync.pending, false);
  } finally { globalThis.fetch = originalFetch; await server.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("conflicting edits require a choice and preserve unrelated edits from both people", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "transplan-conflict-"));
  const server = await listen(dataDir);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (path, init) => originalFetch(new URL(String(path), server.url), init);
    const created = await createNetwork(proposal);
    const a = client(created.access, created.document), b = client(created.access, created.document);
    a.local.lines[0].number = "200"; a.local.lines[0].layoverMin = 9;
    b.local.lines[0].number = "300"; b.local.lines[0].name = "Moja nazwa";
    await a.sync.tick(); await b.sync.tick();
    assert.equal(b.status.conflict, true);
    assert.equal((await fetchNetwork(created.access.id)).proposal.lines[0].number, "200");
    await b.sync.resolve("local");
    const remote = await fetchNetwork(created.access.id);
    assert.equal(remote.proposal.lines[0].number, "300");
    assert.equal(remote.proposal.lines[0].name, "Moja nazwa");
    assert.equal(remote.proposal.lines[0].layoverMin, 9);
    assert.equal(b.status.conflict, false);
    const deleted = structuredClone(proposal); deleted.lines = [];
    assert.ok(mergeProposals(proposal, deleted, remote.proposal).conflicts.includes("lines.line"));
    const preferRemote = mergeProposals(proposal, b.local, a.local, "remote");
    assert.equal(preferRemote.proposal.lines[0].number, "200");
    assert.equal(preferRemote.proposal.lines[0].name, "Moja nazwa");
  } finally { globalThis.fetch = originalFetch; await server.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("server compare-and-swap is atomic across separate handler instances", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "transplan-atomic-"));
  const a = await listen(dataDir), b = await listen(dataDir);
  try {
    const created = await (await fetch(`${a.url}/api/networks`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposal }) })).json();
    const responses = await Promise.all([a, b].map((server) => fetch(`${server.url}/api/networks/${created.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.writeToken}` },
      body: JSON.stringify({ proposal, revision: 1 }),
    })));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const current = await (await fetch(`${a.url}/api/networks/${created.id}`)).json();
    assert.equal(current.revision, 2);
  } finally { await a.close(); await b.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("edits made during a save stay pending, offline edits retry, and routing defers remote updates", async () => {
  const originalFetch = globalThis.fetch;
  const access = { id: "00000000-0000-4000-8000-000000000000", writeToken: "00000000-0000-4000-8000-000000000001" };
  const initial = { revision: 1, updatedAt: "today", proposal };
  const editor = client(access, initial);
  try {
    editor.local.lines[0].number = "200";
    globalThis.fetch = async (_path, init) => {
      const sent = JSON.parse(String(init?.body));
      editor.local.lines[0].name = "Wpisane podczas zapisu";
      return Response.json({ revision: sent.revision + 1, updatedAt: "today", proposal: sent.proposal });
    };
    await editor.sync.tick();
    assert.equal(editor.sync.pending, true);
    assert.ok(editor.saved);
    globalThis.fetch = async () => { throw new Error("offline"); };
    await editor.sync.tick();
    assert.equal(editor.sync.pending, true);
    assert.match(editor.status.message, /Brak połączenia/);
    globalThis.fetch = async (_path, init) => {
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.proposal.lines[0].name, "Wpisane podczas zapisu");
      return Response.json({ revision: sent.revision + 1, updatedAt: "today", proposal: sent.proposal });
    };
    await editor.sync.tick();
    assert.equal(editor.sync.pending, false);
    const viewer = client({ ...access, writeToken: null }, initial);
    viewer.setBusy(true);
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ revision: 5, updatedAt: "today", proposal: editor.local }); };
    await viewer.sync.tick();
    assert.equal(requests, 0);
    viewer.setBusy(false); await viewer.sync.tick();
    assert.equal(viewer.local.lines[0].number, "200");
  } finally { globalThis.fetch = originalFetch; }
});

test("read mode guards editing actions while selection and isochrones still work", async () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ access: "read", lines: structuredClone(proposal.lines), tool: "select", stops: proposal.localStops, tracks: [] });
    const lines = useStore.getState().lines;
    useStore.getState().updateLine("line", { number: "unauthorized" });
    useStore.getState().deleteLine("line");
    useStore.getState().startLine("tram", "42", "Unauthorized");
    useStore.getState().setTakt("line", "wd_am", 4);
    useStore.getState().toggleLineVisible("line");
    await useStore.getState().importJson({ text: async () => JSON.stringify(proposal) } as File);
    useStore.getState().setTool("draw-track");
    assert.equal(useStore.getState().tool, "select");
    assert.equal(useStore.getState().lines, lines);
    useStore.getState().selectLine("line");
    assert.equal(useStore.getState().selectedLineId, "line");
    useStore.getState().setTool("isochrones");
    assert.equal(useStore.getState().tool, "isochrones");
  } finally { useStore.setState(previous); }
});

test("refresh recovers this tab's unsent changes instead of replacing them with newer server data", async () => {
  const descriptors = new Map(["window", "localStorage", "sessionStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const previous = useStore.getState(), session = useSharedSession.getState(), originalFetch = globalThis.fetch;
  const memory = new Map<string, string>();
  const access = { id: "00000000-0000-4000-8000-000000000000", writeToken: "00000000-0000-4000-8000-000000000001" };
  const local = structuredClone(proposal); local.lines[0].number = "Niewysłane";
  const remote = structuredClone(proposal); remote.lines[0].name = "Nowsza wersja serwera";
  const base = { revision: 1, updatedAt: "today", proposal };
  const checkpointKey = `transplan-sync:${access.id}:${access.writeToken}:test-tab`;
  memory.set(checkpointKey, JSON.stringify({ base, local }));
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { search: `?network=${access.id}&write=${access.writeToken}` },
  } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key),
  } });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: () => "test-tab", setItem: () => {},
  } });
  globalThis.fetch = async () => Response.json({ revision: 2, updatedAt: "today", proposal: remote });
  try {
    useStore.setState({ access: "local", stops: [], tracks: [], lines: [], routing: false });
    await openSharedNetwork();
    assert.equal(useStore.getState().lines[0].number, "Niewysłane");
    assert.equal(useStore.getState().access, "write");
    assert.equal(useSharedSession.getState().status.pending, true);
    assert.equal(memory.has(checkpointKey), false);
    assert.equal(JSON.parse(memory.get(`transplan-sync:${access.id}:test-tab`)!).base.revision, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    useStore.setState(previous); useSharedSession.setState(session);
  }
});

test("timetable phases and coordination are validated and preserved through shared snapshots", () => {
  const timed = structuredClone(proposal);
  timed.lines[0].departureOffsetMin = 7.5;
  timed.lines[0].coordinatedLineIds = ["second"];
  timed.lines.push({ ...structuredClone(timed.lines[0]), id: "second", coordinatedLineIds: ["line"] });
  assert.deepEqual(parseProposal(timed), timed);
  saveState(timed); assert.deepEqual(loadState(), timed);
  assert.throws(() => parseProposal({ ...timed, lines: [{ ...timed.lines[0], departureOffsetMin: NaN }] }));
  assert.throws(() => parseProposal({ ...timed, lines: [{ ...timed.lines[0], coordinatedLineIds: [42] }] }));
  const remote = structuredClone(proposal); remote.lines[0].name = "New name";
  const merged = mergeProposals(proposal, timed, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.proposal.lines[0].departureOffsetMin, 7.5);
  assert.deepEqual(merged.proposal.lines[0].coordinatedLineIds, ["second"]);
  assert.equal(merged.proposal.lines[0].name, "New name");
});

test("idle shared polling reuses snapshots and comparisons without serializing route geometry", async () => {
  const previous = useStore.getState(), originalFetch = globalThis.fetch;
  try {
    useStore.setState({ lines: proposal.lines, stops: [...proposal.localStops, ...proposal.movedStops!],
      tracks: proposal.localTracks, constructionOverrides: proposal.constructionOverrides });
    const read = createProjectSnapshotReader();
    const initial = read();
    const remote = structuredClone(initial);
    let geometryReads = 0, writes = 0, polls = 0;
    const geometry = remote.lines[0].segments[0].geometry;
    Object.defineProperty(remote.lines[0].segments[0], "geometry", { enumerable: true,
      get: () => { geometryReads++; return geometry; } });
    const sync = new NetworkSync({ id: "idle", writeToken: "write" }, { revision: 1, updatedAt: "today", proposal: remote }, {
      read, apply: () => assert.fail("unchanged poll must not replace editor state"), busy: () => false, status: () => {},
    });
    globalThis.fetch = async (_path, init) => {
      if (init?.method === "PUT") writes++; else polls++;
      return new Response(null, { status: 204 });
    };
    assert.equal(sync.pending, false);
    assert.ok(geometryReads > 0);
    const compared = geometryReads;
    for (let i = 0; i < 10; i++) {
      useStore.setState({ hoverStopId: String(i), selectedLineId: "line" });
      assert.equal(read(), initial);
      await sync.tick();
    }
    assert.equal(polls, 10);
    assert.equal(writes, 0);
    assert.equal(geometryReads, compared);
    useStore.setState({ lines: proposal.lines.map((line) => ({ ...line, name: "Edited" })) });
    assert.notEqual(read(), initial);
    assert.equal(sync.pending, true);
    assert.equal(initial.lines[0].name, "Test");
    assert.equal(equal({ optional: undefined, name: "same" }, { name: "same" }), true);
    assert.equal(equal({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  } finally { globalThis.fetch = originalFetch; useStore.setState(previous); }
});

test("checkpoint worker coalesces edits and never overwrites newer recovery data", (t) => {
  const descriptors = new Map(["Worker", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const jobs: { version: number; data: { base: SharedDocument; local: Proposal } }[] = [];
  let receive: (event: { data: { version: number; stored: string } }) => void;
  let stored = "", writes = 0;
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: class {
    set onmessage(value: typeof receive) { receive = value; }
    postMessage(job: (typeof jobs)[number]) { jobs.push(job); }
    terminate() {}
  } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem: (_key: string, value: string) => { stored = value; writes++; },
  } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writer = new SyncCheckpointWriter("test-checkpoint");
  try {
    const base = { revision: 1, updatedAt: "today", proposal };
    const first = structuredClone(proposal), second = structuredClone(proposal), third = structuredClone(proposal);
    first.lines[0].name = "First"; second.lines[0].name = "Second"; third.lines[0].name = "Third";
    writer.schedule(base, first); writer.schedule(base, second);
    assert.equal(jobs.length, 0);
    assert.equal(writes, 0);
    t.mock.timers.tick(300);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].data.local, second);
    writer.schedule(base, third);
    receive!({ data: { version: jobs[0].version, stored: serializeCheckpoint(jobs[0].data) } });
    assert.equal(writes, 1);
    assert.equal(JSON.parse(stored).local.lines[0].name, "Second");
    t.mock.timers.tick(300);
    assert.equal(jobs.length, 2);
    writer.flush();
    assert.equal(JSON.parse(stored).local.lines[0].name, "Third");
    const flushed = stored;
    receive!({ data: { version: jobs[1].version, stored: "late worker result" } });
    assert.equal(stored, flushed);
    writer.schedule(base, third);
    t.mock.timers.tick(300);
    assert.equal(jobs.length, 2);
    assert.equal(writes, 2);
  } finally {
    writer.dispose(); t.mock.timers.reset();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("large checkpoint encoding preserves the existing recovery format", () => {
  const local = structuredClone(proposal);
  local.lines[0].segments[0].geometry = Array.from({ length: 40000 }, () => [19.935123456, 50.061234567]);
  const data = { base: { revision: 2, updatedAt: "today", proposal: local }, local };
  const stored = serializeCheckpoint(data);
  assert.ok(stored.startsWith("transplan-lz:"));
  assert.deepEqual(decodeStoredState(stored), data);
});

test("shared editing leaves recovery to the checkpoint instead of synchronously saving a duplicate draft", () => {
  const previous = useStore.getState();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let writes = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: () => { writes++; } } });
  try {
    useStore.setState({ access: "write", lines: structuredClone(proposal.lines), stops: proposal.localStops,
      tracks: proposal.localTracks, constructionOverrides: proposal.constructionOverrides });
    useStore.getState().updateLine("line", { name: "Shared edit" });
    assert.equal(useStore.getState().lines[0].name, "Shared edit");
    assert.equal(writes, 0);
    useStore.setState({ access: "local" });
    useStore.getState().updateLine("line", { name: "Local edit" });
    assert.equal(writes, 1);
  } finally {
    useStore.setState(previous);
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
