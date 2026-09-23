import { INTERLINE_TOLERANCE_M, OFFSET_BASE_PX, OFFSET_PX } from "../constants";
import type { Coord, TransitLine } from "../types";
import { bboxOf, bboxesOverlap, distToLine, pointAlong } from "./geo";

export interface RenderSegment {
  id: string;
  lineId: string;
  color: string;
  width: number;
  offset: number;
  geometry: Coord[];
  number: string;
}

const VEHICLE_WIDTH: Record<string, number> = {
  "8m": 3.2,
  "10m": 3.6,
  "12m": 4.1,
  "18m": 5.4,
  "26m": 5.2,
  "33m": 6.2,
  "42m": 7.4,
};

export function buildRenderSegments(lines: TransitLine[]): RenderSegment[] {
  const visible = lines.filter((l) => l.visible && l.segments.length);
  const items: {
    lineId: string;
    segId: string;
    geometry: Coord[];
    bbox: [number, number, number, number];
  }[] = [];

  for (const line of visible) {
    for (const seg of line.segments) {
      if (seg.geometry.length < 2) continue;
      items.push({
        lineId: line.id,
        segId: seg.id,
        geometry: seg.geometry,
        bbox: bboxOf(seg.geometry),
      });
    }
  }

  const sharing = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    if (!sharing.has(id)) sharing.set(id, new Set([id]));
    return sharing.get(id)!;
  };

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const setA = ensure(a.lineId);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (a.lineId === b.lineId) continue;
      if (!bboxesOverlap(a.bbox, b.bbox)) continue;
      if (corridorsShare(a.geometry, b.geometry)) {
        setA.add(b.lineId);
        ensure(b.lineId).add(a.lineId);
      }
    }
  }

  // Union-find-ish expand
  let changed = true;
  while (changed) {
    changed = false;
    sharing.forEach((set) => {
      const extra: string[] = [];
      set.forEach((id) => {
        sharing.get(id)?.forEach((o) => {
          if (!set.has(o)) extra.push(o);
        });
      });
      if (extra.length) {
        extra.forEach((o) => set.add(o));
        changed = true;
      }
    });
  }

  const indexOf = new Map<string, Map<string, number>>();
  sharing.forEach((set, lineId) => {
    const ids = [...set].sort();
    const map = new Map<string, number>();
    ids.forEach((id, i) => map.set(id, i));
    indexOf.set(lineId, map);
  });

  const out: RenderSegment[] = [];
  for (const line of visible) {
    for (const seg of line.segments) {
      if (seg.geometry.length < 2) continue;
      const peers = indexOf.get(line.id);
      const ids = peers ? [...new Set(peers.keys())].sort() : [line.id];
      const idx = ids.indexOf(line.id);
      const offset = OFFSET_BASE_PX + idx * OFFSET_PX;
      out.push({
        id: seg.id,
        lineId: line.id,
        color: line.color,
        width: VEHICLE_WIDTH[line.vehicle] ?? 4,
        offset,
        geometry: seg.geometry,
        number: line.number,
      });
    }
  }
  return out;
}

function corridorsShare(a: Coord[], b: Coord[]): boolean {
  const samples = [0.25, 0.5, 0.75].map((t) => pointAlong(a, t));
  let hits = 0;
  for (const p of samples) {
    if (distToLine(p, b) < INTERLINE_TOLERANCE_M) hits++;
  }
  return hits >= 2;
}
