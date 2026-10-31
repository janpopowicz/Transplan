import type { PeriodId } from "../constants";
import type { Coord, Stop, TransitLine } from "../types";
import type { WalkingEdge, WalkingNetwork } from "./walkingNetwork";
import { buildTimetable, nextDeparture, type TimetableRun } from "./timetable";

export const WALK_METERS_PER_MIN = 80;
export type Edge = { to: number; minutes: number; headway?: number; phase?: number; transit?: boolean; kind?: "board" | "ride" | "alight"; run?: number; index?: number };
export type AccessibilityScenario = "mean" | "p90" | "best" | "worst";
export interface AccessibilityRequest {
  origin: Coord;
  stops: Stop[];
  lines: TransitLine[];
  period: PeriodId;
  network: WalkingNetwork;
  scenario?: AccessibilityScenario;
  /** Exact departure for timetable diagnostics; otherwise sample a full hour. */
  departureMinute?: number;
}

export function projection(origin: Coord) {
  const lonScale = 111195 * Math.max(0.01, Math.cos(origin[1] * Math.PI / 180));
  return {
    toXY: (p: Coord): Coord => [(p[0] - origin[0]) * lonScale, (p[1] - origin[1]) * 111195],
    toCoord: (p: Coord): Coord => [origin[0] + p[0] / lonScale, origin[1] + p[1] / 111195],
  };
}

interface PreparedWalkingGraph {
  project: ReturnType<typeof projection>;
  xy: Coord[];
  offsets: Uint32Array;
  destinations: Uint32Array;
  minutes: Float64Array;
  cells: Map<string, number[]>;
}
const preparedGraphs = new WeakMap<WalkingNetwork, PreparedWalkingGraph>();
const CELL = 200;

/** The walking topology and spatial index do not depend on the chosen origin. */
export function prepareWalkingGraph(network: WalkingNetwork): PreparedWalkingGraph {
  const cached = preparedGraphs.get(network);
  if (cached) return cached;
  const project = projection(network.coords[0] ?? [19.94, 50.06]);
  const xy = network.coords.map(project.toXY);
  // Compact adjacency avoids hundreds of thousands of arrays and millions of
  // edge objects, keeping the reusable graph inexpensive in a browser worker.
  const offsets = new Uint32Array(network.coords.length + 1);
  for (const edge of network.edges) {
    if (edge.forward) offsets[edge.from + 1]++;
    if (edge.backward) offsets[edge.to + 1]++;
  }
  for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1];
  const destinations = new Uint32Array(offsets.at(-1)!);
  const minutes = new Float64Array(destinations.length);
  const cursor = offsets.slice();
  const connect = (from: number, to: number, time: number) => {
    const index = cursor[from]++;
    destinations[index] = to; minutes[index] = time;
  };
  const cells = new Map<string, number[]>();
  for (let i = 0; i < network.edges.length; i++) {
    const edge = network.edges[i], a = xy[edge.from], b = xy[edge.to];
    if (edge.forward) connect(edge.from, edge.to, edge.meters / WALK_METERS_PER_MIN);
    if (edge.backward) connect(edge.to, edge.from, edge.meters / WALK_METERS_PER_MIN);
    for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
      for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
        const key = `${x},${y}`, bucket = cells.get(key) ?? [];
        bucket.push(i); cells.set(key, bucket);
      }
    }
  }
  const prepared = { project, xy, offsets, destinations, minutes, cells };
  preparedGraphs.set(network, prepared);
  return prepared;
}

/** One shortest-path search over walking ways and on-board transit states.
 * Per-request connections are separate from the immutable walking graph. */
export function buildAccessibilityGraph({ origin, stops, lines, period, network }: AccessibilityRequest,
  runs: TimetableRun[] = buildTimetable(lines, period), targets: Coord[] = []) {
  const prepared = prepareWalkingGraph(network);
  const { project, cells } = prepared;
  const coords = network.coords.slice();
  const xy = prepared.xy.slice();
  let nodeCount = coords.length;
  const extra = new Map<number, Edge[]>();
  const addNode = (coord?: Coord) => {
    const index = nodeCount++;
    if (coord) { coords[index] = coord; xy[index] = project.toXY(coord); }
    return index;
  };
  const connect = (from: number, to: number, minutes: number, schedule: Partial<Edge> = {}) => {
    const edges = extra.get(from) ?? [];
    edges.push({ to, minutes, ...schedule }); extra.set(from, edges);
  };
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
    const node = addNode([stop.lon, stop.lat]);
    connect(node, snapped.node, snapped.minutes); connect(snapped.node, node, snapped.minutes);
    ground.set(id, node);
    return node;
  };
  const targetNodes = targets.map((coord) => {
    const snapped = attach(coord, 150);
    if (!snapped) throw new Error("Brak drogi pieszej OSM w odległości 150 m od celu. Wybierz punkt bliżej chodnika lub ścieżki.");
    const node = addNode(coord);
    connect(snapped.node, node, snapped.minutes); connect(node, snapped.node, snapped.minutes);
    return node;
  });
  // Include every run, including service from earlier/later timetable periods.
  for (const run of runs) for (const id of run.stops) groundNode(id);
  const activeLines = new Set(runs.map((run) => run.lineId)).size;
  const boardings: { from: number; to: number; phase: number; headway: number }[] = [];
  for (const [runIndex, run] of runs.entries()) {
    const onboard = run.stops.map((id, i) => {
      const location = stopById.get(id);
      const ride = addNode(location ? [location.lon, location.lat] : undefined), stop = ground.get(id);
      if (stop !== undefined) {
        const phase = run.phase + run.elapsed[i];
        connect(stop, ride, 0, { headway: run.headway, phase, transit: true, kind: "board", run: runIndex, index: i });
        boardings.push({ from: stop, to: ride, phase, headway: run.headway });
        connect(ride, stop, 0, { transit: true, kind: "alight", run: runIndex, index: i });
      }
      return ride;
    });
    run.minutes.forEach((minutes, i) => connect(onboard[i], onboard[i + 1], minutes, { transit: true, kind: "ride", run: runIndex, index: i }));
  }
  // Original endpoint-to-endpoint walking edges remain valid shortcuts. Only
  // split edges need additional connections; all other adjacency is reused.
  const walkEdges: WalkingEdge[] = splits.size
    ? network.edges.filter((_, index) => !splits.has(index)) : network.edges;
  for (const [index, split] of splits) {
    const edge = network.edges[index];
    const list = [{ t: 0, node: edge.from }, ...split.sort((a, b) => a.t - b.t), { t: 1, node: edge.to }];
    for (let j = 1; j < list.length; j++) {
      const from = list[j - 1].node, to = list[j].node, meters = edge.meters * (list[j].t - list[j - 1].t);
      if (edge.forward) connect(from, to, meters / WALK_METERS_PER_MIN);
      if (edge.backward) connect(to, from, meters / WALK_METERS_PER_MIN);
      walkEdges.push({ ...edge, from, to, meters });
    }
  }
  return { prepared, coords, xy, project, extra, nodeCount, start, ground, targetNodes, runs, walkEdges, activeLines, missed, boardings };
}

