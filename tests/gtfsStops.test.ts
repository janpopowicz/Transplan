import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fixture from "./fixtures/ztp-stops.json";
import { attachLegacyStopIds, fetchGtfsStops, importGtfsStops, parseGtfsCsv, type GtfsFeed } from "../src/lib/gtfsStops";
import { mergeStopCatalogue } from "../src/lib/stopEditing";
import { clusterStops } from "../src/lib/geo";
import { buildRenderSegments } from "../src/lib/interline";
import { buildNetworkStopMarkers } from "../src/lib/networkStops";
import { parseProposal } from "../src/lib/proposal";
import { readOsmCache, writeOsmCache } from "../src/lib/overpass";
import { DEFAULT_TAKT, STOP_GROUP_METERS } from "../src/constants";
import type { LineSegment, Stop, TransitLine } from "../src/types";

const catalogue = () => importGtfsStops(fixture as GtfsFeed[]);
const row = (name: string, number: string, id: string, lat = "50.06") => ({
  stop_name: name, stop_desc: number, stop_id: id, stop_code: `100-${number}`, stop_lat: lat, stop_lon: "19.94", location_type: "0",
});

test("real A/M/T feeds have one entry per exact name and platform, including Kurdwanów and Teligi", () => {
  const stops = catalogue();
  assert.equal(stops.length, 14);
  assert.deepEqual(stops.filter((s) => s.stationName === "Kurdwanów P+R" && s.modes.includes("bus")).map((s) => s.platformNumber), ["02", "04", "05", "06"]);
  assert.deepEqual(stops.filter((s) => s.stationName === "Teligi").map((s) => [s.platformNumber, s.modes]),
    [["01", ["tram"]], ["02", ["tram"]], ["03", ["bus"]], ["04", ["bus"]]]);
  const bujaka = stops.find((s) => s.name === "Bujaka 01")!;
  assert.deepEqual(bujaka.gtfsIds, ["A:10468", "M:2813"]);
  assert.equal(bujaka.lat, 50.01034); // deterministic MPK position, not averaged with Mobilis or OSM
});

test("identity requires exact full names and matching GTFS platform numbers, independent of distance and mode", () => {
  const stops = importGtfsStops([
    { id: "A", mode: "bus", rows: [row("Alpha", "01", "1"), row("Alpha", "02", "2"), row("alpha", "01", "3"), row("Alpha Szpital", "01", "4")] },
    { id: "M", mode: "bus", rows: [row("Alpha", "01", "different-id", "50.061")] },
    { id: "T", mode: "tram", rows: [row("Alpha", "01", "tram-id")] },
  ]);
  assert.equal(stops.length, 4);
  const alpha = stops.find((s) => s.name === "Alpha 01")!;
  assert.deepEqual(alpha.modes, ["bus", "tram"]);
  assert.equal(alpha.gtfsIds!.length, 3);
  assert.equal(new Set(stops.map((s) => s.id)).size, 4); // catalogue platforms stay distinct
});

