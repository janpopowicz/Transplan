import type { Coord, Stop, TransitLine } from "../types";
import { buildDailyTimetable, type ServiceDay } from "./timetable";
import { buildAccessibilityGraph, MinHeap, WALK_METERS_PER_MIN, type Edge } from "./pedestrianRouting";
import type { WalkingNetwork } from "./walkingNetwork";

export interface JourneyPoint { name: string; coord: Coord }
export interface JourneyRequest {
  origin: JourneyPoint; destination: JourneyPoint; departureMinute: number; day: ServiceDay;
  stops: Stop[]; lines: TransitLine[]; network: WalkingNetwork;
}
export interface JourneyLeg {
  kind: "walk" | "wait" | "ride";
  departureMinute: number; arrivalMinute: number; geometry: Coord[];
  lineId?: string; number?: string; color?: string;
  fromStopId?: string; toStopId?: string; stops?: number;
}
export interface JourneyResult {
  departureMinute: number; arrivalMinute: number; legs: JourneyLeg[];
  walkMinutes: number; waitMinutes: number; rideMinutes: number; transfers: number;
}

export function scheduledDeparture(departures: number[], arrival: number, elapsed = 0) {
  let lo = 0, hi = departures.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (departures[mid] + elapsed < arrival - 1e-8) lo = mid + 1; else hi = mid;
  }
  return lo === departures.length ? Infinity : departures[lo] + elapsed;
}

/** Exact earliest arrival over finite day schedules and real OSM walking edges.
 * Each period has its own on-board states, so crossing a boundary keeps the
 * vehicle that actually departed, rather than changing its headway mid-trip. */
export function calculateJourney(request: JourneyRequest): JourneyResult {
  const { origin, destination, lines, stops, network, day, departureMinute } = request;
  if (!Number.isFinite(departureMinute) || departureMinute < 0 || departureMinute >= 1440) throw new Error("Wybierz poprawną godzinę odjazdu.");
  const runs = buildDailyTimetable(lines, day);
  const graph = buildAccessibilityGraph({ origin: origin.coord, stops, lines, network, period: "wd_am" }, runs, [destination.coord]);
  const { prepared, coords, extra, start, targetNodes, nodeCount } = graph;
  const times = new Float64Array(nodeCount).fill(Infinity), previous = new Int32Array(nodeCount).fill(-1);
  const previousExtra = new Map<number, Edge>(), heap = new MinHeap();
  const boardings = new Uint32Array(nodeCount).fill(0xffffffff), walked = new Float64Array(nodeCount).fill(Infinity);
  boardings[start.node] = 0; walked[start.node] = start.minutes;
  const target = targetNodes[0];
  times[start.node] = departureMinute + start.minutes; heap.push(start.node, times[start.node]);
  while (heap.size) {
    const current = heap.pop();
    if (current.minutes !== times[current.to]) continue;
    if (current.minutes > times[target] + 1e-8) break;
    if (current.to === target) continue;
    const relax = (to: number, time: number, edge?: Edge) => {
      const boards = boardings[current.to] + (edge?.kind === "board" ? 1 : 0);
      const walking = walked[current.to] + (edge?.transit ? 0 : time - current.minutes);
      const betterTie = Math.abs(time - times[to]) < 1e-8 && (boards < boardings[to] || (boards === boardings[to] && walking < walked[to] - 1e-8));
      if (time < times[to] - 1e-8 || betterTie) {
        times[to] = time; previous[to] = current.to; boardings[to] = boards; walked[to] = walking;
        if (edge) previousExtra.set(to, edge); else previousExtra.delete(to);
        heap.push(to, time);
      }
    };
    if (current.to < network.coords.length) for (let i = prepared.offsets[current.to]; i < prepared.offsets[current.to + 1]; i++) {
      relax(prepared.destinations[i], current.minutes + prepared.minutes[i]);
    }
    for (const edge of extra.get(current.to) ?? []) {
      const run = edge.run === undefined ? undefined : runs[edge.run];
      const time = edge.kind === "board" ? scheduledDeparture(run!.departures, current.minutes, run!.elapsed[edge.index!])
        : current.minutes + edge.minutes;
      relax(edge.to, time, edge);
    }
  }
  if (!Number.isFinite(times[target])) throw new Error("Nie znaleziono połączenia między tymi punktami. Sprawdź punkty i połączenie z siecią pieszą OSM.");
  const path: number[] = [];
  for (let node = target; node !== -1; node = previous[node]) path.push(node);
  path.reverse();
  const legs: JourneyLeg[] = [];
  const append = (leg: JourneyLeg, run?: number) => {
    if (leg.arrivalMinute - leg.departureMinute < 1e-9 && leg.kind !== "ride") return;
    const last = legs.at(-1);
    if (last && last.kind === leg.kind && leg.kind !== "wait" &&
      (leg.kind === "walk" || (last.lineId === leg.lineId && lastRideRun === run)) && Math.abs(last.arrivalMinute - leg.departureMinute) < 1e-7) {
      last.arrivalMinute = leg.arrivalMinute; last.geometry.push(...leg.geometry.slice(1));
      last.toStopId = leg.toStopId; last.stops = (last.stops ?? 0) + (leg.stops ?? 0);
    } else legs.push(leg);
    if (leg.kind === "ride") lastRideRun = run;
  };
  let lastRideRun: number | undefined;
  if (start.minutes > 0) append({ kind: "walk", departureMinute, arrivalMinute: times[start.node], geometry: [origin.coord, coords[start.node]] });
  const lineById = new Map(lines.map((line) => [line.id, line]));
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1], to = path[i], edge = previousExtra.get(to);
    const departure = times[from], arrival = times[to];
    if (edge?.kind === "alight") continue;
    if (edge?.kind === "board") {
      const run = runs[edge.run!], line = lineById.get(run.lineId)!;
      append({ kind: "wait", departureMinute: departure, arrivalMinute: arrival, geometry: [],
        lineId: line.id, number: line.number, color: line.color, fromStopId: run.stops[edge.index!] });
    } else if (edge?.kind === "ride") {
      const run = runs[edge.run!], line = lineById.get(run.lineId)!, index = edge.index!;
      const fromStopId = run.stops[index], toStopId = run.stops[index + 1];
      const segment = line.segments.find((s) => s.direction === run.direction && s.fromStopId === fromStopId && s.toStopId === toStopId);
      append({ kind: "ride", departureMinute: departure, arrivalMinute: arrival,
        geometry: segment && segment.geometry.length >= 2 ? [...segment.geometry] : [coords[from], coords[to]].filter((coord): coord is Coord => !!coord), lineId: line.id,
        number: line.number, color: line.color, fromStopId, toStopId, stops: 1 }, edge.run);
    } else append({ kind: "walk", departureMinute: departure, arrivalMinute: arrival, geometry: [coords[from], coords[to]] });
  }
  const total = (kind: JourneyLeg["kind"]) => legs.filter((leg) => leg.kind === kind).reduce((sum, leg) => sum + leg.arrivalMinute - leg.departureMinute, 0);
  return { departureMinute, arrivalMinute: times[target], legs, walkMinutes: total("walk"), waitMinutes: total("wait"),
    rideMinutes: total("ride"), transfers: Math.max(0, legs.filter((leg) => leg.kind === "ride").length - 1) };
}

export function walkingMeters(result: JourneyResult) { return result.walkMinutes * WALK_METERS_PER_MIN; }

export type JourneyJob = { kind: "journey"; id: number; request: Omit<JourneyRequest, "network"> };
export type JourneyReply = { id: number; progress?: string; result?: JourneyResult; error?: string };
