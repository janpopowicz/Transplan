import { DEFAULT_TAKT } from "../src/constants";
import type { Coord, Stop, TransitLine, LineSegment, TramTrack } from "../src/types";
const xy = (x: number, y: number): Coord => [19.9372 + x / 71400, 50.0614 + y / 111200];
const positions = [[-1500, 0], [-500, 200], [500, 0], [1500, -200], [1700, 800], [700, 900]];
const names = ["Alpha", "Beta", "Gamma", "Delta", "Echo", "Foxtrot"];
export const stops: Stop[] = positions.flatMap(([x, y], i) => [-24, 24].map((dy, p) => ({
  id: `${i}-${p}`, name: `${names[i]} 0${p + 1}`, lon: xy(x, y + dy)[0], lat: xy(x, y + dy)[1],
  source: "local", modes: ["bus"],
})));
const stop = (i: number, p = 0) => stops.find((s) => s.id === `${i}-${p}`)!;
function segment(a: number, b: number, direction: LineSegment["direction"] = "outbound", via: number[] = []): LineSegment {
  const p = direction === "outbound" ? 0 : 1;
  const coord = (i: number): Coord => [stop(i, p).lon, stop(i, p).lat];
  return { id: `${a}-${b}-${direction}`, fromStopId: stop(a, p).id, toStopId: stop(b, p).id,
    direction, geometry: [coord(a), ...via.map(coord), coord(b)], travelMin: 2 };
}
function line(id: string, color: string, segments: LineSegment[]): TransitLine {
  return { id, number: id, color, name: id, mode: "bus", vehicle: "18m", visible: true,
    outboundStopIds: [...new Set(segments.filter((s) => s.direction === "outbound").flatMap((s) => [s.fromStopId, s.toStopId]))],
    inboundStopIds: [...new Set(segments.filter((s) => s.direction === "inbound").flatMap((s) => [s.fromStopId, s.toStopId]))],
    terminus1Id: segments[0]?.fromStopId ?? null, terminus2Id: null,
    segments, takt: { ...DEFAULT_TAKT, wd_am: 5 }, layoverMin: 5 };
}
export const local = line("100", "#c41e3a", [segment(0, 1), segment(1, 2), segment(2, 3),
  segment(3, 2, "inbound"), segment(2, 1, "inbound"), segment(1, 0, "inbound")]);
export const express = line("500", "#1d4ed8", [segment(0, 3, "outbound", [1, 2]), segment(3, 0, "inbound", [2, 1])]);
export const branch = line("200", "#0f766e", [segment(1, 2), segment(2, 3), segment(3, 4), segment(4, 5),
  segment(5, 2, "inbound"), segment(2, 1, "inbound")]);
export const tracks: TramTrack[] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 2]].map(([a, b], i) => ({
  id: `road-${i}`, source: "local", kind: "road", construction: false,
  geometry: [xy(...positions[a] as [number, number]), xy(...positions[b] as [number, number])],
}));
