import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TAKT } from "../src/constants";
import { calculateIsochrones, contourAreas, reachablePoints, WALK_METERS_PER_MIN } from "../src/lib/isochrones";
import { haversine } from "../src/lib/geo";
import type { Coord, Stop, TransitLine } from "../src/types";

const origin: Coord = [19.94, 50.06];
const stops: Stop[] = [0, 1, 2, 3].map((n) => ({
  id: `s${n}`, name: `Stop ${n}`, lat: origin[1], lon: origin[0] + n * 0.04,
  modes: ["bus"], source: "local",
}));
function line(id: string, ids: string[], travelMin = 3): TransitLine {
  return { id, number: id, name: id, mode: "bus", vehicle: "12m", color: "#123456", visible: true,
    outboundStopIds: ids, inboundStopIds: [], terminus1Id: ids[0], terminus2Id: ids.at(-1)!,
    takt: { ...DEFAULT_TAKT, wd_am: 10 }, layoverMin: 5,
    segments: ids.slice(1).map((to, i) => ({ id: `${id}-${i}`, fromStopId: ids[i], toStopId: to,
      geometry: [], direction: "outbound", travelMin })),
  };
}
const request = { origin, stops, period: "wd_am" as const, maxMinutes: 45 };
const timeAt = (lines: TransitLine[], id: string, overrides = {}) =>
  reachablePoints({ ...request, lines, ...overrides }).points.find((p) => p.stopId === id)?.minutes ?? Infinity;

test("boarding pays half a headway once, riding through stops keeps the vehicle", () => {
  const route = line("A", ["s0", "s1", "s2"]);
  assert.equal(timeAt([route], "s1"), 8);
  assert.equal(timeAt([route], "s2"), 11);
  assert.equal(timeAt([{ ...route, visible: false }], "s2"), 11);
});

test("transfers pay for a second boarding and respect the selected period", () => {
  const first = line("A", ["s0", "s1"]);
  const second = line("B", ["s1", "s2"]);
  assert.equal(timeAt([first, second], "s2"), 16);
  assert.equal(timeAt([first, second], "s2", { period: "wd_early" }), 26);
  const inactive = { ...second, takt: { ...second.takt, wd_am: null } };
  assert.equal(timeAt([first, inactive], "s2"), Infinity);
});

test("directed segments do not allow riding backwards or jumping across missing segments", () => {
  const route = line("A", ["s0", "s1", "s2"]);
  assert.equal(timeAt([route], "s0", { origin: [stops[2].lon, stops[2].lat], maxMinutes: 30 }), Infinity);
  assert.equal(timeAt([{ ...route, segments: route.segments.slice(1) }], "s2", { maxMinutes: 30 }), Infinity);
});

test("origin access, nearby platform transfers and final walking consume time", () => {
  const platform: Stop = { ...stops[1], id: "platform", lat: stops[1].lat + 0.001 };
  const first = line("A", ["s0", "s1"]), second = line("B", ["platform", "s2"]);
  const walk = haversine([stops[1].lon, stops[1].lat], [platform.lon, platform.lat]) / WALK_METERS_PER_MIN;
  assert.ok(Math.abs(timeAt([first, second], "s2", { stops: [...stops, platform] }) - (16 + walk)) < 1e-6);
  const start: Coord = [origin[0], origin[1] - 0.001];
  assert.ok(Math.abs(timeAt([first], "s1", { origin: start }) - (8 + haversine(start, origin) / WALK_METERS_PER_MIN)) < 1e-6);
});

test("choose the earliest route and reject invalid headways / segment times", () => {
  const slow = line("slow", ["s0", "s2"], 20), fast = line("fast", ["s0", "s1", "s2"]);
  assert.equal(timeAt([slow, fast], "s2"), 11);
  assert.equal(timeAt([{ ...fast, takt: { ...fast.takt, wd_am: 0 } }], "s2"), Infinity);
  assert.equal(timeAt([line("invalid", ["s0", "s2"], NaN)], "s2"), Infinity);
});

test("walking-only contours have closed finite rings at the requested travel distance", () => {
  const result = calculateIsochrones({ ...request, lines: [], maxMinutes: 30 });
  assert.equal(result.activeLines, 0);
  assert.equal(result.reachableStops, 0);
  assert.deepEqual(result.areas.features.map((f) => f.properties?.minutes), [30, 20, 10]);
  for (const feature of result.areas.features) {
    assert.equal(feature.geometry.coordinates.length, 1);
    assert.equal(feature.geometry.coordinates[0].length, 1);
    const ring = feature.geometry.coordinates[0][0];
    assert.deepEqual(ring[0], ring.at(-1));
    for (const coord of ring) {
      assert.ok(coord.every(Number.isFinite));
      assert.ok(Math.abs(haversine(origin, coord as Coord) - feature.properties!.minutes * WALK_METERS_PER_MIN) < 25);
    }
  }
});

test("contours keep disconnected transit destinations as separate islands", () => {
  const result = calculateIsochrones({ ...request, lines: [line("express", ["s0", "s3"], 1)], maxMinutes: 30 });
  const ten = result.areas.features.find((f) => f.properties?.minutes === 10)!;
  assert.equal(ten.geometry.coordinates.length, 2);
});

test("contours preserve inaccessible holes within a ring of reachable destinations", () => {
  const points = Array.from({ length: 12 }, (_, i) => {
    const theta = i / 12 * Math.PI * 2;
    return { coord: [origin[0] + Math.cos(theta) * 1700 / (111195 * Math.cos(origin[1] * Math.PI / 180)),
      origin[1] + Math.sin(theta) * 1700 / 111195] as Coord, minutes: 0 };
  });
  const result = contourAreas(points, origin, 10);
  assert.equal(result.areas.features[0].geometry.coordinates.length, 1);
  assert.equal(result.areas.features[0].geometry.coordinates[0].length, 2);
});