test("GTFS line 30 gets one circular network marker for opposite platforms served in both directions", () => {
  const stops = catalogue().filter((s) => s.stationName === "Bujaka" || s.stationName === "Kurdwanów P+R");
  const find = (name: string) => stops.find((s) => s.name === name)!;
  const a1 = find("Bujaka 01"), a2 = find("Bujaka 02");
  const b1 = find("Kurdwanów P+R 04"), b2 = find("Kurdwanów P+R 02");
  const segment = (from: Stop, to: Stop, direction: LineSegment["direction"]): LineSegment => ({
    id: direction, fromStopId: from.id, toStopId: to.id, direction,
    geometry: [[from.lon, from.lat], [to.lon, to.lat]], travelMin: 2,
  });
  const line = { ...legacyLine([a1.id, b1.id]), outboundStopIds: [a1.id, b1.id], inboundStopIds: [b2.id, a2.id],
    segments: [segment(a1, b1, "outbound"), segment(b2, a2, "inbound")] };
  const before = JSON.stringify({ stops, line });
  const groups = clusterStops(stops, STOP_GROUP_METERS);
  assert.equal(groups.length, 2);
  for (const scale of [1, 8]) {
    const render = buildRenderSegments([line], { stops, metersPerPx: scale, collapseDirections: true });
    assert.equal(render.length, 1);
    assert.equal(render[0].oneWay, false);
    const markers = buildNetworkStopMarkers([line], stops, render);
    assert.equal(markers.length, 2);
    assert.ok(markers.every((m) => m.direction === null));
    assert.ok(markers.some((m) => m.group.some((s) => s.id === a1.id) && m.group.some((s) => s.id === a2.id)));
    assert.ok(markers.some((m) => m.group.some((s) => s.id === b1.id) && m.group.some((s) => s.id === b2.id)));
  }
  const outbound = { ...line, inboundStopIds: [], segments: line.segments.slice(0, 1) };
  const render = buildRenderSegments([outbound], { stops, collapseDirections: true });
  assert.ok(buildNetworkStopMarkers([outbound], stops, render).every((m) => m.direction !== null));
  assert.equal(buildRenderSegments([line], { stops, collapseDirections: false }).length, 2);
  assert.equal(JSON.stringify({ stops, line }), before); // grouping never merges the catalogue or changes the route
});

test("CSV handles Polish names, BOM, quoted commas, escaped quotes and line breaks", () => {
  const parsed = parseGtfsCsv('\uFEFFstop_id,stop_name\r\n1,"Łąki, \"\"Park\"\""\r\n2,"Wiersz\nDrugi"\r\n');
  assert.deepEqual(parsed, [{ stop_id: "1", stop_name: 'Łąki, "Park"' }, { stop_id: "2", stop_name: "Wiersz\nDrugi" }]);
  assert.throws(() => parseGtfsCsv('a,b\n1,"unfinished'), /Niekompletny/);
  assert.throws(() => importGtfsStops([{ id: "A", mode: "bus", rows: [{ ...row("Alpha", "01", "1"), stop_lat: "" }] }]), /Nieprawidłowe/);
});

function legacyLine(ids: string[]): TransitLine {
  return { id: "line", name: "", number: "30", color: "#123456", mode: "bus", vehicle: "12m", visible: true,
    outboundStopIds: ids, inboundStopIds: [...ids].reverse(), terminus1Id: ids[0], terminus2Id: ids.at(-1)!,
    segments: [{ id: "segment", fromStopId: ids[0], toStopId: ids.at(-1)!, geometry: [[19.94, 50.06], [19.95, 50.07]],
      direction: "outbound", travelMin: 4, travelTimeSource: "manual", waypoints: [[19.945, 50.065]] }],
    takt: { ...DEFAULT_TAKT }, layoverMin: 5 };
}

