import {
  OFFSET_BLEND_MAX_M,
  OFFSET_BLEND_MIN_M,
  OFFSET_BLEND_PX,
  OFFSET_GAP_PX,
  OFFSET_SAMPLE_M,
} from "../constants";
import type { Coord, LineSegment, Stop, TransitLine } from "../types";
import {
  densifyLine,
  offsetLine,
  pathDistances,
} from "./geo";
import { buildNetworkRenderSegments } from "./networkInterline";
import { lineStrokeWidth } from "./lineWidth";
import type { EdgeRun } from "./tramGraph";
import { roadGraph, tramGraph } from "./tramGraph";

export interface RenderSegment {
  id: string;
  lineId: string;
  color: string;
  width: number;
  offset: number;
  geometry: Coord[];
  number: string;
  oneWay: boolean;
  fromGroupId?: string;
  toGroupId?: string;
}

interface Occupant {
  strokeId: string;
  width: number;
  sort: string;
}

interface Prepared {
  segId: string;
  lineId: string;
  strokeId: string;
  direction: "outbound" | "inbound";
  number: string;
  color: string;
  width: number;
  sort: string;
  geom: Coord[];
  runs: EdgeRun[];
}

interface LaneCache {
  lines: TransitLine[];
  stops: Stop[] | undefined;
  roadN: number;
  tramN: number;
  pieces: Prepared[];
  lanes: Map<string, Map<string, number>>;
}

let cache: LaneCache | null = null;

export function buildRenderSegments(
  lines: TransitLine[],
  opts?: { collapseDirections?: boolean; stops?: Stop[]; metersPerPx?: number },
): RenderSegment[] {
  const metersPerPx = opts?.metersPerPx ?? 2;
  if (opts?.collapseDirections) return buildNetworkRenderSegments(lines, opts.stops, metersPerPx);
  const prepared = prepare(lines, opts?.stops);
  return prepared.pieces.map((piece) => ({
    id: piece.segId,
    lineId: piece.lineId,
    color: piece.color,
    width: piece.width,
    offset: 0,
    geometry: bakePiece(piece, prepared.lanes, metersPerPx),
    number: piece.number,
    oneWay: false,
  }));
}

function prepare(lines: TransitLine[], stops: Stop[] | undefined): LaneCache {
  const roadN = roadGraph.edgeCount();
  const tramN = tramGraph.edgeCount();
  if (
    cache &&
    cache.lines === lines &&
    cache.stops === stops &&
    cache.roadN === roadN &&
    cache.tramN === tramN
  ) {
    return cache;
  }

  const stopById = new Map((stops ?? []).map((s) => [s.id, s]));
  const pieces: Prepared[] = [];

  for (const line of lines) {
    if (!line.visible) continue;
    const width = lineStrokeWidth(line);
    const graph = line.mode === "tram" ? tramGraph : roadGraph;
    for (const seg of line.segments) {
      const clipped = clipToNetwork(line, seg, stopById);
      if (clipped.length < 2) continue;
      const geom = densifyLine(clipped, OFFSET_SAMPLE_M);
      const runs = graph.isEmpty() ? [] : graph.tracePolyline(geom);
      const strokeId = `${line.id}:${seg.direction}`;
      pieces.push({
        segId: seg.id,
        lineId: line.id,
        strokeId,
        direction: seg.direction,
        number: line.number,
        color: line.color,
        width,
        sort: sortKey(line.number, seg.direction),
        geom,
        runs,
      });
    }
  }

  const lanes = assignLanes(pieces);
  cache = { lines, stops, roadN, tramN, pieces, lanes };
  return cache;
}

function assignLanes(pieces: Prepared[]): Map<string, Map<string, number>> {
  const onEdge = new Map<string, Map<string, Occupant>>();
  for (const piece of pieces) {
    for (const run of piece.runs) {
      let bag = onEdge.get(run.key);
      if (!bag) {
        bag = new Map();
        onEdge.set(run.key, bag);
      }
      const prev = bag.get(piece.strokeId);
      if (!prev || piece.sort < prev.sort) {
        bag.set(piece.strokeId, { strokeId: piece.strokeId, width: piece.width, sort: piece.sort });
      } else {
        prev.width = Math.max(prev.width, piece.width);
      }
    }
  }

  const lanes = new Map<string, Map<string, number>>();
  onEdge.forEach((bag, key) => {
    const ordered = [...bag.values()].sort((a, b) => a.sort.localeCompare(b.sort, "pl"));
    const centered = centeredOffsets(ordered.map((o) => o.width));
    const slot = new Map<string, number>();
    ordered.forEach((o, i) => slot.set(o.strokeId, centered[i] ?? 0));
    lanes.set(key, slot);
  });
  return lanes;
}

