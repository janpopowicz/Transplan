import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGtfsTravelTimeCollector, gtfsTimeSeconds, installGtfsTravelTimes, loadGtfsTravelTimes, lookupGtfsTravelTime, type GtfsTravelTimeEntry } from "../src/lib/gtfsTravelTimes";
import { automaticTravelTime, estimateTravelMinutes, refreshAutomaticTravelTimes } from "../src/lib/travelTime";
import { useStore } from "../src/store";
import { roadGraph, tramGraph } from "../src/lib/tramGraph";
import { DEFAULT_TAKT } from "../src/constants";
import { parseProposal } from "../src/lib/proposal";
import { loadState } from "../src/lib/persist";
import type { Coord, Stop, TransitLine, TramTrack } from "../src/types";

const a: Stop = { id: "gtfs-Test-A-01", name: "Test A 01", lon: 19.94, lat: 50.06, modes: ["bus", "tram"], source: "gtfs", gtfsIds: ["A:1", "M:m1"] };
const b: Stop = { ...a, id: "gtfs-Test-B-02", name: "Test B 02", lon: 19.95, gtfsIds: ["A:2", "M:m2"] };
const c: Stop = { ...a, id: "gtfs-Test-C-03", name: "Test C 03", lon: 19.96, gtfsIds: ["A:3"] };
const calls = (trip: string, from: string, to: string, start: string, finish: string) => [
  { trip_id: trip, stop_id: from, stop_sequence: "10", arrival_time: start, departure_time: start },
  { trip_id: trip, stop_id: to, stop_sequence: "20", arrival_time: finish, departure_time: finish },
];
const entry: GtfsTravelTimeEntry = ["bus", a.id, b.id, 180, 23];
const geometry: Coord[] = [[a.lon, a.lat], [b.lon, b.lat]];
function line(): TransitLine {
  return { id: "time-test", number: "30", name: "Time test", mode: "bus", vehicle: "12m", color: "#123456", visible: true,
    outboundStopIds: [a.id, b.id], inboundStopIds: [], terminus1Id: a.id, terminus2Id: b.id,
    takt: { ...DEFAULT_TAKT }, layoverMin: 5,
    segments: [{ id: "segment", fromStopId: a.id, toStopId: b.id, geometry, direction: "outbound", travelMin: 19, travelTimeSource: "auto" }] };
}

test("GTFS import uses directed consecutive calls, actual sequence order, route mode and median across operators", () => {
  const collector = createGtfsTravelTimeCollector([a, b, c]);
  const rows = [
    ...calls("fast", "1", "2", "08:00:00", "08:01:00"),
    ...calls("slow", "1", "2", "08:00:00", "08:03:00"),
    ...calls("outlier", "1", "2", "08:00:00", "08:10:00"),
    ...calls("reverse", "2", "1", "09:00:00", "09:04:00"),
    ...calls("tram", "1", "2", "10:00:00", "10:01:30"),
    ...calls("night", "2", "3", "23:59:00", "24:02:00"),
  ];
  rows[0].arrival_time = "07:50:00";
  rows[1].departure_time = "08:20:00"; // dwell at either endpoint must not enter the running time
  collector.addFeed({ id: "A", mode: "bus", routes: [{ route_id: "bus", route_type: "3" }, { route_id: "tram", route_type: "0" }],
    trips: ["fast", "slow", "outlier", "reverse", "night", "tram"].map((trip_id) => ({ trip_id, route_id: trip_id === "tram" ? "tram" : "bus" })),
    stopTimes: rows.slice().reverse() }); // unsorted and interleaved file rows
  collector.addFeed({ id: "M", mode: "bus", routes: [{ route_id: "bus", route_type: "3" }], trips: [{ trip_id: "mobilis", route_id: "bus" }],
    stopTimes: calls("mobilis", "m1", "m2", "08:00:00", "08:02:00") });
  const entries = collector.entries();
  assert.deepEqual(entries.find((e) => e[0] === "bus" && e[1] === a.id), ["bus", a.id, b.id, 150, 4]);
  assert.deepEqual(entries.find((e) => e[0] === "tram"), ["tram", a.id, b.id, 90, 1]);
  assert.deepEqual(entries.find((e) => e[1] === b.id && e[2] === a.id), ["bus", b.id, a.id, 240, 1]);
  assert.deepEqual(entries.find((e) => e[2] === c.id), ["bus", b.id, c.id, 180, 1]);
  assert.ok(!entries.some((e) => e[1] === a.id && e[2] === c.id));
  assert.equal(gtfsTimeSeconds("25:01:02"), 90062);
  assert.equal(gtfsTimeSeconds("12:99:00"), undefined);
});

test("missing timestamps, duplicate sequences and unknown intermediate stops do not invent GTFS relations", () => {
  const collector = createGtfsTravelTimeCollector([a, b, c]);
  const rows = [
    ...calls("backwards", "1", "2", "23:59:00", "00:02:00"),
    ...calls("missing", "1", "2", "", "12:05:00"),
    ...calls("duplicate", "1", "2", "12:00:00", "12:05:00"),
    { trip_id: "duplicate", stop_id: "3", stop_sequence: "10", arrival_time: "12:01:00", departure_time: "12:01:00" },
    ...calls("intermediate", "1", "unknown", "13:00:00", "13:01:00"),
    { trip_id: "intermediate", stop_id: "2", stop_sequence: "30", arrival_time: "13:02:00", departure_time: "13:02:00" },
  ];
  collector.addFeed({ id: "A", mode: "bus", routes: [{ route_id: "r", route_type: "3" }],
    trips: ["backwards", "missing", "duplicate", "intermediate"].map((trip_id) => ({ trip_id, route_id: "r" })), stopTimes: rows });
  assert.deepEqual(collector.entries(), []);
});

