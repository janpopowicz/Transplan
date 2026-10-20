import {
  DIRECTION_COLLAPSE_M, LINE_WIDTH_FACTOR, LINE_WIDTH_MAX_PX, LINE_WIDTH_MIN_PX,
  OFFSET_BLEND_MAX_M, OFFSET_BLEND_MIN_M, OFFSET_BLEND_PX, OFFSET_GAP_PX,
  OFFSET_SAMPLE_M, STOP_GROUP_METERS,
} from "../constants";
import type { Coord, Stop, TransitLine } from "../types";
import type { RenderSegment } from "./interline";
import {
  bboxOf, clusterCentroid, clusterStops, densifyLine, haversine,
  nearestPointOnLine, offsetLine, pathDistances,
} from "./geo";
import { peakTakt, tripsPerHourNum } from "./takt";

interface Group {
  id: string;
  coord: Coord;
  stops: Stop[];
  used: boolean;
}
interface Leg {
  line: TransitLine;
  from: Group;
  to: Group;
  geom: Coord[];
}
interface Corridor {
  id: string;
  from: Group;
  to: Group;
  legs: Leg[];
  geom: Coord[];
}
interface Stroke {
  corridor: Corridor;
  line: TransitLine;
  width: number;
  offset: number;
  oneWay: boolean;
  reverse: boolean;
}

let cache: { lines: TransitLine[]; stops: Stop[] | undefined; strokes: Stroke[] } | null = null;

/** Network topology belongs to stop groups, not to directed OSM road edges. */
export function buildNetworkRenderSegments(
  lines: TransitLine[], stops: Stop[] | undefined, metersPerPx: number,
): RenderSegment[] {
  if (!cache || cache.lines !== lines || cache.stops !== stops) {
    cache = { lines, stops, strokes: prepare(lines, stops) };
  }
  const strokes = cache.strokes;
  const geometries = strokes.map((s) => offsetLine(s.corridor.geom,
    s.corridor.geom.map(() => s.offset * metersPerPx)));

  // The same service must meet at exactly the same point on both sides of a
  // group, even when another service joins/leaves and changes the bundle width.
  const joints = new Map<string, Coord[]>();
  strokes.forEach((s, i) => {
    for (const [group, coord] of [
      [s.corridor.from, geometries[i][0]],
      [s.corridor.to, geometries[i].at(-1)!],
    ] as const) {
      const key = JSON.stringify([s.line.id, group.id]);
      const coords = joints.get(key) ?? [];
      coords.push(coord);
      joints.set(key, coords);
    }
  });
  const centers = new Map([...joints].map(([key, coords]) => [key, mean(coords)]));
  const blend = Math.min(OFFSET_BLEND_MAX_M,
    Math.max(OFFSET_BLEND_MIN_M, OFFSET_BLEND_PX * metersPerPx));
  return strokes.map((s, i) => {
    const from = centers.get(JSON.stringify([s.line.id, s.corridor.from.id]))!;
    const to = centers.get(JSON.stringify([s.line.id, s.corridor.to.id]))!;
    const geometry = anchor(geometries[i], from, to, blend);
    return {
      id: JSON.stringify([s.corridor.id, s.line.id]),
      lineId: s.line.id, color: s.line.color, width: s.width, offset: 0,
      geometry: s.reverse ? geometry.reverse() : geometry,
      number: s.line.number, oneWay: s.oneWay,
      fromGroupId: s.corridor.from.id, toGroupId: s.corridor.to.id,
    };
  });
}

