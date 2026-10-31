import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TAKT } from "../src/constants";
import { calculateIsochrones, isochroneBands } from "../src/lib/isochrones";
import { calculateAccessibility, WALK_METERS_PER_MIN } from "../src/lib/pedestrianRouting";
import { parseWalkingNetwork, isWalkable, type WalkingNetwork } from "../src/lib/walkingNetwork";
import { haversine } from "../src/lib/geo";
import { buildTimetable, findSharedSections, nextDeparture } from "../src/lib/timetable";
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
  Math.round((calculateAccessibility({ ...request, lines, ...overrides }).stopTimes.get(id) ?? Infinity) * 1e9) / 1e9;

test("hourly empirical mean for a periodic service preserves staying on the vehicle", () => {
  const route = line("A", ["s0", "s1", "s2"]);
  assert.equal(timeAt([route], "s1"), 8);
  assert.equal(timeAt([route], "s2"), 11);
  assert.equal(timeAt([{ ...route, visible: false }], "s2"), 11);
});

test("transfers catch or miss actual departures and respect the selected period", () => {
  const first = line("A", ["s0", "s1"]);
  const second = line("B", ["s1", "s2"]);
  assert.equal(timeAt([first, second], "s2"), 18);
  assert.equal(timeAt([first, second], "s2", { period: "wd_early" }), 13 + DEFAULT_TAKT.wd_early!);
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
  assert.ok(walk > 0);
  assert.equal(timeAt([first, second], "s2", { stops: [...stops, platform] }), 18);
  const start: Coord = [origin[0], origin[1] - 0.001];
  assert.equal(timeAt([first], "s1", { origin: start, departureMinute: 0 }), 13);
  assert.ok(Math.abs(timeAt([first], "s1", { origin: start }) - (8 + haversine(start, origin) / WALK_METERS_PER_MIN)) <= 0.25);
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

test("repeated origins reuse walking preparation without leaking edge splits or transit connections", async () => {
  const { prepareWalkingGraph } = await import("../src/lib/pedestrianRouting");
  const walking: WalkingNetwork = { coords: [origin, [origin[0] + 0.1, origin[1]]],
    edges: [{ from: 0, to: 1, meters: haversine(origin, [origin[0] + 0.1, origin[1]]), forward: true, backward: true }], fetchedAt: 0 };
  const prepared = prepareWalkingGraph(walking);
  const original = JSON.stringify(walking);
  const first = calculateAccessibility({ ...request, network: walking, lines: [line("A", ["s0", "s1"])], origin: [origin[0] + 0.03, origin[1]] });
  const other = calculateAccessibility({ ...request, network: walking, lines: [], origin: [origin[0] + 0.07, origin[1]] });
  assert.equal(prepareWalkingGraph(walking), prepared);
  assert.equal(first.stopTimes.size, 2);
  assert.equal(other.stopTimes.size, 0);
  assert.equal(other.activeLines, 0);
  assert.ok(Math.abs(other.times[0] - haversine(origin, [origin[0] + 0.07, origin[1]]) / WALK_METERS_PER_MIN) < 0.001);
  assert.equal(JSON.stringify(walking), original);
  assert.notEqual(prepareWalkingGraph({ ...walking }), prepared);
});


test("actual coincident departures do not provide independent-arrival waiting benefits", () => {
  const a = line("A", ["s0", "s1", "s2"]), b = line("B", ["s0", "s1", "s2"]);
  assert.equal(timeAt([a, b], "s1"), 8);
  assert.equal(timeAt([a, b], "s2"), 11);
  assert.equal(timeAt([a, { ...b, departureOffsetMin: 5 }], "s2"), 8.5);
  assert.equal(timeAt([a, { ...b, departureOffsetMin: 5, visible: false }], "s2"), 8.5);
});

test("coordination staggers two 15-minute services and respects the network time translation", () => {
  const routes = ["A", "B"].map((id) => ({ ...line(id, ["s0", "s1", "s2"]), coordinationId: "group",
    departureOffsetMin: 2, takt: { ...DEFAULT_TAKT, wd_am: 15 } }));
  const runs = buildTimetable(routes, "wd_am");
  assert.equal(runs[0].phase, 2); assert.equal(runs[1].phase, 9.5);
  assert.equal(timeAt(routes, "s1"), 6.75);
  assert.equal(timeAt(routes, "s2"), 9.75);
  assert.equal(timeAt(routes, "s1", { departureMinute: 0 }), 5);
  assert.equal(timeAt(routes, "s1", { departureMinute: 0.1 }), 4.9);
});

test("best, worst and P90 summarize complete journeys rather than individual edge waits", () => {
  const routes = [line("A", ["s0", "s1"]), { ...line("B", ["s1", "s2"]), departureOffsetMin: 4 }];
  assert.equal(timeAt(routes, "s2", { departureMinute: 0 }), 7);
  assert.equal(timeAt(routes, "s2", { departureMinute: 0.01 }), 16.99);
  assert.equal(timeAt(routes, "s2", { scenario: "mean" }), 12);
  assert.equal(timeAt(routes, "s2", { scenario: "best" }), 7.25);
  assert.equal(timeAt(routes, "s2", { scenario: "worst" }), 16.75);
  assert.equal(timeAt(routes, "s2", { scenario: "p90" }), 15.75);
});

test("a coordinated corridor cannot give its short wait to a specific branch", () => {
  const a = { ...line("A", ["s0", "s1", "s2"]), coordinationId: "g" };
  const b = { ...line("B", ["s0", "s1", "s3"]), coordinationId: "g" };
  assert.equal(timeAt([a, b], "s1"), 5.5);
  assert.equal(timeAt([a, b], "s2"), 11);
  assert.equal(timeAt([a, b], "s3"), 11);
});

test("the longest continuous common section is selected independently in both directions", () => {
  const a = line("A", ["x", "s0", "s1", "s2", "q", "s0", "s1"]);
  const b = line("B", ["s0", "s1", "s2", "z", "s0", "s1"]);
  a.inboundStopIds = ["s2", "s1", "s0"]; b.inboundStopIds = ["s2", "s1", "s0"];
  for (const route of [a, b]) route.segments.push(...["s1", "s0"].map((to, i) => ({ id: `${route.id}-in-${i}`,
    fromStopId: ["s2", "s1"][i], toStopId: to, direction: "inbound" as const, geometry: [], travelMin: 3 })));
  const sections = findSharedSections([a, b]);
  assert.deepEqual(sections.map((s) => s.stops), [["s0", "s1", "s2"], ["s2", "s1", "s0"]]);
  assert.deepEqual(findSharedSections([line("A", ["s0", "s1", "s2"]), line("B", ["s0", "s2"])]), []);
  const broken = { ...b, segments: b.segments.filter((s) => s.fromStopId !== "s1") };
  assert.ok(findSharedSections([a, broken]).every((s) => s.stops.length <= 2));
});

test("coordination uses travel to the corridor, ignores inactive members, and retains physical platforms", () => {
  const a = { ...line("A", ["s0", "s1", "s2"]), coordinationId: "g" };
  const b = { ...line("B", ["s1", "s2"]), coordinationId: "g" };
  const runs = buildTimetable([a, b], "wd_am");
  assert.equal(nextDeparture(0, runs[0].phase + 3, 10), 3);
  assert.equal(nextDeparture(0, runs[1].phase, 10), 8);
  const off = { ...b, takt: { ...b.takt, wd_am: null } };
  assert.equal(timeAt([a, off], "s2"), 11);
  assert.deepEqual(findSharedSections([a, line("C", ["other-platform", "s2"])]), []);
  const unequal = buildTimetable([a, { ...b, takt: { ...b.takt, wd_am: 20 } }], "wd_am");
  assert.deepEqual(unequal.map((r) => r.headway), [10, 20]);
});

test("incremental hourly simulation matches independent searches for every statistic", () => {
  const routes = [line("A", ["s0", "s1", "s2"]), { ...line("B", ["s1", "s3"], 4), departureOffsetMin: 4.5 },
    { ...line("C", ["s0", "s3"], 12), departureOffsetMin: 1, takt: { ...DEFAULT_TAKT, wd_am: 7.5 } }];
  const samples = Array.from({ length: 120 }, (_, i) => calculateAccessibility({ ...request, lines: routes, departureMinute: (i + 0.5) / 2 }));
  for (const scenario of ["mean", "best", "worst", "p90"] as const) {
    const result = calculateAccessibility({ ...request, lines: routes, scenario });
    for (const [id, actual] of result.stopTimes) {
      const values = samples.map((s) => s.stopTimes.get(id)!).sort((a, b) => a - b);
      const expected = scenario === "mean" ? values.reduce((a, b) => a + b, 0) / values.length
        : scenario === "best" ? values[0] : scenario === "worst" ? values.at(-1)! : values[Math.ceil(values.length * .9) - 1];
      assert.ok(Math.abs(actual - expected) < 1e-8 || actual === expected, `${scenario} ${id}: ${actual} != ${expected}`);
    }
  }
});

test("three coordinated lines keep actual five-minute departures; unequal takts are simulated", () => {
  const routes = ["A", "B", "C"].map((id) => ({ ...line(id, ["s0", "s1"]), coordinationId: "g",
    takt: { ...DEFAULT_TAKT, wd_am: 15 } }));
  assert.deepEqual(buildTimetable(routes, "wd_am").map((run) => run.phase), [0, 5, 10]);
  assert.equal(timeAt(routes, "s1"), 5.5);
  const mixed = [routes[0], { ...routes[1], takt: { ...routes[1].takt, wd_am: 20 } }];
  const runs = buildTimetable(mixed, "wd_am");
  const empirical = Array.from({ length: 120 }, (_, i) => {
    const departure = (i + .5) / 2;
    return Math.min(...runs.map((run) => nextDeparture(departure, run.phase, run.headway) + 3)) - departure;
  }).reduce((a, b) => a + b, 0) / 120;
  assert.ok(Math.abs(timeAt(mixed, "s1") - empirical) < 1e-8);
  const inactive = { ...routes[1], takt: { ...routes[1].takt, wd_am: null } };
  assert.equal(buildTimetable([{ ...routes[0], departureOffsetMin: 2 }, inactive], "wd_am")[0].phase, 2);
});