test("automatic travel time prefers GTFS, preserves platform/direction/mode identities and falls back to geometry", () => {
  installGtfsTravelTimes([entry]);
  try {
    assert.deepEqual(automaticTravelTime(a, b, geometry, "bus"), { travelMin: 3, travelTimeSource: "gtfs", gtfsSamples: 23 });
    assert.equal(automaticTravelTime({ ...a, name: "Renamed", lon: 20 }, b, geometry, "bus").travelTimeSource, "gtfs");
    for (const [from, to, mode] of [[b, a, "bus"], [a, b, "tram"], [{ ...a, id: "another-platform" }, b, "bus"]] as const) {
      const time = automaticTravelTime(from, to, geometry, mode);
      assert.equal(time.travelTimeSource, "auto");
      assert.equal(time.travelMin, estimateTravelMinutes(geometry, mode));
    }
    const automatic = line();
    const manual = { ...automatic, id: "manual", segments: [{ ...automatic.segments[0], travelTimeSource: "manual" as const, travelMin: 99 }] };
    const legacy = { ...manual, id: "legacy", segments: [{ ...manual.segments[0], travelTimeSource: undefined }] };
    const updated = refreshAutomaticTravelTimes([automatic, manual, legacy], [a, b]);
    assert.equal(updated[0].segments[0].travelMin, 3);
    assert.equal(updated[1], manual);
    assert.equal(updated[2], legacy);
  } finally { installGtfsTravelTimes([]); }
});

test("drawing, moving and resetting legs use GTFS while manual times survive saving and import", async () => {
  installGtfsTravelTimes([entry]);
  const track: TramTrack = { id: "gtfs-time-road", source: "local", kind: "road", geometry, construction: false };
  roadGraph.load([track]); tramGraph.clear();
  useStore.setState({ access: "local", stops: [a, b], tracks: [track], lines: [], selectedLineId: null, drawing: null,
    routing: false, routingError: null, constructionOverrides: {}, insertSlot: null });
  try {
    useStore.getState().startLine("bus", "GTFS", "GTFS time test");
    await useStore.getState().addStopToDrawing(a.id);
    await useStore.getState().addStopToDrawing(b.id);
    let route = useStore.getState().lines[0];
    assert.equal(route.segments[0].travelMin, 3);
    assert.equal(route.segments[0].travelTimeSource, "gtfs");
    const id = route.segments[0].id;
    useStore.getState().cancelDrawing();
    await useStore.getState().moveStop(b.id, [b.lon - 0.001, b.lat]);
    assert.equal(useStore.getState().lines[0].segments[0].travelTimeSource, "gtfs");
    useStore.getState().setSegmentTime(route.id, id, 19);
    assert.equal(useStore.getState().lines[0].segments[0].gtfsSamples, undefined);
    await useStore.getState().moveStop(b.id, [b.lon - 0.002, b.lat]);
    assert.equal(useStore.getState().lines[0].segments[0].travelMin, 19);
    const saved = parseProposal(loadState()!);
    useStore.getState().openProposal(saved);
    assert.equal(useStore.getState().lines[0].segments[0].travelMin, 19);
    useStore.getState().resetSegmentTime(route.id, id);
    route = useStore.getState().lines[0];
    assert.equal(route.segments[0].travelTimeSource, "gtfs");
    assert.equal(route.segments[0].gtfsSamples, 23);
    assert.equal(parseProposal(loadState()!).lines[0].segments[0].travelMin, 3);
  } finally { installGtfsTravelTimes([]); }
});

test("travel-time loader deduplicates downloads and uses the downloaded index", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(url, "/gtfs-times.json"); calls++;
    return new Response(JSON.stringify({ version: 1, entries: [entry] }));
  };
  try {
    await Promise.all([loadGtfsTravelTimes(true), loadGtfsTravelTimes(true)]);
    assert.equal(calls, 1);
    assert.equal(lookupGtfsTravelTime(a, b, "bus")!.seconds, 180);
  } finally { globalThis.fetch = original; installGtfsTravelTimes([]); }
});

test("an invalid downloaded time index preserves the previous valid GTFS data", async () => {
  const original = globalThis.fetch;
  installGtfsTravelTimes([entry]);
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, entries: [["bus", a.id, b.id, -10, 0]] }));
  try {
    assert.equal(await loadGtfsTravelTimes(true), false);
    assert.equal(lookupGtfsTravelTime(a, b, "bus")!.seconds, 180);
  } finally { globalThis.fetch = original; installGtfsTravelTimes([]); }
});

test("the entire imported timetable index contains unique valid directed platform relations", () => {
  const data = JSON.parse(readFileSync("public/gtfs-times.json", "utf8")) as { entries: GtfsTravelTimeEntry[] };
  const stops = JSON.parse(readFileSync("public/stops.json", "utf8")).stops as Stop[];
  const known = new Set(stops.map((s) => s.id));
  assert.ok(data.entries.length > 3000);
  assert.equal(new Set(data.entries.map((e) => JSON.stringify(e.slice(0, 3)))).size, data.entries.length);
  assert.ok(data.entries.every(([mode, from, to, seconds, samples]) => ["bus", "tram"].includes(mode)
    && known.has(from) && known.has(to) && from !== to && Number.isFinite(seconds) && seconds >= 0 && samples > 0));
});
