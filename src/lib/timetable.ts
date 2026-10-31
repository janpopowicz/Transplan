import { PERIODS, type PeriodId } from "../constants";
import type { LineDirection, TransitLine } from "../types";

export interface TimetableRun {
  lineId: string;
  direction: LineDirection;
  stops: string[];
  minutes: number[];
  elapsed: number[];
  headway: number;
  phase: number;
}
export interface SharedSection {
  stops: string[];
  runs: TimetableRun[];
  starts: number[];
}
export const modulo = (value: number, period: number) => ((value % period) + period) % period;
export function nextDeparture(time: number, phase: number, headway: number) {
  return phase + Math.ceil((time - phase - 1e-9) / headway) * headway;
}

/** A missing leg breaks the vehicle's path. Platforms remain distinct. */
export function timetableRuns(lines: TransitLine[], period?: PeriodId): TimetableRun[] {
  const runs: TimetableRun[] = [];
  for (const line of lines) {
    const headway = period ? line.takt[period] : 1;
    if (headway == null || !Number.isFinite(headway) || headway <= 0) continue;
    for (const direction of ["outbound", "inbound"] as const) {
      if (period && line.serviceWindows && !line.serviceWindows[period]?.[direction]) continue;
      const ids = [...(direction === "outbound" ? line.outboundStopIds : line.inboundStopIds)];
      if (direction === "inbound" && line.terminus2Id && ids[0] !== line.terminus2Id &&
        line.segments.some((s) => s.direction === direction && s.fromStopId === line.terminus2Id && s.toStopId === ids[0])) ids.unshift(line.terminus2Id);
      const legs = new Map<string, number>();
      for (const leg of line.segments) if (leg.direction === direction) {
        const key = JSON.stringify([leg.fromStopId, leg.toStopId]);
        if (!legs.has(key)) legs.set(key, leg.travelMin);
      }
      let stops = ids.slice(0, 1), minutes: number[] = [];
      const flush = () => {
        if (!minutes.length) return;
        const elapsed = [0];
        for (const time of minutes) elapsed.push(elapsed.at(-1)! + time);
        runs.push({ lineId: line.id, direction, stops, minutes, elapsed, headway, phase: (period ? line.departureOffsets?.[period]?.[direction] : undefined) ?? line.departureOffsetMin ?? 0 });
      };
      for (let i = 1; i < ids.length; i++) {
        const time = legs.get(JSON.stringify([ids[i - 1], ids[i]]));
        if (time === undefined || !Number.isFinite(time) || time < 0) {
          flush(); stops = [ids[i]]; minutes = [];
        } else { stops.push(ids[i]); minutes.push(time); }
      }
      flush();
    }
  }
  return runs;
}

/** Longest contiguous shared sequence per direction of the first line.
 * Direction labels may differ between lines; the ordered platforms must match. */
export function findSharedSections(lines: TransitLine[], suppliedRuns = timetableRuns(lines)): SharedSection[] {
  if (lines.length < 2) return [];
  const byLine = lines.map((line) => suppliedRuns.filter((run) => run.lineId === line.id));
  const sections: SharedSection[] = [];
  for (const direction of ["outbound", "inbound"] as const) {
    let best: SharedSection | undefined;
    for (const run of byLine[0].filter((r) => r.direction === direction)) {
      for (let start = 0; start < run.stops.length - 1; start++) {
        let length = run.stops.length - start;
        const matchedRuns = [run], starts = [start];
        for (const alternatives of byLine.slice(1)) {
          let matchLength = 0, matchRun: TimetableRun | undefined, matchStart = 0;
          for (const other of alternatives) for (let j = 0; j < other.stops.length; j++) {
            let count = 0;
            while (count < length && other.stops[j + count] === run.stops[start + count]) count++;
            if (count > matchLength) { matchLength = count; matchRun = other; matchStart = j; }
          }
          length = Math.min(length, matchLength);
          if (length < 2) break;
          matchedRuns.push(matchRun!); starts.push(matchStart);
        }
        if (length >= 2 && matchedRuns.length === lines.length && length > (best?.stops.length ?? 1)) {
          best = { stops: run.stops.slice(start, start + length), runs: matchedRuns, starts };
        }
      }
    }
    if (best) sections.push(best);
  }
  return sections;
}