test("saved OSM line references migrate to GTFS across platform representations without extra markers", () => {
  const stops = attachLegacyStopIds(catalogue(), [
    { id: "osm-node", name: "Bujaka 01" }, { id: "osm-way-1", name: "Bujaka 01" }, { id: "osm-other", name: "Bujaka 02" },
  ]);
  const line = legacyLine(["osm-node", "osm-way-1", "osm-other"]);
  const moved: Stop = { id: "osm-way-1", name: "Bujaka 01", source: "osm", modes: ["bus"],
    lon: 19.95, lat: 50.07, originalPosition: [19.94, 50.06], groupId: "manual" };
  const merged = mergeStopCatalogue(stops, [moved], [line]);
  assert.equal(merged.stops.length, 14);
  const first = merged.stops.find((s) => s.name === "Bujaka 01")!;
  const second = merged.stops.find((s) => s.name === "Bujaka 02")!;
  assert.equal(first.source, "gtfs");
  assert.equal(first.lon, 19.95);
  assert.deepEqual(first.originalPosition, [19.94884, 50.01034]);
  assert.equal(first.groupId, "manual");
  assert.deepEqual(merged.lines[0].outboundStopIds, [first.id, second.id]);
  assert.deepEqual(merged.lines[0].inboundStopIds, [second.id, first.id]);
  assert.equal(merged.lines[0].terminus1Id, first.id);
  assert.equal(merged.lines[0].terminus2Id, second.id);
  assert.equal(merged.lines[0].segments[0].fromStopId, first.id);
  assert.equal(merged.lines[0].segments[0].toStopId, second.id);
  assert.deepEqual(merged.lines[0].segments[0].geometry, line.segments[0].geometry);
  assert.deepEqual(merged.lines[0].segments[0].waypoints, line.segments[0].waypoints);
  assert.equal(merged.lines[0].segments[0].travelMin, 4);
  const proposal = { lines: merged.lines, localStops: [], movedStops: [first], localTracks: [], constructionOverrides: {} };
  assert.deepEqual(parseProposal(proposal), proposal); // API/shared snapshots accept GTFS positions
  assert.deepEqual(mergeStopCatalogue(stops, merged.stops, merged.lines), merged); // repeat refresh is idempotent
  assert.deepEqual(mergeStopCatalogue(merged.stops, [first], merged.lines), merged); // importing a saved moved stop resets its base first
});

test("unavailable referenced OSM stops survive as local proposals; unused OSM duplicates disappear", () => {
  const old: Stop = { id: "old", name: "Unused", lon: 19.94, lat: 50.06, modes: ["bus"], source: "osm" };
  const local: Stop = { ...old, id: "local", source: "local" };
  const used = { ...old, id: "used", name: "Obsolete unnumbered stop" };
  const result = mergeStopCatalogue(catalogue(), [old, used, local], [legacyLine(["used", "local"])]);
  assert.equal(result.stops.find((s) => s.id === "used")!.source, "local");
  assert.ok(result.stops.some((s) => s.id === "local"));
  assert.ok(!result.stops.some((s) => s.id === "old"));
});

test("old OSM cache is migration data only; GTFS cache replaces it while retaining tracks", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const legacy = [{ id: "old", name: "Bujaka 01", source: "osm" }];
  const values = new Map([["transplan-osm-cache-v5", JSON.stringify({ at: Date.now(), stops: legacy, tracks: [{ id: "track" }] })]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    assert.deepEqual(readOsmCache()!.stops, []);
    assert.deepEqual(readOsmCache()!.legacyStops, legacy);
    assert.equal(readOsmCache()!.tracks[0].id, "track");
    writeOsmCache(catalogue(), []);
    assert.deepEqual(readOsmCache()!.stops, catalogue());
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("catalogue fetch only uses GTFS and rejects duplicate identities instead of falling back to OSM", async () => {
  const fetcher = globalThis.fetch;
  let stops = catalogue();
  globalThis.fetch = async (url) => {
    assert.equal(url, "/stops.json");
    return new Response(JSON.stringify({ version: 1, stops }));
  };
  try {
    assert.deepEqual(await fetchGtfsStops(), stops);
    stops = [stops[0], stops[0]];
    await assert.rejects(fetchGtfsStops(), /Powtórzone/);
  } finally { globalThis.fetch = fetcher; }
});

test("entire reimported database has unique name/number pairs and unique legacy IDs", () => {
  const { stops } = JSON.parse(readFileSync("public/stops.json", "utf8")) as { stops: Stop[] };
  assert.ok(stops.length > 3000);
  assert.equal(new Set(stops.map((s) => JSON.stringify([s.stationName, s.platformNumber]))).size, stops.length);
  assert.equal(new Set(stops.map((s) => s.id)).size, stops.length);
  assert.ok(stops.every((s) => s.source === "gtfs" && s.gtfsIds!.length));
  const aliases = stops.flatMap((s) => s.aliases ?? []);
  assert.equal(new Set(aliases).size, aliases.length);
});
