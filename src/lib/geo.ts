import type { Coord } from "../types";

const R = 6371000;

export function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function haversine(a: Coord, b: Coord): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a: Coord, b: Coord): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function distToSegment(p: Coord, a: Coord, b: Coord): number {
  const len = haversine(a, b);
  if (len < 1) return haversine(p, a);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) /
        ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2),
    ),
  );
  const proj: Coord = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return haversine(p, proj);
}

export function distToLine(p: Coord, line: Coord[]): number {
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    min = Math.min(min, distToSegment(p, line[i], line[i + 1]));
  }
  return min;
}

export function nearestPointOnLine(
  p: Coord,
  line: Coord[],
): { coord: Coord; dist: number; index: number } {
  let best = { coord: line[0], dist: Infinity, index: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    const t =
      len2 < 1e-18
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) /
                len2,
            ),
          );
    const coord: Coord = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const dist = haversine(p, coord);
    if (dist < best.dist) best = { coord, dist, index: i };
  }
  return best;
}

export function lineLength(line: Coord[]): number {
  let n = 0;
  for (let i = 0; i < line.length - 1; i++) n += haversine(line[i], line[i + 1]);
  return n;
}

export function pointAlong(line: Coord[], t: number): Coord {
  const total = lineLength(line);
  if (total === 0) return line[0];
  let target = total * t;
  for (let i = 0; i < line.length - 1; i++) {
    const d = haversine(line[i], line[i + 1]);
    if (target <= d) {
      const u = d === 0 ? 0 : target / d;
      return [
        line[i][0] + u * (line[i + 1][0] - line[i][0]),
        line[i][1] + u * (line[i + 1][1] - line[i][1]),
      ];
    }
    target -= d;
  }
  return line[line.length - 1];
}

export function sideOfHeading(origin: Coord, headingTo: Coord, p: Coord): number {
  const dx = headingTo[0] - origin[0];
  const dy = headingTo[1] - origin[1];
  const px = p[0] - origin[0];
  const py = p[1] - origin[1];
  return dx * py - dy * px;
}

export function normalizeStopName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\((nż|nz|n\.ż\.)\)\s*/gi, "")
    .replace(/[–—]/g, "-")
    .trim();
}

export function formatTakt(v: number | null): string {
  if (v == null) return "—";
  return Number.isInteger(v) ? `${v} min` : `${v.toString().replace(".", ",")} min`;
}

export function tripsPerHour(takt: number | null): string {
  if (takt == null) return "—";
  const n = 60 / takt;
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ",");
}

export function bboxOf(line: Coord[]): [number, number, number, number] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of line) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

export function bboxesOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
  pad = 0.0004,
): boolean {
  return (
    a[0] <= b[2] + pad &&
    a[2] >= b[0] - pad &&
    a[1] <= b[3] + pad &&
    a[3] >= b[1] - pad
  );
}
