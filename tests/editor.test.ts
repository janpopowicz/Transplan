import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRenderSegments } from "../src/lib/interline";
import { buildNetworkStopMarkers } from "../src/lib/networkStops";
import { isNetworkView } from "../src/lib/mapViewMode";
import { useStore } from "../src/store";
import { roadGraph, tramGraph } from "../src/lib/tramGraph";
import { DEFAULT_TAKT } from "../src/constants";
import { distToLine } from "../src/lib/geo";
import { loadState } from "../src/lib/persist";
import { mergeStopPositions } from "../src/lib/stopEditing";
import { coordinationMembers } from "../src/lib/timetable";
import { writeOsmCache } from "../src/lib/overpass";
import type { Coord, LineSegment, Stop, TransitLine, TramTrack } from "../src/types";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
} });
const stops: Stop[] = [0, 1, 2, 3].map((n) => ({ id: `s${n}`, name: `Stop ${String.fromCharCode(65 + n)}`,
  lon: 19.93 + n * 0.01, lat: 50.06, modes: ["bus"], source: "local" }));
const point = (n: number): Coord => [stops[n].lon, stops[n].lat];
function seg(a: number, b: number): LineSegment {
  return { id: `${a}-${b}`, fromStopId: stops[a].id, toStopId: stops[b].id,
    direction: a < b ? "outbound" : "inbound", geometry: [point(a), point(b)], travelMin: 7 };
}
function route(id: string, segments: LineSegment[]): TransitLine {
  return { id, number: id, name: id, mode: "bus", color: "#c41e3a", vehicle: "12m", visible: true,
    segments, outboundStopIds: [...new Set(segments.filter((s) => s.direction === "outbound").flatMap((s) => [s.fromStopId, s.toStopId]))],
    inboundStopIds: [...new Set(segments.filter((s) => s.direction === "inbound").flatMap((s) => [s.fromStopId, s.toStopId]))], terminus1Id: null, terminus2Id: null,
    takt: { ...DEFAULT_TAKT }, layoverMin: 5 };
}
const local = route("100", [seg(0, 1), seg(1, 2), seg(2, 3), seg(3, 2), seg(2, 1), seg(1, 0)]);
const express = route("500", [seg(0, 3), seg(3, 0)]);
const track: TramTrack = { id: "road", source: "osm", kind: "road", construction: false,
  geometry: [point(0), point(1), point(2), point(3)] };
function reset() {
  memory.clear();
  roadGraph.load([track]); tramGraph.clear();
  useStore.setState({ stops: stops.map((s) => ({ ...s })), lines: [local, express], tracks: [track],
    tool: "select", selectedLineId: null, selectedStopId: null, drawing: null, insertSlot: null,
    oppositeHintIds: [], routing: false, routingError: null, constructionOverrides: {},
    osm: { loading: false, error: null, stops: 0, tracks: 0, roads: 0, loadedAt: null } });
}

test("white markers project onto each served line and exclude skipped express stops", () => {
  const lines = [local, express];
  const render = buildRenderSegments(lines, { collapseDirections: true, stops, metersPerPx: 5 });
  const markers = buildNetworkStopMarkers(lines, stops, render);
  assert.equal(markers.filter((m) => m.lineId === "100").length, 4);
  assert.deepEqual(markers.filter((m) => m.lineId === "500").map((m) => m.group[0].id).sort(), ["s0", "s3"]);
  for (const marker of markers) {
    assert.ok(Math.min(...render.filter((r) => r.lineId === marker.lineId).map((r) => distToLine(marker.coord, r.geometry))) < 0.01);
  }
  const atA = markers.filter((m) => m.group[0].id === "s0");
  assert.notDeepEqual(atA[0].coord, atA[1].coord);
});

test("opposite platforms produce a single marker per line and hidden lines have none", () => {
  const platforms = stops.map((s) => ({ ...s, name: `${s.name} 01` }));
  platforms.push({ ...stops[1], id: "s1-reverse", name: `${stops[1].name} 02`, lat: 50.0601 });
  platforms[1].groupId = platforms.at(-1)!.groupId = "manual-platforms";
  const line = { ...local, inboundStopIds: ["s1-reverse"] };
  const lines = [line, { ...express, visible: false }];
  const markers = buildNetworkStopMarkers(lines, platforms, buildRenderSegments(lines, { collapseDirections: true, stops: platforms }));
  assert.equal(markers.length, 4);
  assert.equal(markers.find((m) => m.group.some((s) => s.id === "s1"))!.group.length, 2);
});

