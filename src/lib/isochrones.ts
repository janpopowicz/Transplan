import type { PeriodId } from "../constants";
import type { Coord, Stop, TransitLine } from "../types";
import { haversine } from "./geo";

export const ISOCHRONE_BANDS = [
  { minutes: 10, color: "#059669" },
  { minutes: 20, color: "#65a30d" },
  { minutes: 30, color: "#eab308" },
  { minutes: 45, color: "#ea580c" },
  { minutes: 60, color: "#9333ea" },
];
export const WALK_METERS_PER_MIN = 80;
const TRANSFER_METERS = 600;

export interface IsochroneRequest {
  origin: Coord;
  stops: Stop[];
  lines: TransitLine[];
  period: PeriodId;
  maxMinutes: number;
}

export interface ReachablePoint {
  coord: Coord;
  minutes: number;
  stopId?: string;
}

export interface IsochroneResult {
  areas: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>;
  reachableStops: number;
  activeLines: number;
  resolutionMeters: number;
}

type Edge = { to: number; minutes: number };

/** Off-board stop nodes and separate on-board nodes for each direction/occurrence.
 * Waiting is paid on boarding only, including after a transfer. Visibility is
 * deliberately ignored: hiding a line is a display preference, not a service cut.
 */
export function reachablePoints(request: IsochroneRequest) {
  const { origin, stops, lines, period, maxMinutes } = request;
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const graph: Edge[][] = [];
  const ground = new Map<string, number>();
  let activeLines = 0;
  const node = () => { graph.push([]); return graph.length - 1; };
  const groundNode = (id: string) => {
    if (!ground.has(id)) ground.set(id, node());
    return ground.get(id)!;
  };
  for (const line of lines) {
    const takt = line.takt[period];
    if (takt == null || !Number.isFinite(takt) || takt <= 0) continue;
    let served = false;
    for (const direction of ["outbound", "inbound"] as const) {
      const ids = direction === "outbound" ? line.outboundStopIds : line.inboundStopIds;
      const onboard = new Map<number, number>();
      const boardNode = (index: number) => {
        if (!onboard.has(index)) {
          const ride = node();
          const stop = groundNode(ids[index]);
          onboard.set(index, ride);
          graph[stop].push({ to: ride, minutes: takt / 2 });
          graph[ride].push({ to: stop, minutes: 0 });
        }
        return onboard.get(index)!;
      };
      for (let i = 0; i < ids.length - 1; i++) {
        if (!byId.has(ids[i]) || !byId.has(ids[i + 1])) continue;
        const segment = line.segments.find((s) => s.direction === direction &&
          s.fromStopId === ids[i] && s.toStopId === ids[i + 1]);
        if (!segment || !Number.isFinite(segment.travelMin) || segment.travelMin < 0) continue;
        const from = boardNode(i);
        const to = boardNode(i + 1);
        graph[from].push({ to, minutes: segment.travelMin });
        served = true;
      }
    }
    if (served) activeLines++;
  }

  const servedStops = [...ground].map(([id, index]) => ({ stop: byId.get(id)!, index }));
  const project = projection(origin);
  const buckets = new Map<string, typeof servedStops>();
  for (const item of servedStops) {
    const coord: Coord = [item.stop.lon, item.stop.lat];
    const xy = project.toXY(coord);
    const x = Math.floor(xy[0] / TRANSFER_METERS);
    const y = Math.floor(xy[1] / TRANSFER_METERS);
    // Two cells of padding also cover the small projection distortion.
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      for (const other of buckets.get(`${x + dx},${y + dy}`) ?? []) {
        const meters = haversine(coord, [other.stop.lon, other.stop.lat]);
        if (meters > TRANSFER_METERS) continue;
        graph[item.index].push({ to: other.index, minutes: meters / WALK_METERS_PER_MIN });
        graph[other.index].push({ to: item.index, minutes: meters / WALK_METERS_PER_MIN });
      }
    }
    const key = `${x},${y}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }

  const times = new Float64Array(graph.length).fill(Infinity);
  const heap = new MinHeap();
  const relax = (index: number, minutes: number) => {
    if (minutes >= times[index] || minutes > maxMinutes) return;
    times[index] = minutes;
    heap.push(index, minutes);
  };
  for (const { stop, index } of servedStops) {
    relax(index, haversine(origin, [stop.lon, stop.lat]) / WALK_METERS_PER_MIN);
  }
  while (heap.size) {
    const current = heap.pop();
    if (current.minutes !== times[current.to]) continue;
    for (const edge of graph[current.to]) relax(edge.to, current.minutes + edge.minutes);
  }
  const points: ReachablePoint[] = [{ coord: origin, minutes: 0 }];
  for (const { stop, index } of servedStops) {
    if (times[index] <= maxMinutes) points.push({
      coord: [stop.lon, stop.lat], minutes: times[index], stopId: stop.id,
    });
  }
  return { points, activeLines };
}

export function calculateIsochrones(request: IsochroneRequest): IsochroneResult {
  const { points, activeLines } = reachablePoints(request);
  const { areas, resolutionMeters } = contourAreas(points, request.origin, request.maxMinutes);
  return { areas, resolutionMeters, activeLines, reachableStops: points.length - 1 };
}

/** Sample the fastest transit + final walk time, then interpolate contour rings.
 * The grid covers all reachable destinations, independently of the map viewport.
 */
export function contourAreas(points: ReachablePoint[], origin: Coord, maxMinutes: number) {
  const project = projection(origin);
  const seeds = points.filter((p) => p.minutes <= maxMinutes).map((p) => ({
    xy: project.toXY(p.coord), minutes: p.minutes,
    radius: (maxMinutes - p.minutes) * WALK_METERS_PER_MIN,
  }));
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const { xy: [x, y], radius } of seeds) {
    west = Math.min(west, x - radius); east = Math.max(east, x + radius);
    south = Math.min(south, y - radius); north = Math.max(north, y + radius);
  }
  const step = Math.max(120, Math.sqrt((east - west) * (north - south) / 180_000));
  west -= step * 2; south -= step * 2;
  const width = Math.ceil((east - west) / step) + 3;
  const height = Math.ceil((north - south) / step) + 3;
  const values = new Float64Array(width * height).fill(maxMinutes + 10);
  for (const { xy: [x, y], radius, minutes } of seeds) {
    const pad = radius + step * 2;
    const x0 = Math.max(0, Math.floor((x - pad - west) / step));
    const x1 = Math.min(width - 1, Math.ceil((x + pad - west) / step));
    const y0 = Math.max(0, Math.floor((y - pad - south) / step));
    const y1 = Math.min(height - 1, Math.ceil((y + pad - south) / step));
    for (let row = y0; row <= y1; row++) for (let col = x0; col <= x1; col++) {
      const time = minutes + Math.hypot(west + col * step - x, south + row * step - y) / WALK_METERS_PER_MIN;
      const index = row * width + col;
      if (time < values[index]) values[index] = time;
    }
  }
  const areas: IsochroneResult["areas"] = { type: "FeatureCollection", features: [] };
  // Largest polygons first: smaller time bands are painted on top.
  for (const band of ISOCHRONE_BANDS.filter((b) => b.minutes <= maxMinutes).reverse()) {
    const rings = traceContours(values, width, height, band.minutes);
    const shells = rings.filter((ring) => signedArea(ring) > 0);
    const holes = rings.filter((ring) => signedArea(ring) < 0);
    const polygons = shells.map((shell) => [shell]);
    for (const hole of holes) {
      let owner = -1, area = Infinity;
      for (let i = 0; i < shells.length; i++) {
        const size = signedArea(shells[i]);
        if (size < area && insideRing(hole[0], shells[i])) { owner = i; area = size; }
      }
      if (owner >= 0) polygons[owner].push(hole);
    }
    if (polygons.length) areas.features.push({
      type: "Feature", properties: { minutes: band.minutes, color: band.color },
      geometry: { type: "MultiPolygon", coordinates: polygons.map((polygon) =>
        polygon.map((ring) => ring.map(([x, y]) => project.toCoord([west + x * step, south + y * step])))),
      },
    });
  }
  return { areas, resolutionMeters: step };
}

/** Marching triangles avoids ambiguous saddle cells. Directed edges keep land
 * on the left, giving CCW shells and CW holes, including disconnected islands. */
function traceContours(values: Float64Array, width: number, height: number, level: number): Coord[][] {
  const next = new Map<string, string>();
  const coords = new Map<string, Coord>();
  const threshold = level + 1e-7;
  const crossing = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!coords.has(key)) {
      const t = (threshold - values[a]) / (values[b] - values[a]);
      coords.set(key, [a % width + t * (b % width - a % width),
        Math.floor(a / width) + t * (Math.floor(b / width) - Math.floor(a / width))]);
    }
    return key;
  };
  const triangle = (a: number, b: number, c: number) => {
    const ids = [a, b, c];
    let entry: string | undefined, exit: string | undefined;
    for (let i = 0; i < 3; i++) {
      const from = ids[i], to = ids[(i + 1) % 3];
      if (values[from] <= threshold && values[to] > threshold) exit = crossing(from, to);
      if (values[from] > threshold && values[to] <= threshold) entry = crossing(from, to);
    }
    if (entry && exit) next.set(exit, entry);
  };
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const a = y * width + x, b = a + 1, c = b + width, d = a + width;
    const below = [a, b, c, d].map((i) => values[i] <= threshold);
    if (below.every(Boolean) || below.every((v) => !v)) continue;
    triangle(a, b, c); triangle(a, c, d);
  }
  const rings: Coord[][] = [];
  while (next.size) {
    const first = next.keys().next().value!;
    let key = first;
    const ring: Coord[] = [];
    do {
      ring.push(coords.get(key)!);
      const following = next.get(key);
      next.delete(key);
      if (!following) break;
      key = following;
    } while (key !== first);
    if (key === first && ring.length >= 3) {
      ring.push(ring[0]);
      if (Math.abs(signedArea(ring)) > 1e-8) rings.push(ring);
    }
  }
  return rings;
}

function signedArea(ring: Coord[]) {
  let area = 0;
  for (let i = 1; i < ring.length; i++) area += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return area / 2;
}

function insideRing([x, y]: Coord, ring: Coord[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function projection(origin: Coord) {
  const lonScale = 111195 * Math.max(0.01, Math.cos(origin[1] * Math.PI / 180));
  return {
    toXY: (p: Coord): Coord => [(p[0] - origin[0]) * lonScale, (p[1] - origin[1]) * 111195],
    toCoord: (p: Coord): Coord => [origin[0] + p[0] / lonScale, origin[1] + p[1] / 111195],
  };
}

class MinHeap {
  private items: Edge[] = [];
  get size() { return this.items.length; }
  push(to: number, minutes: number) {
    const item = { to, minutes };
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].minutes <= minutes) break;
      this.items[i] = this.items[parent]; i = parent;
    }
    this.items[i] = item;
  }
  pop(): Edge {
    const first = this.items[0], last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1].minutes < this.items[child].minutes) child++;
        if (last.minutes <= this.items[child].minutes) break;
        this.items[i] = this.items[child]; i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}
