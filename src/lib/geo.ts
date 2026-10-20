import type { Coord, Stop } from "../types";

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

/** Group key: same name, Kraków platform number at the end removed ("Bagatela 01"). */
export function stopGroupKey(name: string): string {
  return normalizeStopName(name).replace(/\s+\d{1,3}$/, "").trim();
}

export function stopGroupLabel(name: string): string {
  return name
    .replace(/\s*\((nż|nz|n\.ż\.)\)\s*/gi, " ")
    .replace(/\s+\d{1,3}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function clusterStops(stops: Stop[], maxMeters: number): Stop[][] {
  const named = new Map<string, Stop[]>();
  const singles: Stop[][] = [];
  for (const stop of stops) {
    const key = stopGroupKey(stop.name);
    if (!key || key === "bez nazwy") {
      singles.push([stop]);
      continue;
    }
    const list = named.get(key);
    if (list) list.push(stop);
    else named.set(key, [stop]);
  }
  const out = [...singles];
  for (const list of named.values()) {
    const parent = list.map((_, i) => i);
    const find = (i: number): number => {
      let x = i;
      while (parent[x] !== x) x = parent[x];
      let y = i;
      while (parent[y] !== x) {
        const next = parent[y];
        parent[y] = x;
        y = next;
      }
      return x;
    };
    const union = (i: number, j: number) => {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    };
    for (let i = 0; i < list.length; i++) {
      const ai: Coord = [list[i].lon, list[i].lat];
      for (let j = i + 1; j < list.length; j++) {
        if (haversine(ai, [list[j].lon, list[j].lat]) <= maxMeters) union(i, j);
      }
    }
    const groups = new Map<number, Stop[]>();
    for (let i = 0; i < list.length; i++) {
      const root = find(i);
      const g = groups.get(root);
      if (g) g.push(list[i]);
      else groups.set(root, [list[i]]);
    }
    for (const g of groups.values()) out.push(g);
  }
  return out;
}

export function clusterCentroid(stops: Stop[]): Coord {
  let lon = 0;
  let lat = 0;
  for (const s of stops) {
    lon += s.lon;
    lat += s.lat;
  }
  const n = stops.length || 1;
  return [lon / n, lat / n];
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

export function densifyLine(line: Coord[], maxM: number): Coord[] {
  if (line.length < 2) return line.slice();
  const out: Coord[] = [line[0]];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const d = haversine(a, b);
    const n = Math.max(1, Math.ceil(d / Math.max(1, maxM)));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

export function metersPerPixel(lat: number, zoom: number): number {
  // MapLibre uses a 512 px world tile, including when raster tiles are 256 px.
  return (78271.51696 * Math.cos(toRad(lat))) / 2 ** zoom;
}

export function pathDistances(line: Coord[]): number[] {
  const s = [0];
  for (let i = 1; i < line.length; i++) s.push(s[i - 1] + haversine(line[i - 1], line[i]));
  return s;
}

/** Shift a polyline to the right of travel by `meters[i]` at each vertex. */
export function offsetLine(line: Coord[], meters: number[]): Coord[] {
  if (line.length < 2) return line.slice();
  return line.map((p, i) => {
    const m = meters[i] ?? 0;
    if (Math.abs(m) < 0.05) return p;
    return shiftRight(line, i, m);
  });
}

function shiftRight(line: Coord[], i: number, meters: number): Coord {
  const p = line[i];
  const prev = i > 0 ? line[i - 1] : p;
  const next = i < line.length - 1 ? line[i + 1] : p;
  const a = toLocal(prev, p);
  const b = toLocal(next, p);
  const inT = unit([-a[0], -a[1]]);
  const outT = unit(b);
  const t =
    i === 0
      ? outT
      : i === line.length - 1
        ? inT
        : inT && outT
          ? unit([inT[0] + outT[0], inT[1] + outT[1]])
          : (inT ?? outT);
  if (!t) return p;
  const n: [number, number] = [t[1], -t[0]];
  if (inT && outT && i > 0 && i < line.length - 1) {
    const nIn: [number, number] = [inT[1], -inT[0]];
    const nOut: [number, number] = [outT[1], -outT[0]];
    const sum: [number, number] = [nIn[0] + nOut[0], nIn[1] + nOut[1]];
    const sl = Math.hypot(sum[0], sum[1]);
    if (sl > 0.35) {
      const miter = 2 / sl;
      if (miter <= 3.2) {
        return fromLocal([sum[0] * (meters / sl), sum[1] * (meters / sl)], p);
      }
    }
  }
  return fromLocal([n[0] * meters, n[1] * meters], p);
}

function toLocal(c: Coord, origin: Coord): [number, number] {
  const cos = Math.cos(toRad(origin[1]));
  return [(c[0] - origin[0]) * 111320 * cos, (c[1] - origin[1]) * 110540];
}

function fromLocal(xy: [number, number], origin: Coord): Coord {
  const cos = Math.cos(toRad(origin[1]));
  return [origin[0] + xy[0] / (111320 * Math.max(0.2, cos)), origin[1] + xy[1] / 110540];
}

function unit(v: [number, number]): [number, number] | null {
  const n = Math.hypot(v[0], v[1]);
  if (n < 0.4) return null;
  return [v[0] / n, v[1] / n];
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
