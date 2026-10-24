import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TAKT } from "../src/constants";
import { calculateIsochrones, isochroneBands } from "../src/lib/isochrones";
import { calculateAccessibility, WALK_METERS_PER_MIN } from "../src/lib/pedestrianRouting";
import { parseWalkingNetwork, isWalkable, type WalkingNetwork } from "../src/lib/walkingNetwork";
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
const network: WalkingNetwork = {
  coords: stops.flatMap((stop) => [[stop.lon, stop.lat], [stop.lon, stop.lat + 0.002]] as Coord[]),
  edges: stops.map((stop, i) => ({ from: i * 2, to: i * 2 + 1, meters: haversine([stop.lon, stop.lat], [stop.lon, stop.lat + 0.002]), forward: true, backward: true })),
  fetchedAt: 0,
};
const request = { origin, stops, period: "wd_am" as const, network };
const timeAt = (lines: TransitLine[], id: string, overrides = {}) =>
  calculateAccessibility({ ...request, lines, ...overrides }).stopTimes.get(id) ?? Infinity;

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
  assert.equal(timeAt([first, second], "s2", { period: "wd_early" }), 6 + DEFAULT_TAKT.wd_early!);
  const inactive = { ...second, takt: { ...second.takt, wd_am: null } };
  assert.equal(timeAt([first, inactive], "s2"), Infinity);
});

test("directed segments do not allow riding backwards or jumping across missing segments", () => {
  const route = line("A", ["s0", "s1", "s2"]);
  assert.equal(timeAt([route], "s0", { origin: [stops[2].lon, stops[2].lat] }), Infinity);
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

test("walking follows a distant bridge instead of crossing a narrow river", () => {
  const coords: Coord[] = [origin, [origin[0], origin[1] + 0.02], [origin[0] + 0.002, origin[1] + 0.02], [origin[0] + 0.002, origin[1]]];
  const bridge: WalkingNetwork = { coords, edges: coords.slice(1).map((_, i) => ({
    from: i, to: i + 1, meters: haversine(coords[i], coords[i + 1]), forward: true, backward: true,
  })), fetchedAt: 0 };
  const result = calculateAccessibility({ ...request, stops: [], lines: [], network: bridge });
  const walking = bridge.edges.reduce((sum, edge) => sum + edge.meters, 0) / WALK_METERS_PER_MIN;
  assert.ok(Math.abs(result.times[3] - walking) < 1e-6);
  assert.ok(result.times[3] > 50);
  assert.ok(haversine(coords[0], coords[3]) / WALK_METERS_PER_MIN < 2);
});

test("OSM access and separate sidewalks are respected", () => {
  assert.equal(isWalkable({ highway: "footway", foot: "no" }), false);
  assert.equal(isWalkable({ highway: "path", access: "private" }), false);
  assert.equal(isWalkable({ highway: "path", access: "private", foot: "yes" }), true);
  assert.equal(isWalkable({ highway: "primary", sidewalk: "separate" }), false);
  assert.equal(isWalkable({ highway: "motorway" }), false);
  assert.equal(isWalkable({ highway: "steps" }), true);
  assert.equal(isWalkable({ highway: "cycleway", foot: "yes" }), true);
});

test("geometric crossings with distinct OSM node IDs do not create connections", () => {
  const parsed = parseWalkingNetwork([
    { type: "way", id: 1, nodes: [1, 2], tags: { highway: "footway" }, geometry: [{ lon: origin[0], lat: origin[1] }, { lon: origin[0] + 0.01, lat: origin[1] }] },
    { type: "way", id: 2, nodes: [3, 4], tags: { highway: "footway" }, geometry: [{ lon: origin[0] + 0.005, lat: origin[1] - 0.005 }, { lon: origin[0] + 0.005, lat: origin[1] + 0.005 }] },
  ]);
  const result = calculateAccessibility({ ...request, stops: [], lines: [], network: parsed });
  assert.ok(Number.isFinite(result.times[1]));
  assert.equal(result.times[2], Infinity);
  assert.equal(result.times[3], Infinity);
});

test("blocked pedestrian nodes break the path and vehicle one-way does not restrict walking", () => {
  const elements = [{ type: "way" as const, id: 1, nodes: [1, 2, 3], tags: { highway: "footway", oneway: "yes" },
    geometry: [{ lon: 19.94, lat: 50.06 }, { lon: 19.95, lat: 50.06 }, { lon: 19.96, lat: 50.06 }] }];
  const open = parseWalkingNetwork(elements);
  assert.equal(open.edges.length, 2);
  assert.ok(open.edges.every((edge) => edge.forward && edge.backward));
  const blocked = parseWalkingNetwork([...elements, { type: "node", id: 2, tags: { barrier: "gate", access: "private" } }]);
  assert.equal(blocked.edges.length, 0);
});

test("origin and stop snaps split an edge so trips do not detour via its ends", () => {
  const middle: Coord = [origin[0] + 0.03, origin[1]];
  const route: WalkingNetwork = { coords: [origin, [origin[0] + 0.1, origin[1]]],
    edges: [{ from: 0, to: 1, meters: haversine(origin, [origin[0] + 0.1, origin[1]]), forward: true, backward: true }], fetchedAt: 0 };
  const result = calculateAccessibility({ ...request, origin: middle, lines: [line("A", ["s0", "s1"])], network: route });
  assert.ok(Math.abs(result.stopTimes.get("s1")! - haversine(middle, [stops[1].lon, stops[1].lat]) / WALK_METERS_PER_MIN) < 0.001);
});

test("isochrones extend beyond an hour to the maximum reachable time with finite closed rings", () => {
  const far: Coord = [20.18, origin[1]];
  const longWalk: WalkingNetwork = { coords: [origin, far], edges: [{ from: 0, to: 1,
    meters: haversine(origin, far), forward: true, backward: true }], fetchedAt: 0 };
  const result = calculateIsochrones({ ...request, stops: [], lines: [], network: longWalk });
  assert.ok(result.maxMinutes > 200);
  assert.equal(result.bands.at(-1)!.minutes, Math.ceil(result.maxMinutes));
  assert.ok(result.bands.some((b) => b.minutes === 120));
  for (const feature of result.fills.features) {
    for (const polygon of feature.geometry.coordinates) for (const ring of polygon) {
      assert.ok(ring.length >= 4);
      assert.deepEqual(ring[0], ring.at(-1));
      assert.ok(ring.flat().every(Number.isFinite));
    }
  }
  assert.deepEqual(isochroneBands(34).map((b) => b.minutes), [10, 20, 30, 34]);
});

test("unconnected streets stay unreachable even when nearby", () => {
  const result = calculateAccessibility({ ...request, stops: [], lines: [] });
  assert.equal(result.times[2], Infinity);
  assert.ok(Number.isFinite(result.times[1]));
  assert.throws(() => calculateAccessibility({ ...request, origin: [21, 51], lines: [] }), /150 m/);
});