function bakePiece(
  piece: Prepared,
  lanes: Map<string, Map<string, number>>,
  metersPerPx: number,
): Coord[] {
  if (piece.geom.length < 2 || !piece.runs.length) return piece.geom;

  const s = pathDistances(piece.geom);
  const runPx = piece.runs.map((run) => {
    const canonical = lanes.get(run.key)?.get(piece.strokeId) ?? 0;
    return canonical * (run.forward ? 1 : -1);
  });
  const runOf = new Array<number>(piece.geom.length).fill(-1);
  const raw = new Array<number>(piece.geom.length).fill(0);

  for (let r = 0; r < piece.runs.length; r++) {
    const run = piece.runs[r];
    for (let i = run.from; i <= run.to; i++) {
      runOf[i] = r;
      raw[i] = runPx[r];
    }
  }

  for (let i = 0; i < raw.length; i++) {
    if (runOf[i] >= 0) continue;
    let p = i - 1;
    let n = i + 1;
    while (p >= 0 && runOf[p] < 0) p--;
    while (n < raw.length && runOf[n] < 0) n++;
    if (p >= 0 && n < raw.length) {
      raw[i] = mix(raw[p], raw[n], (s[i] - s[p]) / Math.max(1e-3, s[n] - s[p]));
    } else if (p >= 0) raw[i] = raw[p];
    else if (n < raw.length) raw[i] = raw[n];
  }

  const px = blendOffsets(raw, s, runPx, piece.runs, metersPerPx);
  return offsetLine(
    piece.geom,
    px.map((v) => v * metersPerPx),
  );
}

function blendOffsets(
  raw: number[],
  s: number[],
  runPx: number[],
  runs: EdgeRun[],
  metersPerPx: number,
): number[] {
  const out = raw.slice();
  if (runs.length < 2) return out;

  const runLen = (r: number) => s[runs[r].to] - s[runs[r].from];
  const baseW = Math.min(
    OFFSET_BLEND_MAX_M,
    Math.max(OFFSET_BLEND_MIN_M, OFFSET_BLEND_PX * metersPerPx),
  );

  for (let r = 0; r < runs.length; r++) {
    if (runLen(r) >= 2 * OFFSET_BLEND_MIN_M) continue;
    const prev = r > 0 ? runPx[r - 1] : null;
    const next = r < runs.length - 1 ? runPx[r + 1] : null;
    if (prev == null || next == null) continue;
    const from = s[runs[r].from];
    const span = Math.max(1e-3, s[runs[r].to] - from);
    for (let i = runs[r].from; i <= runs[r].to; i++) {
      out[i] = mix(prev, next, smoothstep((s[i] - from) / span));
    }
  }

  for (let b = 0; b < runs.length - 1; b++) {
    const o0 = runPx[b];
    const o1 = runPx[b + 1];
    if (Math.abs(o1 - o0) < 0.15) continue;
    if (runLen(b) < 2 * OFFSET_BLEND_MIN_M || runLen(b + 1) < 2 * OFFSET_BLEND_MIN_M) continue;
    const w = Math.min(baseW, 0.45 * runLen(b), 0.45 * runLen(b + 1));
    if (w < 2) continue;
    const at = s[runs[b].to];
    const lo = at - w;
    const hi = at + w;
    for (let i = 0; i < s.length; i++) {
      if (s[i] < lo || s[i] > hi) continue;
      out[i] = mix(o0, o1, smoothstep((s[i] - lo) / (2 * w)));
    }
  }

  return out;
}

function clipToNetwork(line: TransitLine, seg: LineSegment, stops: Map<string, Stop>): Coord[] {
  const graph = line.mode === "tram" ? tramGraph : roadGraph;
  if (line.gtfsImport || graph.isEmpty()) return seg.geometry;
  const a = stops.get(seg.fromStopId);
  const b = stops.get(seg.toStopId);
  if (!a || !b) return seg.geometry;
  return graph.anchorLine(seg.geometry, [a.lon, a.lat], [b.lon, b.lat]);
}

function centeredOffsets(widths: number[]): number[] {
  if (widths.length <= 1) return [0];
  const total = widths.reduce((s, w) => s + w, 0) + OFFSET_GAP_PX * (widths.length - 1);
  let x = -total / 2;
  return widths.map((w) => {
    const center = x + w / 2;
    x += w + OFFSET_GAP_PX;
    return center;
  });
}

function sortKey(number: string, direction: string): string {
  const m = number.match(/(\d+)/);
  const n = (m ? m[1] : "999999").padStart(6, "0");
  const dir = direction === "outbound" ? "0" : "1";
  return `${n}\0${number}\0${dir}`;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}