function prepare(lines: TransitLine[], stops: Stop[] | undefined): Stroke[] {
  const visible = lines.filter((l) => l.visible).sort(compareLines);
  const known = new Map((stops ?? []).map((s) => [s.id, s]));
  // Imported proposals can be rendered before the OSM stop catalogue arrives.
  for (const line of visible) for (const seg of line.segments) {
    if (seg.geometry.length < 2) continue;
    for (const [id, coord] of [[seg.fromStopId, seg.geometry[0]],
      [seg.toStopId, seg.geometry.at(-1)!]] as const) {
      if (!known.has(id)) known.set(id, {
        id, name: "", lon: coord[0], lat: coord[1], modes: [line.mode], source: "local",
      });
    }
  }
  const byStop = new Map<string, Group>();
  const groups = clusterStops([...known.values()].sort((a, b) => a.id.localeCompare(b.id)), STOP_GROUP_METERS)
    .map((members): Group => {
      const group = { id: members[0].id, coord: clusterCentroid(members), stops: members, used: false };
      for (const stop of members) byStop.set(stop.id, group);
      return group;
    });
  for (const line of visible) for (const seg of line.segments) {
    for (const id of [seg.fromStopId, seg.toStopId]) {
      const group = byStop.get(id);
      if (group) group.used = true;
    }
  }
  const used = groups.filter((g) => g.used);
  const corridors = new Map<string, Corridor>();
  for (const line of visible) for (const seg of line.segments) {
    const from = byStop.get(seg.fromStopId);
    const to = byStop.get(seg.toStopId);
    if (!from || !to || from === to || seg.geometry.length < 2) continue;
    const geom = anchor(densifyLine(seg.geometry, OFFSET_SAMPLE_M), from.coord, to.coord);
    const distances = pathDistances(geom);
    const length = distances.at(-1)!;
    if (length < 1) continue;
    const bounds = bboxOf(geom);
    const cuts = [{ group: from, at: 0, coord: geom[0], index: 0 },
      { group: to, at: length, coord: geom.at(-1)!, index: geom.length - 2 }];
    for (const group of used) {
      if (group === from || group === to) continue;
      // Nearby stops split the shared corridor regardless of transport mode.
      // A virtual cut does not add a served stop to this line.
      // Check platforms too: a centroid may be on the other side of a wide road.
      const candidates = [group.coord, ...group.stops.map((s): Coord => [s.lon, s.lat])];
      let best: ReturnType<typeof nearestPointOnLine> | undefined;
      for (const coord of candidates) {
        const padY = DIRECTION_COLLAPSE_M / 110540;
        const padX = padY / Math.max(0.2, Math.cos(coord[1] * Math.PI / 180));
        if (coord[0] < bounds[0] - padX || coord[0] > bounds[2] + padX ||
          coord[1] < bounds[1] - padY || coord[1] > bounds[3] + padY) continue;
        const near = nearestPointOnLine(coord, geom);
        if (!best || near.dist < best.dist) best = near;
      }
      if (!best || best.dist > DIRECTION_COLLAPSE_M) continue;
      const at = distances[best.index] + haversine(geom[best.index], best.coord);
      if (at < OFFSET_SAMPLE_M || length - at < OFFSET_SAMPLE_M) continue;
      cuts.push({ group, at, coord: best.coord, index: best.index });
    }
    cuts.sort((a, b) => a.at - b.at || a.group.id.localeCompare(b.group.id));
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1], b = cuts[i];
      if (b.at - a.at < 1) continue;
      const part = [a.coord, ...geom.slice(a.index + 1, b.index + 1), b.coord];
      const leg: Leg = { line, from: a.group, to: b.group,
        geom: anchor(part, a.group.coord, b.group.coord) };
      const key = JSON.stringify([a.group.id, b.group.id].sort());
      let corridor = corridors.get(key);
      if (!corridor) {
        corridor = { id: key, from: a.group, to: b.group, legs: [], geom: [] };
        corridors.set(key, corridor);
      }
      corridor.legs.push(leg);
    }
  }
  orientCorridors([...corridors.values()]);
  const strokes: Stroke[] = [];
  for (const corridor of corridors.values()) {
    const paths = corridor.legs.map((leg) => leg.from === corridor.from ? leg.geom : leg.geom.slice().reverse());
    corridor.geom = averagePaths(paths);
    const occupants = new Map<string, Leg[]>();
    for (const leg of corridor.legs) {
      const legs = occupants.get(leg.line.id) ?? [];
      legs.push(leg);
      occupants.set(leg.line.id, legs);
    }
    const bundle = [...occupants.values()].sort((a, b) => compareLines(a[0].line, b[0].line)).map((legs): Stroke => {
      const line = legs[0].line;
      const forward = legs.some((l) => l.from === corridor.from);
      const backward = legs.some((l) => l.from === corridor.to);
      const vehicleLength = parseFloat(line.vehicle);
      const fullWidth = Math.min(LINE_WIDTH_MAX_PX, Math.max(LINE_WIDTH_MIN_PX,
        tripsPerHourNum(peakTakt(line)) * (Number.isFinite(vehicleLength) ? vehicleLength : 12) * LINE_WIDTH_FACTOR));
      return { corridor, line, width: fullWidth * (forward && backward ? 1 : 0.5),
        offset: 0, oneWay: !(forward && backward), reverse: !forward };
    });
    let cursor = -(bundle.reduce((sum, s) => sum + s.width, 0) + OFFSET_GAP_PX * (bundle.length - 1)) / 2;
    for (const stroke of bundle) {
      stroke.offset = cursor + stroke.width / 2;
      cursor += stroke.width + OFFSET_GAP_PX;
      strokes.push(stroke);
    }
  }
  return strokes;
}

