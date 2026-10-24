import type { Coord } from "../types";
import { calculateAccessibility, projection, WALK_METERS_PER_MIN, type AccessibilityRequest } from "./pedestrianRouting";

export type IsochroneRequest = AccessibilityRequest;
export interface IsochroneBand { minutes: number; color: string }
export interface IsochroneResult {
  contours: GeoJSON.FeatureCollection<GeoJSON.MultiLineString>;
  fills: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>;
  bands: IsochroneBand[];
  reachableStops: number;
  activeLines: number;
  unconnectedStops: number;
  resolutionMeters: number;
  maxMinutes: number;
}

export function isochroneBands(maxMinutes: number): IsochroneBand[] {
  const maximum = Math.max(1, Math.ceil(maxMinutes));
  const levels: number[] = [];
  for (let minutes = 10; minutes < maximum; minutes += 10) levels.push(minutes);
  levels.push(maximum);
  return levels.map((minutes) => {
    // A stable progression for the first hour, then purple for longer journeys.
    const hue = minutes <= 60 ? 150 - minutes * 2.5 : 360 - Math.min(90, (minutes - 60) * 1.5);
    const lightness = minutes <= 120 ? 43 : Math.max(22, 43 - (minutes - 120) / 20);
    return { minutes, color: `hsl(${Math.round(hue)}, 72%, ${Math.round(lightness)}%)` };
  });
}

/** Times follow OSM ways. The raster only widens their display into a narrow
 * corridor; it never adds walking edges across rivers or disconnected streets. */
export function calculateIsochrones(request: IsochroneRequest): IsochroneResult {
  const accessibility = calculateAccessibility(request);
  const { xy, walkEdges, times, activeLines, unconnectedStops, stopTimes } = accessibility;
  const project = projection(request.origin);
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const edge of walkEdges) {
    if (!Number.isFinite(times[edge.from]) && !Number.isFinite(times[edge.to])) continue;
    for (const index of [edge.from, edge.to]) {
      const [x, y] = xy[index];
      west = Math.min(west, x); east = Math.max(east, x);
      south = Math.min(south, y); north = Math.max(north, y);
    }
  }
  if (!Number.isFinite(west)) throw new Error("Brak osiągalnych dróg pieszych z tego punktu.");
  const step = Math.max(60, Math.sqrt((east - west) * (north - south) / 220_000));
  const corridor = step * 0.8;
  west -= step * 2; south -= step * 2;
  const width = Math.ceil((east - west) / step) + 3;
  const height = Math.ceil((north - south) / step) + 3;
  const values = new Float64Array(width * height).fill(Infinity);
  let maxMinutes = 0;
  for (const edge of walkEdges) {
    const ta = edge.forward ? times[edge.from] : Infinity;
    const tb = edge.backward ? times[edge.to] : Infinity;
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) continue;
    const a = xy[edge.from], b = xy[edge.to];
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - corridor - west) / step));
    const x1 = Math.min(width - 1, Math.ceil((Math.max(a[0], b[0]) + corridor - west) / step));
    const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - corridor - south) / step));
    const y1 = Math.min(height - 1, Math.ceil((Math.max(a[1], b[1]) + corridor - south) / step));
    for (let row = y0; row <= y1; row++) for (let col = x0; col <= x1; col++) {
      const x = west + col * step, y = south + row * step;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (length2 || 1)));
      if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) > corridor) continue;
      const minutes = Math.min(ta + t * edge.meters / WALK_METERS_PER_MIN, tb + (1 - t) * edge.meters / WALK_METERS_PER_MIN);
      const index = row * width + col;
      if (minutes < values[index]) values[index] = minutes;
    }
  }
  for (const value of values) if (Number.isFinite(value)) maxMinutes = Math.max(maxMinutes, value);
  // Include farthest reachable endpoints even when a grid cell lies slightly before them.
  for (const edge of walkEdges) for (const index of [edge.from, edge.to]) {
    if (Number.isFinite(times[index])) maxMinutes = Math.max(maxMinutes, times[index]);
  }
  const bands = isochroneBands(maxMinutes);
  const contours: IsochroneResult["contours"] = { type: "FeatureCollection", features: [] };
  const fills: IsochroneResult["fills"] = { type: "FeatureCollection", features: [] };
  const toCoord = ([x, y]: Coord) => project.toCoord([west + x * step, south + y * step]);
  const bandCells = new Int16Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) {
    bandCells[i] = Math.min(bands.length - 1, Math.max(0, Math.ceil(values[i] / 10) - 1));
  }
  for (let index = 0; index < bands.length; index++) {
    const band = bands[index];
    const paths = traceIsolines(values, width, height, band.minutes);
    if (paths.length) contours.features.push({ type: "Feature", properties: band,
      geometry: { type: "MultiLineString", coordinates: paths.map((path) => path.map(toCoord)) } });
    const rings = traceCells(bandCells, width, height, index);
    if (rings.length) fills.features.push({ type: "Feature", properties: band,
      geometry: { type: "MultiPolygon", coordinates: polygonsFromRings(rings).map((polygon) => polygon.map((ring) => ring.map(toCoord))) } });
  }
  return { contours, fills, bands, activeLines, unconnectedStops, resolutionMeters: step, maxMinutes,
    reachableStops: [...stopTimes.values()].filter(Number.isFinite).length };
}