export function calculateAccessibility(request: AccessibilityRequest) {
  const { scenario = "mean", departureMinute, network } = request;
  const { prepared, coords, xy, project, extra, nodeCount, start, ground, walkEdges, activeLines, missed, boardings } = buildAccessibilityGraph(request);
  const walkOnly = new Float64Array(nodeCount).fill(Infinity);
  const arrivals = new Float64Array(nodeCount).fill(Infinity);
  const heap = new MinHeap();
  function search(times: Float64Array, departure: number, walkingOnly: boolean) {
    const relax = (to: number, time: number) => {
      // Walking from the origin is already available without a graph search
      // for each sample. A dominated transit path cannot improve downstream.
      if (!walkingOnly && time >= departure + walkOnly[to] - 1e-9) return;
      if (time < times[to] - 1e-9) { times[to] = time; heap.push(to, time); }
    };
    while (heap.size) {
      const current = heap.pop();
      if (times[current.to] !== current.minutes) continue;
      if (current.to < network.coords.length) for (let i = prepared.offsets[current.to]; i < prepared.offsets[current.to + 1]; i++) {
        relax(prepared.destinations[i], current.minutes + prepared.minutes[i]);
      }
      for (const edge of extra.get(current.to) ?? []) {
        if (walkingOnly && edge.transit) continue;
        const time = edge.headway === undefined ? current.minutes + edge.minutes
          : nextDeparture(current.minutes, edge.phase!, edge.headway);
        relax(edge.to, time);
      }
    }
  }
  walkOnly[start.node] = start.minutes; heap.push(start.node, start.minutes);
  search(walkOnly, 0, true);
  const sampleCount = departureMinute === undefined ? 120 : 1;
  const times = new Float64Array(nodeCount).fill(scenario === "best" ? Infinity : 0);
  // Exact nearest-rank P90 needs only the largest 13 of 120 observations.
  // This avoids retaining 120 full city graphs in worker memory.
  const tailSize = sampleCount - Math.ceil(0.9 * sampleCount) + 1;
  const tail = scenario === "p90" ? new Float64Array(nodeCount * tailSize).fill(-Infinity) : null;
  for (let sample = sampleCount - 1; sample >= 0; sample--) {
    const departure = departureMinute ?? (sample + 0.5) * 0.5;
    // Earlier starts can wait for every journey available to later starts.
    // Keep those valid absolute arrivals and only propagate improvements.
    for (const boarding of boardings) {
      if (!Number.isFinite(walkOnly[boarding.from])) continue;
      const time = nextDeparture(departure + walkOnly[boarding.from], boarding.phase, boarding.headway);
      if (time < arrivals[boarding.to] - 1e-9) { arrivals[boarding.to] = time; heap.push(boarding.to, time); }
    }
    search(arrivals, departure, false);
    for (let node = 0; node < nodeCount; node++) {
      const duration = Math.min(walkOnly[node], arrivals[node] - departure);
      if (tail) {
        const base = node * tailSize;
        if (duration > tail[base]) {
          let i = 0;
          while (i < tailSize - 1 && tail[base + i + 1] < duration) {
            tail[base + i] = tail[base + i + 1]; i++;
          }
          tail[base + i] = duration;
        }
      } else if (scenario === "best") times[node] = Math.min(times[node], duration);
      else if (scenario === "worst") times[node] = Math.max(times[node], duration);
      else times[node] += duration;
    }
  }
  if (tail) for (let node = 0; node < nodeCount; node++) times[node] = tail[node * tailSize];
  else if (scenario === "mean") for (let node = 0; node < nodeCount; node++) times[node] /= sampleCount;
  return { coords, xy, walkEdges, times, project, activeLines, unconnectedStops: missed.size,
    stopTimes: new Map([...ground].map(([id, index]) => [id, times[index]])), originSnapMeters: start.distance };
}

export class MinHeap {
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
