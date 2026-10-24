import { test } from "node:test";
import assert from "node:assert/strict";
import { AVERAGE_SPEED_KMH } from "../src/constants";
import { useStore } from "../src/store";
import { roadGraph, tramGraph } from "../src/lib/tramGraph";
import { routeBetween } from "../src/lib/routing";
import { estimateTravelMinutes } from "../src/lib/travelTime";
import { lineLength, distToLine } from "../src/lib/geo";
import { loadState } from "../src/lib/persist";
import type { Coord, Stop, TramTrack } from "../src/types";

const a: Coord = [19.9, 50], b: Coord = [19.91, 50], c: Coord = [19.91, 50.01], d: Coord = [19.9, 50.01];
const stops: Stop[] = [a, b, c].map((coord, i) => ({ id: ["a", "b", "c"][i], name: ["A", "B", "C"][i],
  lon: coord[0], lat: coord[1], modes: ["bus", "tram"], source: "local" }));
const tracks: TramTrack[] = [[a, b], [b, c], [c, d], [d, a]].map((geometry, i) => ({
  id: `edge${i}`, geometry, source: "local", kind: "road", construction: false,
}));
function reset(mode: "bus" | "tram" = "bus") {
  roadGraph.load(tracks); tramGraph.load(tracks);
  useStore.setState({ stops, tracks, lines: [], drawing: null, insertSlot: null, selectedLineId: null,
    selectedStopId: null, routing: false, routingError: null, constructionOverrides: {},
    pendingStop: null, trackDraft: null, stopPicker: null });
  useStore.getState().startLine(mode, "WP", "Waypoint test");
}
async function drawVia() {
  await useStore.getState().addStopToDrawing("a");
  await useStore.getState().addDrawingWaypoint(d);
  await useStore.getState().addDrawingWaypoint(c);
  await useStore.getState().addStopToDrawing("b");
  return useStore.getState().lines[0];
}

test("bus and tram routes follow ordered waypoints without introducing stops", async () => {
  for (const mode of ["bus", "tram"] as const) {
    reset(mode);
    const direct = await routeBetween(a, b, mode);
    const line = await drawVia();
    assert.deepEqual(line.outboundStopIds, ["a", "b"]);
    assert.equal(line.segments.length, 1);
    assert.equal(useStore.getState().stops.length, 3);
    const segment = line.segments[0];
    assert.deepEqual(segment.waypoints, [d, c]);
    assert.ok(distToLine(d, segment.geometry) < 0.1 && distToLine(c, segment.geometry) < 0.1);
    assert.ok(lineLength(segment.geometry) > lineLength(direct) * 3);
    assert.equal(segment.travelMin, estimateTravelMinutes(segment.geometry, mode));
    assert.equal(segment.travelTimeSource, "auto");
    assert.deepEqual(loadState()?.lines[0].segments[0].waypoints, [d, c]);
    assert.equal(useStore.getState().drawing?.waypoints?.length, 0);
  }
});

test("speed defaults use configured speeds and whole-minute precision", () => {
  const geometry: Coord[] = [[19.9, 50], [19.9, 50 + AVERAGE_SPEED_KMH.bus * 1000 / 111194.9266]];
  assert.equal(estimateTravelMinutes(geometry, "bus"), 60);
  assert.equal(estimateTravelMinutes(geometry, "tram"), Math.round(60 * AVERAGE_SPEED_KMH.bus / AVERAGE_SPEED_KMH.tram));
  assert.equal(estimateTravelMinutes([a, a], "bus"), 1);
});

