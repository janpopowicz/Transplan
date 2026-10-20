import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRenderSegments } from "../src/lib/interline";
import { isNetworkView } from "../src/lib/mapViewMode";
import { buildNetworkStopMarkers } from "../src/lib/networkStops";
import { DEFAULT_TAKT, OFFSET_GAP_PX } from "../src/constants";
import { haversine, metersPerPixel, nearestPointOnLine, pointAlong } from "../src/lib/geo";
import type { Coord, LineSegment, Stop, TransitLine } from "../src/types";

const base: Coord = [19.9372, 50.0614];
function xy(x: number, y: number): Coord { return [base[0] + x / 71400, base[1] + y / 111200]; }
function stop(id: string, x: number, y = 0, name = id): Stop {
  const [lon, lat] = xy(x, y);
  return { id, name, lon, lat, source: "local", modes: ["bus"] };
}
function segment(a: Stop, b: Stop, direction: LineSegment["direction"] = "outbound", via: Coord[] = []): LineSegment {
  return { id: `${a.id}-${b.id}`, fromStopId: a.id, toStopId: b.id,
    geometry: [[a.lon, a.lat], ...via, [b.lon, b.lat]], direction, travelMin: 2 };
}
function line(id: string, segments: LineSegment[]): TransitLine {
  return { id, number: id, color: "#c41e3a", name: id, mode: "bus", vehicle: "12m", visible: true,
    outboundStopIds: [], inboundStopIds: [], terminus1Id: null, terminus2Id: null,
    segments, takt: { ...DEFAULT_TAKT }, layoverMin: 5 };
}
const render = (lines: TransitLine[], stops: Stop[], metersPerPx = 1) =>
  buildRenderSegments(lines, { stops, metersPerPx, collapseDirections: true });
const a = stop("a", 0), b = stop("b", 300), c = stop("c", 600), d = stop("d", 900);
const stops = [a, b, c, d];
const local = line("100", [segment(a, b), segment(b, c), segment(c, d),
  segment(d, c, "inbound"), segment(c, b, "inbound"), segment(b, a, "inbound")]);
const express = line("500", [segment(a, d), segment(d, a, "inbound")]);

test("opposite platforms merge at their mean, without doubling stroke width", () => {
  const a1 = stop("a1", 0, -12, "Alpha 01"), a2 = stop("a2", 0, 12, "Alpha 02");
  const b1 = stop("b1", 300, -12, "Beta 01"), b2 = stop("b2", 300, 12, "Beta 02");
  const route = line("100", [segment(a1, b1), segment(b2, a2, "inbound")]);
  const result = render([route], [a1, a2, b1, b2]);
  assert.equal(result.length, 1);
  assert.equal(result[0].oneWay, false);
  assert.ok(Math.abs(result[0].width - 3.6) < 1e-8);
  assert.ok(haversine(result[0].geometry[0], xy(0, 0)) < 0.01);
  assert.ok(haversine(result[0].geometry.at(-1)!, xy(300, 0)) < 0.01);
  assert.ok(haversine(pointAlong(result[0].geometry, 0.5), xy(150, 0)) < 0.1);
  const detailed = buildRenderSegments([route], { stops: [a1, a2, b1, b2] });
  assert.equal(detailed.length, 2);
  assert.ok(haversine(detailed[0].geometry[0], [a1.lon, a1.lat]) < 0.01);
});

test("one-way stroke has exactly half width and follows actual travel, including inbound-only", () => {
  const both = render([line("1", [segment(a, b), segment(b, a, "inbound")])], [a, b])[0];
  for (const seg of [segment(a, b), segment(b, a, "inbound")]) {
    const one = render([line("1", [seg])], [a, b])[0];
    assert.equal(one.width, both.width / 2);
    assert.equal(one.oneWay, true);
    assert.ok(haversine(one.geometry[0], seg.geometry[0]) < 0.01);
    assert.equal(one.number, "1");
  }
});

test("express skipping multiple stops shares every corridor without adding actual stops", () => {
  const original = JSON.stringify([local, express]);
  const result = render([local, express], stops);
  assert.equal(result.length, 6);
  assert.ok(result.every((r) => !r.oneWay));
  const ordinary = result.filter((r) => r.lineId === local.id);
  const fast = result.filter((r) => r.lineId === express.id);
  for (let i = 0; i < 3; i++) {
    const separation = haversine(pointAlong(ordinary[i].geometry, 0.5), pointAlong(fast[i].geometry, 0.5));
    assert.ok(Math.abs(separation - (ordinary[i].width + OFFSET_GAP_PX)) < 0.1);
    if (i > 0) assert.deepEqual(fast[i - 1].geometry.at(-1), fast[i].geometry[0]);
  }
  assert.equal(JSON.stringify([local, express]), original);
});