test("selecting a line twice or closing it clears editing without losing the route", () => {
  reset();
  useStore.getState().selectLine("100");
  assert.equal(useStore.getState().selectedLineId, "100");
  useStore.getState().selectLine("100");
  assert.equal(useStore.getState().selectedLineId, null);
  useStore.setState({ selectedLineId: "100", tool: "draw-bus", drawing: { lineId: "100", mode: "bus", phase: "outbound" },
    insertSlot: { lineId: "100", direction: "outbound", afterIndex: 0 } });
  useStore.getState().selectLine(null);
  assert.equal(useStore.getState().drawing, null);
  assert.equal(useStore.getState().insertSlot, null);
  assert.equal(isNetworkView(12, useStore.getState()), true);
  assert.deepEqual(useStore.getState().lines, [local, express]);
});

test("moving a stop reroutes both directions and all serving lines, preserving travel times and express geometry", async () => {
  reset();
  const second = route("200", [seg(1, 3)]);
  useStore.setState({ lines: [local, express, second] });
  const target: Coord = [stops[1].lon + 0.002, stops[1].lat];
  await useStore.getState().moveStop("s1", target);
  assert.equal(useStore.getState().routingError, null);
  assert.equal(useStore.getState().stops[1].lon, target[0]);
  for (const line of useStore.getState().lines) for (const segment of line.segments) {
    assert.equal(segment.travelMin, 7);
    if (segment.fromStopId === "s1") assert.ok(Math.abs(segment.geometry[0][0] - target[0]) < 1e-8);
    if (segment.toStopId === "s1") assert.ok(Math.abs(segment.geometry.at(-1)![0] - target[0]) < 1e-8);
  }
  assert.equal(useStore.getState().lines[1].segments[0], express.segments[0]);
  assert.equal(loadState()!.localStops.find((s) => s.id === "s1")!.lon, target[0]);
});

test("unroutable stop moves roll back position and all route changes", async () => {
  reset();
  useStore.setState({ lines: [{ ...local, mode: "tram" }] });
  const previous = useStore.getState();
  await useStore.getState().moveStop("s1", [19.941, 50.06]);
  assert.equal(useStore.getState().stops, previous.stops);
  assert.equal(useStore.getState().lines, previous.lines);
  assert.match(useStore.getState().routingError!, /Nie przesunięto/);
  assert.equal(useStore.getState().routing, false);
});

test("OSM moves survive saved projects, OSM refresh and proposal import", async () => {
  reset();
  const osmStops = stops.map((s) => ({ ...s, source: "osm" as const }));
  useStore.setState({ stops: osmStops });
  await useStore.getState().moveStop("s1", [19.942, 50.06]);
  const saved = loadState()!;
  assert.equal(saved.movedStops!.length, 1);
  assert.deepEqual(saved.movedStops![0].originalPosition, point(1));
  assert.equal(mergeStopPositions(osmStops, [], saved.movedStops!)[1].lon, 19.942);
  writeOsmCache(osmStops, [track]);
  await useStore.getState().loadOsm();
  assert.equal(useStore.getState().stops[1].lon, 19.942);
  await useStore.getState().importJson({ text: async () => JSON.stringify(saved) } as File);
  assert.equal(useStore.getState().stops[1].lon, 19.942);
  await useStore.getState().importJson({ text: async () => JSON.stringify({ ...saved, movedStops: [] }) } as File);
  assert.equal(useStore.getState().stops[1].lon, stops[1].lon);
});

test("move mode always exposes individual stops, and concurrent moves are ignored", async () => {
  reset();
  useStore.getState().setTool("move-stop");
  assert.equal(isNetworkView(10, useStore.getState()), false);
  useStore.setState({ routing: true });
  const before = useStore.getState().stops;
  await useStore.getState().moveStop("s1", [19.942, 50.06]);
  assert.equal(useStore.getState().stops, before);
});

test("joining a stop creates or reuses a persistent group including OSM platforms", async () => {
  reset();
  const osm = { ...stops[0], source: "osm" as const };
  useStore.setState({ stops: [osm, ...stops.slice(1)] });
  useStore.getState().joinStopGroup("s1", "s0");
  const groupId = useStore.getState().stops[0].groupId;
  assert.ok(groupId);
  assert.equal(useStore.getState().stops[1].groupId, groupId);
  assert.equal(loadState()!.movedStops![0].groupId, groupId);
  const saved = loadState()!;
  assert.equal(mergeStopPositions([osm], saved.localStops, saved.movedStops!)[0].groupId, groupId);
  useStore.getState().openAddStop([19.94, 50.06]);
  useStore.getState().confirmAddStop("New platform", ["bus", "tram"], "s1");
  assert.equal(useStore.getState().stops.at(-1)!.groupId, groupId);
  assert.equal(useStore.getState().stops[2].groupId, undefined);
});