export interface CoordinationEdge { a: string; b: string }

/** Explicit pair links; old all-member groups are read as pair links too. */
export function coordinationEdges(lines: TransitLine[]): CoordinationEdge[] {
  const ids = new Set(lines.map((line) => line.id)), edges = new Map<string, CoordinationEdge>();
  const add = (a: string, b: string) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    if (a > b) [a, b] = [b, a];
    edges.set(JSON.stringify([a, b]), { a, b });
  };
  for (const line of lines) {
    for (const other of line.coordinatedLineIds ?? []) add(line.id, other);
    if (line.coordinationId && line.coordinatedLineIds === undefined) {
      for (const other of lines) if (other.coordinationId === line.coordinationId && other.coordinatedLineIds === undefined) add(line.id, other.id);
    }
  }
  return [...edges.values()].sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

export function coordinationMembers(lines: TransitLine[], line: TransitLine) {
  const members = new Set([line.id]), edges = coordinationEdges(lines);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { a, b } of edges) if (members.has(a) || members.has(b)) {
      if (!members.has(a) || !members.has(b)) changed = true;
      members.add(a); members.add(b);
    }
  }
  return lines.filter((l) => members.has(l.id));
}

/** Normalize reciprocal links, discard missing IDs and migrate old groups. */
export function cleanCoordination(lines: TransitLine[]): TransitLine[] {
  const edges = coordinationEdges(lines);
  return lines.map((line) => {
    const linked = edges.flatMap(({ a, b }) => a === line.id ? [b] : b === line.id ? [a] : []);
    if (!line.coordinationId && JSON.stringify(line.coordinatedLineIds ?? []) === JSON.stringify(linked)) return line;
    const { coordinationId: _legacy, ...rest } = line;
    return { ...rest, coordinatedLineIds: linked.length ? linked : undefined };
  });
}

export function compatibleHeadways(a: number, b: number) {
  const ratio = Math.max(a, b) / Math.min(a, b);
  return a > 0 && b > 0 && Number.isFinite(ratio) && Math.abs(ratio - Math.round(ratio)) < 1e-7;
}

interface Constraint { a: number; b: number; period: number; delta: number; pair: CoordinationEdge }
export interface CoordinationIssue extends CoordinationEdge { kind: "incompatible" | "conflict" | "no-section" }
const phaseError = (difference: number, period: number) => Math.abs(modulo(difference + period / 2, period) - period / 2);
const runKey = (run: TimetableRun) => JSON.stringify([run.lineId, run.direction, run.stops]);

/** Solve modular phase constraints over the whole linked network. A slow line
 * can choose any alternate slot of a faster line: e.g. 10 min versus 5 min.
 * Backtracking is important for cycles: a greedy choice of that slot can make
 * an otherwise feasible network appear inconsistent. */