/** Keep lane order through bends and through services whose stored directions differ. */
function orientCorridors(corridors: Corridor[]): void {
  const services = new Map<string, Map<Corridor, Leg>>();
  for (const corridor of corridors) for (const leg of corridor.legs) {
    const service = services.get(leg.line.id) ?? new Map<Corridor, Leg>();
    if (!service.has(corridor)) service.set(corridor, leg);
    services.set(leg.line.id, service);
  }
  const ordered = [...services.values()].sort((a, b) => b.size - a.size ||
    compareLines(a.values().next().value!.line, b.values().next().value!.line));
  const oriented = new Set<Corridor>();
  for (const service of ordered) {
    let agreement = 0;
    for (const [corridor, leg] of service) {
      if (oriented.has(corridor)) agreement += leg.from === corridor.from ? 1 : -1;
    }
    for (const [corridor, leg] of service) {
      if (oriented.has(corridor)) continue;
      corridor.from = agreement < 0 ? leg.to : leg.from;
      corridor.to = agreement < 0 ? leg.from : leg.to;
      oriented.add(corridor);
    }
  }
}

function compareLines(a: TransitLine, b: TransitLine): number {
  return a.number.localeCompare(b.number, "pl", { numeric: true }) || a.id.localeCompare(b.id);
}

function mean(coords: Coord[]): Coord {
  return [coords.reduce((sum, c) => sum + c[0], 0) / coords.length,
    coords.reduce((sum, c) => sum + c[1], 0) / coords.length];
}

function averagePaths(paths: Coord[][]): Coord[] {
  const distances = paths.map(pathDistances);
  const count = Math.max(1, Math.ceil(Math.max(...distances.map((d) => d.at(-1)!)) / OFFSET_SAMPLE_M));
  const cursors = paths.map(() => 0);
  return Array.from({ length: count + 1 }, (_, i) => mean(paths.map((path, k): Coord => {
    const d = distances[k], target = d.at(-1)! * i / count;
    while (cursors[k] < path.length - 2 && d[cursors[k] + 1] < target) cursors[k]++;
    const j = cursors[k], t = (target - d[j]) / Math.max(1e-9, d[j + 1] - d[j]);
    return [path[j][0] + (path[j + 1][0] - path[j][0]) * t,
      path[j][1] + (path[j + 1][1] - path[j][1]) * t];
  })));
}

/** Move endpoints to group centers/joints, fading the correction along the path. */
function anchor(path: Coord[], from: Coord, to: Coord, blend = Infinity): Coord[] {
  const distances = pathDistances(path), length = distances.at(-1)!;
  const first = path[0], last = path.at(-1)!;
  const span = Math.min(blend, length / 2);
  return path.map((p, i): Coord => {
    if (i === 0) return from;
    if (i === path.length - 1) return to;
    const a = Math.max(0, 1 - distances[i] / Math.max(1e-9, span));
    const b = Math.max(0, 1 - (length - distances[i]) / Math.max(1e-9, span));
    return [p[0] + (from[0] - first[0]) * a + (to[0] - last[0]) * b,
      p[1] + (from[1] - first[1]) * a + (to[1] - last[1]) * b];
  });
}