test("direction markers only appear at served one-way stops and follow reverse travel", () => {
  for (const [from, to, expected] of [[0, 3, 90], [3, 0, 270]]) {
    const one = route("one", [seg(from, to)]);
    const lines = [local, one];
    const render = buildRenderSegments(lines, { collapseDirections: true, stops });
    const markers = buildNetworkStopMarkers(lines, stops, render);
    assert.ok(markers.filter((m) => m.lineId === local.id).every((m) => m.direction === null));
    const directional = markers.filter((m) => m.lineId === one.id);
    assert.equal(directional.length, 2);
    assert.ok(directional.every((m) => Math.abs(m.direction! - expected) < 1));
    assert.deepEqual(directional.map((m) => m.group[0].id).sort(), ["s0", "s3"]);
  }
});

test("disused tram tracks load as closed and can toggle into service and back", async () => {
  reset();
  const { fetchTramTracks } = await import("../src/lib/overpass");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { kind: "tram" });
    return new Response(JSON.stringify({ elements: [{
      type: "way", id: 42, tags: { "disused:railway": "tram" },
      geometry: [{ lon: 19.93, lat: 50.06 }, { lon: 19.94, lat: 50.06 }],
    }] }), { status: 200 });
  };
  try {
    const tracks = await fetchTramTracks();
    assert.equal(tracks[0].construction, true);
    useStore.setState({ tracks });
    useStore.getState().toggleConstruction(tracks[0].id);
    assert.equal(useStore.getState().tracks[0].construction, false);
    assert.equal(useStore.getState().constructionOverrides[tracks[0].id], false);
    useStore.getState().toggleConstruction(tracks[0].id);
    assert.equal(useStore.getState().tracks[0].construction, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GTFS names and modes persist through save, catalogue refresh and import without changing line geometry", async () => {
  reset();
  const catalogueStop: Stop = { ...stops[0], source: "gtfs", stationName: "Stop A", platformNumber: "01" };
  useStore.setState({ stops: [catalogueStop, ...stops.slice(1)] });
  const originalLines = useStore.getState().lines;
  assert.equal(useStore.getState().updateStop(catalogueStop.id, "Nowa nazwa 01", ["bus", "tram"]), true);
  let changed = useStore.getState().stops[0];
  assert.equal(changed.name, "Nowa nazwa 01");
  assert.deepEqual(changed.modes, ["bus", "tram"]);
  assert.equal(changed.originalName, catalogueStop.name);
  assert.deepEqual(changed.originalModes, ["bus"]);
  assert.equal(changed.originalPosition, undefined);
  assert.equal(useStore.getState().lines, originalLines);
  const saved = loadState()!;
  assert.equal(saved.movedStops![0].name, changed.name);
  useStore.getState().openProposal(saved);
  assert.equal(useStore.getState().stops.find((s) => s.id === catalogueStop.id)!.name, "Nowa nazwa 01");
  writeOsmCache([catalogueStop], [track]);
  useStore.setState({ osm: { loading: false, error: null, stops: 0, tracks: 0, roads: 0, loadedAt: null } });
  await useStore.getState().loadOsm();
  changed = useStore.getState().stops.find((s) => s.id === catalogueStop.id)!;
  assert.equal(changed.name, "Nowa nazwa 01");
  assert.deepEqual(changed.modes, ["bus", "tram"]);
  assert.equal(changed.originalName, catalogueStop.name);
  assert.deepEqual(changed.originalModes, ["bus"]);
  useStore.getState().openProposal({ ...saved, movedStops: [] });
  const restored = useStore.getState().stops.find((s) => s.id === catalogueStop.id)!;
  assert.equal(restored.name, catalogueStop.name);
  assert.deepEqual(restored.modes, ["bus"]);
});