/** Join cell boundaries into disjoint colour bands without overlapping alpha. */
function traceCells(cells: Int16Array, width: number, height: number, band: number): Coord[][] {
  const stride = width + 1;
  const next = new Map<number, number[]>();
  const edge = (a: number, b: number) => { const list = next.get(a) ?? []; list.push(b); next.set(a, list); };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (cells[i] !== band) continue;
    const a = y * stride + x, b = a + 1, c = b + stride, d = a + stride;
    if (y === 0 || cells[i - width] !== band) edge(a, b);
    if (x === width - 1 || cells[i + 1] !== band) edge(b, c);
    if (y === height - 1 || cells[i + width] !== band) edge(c, d);
    if (x === 0 || cells[i - 1] !== band) edge(d, a);
  }
  const point = (key: number): Coord => [key % stride - 0.5, Math.floor(key / stride) - 0.5];
  const rings: Coord[][] = [];
  while (next.size) {
    const start = next.keys().next().value!;
    let current = start, previous: number | undefined;
    const ring: Coord[] = [];
    do {
      ring.push(point(current));
      const exits = next.get(current);
      if (!exits?.length) break;
      let choice = 0;
      if (previous !== undefined && exits.length > 1) {
        const p = point(previous), q = point(current), dx = q[0] - p[0], dy = q[1] - p[1];
        let best = -Infinity;
        for (let i = 0; i < exits.length; i++) {
          const r = point(exits[i]), ex = r[0] - q[0], ey = r[1] - q[1];
          const angle = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
          if (angle > best) { best = angle; choice = i; }
        }
      }
      const target = exits.splice(choice, 1)[0];
      if (!exits.length) next.delete(current);
      previous = current; current = target;
    } while (current !== start);
    if (current === start && ring.length >= 4) {
      // Drop collinear grid corners to keep city-wide GeoJSON compact.
      const simple = ring.filter((p, i) => {
        const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
        return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
      });
      if (simple.length >= 3) { simple.push(simple[0]); rings.push(simple); }
    }
  }
  return rings;
}

function polygonsFromRings(rings: Coord[][]): Coord[][][] {
  const shells = rings.filter((ring) => signedArea(ring) > 0);
  const polygons = shells.map((shell) => [shell]);
  const sizes = shells.map(signedArea);
  const bounds = shells.map((ring) => {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const [x, y] of ring) { west = Math.min(west, x); south = Math.min(south, y); east = Math.max(east, x); north = Math.max(north, y); }
    return { west, south, east, north };
  });
  for (const hole of rings.filter((ring) => signedArea(ring) < 0)) {
    let owner = -1, area = Infinity;
    const [x, y] = hole[0];
    for (let i = 0; i < shells.length; i++) {
      const box = bounds[i];
      if (sizes[i] >= area || x < box.west || x > box.east || y < box.south || y > box.north) continue;
      if (insideRing(hole[0], shells[i])) { owner = i; area = sizes[i]; }
    }
    if (owner >= 0) polygons[owner].push(hole);
  }
  return polygons;
}

/** True equal-time lines only. Unknown cells cannot create labelled boundaries. */
function traceIsolines(values: Float64Array, width: number, height: number, level: number): Coord[][] {
  const next = new Map<string, string>(), incoming = new Set<string>(), coords = new Map<string, Coord>();
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
    if (![a, b, c].every((i) => Number.isFinite(values[i]))) return;
    const ids = [a, b, c];
    let entry: string | undefined, exit: string | undefined;
    for (let i = 0; i < 3; i++) {
      const from = ids[i], to = ids[(i + 1) % 3];
      if (values[from] <= threshold && values[to] > threshold) exit = crossing(from, to);
      if (values[from] > threshold && values[to] <= threshold) entry = crossing(from, to);
    }
    if (entry && exit) { next.set(exit, entry); incoming.add(entry); }
  };
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const a = y * width + x, b = a + 1, c = b + width, d = a + width;
    if (values[a] > threshold && values[b] > threshold && values[c] > threshold && values[d] > threshold) continue;
    if (values[a] <= threshold && values[b] <= threshold && values[c] <= threshold && values[d] <= threshold) continue;
    triangle(a, b, c); triangle(a, c, d);
  }
  const paths: Coord[][] = [];
  const trace = (start: string) => {
    const path: Coord[] = [coords.get(start)!];
    let key = start;
    while (next.has(key)) {
      const target = next.get(key)!;
      next.delete(key); key = target;
      path.push(coords.get(key)!);
      if (key === start) break;
    }
    if (path.length >= 2) paths.push(path);
  };
  for (const start of [...next.keys()].filter((key) => !incoming.has(key))) trace(start);
  while (next.size) trace(next.keys().next().value!);
  return paths;
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