function solvePhases(nodes: number[], constraints: Constraint[], runs: TimetableRun[]) {
  const assigned = new Map<number, number>([[nodes[0], 0]]);
  let attempts = 0;
  const solve = (): boolean => {
    if (assigned.size === nodes.length) return true;
    if (++attempts > 20_000) return false;
    const remaining = nodes.filter((node) => !assigned.has(node));
    remaining.sort((a, b) => constraints.filter((c) => (c.a === b && assigned.has(c.b)) || (c.b === b && assigned.has(c.a))).length
      - constraints.filter((c) => (c.a === a && assigned.has(c.b)) || (c.b === a && assigned.has(c.a))).length || a - b);
    const node = remaining[0];
    const known = constraints.filter((c) => (c.a === node && assigned.has(c.b)) || (c.b === node && assigned.has(c.a)));
    if (!known.length) return false;
    const first = known[0], neighbor = first.a === node ? first.b : first.a;
    const base = assigned.get(neighbor)! + (first.b === node ? first.delta : -first.delta);
    const headway = runs[node].headway;
    const candidates: number[] = [];
    for (let slot = 0, phase = modulo(base, first.period); slot < 2048 && phase < headway - 1e-8; slot++, phase += first.period) {
      if (known.every((c) => phaseError((c.b === node ? phase - assigned.get(c.a)! : assigned.get(c.b)! - phase) - c.delta, c.period) < 1e-6)) candidates.push(phase);
    }
    for (const phase of candidates) {
      assigned.set(node, phase);
      if (solve()) return true;
      assigned.delete(node);
    }
    return false;
  };
  if (solve()) return { phases: assigned, exact: true };
  // A conflicting cycle (including legacy three-line cliques) gets an explicit
  // approximation, never a claim of an exact even takt. Keep the root fixed so
  // translating any member still translates every line identically.
  const phases = new Map(nodes.map((node, i) => [node, i * runs[node].headway / nodes.length]));
  const score = () => constraints.reduce((sum, c) => sum + (phaseError(phases.get(c.b)! - phases.get(c.a)! - c.delta, c.period) / c.period) ** 2, 0);
  let best = score();
  for (let pass = 0; pass < 8; pass++) for (const node of nodes.slice(1)) {
    let chosen = phases.get(node)!;
    for (let step = 0; step < 120; step++) {
      phases.set(node, step * runs[node].headway / 120);
      const cost = score();
      if (cost < best - 1e-12) { best = cost; chosen = phases.get(node)!; }
    }
    phases.set(node, chosen);
  }
  return { phases, exact: false };
}

export function coordinationPlan(lines: TransitLine[], period: PeriodId) {
  const runs = timetableRuns(lines, period), byKey = new Map(runs.map((run, i) => [runKey(run), i]));
  const byId = new Map(lines.map((line) => [line.id, line]));
  const constraints: Constraint[] = [], issues: CoordinationIssue[] = [];
  for (const pair of coordinationEdges(lines)) {
    const a = byId.get(pair.a)!, b = byId.get(pair.b)!;
    const sections = findSharedSections([a, b]);
    if (!sections.length) { issues.push({ ...pair, kind: "no-section" }); continue; }
    const ta = a.takt[period], tb = b.takt[period];
    if (ta == null || tb == null) continue;
    if (!compatibleHeadways(ta, tb)) { issues.push({ ...pair, kind: "incompatible" }); continue; }
    for (const section of sections) {
      const ia = byKey.get(runKey(section.runs[0])), ib = byKey.get(runKey(section.runs[1]));
      if (ia === undefined || ib === undefined) continue;
      const interval = Math.min(ta, tb);
      constraints.push({ a: ia, b: ib, period: interval, pair,
        delta: runs[ia].elapsed[section.starts[0]] - runs[ib].elapsed[section.starts[1]] + interval / 2 });
    }
  }
  const remaining = new Set(constraints.flatMap((c) => [c.a, c.b]));
  while (remaining.size) {
    const first = [...remaining].sort((a, b) => runKey(runs[a]).localeCompare(runKey(runs[b])))[0];
    const nodes = new Set([first]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of constraints) if (nodes.has(c.a) || nodes.has(c.b)) {
        if (!nodes.has(c.a) || !nodes.has(c.b)) changed = true;
        nodes.add(c.a); nodes.add(c.b);
      }
    }
    const ordered = [...nodes].sort((a, b) => runKey(runs[a]).localeCompare(runKey(runs[b])));
    const selected = constraints.filter((c) => nodes.has(c.a));
    const solution = solvePhases(ordered, selected, runs);
    // The same group translation is used even when some members don't run in
    // this period or a direction has a different root/platform arrangement.
    const root = coordinationMembers(lines, byId.get(runs[first].lineId)!).sort((a, b) => a.id.localeCompare(b.id))[0];
    const translation = root.departureOffsets?.[period]?.[runs[first].direction] ?? root.departureOffsetMin ?? 0;
    for (const node of ordered) {
      runs[node].phase = modulo(solution.phases.get(node)! + translation, runs[node].headway);
      remaining.delete(node);
    }
    if (!solution.exact) for (const c of selected) if (phaseError(solution.phases.get(c.b)! - solution.phases.get(c.a)! - c.delta, c.period) > 1e-6) {
      issues.push({ ...c.pair, kind: "conflict" });
    }
  }
  return { runs, issues };
}