test("stop property editing accepts all transport types and rejects empty values and read-only edits", () => {
  reset();
  for (const modes of [["bus"], ["tram"], ["bus", "tram"]] as Stop["modes"][]) {
    assert.equal(useStore.getState().updateStop("s0", " Test 01 ", modes), true);
    assert.equal(useStore.getState().stops[0].name, "Test 01");
    assert.deepEqual(useStore.getState().stops[0].modes, modes);
    assert.equal(useStore.getState().stops[0].originalName, undefined);
  }
  const previous = useStore.getState().stops;
  assert.equal(useStore.getState().updateStop("s0", "", ["bus"]), false);
  assert.equal(useStore.getState().updateStop("s0", "X", []), false);
  assert.equal(useStore.getState().stops, previous);
  useStore.setState({ access: "read" });
  useStore.getState().updateStop("s0", "Blocked", ["tram"]);
  assert.equal(useStore.getState().stops, previous);
  useStore.setState({ access: "local" });
});

test("pair coordination survives saving and import, splits on detach, and cleans up on delete", () => {
  reset();
  const a = { ...route("A", [seg(0, 1), seg(1, 2)]), outboundStopIds: ["s0", "s1", "s2"] };
  const b = { ...a, id: "B" }, c = { ...a, id: "C" }, d = { ...a, id: "D" };
  const unrelated = { ...a, id: "X", outboundStopIds: ["s2", "s3"], segments: [seg(2, 3)] };
  useStore.setState({ access: "local", lines: [a, b, c, d, unrelated] });
  useStore.getState().coordinateLines("A", "X");
  assert.ok(useStore.getState().lines.every((l) => !l.coordinatedLineIds?.length));
  useStore.getState().coordinateLines("A", "B");
  useStore.getState().coordinateLines("C", "D");
  assert.deepEqual(useStore.getState().lines[0].coordinatedLineIds, ["B"]);
  assert.deepEqual(useStore.getState().lines[2].coordinatedLineIds, ["D"]);
  useStore.getState().coordinateLines("B", "C");
  let lines = useStore.getState().lines;
  assert.equal(coordinationMembers(lines, lines[0]).length, 4);
  assert.deepEqual(lines[0].coordinatedLineIds, ["B"]);
  useStore.getState().openProposal(loadState()!);
  lines = useStore.getState().lines;
  assert.equal(coordinationMembers(lines, lines[0]).length, 4);
  useStore.getState().uncoordinateLine("B", "C");
  lines = useStore.getState().lines;
  assert.equal(coordinationMembers(lines, lines[0]).length, 2);
  assert.equal(coordinationMembers(lines, lines[2]).length, 2);
  useStore.getState().deleteLine("B");
  assert.equal(useStore.getState().lines.find((l) => l.id === "A")!.coordinatedLineIds?.length ?? 0, 0);
  useStore.getState().uncoordinateLine("C");
  assert.equal(useStore.getState().lines.find((l) => l.id === "D")!.coordinatedLineIds?.length ?? 0, 0);
  useStore.setState({ access: "read" });
  const before = useStore.getState().lines;
  useStore.getState().coordinateLines("A", "C");
  useStore.getState().setDepartureOffset("A", 4, "wd_am", "outbound");
  assert.equal(useStore.getState().lines, before);
  useStore.setState({ access: "local" });
});


test("bulk visibility affects the entire selected transport mode once and preserves the other mode and schedules",()=>{
  reset();
  const bus={...local,id:"bus",visible:true},tram={...express,id:"tram",mode:"tram" as const,visible:true};
  const hiddenBus={...bus,id:"hidden-bus",visible:false};
  useStore.setState({access:"local",lines:[bus,tram,hiddenBus]});
  useStore.getState().setModeVisible("bus",false);
  assert.deepEqual(useStore.getState().lines.map(l=>l.visible),[false,true,false]);
  assert.deepEqual(useStore.getState().lines[0].takt,bus.takt);
  assert.deepEqual(useStore.getState().lines[0].segments,bus.segments);
  assert.equal(useStore.getState().lines[1],tram);
  assert.deepEqual(loadState()!.lines.map(l=>l.visible),[false,true,false]);
  useStore.getState().setModeVisible("bus",true);
  assert.deepEqual(useStore.getState().lines.map(l=>l.visible),[true,true,true]);
  useStore.getState().setModeVisible("tram",false);
  assert.deepEqual(useStore.getState().lines.map(l=>l.visible),[true,false,true]);
  useStore.setState({access:"read"});useStore.getState().setModeVisible("bus",false);
  assert.deepEqual(useStore.getState().lines.map(l=>l.visible),[true,false,true]);
  useStore.setState({access:"local"});
});
