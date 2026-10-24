import type { PeriodId } from "../constants";
import type { Coord, Stop, TransitLine } from "../types";
import type { WalkingEdge, WalkingNetwork } from "./walkingNetwork";

export const WALK_METERS_PER_MIN = 80;
type Edge = { to: number; minutes: number };
export interface AccessibilityRequest {
  origin: Coord;
  stops: Stop[];
  lines: TransitLine[];
  period: PeriodId;
  network: WalkingNetwork;
}

export function projection(origin: Coord) {
  const lonScale = 111195 * Math.max(0.01, Math.cos(origin[1] * Math.PI / 180));
  return {
    toXY: (p: Coord): Coord => [(p[0] - origin[0]) * lonScale, (p[1] - origin[1]) * 111195],
    toCoord: (p: Coord): Coord => [origin[0] + p[0] / lonScale, origin[1] + p[1] / 111195],
  };
}

/** One shortest-path search over walking ways and on-board transit states.
 * All access, egress and transfers follow the same pedestrian network. */
export function calculateAccessibility({ origin, stops, lines, period, network }: AccessibilityRequest) {
  const project = projection(origin);
  const coords = network.coords.slice();
  const xy = coords.map(project.toXY);
  const graph: Edge[][] = coords.map(() => []);
  const addNode = (coord?: Coord) => {
    const index = graph.length;
    graph.push([]);
    if (coord) { coords[index] = coord; xy[index] = project.toXY(coord); }
    return index;
  };
  const connect = (from: number, to: number, minutes: number) => graph[from].push({ to, minutes });
  const cells = new Map<string, number[]>();
  const CELL = 200;
  for (let i = 0; i < network.edges.length; i++) {
    const edge = network.edges[i], a = xy[edge.from], b = xy[edge.to];
    for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
      for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
        const key = `${x},${y}`, bucket = cells.get(key) ?? [];
        bucket.push(i); cells.set(key, bucket);
      }
    }
  }
  const splits = new Map<number, { t: number; node: number }[]>();
  const attach = (coord: Coord, maxMeters: number) => {
    const p = project.toXY(coord), cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    let best: { edge: number; t: number; distance: number; point: Coord } | undefined;
    const checked = new Set<number>();
    const radius = Math.ceil(maxMeters / CELL);
    for (let x = cx - radius; x <= cx + radius; x++) for (let y = cy - radius; y <= cy + radius; y++) {
      for (const index of cells.get(`${x},${y}`) ?? []) {
        if (checked.has(index)) continue;
        checked.add(index);
        const edge = network.edges[index], a = xy[edge.from], b = xy[edge.to];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const point: Coord = [a[0] + t * dx, a[1] + t * dy];
        const distance = Math.hypot(p[0] - point[0], p[1] - point[1]);
        if (distance <= maxMeters && distance < (best?.distance ?? Infinity)) best = { edge: index, t, distance, point };
      }
    }
    if (!best) return null;
    const edge = network.edges[best.edge];
    let node: number;
    if (best.t < 1e-8) node = edge.from;
    else if (best.t > 1 - 1e-8) node = edge.to;
    else {
      const list = splits.get(best.edge) ?? [];
      const match = list.find((split) => Math.abs(split.t - best!.t) * edge.meters < 0.01);
      node = match?.node ?? addNode(project.toCoord(best.point));
      if (!match) list.push({ t: best.t, node });
      splits.set(best.edge, list);
    }
    return { node, minutes: best.distance / WALK_METERS_PER_MIN, distance: best.distance };
  };

  const start = attach(origin, 150);
  if (!start) throw new Error("Brak drogi pieszej OSM w odległości 150 m od punktu. Kliknij bliżej chodnika lub ścieżki.");
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const ground = new Map<string, number>();
  const missed = new Set<string>();
  const groundNode = (id: string): number | undefined => {
    if (ground.has(id)) return ground.get(id);
    if (missed.has(id)) return undefined;
    const stop = stopById.get(id);
    if (!stop) return undefined;
    const snapped = attach([stop.lon, stop.lat], 80);
    if (!snapped) { missed.add(id); return undefined; }
    const node = addNode();
    connect(node, snapped.node, snapped.minutes); connect(snapped.node, node, snapped.minutes);
    ground.set(id, node);
    return node;
  };
  // Split pedestrian edges at every served stop before connecting the graph.
  for (const line of lines) {
    const takt = line.takt[period];
    if (takt == null || !Number.isFinite(takt) || takt <= 0) continue;
    for (const segment of line.segments) { groundNode(segment.fromStopId); groundNode(segment.toStopId); }
  }
  let activeLines = 0;
  for (const line of lines) {
    const takt = line.takt[period];
    if (takt == null || !Number.isFinite(takt) || takt <= 0) continue;
    let served = false;
    for (const direction of ["outbound", "inbound"] as const) {
      const ids = [...(direction === "outbound" ? line.outboundStopIds : line.inboundStopIds)];
      if (direction === "inbound" && line.terminus2Id && ids[0] !== line.terminus2Id &&
        line.segments.some((s) => s.direction === direction && s.fromStopId === line.terminus2Id && s.toStopId === ids[0])) ids.unshift(line.terminus2Id);
      const onboard = new Map<number, number>();
      const boardNode = (index: number) => {
        if (!onboard.has(index)) {
          const ride = addNode(), stop = ground.get(ids[index]);
          onboard.set(index, ride);
          // A stop without a mapped pedestrian connection can still be passed
          // on board, but cannot create a walk across a gap in OSM.
          if (stop !== undefined) { connect(stop, ride, takt / 2); connect(ride, stop, 0); }
        }
        return onboard.get(index)!;
      };
      for (let i = 0; i < ids.length - 1; i++) {
        const segment = line.segments.find((s) => s.direction === direction && s.fromStopId === ids[i] && s.toStopId === ids[i + 1]);
        if (!segment || !Number.isFinite(segment.travelMin) || segment.travelMin < 0) continue;
        const from = boardNode(i), to = boardNode(i + 1);
        connect(from, to, segment.travelMin); served = true;
      }
    }
    if (served) activeLines++;
  }
  const walkEdges: WalkingEdge[] = [];
  for (let i = 0; i < network.edges.length; i++) {
    const edge = network.edges[i];
    const list = [{ t: 0, node: edge.from }, ...(splits.get(i) ?? []).sort((a, b) => a.t - b.t), { t: 1, node: edge.to }];
    for (let j = 1; j < list.length; j++) {
      const from = list[j - 1].node, to = list[j].node, meters = edge.meters * (list[j].t - list[j - 1].t);
      if (edge.forward) connect(from, to, meters / WALK_METERS_PER_MIN);
      if (edge.backward) connect(to, from, meters / WALK_METERS_PER_MIN);
      walkEdges.push({ ...edge, from, to, meters });
    }
  }
  const times = new Float64Array(graph.length).fill(Infinity);
  const heap = new MinHeap();
  times[start.node] = start.minutes; heap.push(start.node, start.minutes);
  while (heap.size) {
    const current = heap.pop();
    if (times[current.to] !== current.minutes) continue;
    for (const edge of graph[current.to]) {
      const time = current.minutes + edge.minutes;
      if (time < times[edge.to]) { times[edge.to] = time; heap.push(edge.to, time); }
    }
  }
  return { coords, xy, walkEdges, times, activeLines, unconnectedStops: missed.size,
    stopTimes: new Map([...ground].map(([id, index]) => [id, times[index]])), originSnapMeters: start.distance };
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