export function buildTimetable(lines: TransitLine[], period: PeriodId): TimetableRun[] {
  return coordinationPlan(lines, period).runs;
}

/** One edit rotates all schedules in the connected component, including lines
 * whose coordination takes place on an entirely different shared section. */
export function shiftDeparture(lines: TransitLine[], id: string, value: number, period: PeriodId, direction: LineDirection): TransitLine[] {
  const line = lines.find((l) => l.id === id);
  if (!line || !Number.isFinite(value)) return lines;
  const run = buildTimetable(lines, period).find((r) => r.lineId === id && r.direction === direction);
  const previous = run ? modulo(run.phase, run.headway) : line.departureOffsetMin ?? 0;
  const delta = value - previous;
  const members = new Set(coordinationMembers(lines, line).map((l) => l.id));
  return lines.map((l) => members.has(l.id) ? { ...l, departureOffsetMin: (l.departureOffsetMin ?? 0) + delta,
    ...(l.departureOffsets ? { departureOffsets: Object.fromEntries(Object.entries(l.departureOffsets).map(([p, directions]) =>
      [p, Object.fromEntries(Object.entries(directions!).map(([d, phase]) => [d, phase! + delta]))])) } : {}) } : l);
}

export function periodStartMinute(period: PeriodId) {
  return Number(PERIODS.find((p) => p.id === period)!.hours.split(":")[0]) * 60;
}
export function formatDeparture(minute: number) {
  const seconds = Math.round(minute * 60), hours = Math.floor(seconds / 3600), mins = Math.floor(seconds / 60) % 60, secs = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}${secs ? `:${String(secs).padStart(2, "0")}` : ""}`;
}
/** First hour of the selected project period, at every platform of this run. */
export function timetableDepartures(run: TimetableRun, period: PeriodId, index = 0) {
  const result: number[] = [], phase = run.phase + run.elapsed[index];
  for (let time = nextDeparture(0, phase, run.headway); time < 60 - 1e-8; time += run.headway) result.push(periodStartMinute(period) + time);
  return result;
}

export type ServiceDay = "weekday" | "weekend";
export interface DailyTimetableRun extends TimetableRun { departures: number[]; period: PeriodId }
export function periodEndMinute(period: PeriodId) {
  const end = Number(PERIODS.find((p) => p.id === period)!.hours.split("–")[1].split(":")[0]) * 60;
  return end <= periodStartMinute(period) ? end + 1440 : end;
}

/** Finite origin departures. A vehicle continues its trip after a period ends. */
export function buildDailyTimetable(lines: TransitLine[], day: ServiceDay): DailyTimetableRun[] {
  const periods = PERIODS.filter((p) => p.group === day).map((p) => p.id);
  return periods.flatMap((period) => buildTimetable(lines, period).map((run) => {
    const departures: number[] = [], start = periodStartMinute(period), end = periodEndMinute(period);
    const window = lines.find((l) => l.id === run.lineId)?.serviceWindows?.[period]?.[run.direction];
    const lo = window?.[0] ?? 0, hi = window?.[1] ?? end - start;
    for (let t = start + nextDeparture(lo, run.phase, run.headway); t < Math.min(end, start + hi) - 1e-8; t += run.headway) {
      if (t < 1440) departures.push(t);
      if (end > 1440) departures.push(t - 1440);
    }
    departures.sort((a,b) => a-b);
    return { ...run, period, departures };
  }));
}

export function dailyStopDepartures(runs: DailyTimetableRun[], lineId: string, direction: LineDirection, stopId: string) {
  const departures = new Set<number>();
  for (const run of runs) if (run.lineId === lineId && run.direction === direction) {
    run.stops.forEach((id, i) => {
      if (id === stopId) for (const time of run.departures) { const arrival = Math.round((time + run.elapsed[i]) * 1e6) / 1e6; if (arrival >= 0) departures.add(arrival); }
    });
  }
  return [...departures].sort((a, b) => a - b);
}