test("asymmetric stopping patterns still merge reverse travel on shared sections", () => {
  const asymmetric = line("1", [segment(a, d), segment(d, c, "inbound"),
    segment(c, b, "inbound"), segment(b, a, "inbound")]);
  const result = render([asymmetric], stops);
  assert.equal(result.length, 3);
  assert.ok(result.every((r) => !r.oneWay));
});

test("a one-way branch does not erase the shared two-way trunk", () => {
  const e = stop("e", 600, 240);
  const result = render([line("1", [segment(a, b), segment(b, c), segment(c, e),
    segment(e, b, "inbound"), segment(b, a, "inbound")])], [...stops, e]);
  assert.equal(result.filter((r) => !r.oneWay).length, 1);
  assert.equal(result.filter((r) => r.oneWay).length, 3);
});

test("a remote express bypass is not snapped across intervening stops", () => {
  const bypass = line("500", [segment(a, d, "outbound", [xy(100, 300), xy(800, 300)]),
    segment(d, a, "inbound", [xy(800, 300), xy(100, 300)])]);
  const result = render([local, bypass], stops);
  assert.equal(result.filter((r) => r.lineId === "500").length, 1);
  assert.ok(haversine(pointAlong(result.find((r) => r.lineId === "500")!.geometry, 0.5), xy(450, 0)) > 250);
});

test("lane joints stay continuous when bundle membership changes", () => {
  const short = line("50", [segment(a, b), segment(b, a, "inbound")]);
  const result = render([local, short], stops);
  const trunk = result.filter((r) => r.lineId === "100");
  for (let i = 1; i < trunk.length; i++) assert.deepEqual(trunk[i - 1].geometry.at(-1), trunk[i].geometry[0]);
});

test("hidden services do not consume lanes and zoom only changes screen-space spacing", () => {
  const solo = render([local, { ...express, visible: false }], stops);
  assert.equal(solo.length, 3);
  assert.ok(haversine(pointAlong(solo[0].geometry, 0.5), xy(150, 0)) < 0.1);
  for (const scale of [0.5, 2, 10]) {
    const result = render([local, express], stops, scale);
    const pair = result.slice(0, 2);
    assert.ok(Math.abs(haversine(pointAlong(pair[0].geometry, 0.5), pointAlong(pair[1].geometry, 0.5)) / scale - 5.8) < 0.1);
  }
});

test("mixed modes share all intermediate corridors, including without a stop catalogue", () => {
  const result = render([local, { ...express, mode: "tram" }], stops);
  assert.equal(result.filter((r) => r.lineId === "500").length, 3);
  assert.equal(buildRenderSegments([express], { collapseDirections: true }).length, 1);
  assert.equal(buildRenderSegments([local, { ...express, mode: "tram" }], { collapseDirections: true }).length, 6);
});

