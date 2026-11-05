import type { Coord } from "../types";
import { BBOX } from "../constants";
import { WALK_METERS_PER_MIN, type projection } from "./pedestrianRouting";
import type { WalkingEdge } from "./walkingNetwork";

export interface AreaRasterModel {
  cellCount: number;
  resolutionMeters: number;
  ids: Uint32Array;
  sources: Uint32Array;
  targets: Uint32Array;
  forward: Float64Array;
  backward: Float64Array;
}

/** Fixed, equal-area cells, deduplicated across overlapping street corridors.
 * Geometry is prepared once for a whole origin batch. This follows the same
 * 0.8-cell OSM corridor convention as the map, without tracing GeoJSON rings. */
export function prepareAreaRaster(xy: Coord[], edges: WalkingEdge[], project: ReturnType<typeof projection>, resolutionMeters: number) {
  const step = resolutionMeters, corridor = step * 0.8;
  const [west, south] = project.toXY([BBOX.west, BBOX.south]);
  const [east, north] = project.toXY([BBOX.east, BBOX.north]);
  const width = Math.ceil((east - west) / step), height = Math.ceil((north - south) / step);
  // Dense grid index and growable typed columns: a Map plus six plain arrays
  // of ~2M entries cost more in hashing and GC than the geometry itself.
  const cellIndex = new Int32Array(width * height).fill(-1);
  let cellCount = 0, size = 0, capacity = 1 << 16;
  let cell = new Uint32Array(capacity), from = new Uint32Array(capacity), to = new Uint32Array(capacity);
  let forward = new Float64Array(capacity), backward = new Float64Array(capacity);
  const grow = () => {
    capacity *= 2;
    const widen = <T extends Uint32Array | Float64Array>(old: T) => { const next = new (old.constructor as new (n: number) => T)(capacity); next.set(old); return next; };
    cell = widen(cell); from = widen(from); to = widen(to); forward = widen(forward); backward = widen(backward);
  };
  for (const edge of edges) {
    const a = xy[edge.from], b = xy[edge.to];
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - corridor - west) / step));
    const x1 = Math.min(width - 1, Math.ceil((Math.max(a[0], b[0]) + corridor - west) / step));
    const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - corridor - south) / step));
    const y1 = Math.min(height - 1, Math.ceil((Math.max(a[1], b[1]) + corridor - south) / step));
    for (let row = y0; row <= y1; row++) for (let col = x0; col <= x1; col++) {
      const x = west + (col + 0.5) * step, y = south + (row + 0.5) * step;
      if (x > east || y > north) continue;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (length2 || 1)));
      // sqrt instead of Math.hypot: hypot is several times slower in V8 and
      // never changed a corridor decision on the full Kraków extract.
      const ex = x - a[0] - t * dx, ey = y - a[1] - t * dy;
      if (Math.sqrt(ex * ex + ey * ey) > corridor) continue;
      const key = row * width + col;
      if (cellIndex[key] < 0) cellIndex[key] = cellCount++;
      if (size === capacity) grow();
      cell[size] = cellIndex[key]; from[size] = edge.from; to[size] = edge.to;
      forward[size] = edge.forward ? t * edge.meters / WALK_METERS_PER_MIN : Infinity;
      backward[size++] = edge.backward ? (1 - t) * edge.meters / WALK_METERS_PER_MIN : Infinity;
    }
  }
  const ids = cell.slice(0, size), sources = from.slice(0, size), targets = to.slice(0, size);
  const fa = forward.slice(0, size), ba = backward.slice(0, size);
  const model: AreaRasterModel = { cellCount, resolutionMeters: step, ids, sources, targets, forward: fa, backward: ba };
  return {
    cellCount,
    model,
    areasKm2(times: Float64Array, thresholds: readonly number[]) {
      return rasterAreasKm2(model, times, thresholds);
    },
  };
}

export function rasterAreasKm2(model: AreaRasterModel, times: Float64Array, thresholds: readonly number[]) {
  const { ids, sources, targets, forward: fa, backward: ba, resolutionMeters: step } = model;
  const values = new Float64Array(model.cellCount).fill(Infinity);
  for (let i = 0; i < ids.length; i++) {
    const time = Math.min(times[sources[i]] + fa[i], times[targets[i]] + ba[i]);
    if (time < values[ids[i]]) values[ids[i]] = time;
  }
  const counts = thresholds.map(() => 0);
  // Count each cell once, then accumulate disjoint bands to cumulative areas.
  for (const value of values) {
    for (let i = 0; i < thresholds.length; i++) if (value <= thresholds[i]) { counts[i]++; break; }
  }
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  return counts.map((count) => count * step * step / 1e6);
}