test("external routing keeps waypoint endpoints instead of trimming them as stop spurs", async () => {
  roadGraph.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.includes("/driving/")) throw new Error("Valhalla unavailable in fixture");
    const coords = url.split("/driving/")[1].split("?")[0].split(";").map((point) => point.split(",").map(Number) as Coord);
    const middle = [(coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2];
    return new Response(JSON.stringify({ routes: [{ geometry: { coordinates: [coords[0], middle, coords[1]] } }] }), { status: 200 });
  };
  try {
    const path = await routeBetween(a, b, "bus", [d, c]);
    assert.ok(path.some((point) => point[0] === d[0] && point[1] === d[1]));
    assert.ok(path.some((point) => point[0] === c[0] && point[1] === c[1]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pending waypoints can be undone and prevent ending an unfinished leg", async () => {
  reset();
  await drawVia();
  await useStore.getState().addDrawingWaypoint(c);
  useStore.getState().markTerminus2();
  assert.equal(useStore.getState().drawing?.phase, "outbound");
  useStore.getState().undoDrawingStop();
  assert.equal(useStore.getState().drawing?.waypoints?.length, 0);
  assert.deepEqual(useStore.getState().lines[0].outboundStopIds, ["a", "b"]);
  useStore.getState().markTerminus2();
  assert.equal(useStore.getState().drawing?.phase, "inbound");
  await useStore.getState().addDrawingWaypoint(c);
  await useStore.getState().addStopToDrawing("a");
  assert.deepEqual(useStore.getState().lines[0].segments[1].waypoints, [c]);
  useStore.getState().finishInbound();
  assert.equal(useStore.getState().drawing, null);
});

test("failed waypoint leaves the draft intact and cancellation ignores in-flight routes", async () => {
  reset();
  await useStore.getState().addStopToDrawing("a");
  await useStore.getState().addDrawingWaypoint(d);
  await useStore.getState().addDrawingWaypoint([21, 51]);
  assert.deepEqual(useStore.getState().drawing?.waypoints, [d]);
  assert.ok(useStore.getState().routingError);
  const pending = useStore.getState().addStopToDrawing("b");
  useStore.getState().cancelDrawing();
  await pending;
  assert.equal(useStore.getState().drawing, null);
  assert.equal(useStore.getState().lines[0].segments.length, 0);
  assert.equal(useStore.getState().routing, false);
});

test("moving stops retains waypoints and recalculates only automatic times", async () => {
  reset();
  const line = await drawVia();
  const id = line.segments[0].id;
  await useStore.getState().moveStop("b", [19.91, 50.004]);
  let segment = useStore.getState().lines[0].segments[0];
  assert.deepEqual(segment.waypoints, [d, c]);
  assert.ok(segment.travelMin < line.segments[0].travelMin);
  assert.equal(segment.travelMin, estimateTravelMinutes(segment.geometry, "bus"));
  useStore.getState().setSegmentTime(line.id, id, 99);
  await useStore.getState().moveStop("b", b);
  segment = useStore.getState().lines[0].segments[0];
  assert.equal(segment.travelMin, 99);
  assert.equal(segment.travelTimeSource, "manual");
  useStore.getState().resetSegmentTime(line.id, id);
  segment = useStore.getState().lines[0].segments[0];
  assert.equal(segment.travelTimeSource, "auto");
  assert.equal(segment.travelMin, estimateTravelMinutes(segment.geometry, "bus"));
});

test("inserting and removing a stop preserves the route's shaping points", async () => {
  reset();
  const line = await drawVia();
  useStore.getState().cancelDrawing();
  useStore.getState().beginInsert(line.id, "outbound", 0);
  await useStore.getState().insertStopAtSlot("c");
  const split = useStore.getState().lines[0];
  assert.deepEqual(split.outboundStopIds, ["a", "c", "b"]);
  assert.deepEqual(split.segments.flatMap((s) => s.waypoints ?? []), [d, c]);
  for (const segment of split.segments) assert.equal(segment.travelMin, estimateTravelMinutes(segment.geometry, "bus"));
  await useStore.getState().removeStopFromLine(line.id, "c", "outbound");
  assert.deepEqual(useStore.getState().lines[0].segments[0].waypoints, [d, c]);
});