test("parallel bus and tram share lanes but only mark their own stops", () => {
  const busA = stop("bus-a", 0, -18, "Alpha 01"), busC = stop("bus-c", 600, -18, "Bus only");
  const busD = stop("bus-d", 900, -18, "Delta 01");
  const tramStop = (id: string, x: number, name: string): Stop => ({ ...stop(id, x, 18, name), modes: ["tram"] });
  const tramA = tramStop("tram-a", 0, "Alpha 02"), tramB = tramStop("tram-b", 300, "Tram only");
  const tramD = tramStop("tram-d", 900, "Delta 02");
  const bus = line("100", [segment(busA, busC), segment(busC, busD),
    segment(busD, busC, "inbound"), segment(busC, busA, "inbound")]);
  const tram: TransitLine = { ...line("13", [segment(tramA, tramB), segment(tramB, tramD),
    segment(tramD, tramB, "inbound"), segment(tramB, tramA, "inbound")]), mode: "tram", vehicle: "33m" };
  const routes = [bus, tram];
  const platforms = [busA, busC, busD, tramA, tramB, tramD];
  const before = JSON.stringify({ routes, platforms });
  for (const scale of [1, 8]) {
    const rendered = render(routes, platforms, scale);
    assert.equal(rendered.length, 6);
    assert.ok(rendered.every((part) => !part.oneWay));
    const buses = rendered.filter((part) => part.lineId === bus.id);
    const trams = rendered.filter((part) => part.lineId === tram.id);
    for (let i = 0; i < 3; i++) {
      assert.equal(buses[i].fromGroupId, trams[i].fromGroupId);
      assert.equal(buses[i].toGroupId, trams[i].toGroupId);
      const gap = haversine(pointAlong(buses[i].geometry, 0.5), pointAlong(trams[i].geometry, 0.5)) / scale;
      assert.ok(Math.abs(gap - ((buses[i].width + trams[i].width) / 2 + OFFSET_GAP_PX)) < 0.15);
      if (i) for (const parts of [buses, trams]) assert.deepEqual(parts[i - 1].geometry.at(-1), parts[i].geometry[0]);
    }
    const markers = buildNetworkStopMarkers(routes, platforms, rendered);
    assert.equal(markers.length, 6);
    assert.deepEqual(markers.filter((m) => m.lineId === bus.id).map((m) => m.group[0].id).sort(), ["bus-a", "bus-c", "bus-d"]);
    assert.deepEqual(markers.filter((m) => m.lineId === tram.id).map((m) => m.group[0].id).sort(), ["bus-a", "bus-d", "tram-b"]);
    for (const marker of markers) {
      assert.ok(rendered.some((part) => part.lineId === marker.lineId && nearestPointOnLine(marker.coord, part.geometry).dist < 0.01));
    }
  }
  const detailed = buildRenderSegments(routes, { stops: platforms, collapseDirections: false });
  assert.equal(detailed.length, 8);
  assert.equal(JSON.stringify({ routes, platforms }), before);
});

test("editing and drawing override network zoom", () => {
  const idle = { selectedLineId: null, drawing: null, insertSlot: null, tool: "select" as const };
  assert.equal(isNetworkView(12, idle), true);
  assert.equal(isNetworkView(15, idle), false);
  assert.equal(isNetworkView(12, { ...idle, selectedLineId: "1" }), false);
  assert.equal(isNetworkView(12, { ...idle, tool: "draw-bus" }), false);
  assert.equal(isNetworkView(12, { ...idle, drawing: { lineId: "1", mode: "bus", phase: "outbound" } }), false);
  assert.equal(isNetworkView(12, { ...idle, insertSlot: { lineId: "1", direction: "inbound", afterIndex: 1 } }), false);
});

test("opposite stored directions do not make parallel services swap sides at a group", () => {
  const reverseShort = line("50", [segment(b, a), segment(a, b, "inbound")]);
  const result = render([reverseShort, local, express], stops);
  const ordinary = result.filter((r) => r.lineId === "100");
  const fast = result.filter((r) => r.lineId === "500");
  const sides = ordinary.map((part, i) => Math.sign(
    pointAlong(part.geometry, 0.5)[1] - pointAlong(fast[i].geometry, 0.5)[1]));
  assert.ok(sides.every((side) => side === sides[0]));
  const atB = ordinary[0].geometry.at(-1)!;
  assert.ok(haversine(atB, fast[0].geometry.at(-1)!) > 4);
});


test("group connectivity merges directions even when they use different streets", () => {
  const result = render([line("1", [segment(a, b, "outbound", [xy(150, 160)]),
    segment(b, a, "inbound", [xy(150, -160)])])], [a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0].oneWay, false);
  assert.ok(haversine(pointAlong(result[0].geometry, 0.5), xy(150, 0)) < 1);
});

test("a reverse-only service in a shared bundle keeps its arrow travel direction", () => {
  const reverse = line("500", [segment(b, a, "inbound")]);
  const result = render([local, reverse], stops).find((r) => r.lineId === "500")!;
  assert.equal(result.oneWay, true);
  assert.ok(result.geometry[0][0] > result.geometry.at(-1)![0]);
});

test("screen offsets use MapLibre's 512-pixel zoom convention", () => {
  const zoom = 12, latitude = 50;
  const geographicMeters = haversine([19, latitude], [19.001, latitude]);
  const screenPixels = 0.001 / 360 * 512 * 2 ** zoom;
  assert.ok(Math.abs(metersPerPixel(latitude, zoom) * screenPixels / geographicMeters - 1) < 0.002);
});
