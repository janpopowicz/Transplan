import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchOsmRoads } from "../src/lib/overpass";
import { TramGraph } from "../src/lib/tramGraph";
import { pathDistances } from "../src/lib/geo";
import type { Coord } from "../src/types";
import bonarka from "./fixtures/matecznego-bonarka.json";

test("Rondo Matecznego 03 to Bonarka 01 snaps to the road, not a pedestrian area", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(bonarka)));
  const roads = await fetchOsmRoads();
  assert.ok(!roads.some((road) => road.osmId === 309423742));
  const graph = new TramGraph();
  graph.load(roads.filter((road) => !road.construction));
  const from: Coord = [19.9412762, 50.0358859];
  const to: Coord = [19.9539883, 50.0287799];
  const snap = graph.nearestOnNetwork(to)!;
  assert.ok(snap.dist > 6 && snap.dist < 9);
  const route = graph.route(from, to);
  assert.ok(route);
  const length = pathDistances(route).at(-1)!;
  assert.ok(length > 1200 && length < 1300, `unexpected route length: ${length}`);
  // Reintroducing the old importer bug reproduces the reported failure.
  const area = bonarka.elements.find((el) => el.id === 309423742)!;
  graph.addTrack({ id: "old-area", source: "osm", kind: "road", construction: false,
    geometry: area.geometry!.map((p): Coord => [p.lon, p.lat]) });
  assert.ok(graph.nearestOnNetwork(to)!.dist < 2);
  assert.equal(graph.route(from, to), null);
});

const xy = (x: number, y = 0): Coord => [19.94 + x / 71400, 50.03 + y / 111200];
const way = (id: number, points: Coord[], tags: Record<string, string> = {}) => ({
  type: "way", id, tags: { highway: "residential", ...tags },
  geometry: points.map(([lon, lat]) => ({ lon, lat })),
});

test("road import preserves junctions less than 14 meters from the preceding vertex", async (t) => {
  const junction = xy(5);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ elements: [
    way(1, [xy(0), junction, xy(200)]), way(2, [junction, xy(5, 200)]),
  ] })));
  const graph = new TramGraph();
  graph.load(await fetchOsmRoads());
  const route = graph.route(xy(150), xy(5, 150));
  assert.ok(route);
  assert.ok(route.some((p) => p[0] === junction[0] && p[1] === junction[1]));
});

test("pedestrian streets require vehicle access; area boundaries never become roads", async (t) => {
  const points = [xy(0), xy(100)];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ elements: [
    way(1, points, { highway: "pedestrian" }),
    way(2, points, { highway: "pedestrian", bus: "yes", access: "no" }),
    way(3, points, { highway: "pedestrian", psv: "designated" }),
    way(4, points, { highway: "pedestrian", bus: "no", psv: "yes" }),
    way(5, [...points, points[0]], { highway: "service", area: "yes" }),
    way(6, [...points, points[0]], { highway: "pedestrian", area: "yes", bus: "yes" }),
    way(7, points, { highway: "construction" }),
    way(8, [...points, points[0]], { highway: "residential", junction: "roundabout" }),
  ] })));
  const roads = await fetchOsmRoads();
  assert.deepEqual(roads.map((road) => road.osmId), [2, 3, 7, 8]);
  assert.equal(roads.find((road) => road.osmId === 7)!.construction, true);
});
