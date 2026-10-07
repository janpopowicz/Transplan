import { EDGE_STICK_M } from "../constants";
import type { Coord, TramTrack } from "../types";
import { haversine, nearestPointOnLine } from "./geo";

interface Edge {
  to: string;
  length: number;
  wayId: string;
}

interface SpatialEdge {
  a: string;
  b: string;
  wayId: string;
}

export interface NetworkSnap {
  coord: Coord;
  dist: number;
  a: string;
  b: string;
  aCoord: Coord;
  bCoord: Coord;
}

export interface EdgeRun {
  key: string;
  a: string;
  b: string;
  forward: boolean;
  from: number;
  to: number;
}

/** Grid cell in degrees. ~300 m — keeps nearest-edge queries local. */
const CELL = 0.003;
/** Conservative meters per cell, so the ring search does not stop early. */
const CELL_M = 160;

export class TramGraph {
  private adj = new Map<string, Edge[]>();
  private coords = new Map<string, Coord>();
  private wayNodes = new Map<string, string[]>();
  private edgeList: SpatialEdge[] = [];
  private grid = new Map<string, number[]>();

  clear(): void {
    this.adj.clear();
    this.coords.clear();
    this.wayNodes.clear();
    this.edgeList = [];
    this.grid.clear();
  }

  load(tracks: TramTrack[]): void {
    this.clear();
    for (const t of tracks) this.addTrack(t);
  }

  isEmpty(): boolean {
    return this.wayNodes.size === 0;
  }

  addTrack(track: TramTrack): void {
    this.removeTrack(track.id);
    const keys: string[] = [];
    for (const c of track.geometry) {
      const k = keyOf(c);
      this.coords.set(k, c);
      keys.push(k);
    }
    this.wayNodes.set(track.id, keys);
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      const len = haversine(track.geometry[i], track.geometry[i + 1]);
      if (len < 0.2) continue;
      this.link(a, b, len, track.id);
      this.link(b, a, len, track.id);
      this.indexEdge(a, b, track.id);
    }
  }

  removeTrack(id: string): void {
    const nodes = this.wayNodes.get(id);
    if (!nodes) return;
    this.wayNodes.delete(id);
    for (const n of nodes) {
      const edges = this.adj.get(n);
      if (!edges) continue;
      this.adj.set(
        n,
        edges.filter((e) => e.wayId !== id),
      );
    }
    this.rebuildSpatial();
  }

  /** Closest point on any edge, not the stop itself and not only a vertex. */
  nearestOnNetwork(p: Coord, maxM = 220): NetworkSnap | null {
    const cx = Math.floor(p[0] / CELL);
    const cy = Math.floor(p[1] / CELL);
    let best: NetworkSnap | null = null;
    const maxRing = Math.ceil(maxM / CELL_M) + 1;
    for (let ring = 0; ring <= maxRing; ring++) {
      const ringFloor = ring === 0 ? 0 : (ring - 1) * CELL_M;
      if (best && ringFloor > best.dist) break;
      if (ringFloor > maxM) break;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const bucket = this.grid.get(`${cx + dx},${cy + dy}`);
          if (!bucket) continue;
          for (const idx of bucket) {
            const e = this.edgeList[idx];
            const ca = this.coords.get(e.a);
            const cb = this.coords.get(e.b);
            if (!ca || !cb) continue;
            const near = nearestPointOnLine(p, [ca, cb]);
            if (near.dist <= maxM && near.dist < (best?.dist ?? Infinity)) {
              best = {
                coord: near.coord,
                dist: near.dist,
                a: e.a,
                b: e.b,
                aCoord: ca,
                bCoord: cb,
              };
            }
          }
        }
      }
    }
    return best;
  }

  edgeCount(): number {
    return this.edgeList.length;
  }

  /**
   * Walk a polyline and split it into runs on undirected graph edges.
   * Indices are inclusive into `geom`.
   */
  tracePolyline(geom: Coord[], maxM = 48): EdgeRun[] {
    if (geom.length < 2 || this.isEmpty()) return [];
    const runs: EdgeRun[] = [];
    let snap = this.nearestOnNetwork(geom[0], maxM);
    let from = 0;

    const flush = (to: number) => {
      if (!snap || to - from < 1) return;
      const a = snap.a < snap.b ? snap.a : snap.b;
      const b = snap.a < snap.b ? snap.b : snap.a;
      const aCoord = a === snap.a ? snap.aCoord : snap.bCoord;
      const bCoord = a === snap.a ? snap.bCoord : snap.aCoord;
      const start = geom[from];
      const end = geom[to];
      const forward =
        haversine(start, aCoord) + haversine(end, bCoord) <=
        haversine(start, bCoord) + haversine(end, aCoord);
      runs.push({ key: edgeKey(snap.a, snap.b), a, b, forward, from, to });
    };

    for (let i = 1; i < geom.length; i++) {
      const p = geom[i];
      if (snap) {
        const stay = nearestPointOnLine(p, [snap.aCoord, snap.bCoord]);
        if (stay.dist < EDGE_STICK_M) continue;
      }
      const next = this.nearestOnNetwork(p, maxM);
      if (next && snap && sameEdge(next, snap)) {
        snap = next;
        continue;
      }
      flush(i - 1);
      snap = next;
      from = i - 1;
    }
    flush(geom.length - 1);
    return runs.filter((r) => r.to > r.from);
  }

  /**
   * Path along the network between the nearest points to `from` and `to`.
   * The stop coordinates are not appended — that spur leaves the street
   * and circles the platform in the air.
   */
  route(from: Coord, to: Coord): Coord[] | null {
    const sa = this.nearestOnNetwork(from);
    const sb = this.nearestOnNetwork(to);
    if (!sa || !sb) return null;
    if (sameEdge(sa, sb)) return [sa.coord, sb.coord];

    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();
    const heap = new MinHeap();
    const seed = (node: string, d: number) => {
      if (d < (dist.get(node) ?? Infinity)) {
        dist.set(node, d);
        prev.set(node, null);
        heap.push(node, d);
      }
    };
    seed(sa.a, haversine(sa.coord, sa.aCoord));
    if (sa.b !== sa.a) seed(sa.b, haversine(sa.coord, sa.bCoord));

    const targets = new Set([sb.a, sb.b]);
    const settled = new Set<string>();
    let found = 0;
    while (!heap.empty()) {
      const cur = heap.pop();
      if (!cur) break;
      const best = dist.get(cur.id) ?? Infinity;
      if (cur.prio > best || settled.has(cur.id)) continue;
      settled.add(cur.id);
      if (targets.has(cur.id)) {
        found++;
        if (found >= targets.size) break;
      }
      const edges = this.adj.get(cur.id);
      if (!edges) continue;
      for (const e of edges) {
        const nd = best + e.length;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, cur.id);
          heap.push(e.to, nd);
        }
      }
    }

    let endNode: string | null = null;
    let endCost = Infinity;
    for (const node of targets) {
      const d = dist.get(node);
      const c = this.coords.get(node);
      if (d == null || !c) continue;
      const cost = d + haversine(c, sb.coord);
      if (cost < endCost) {
        endCost = cost;
        endNode = node;
      }
    }
    if (!endNode) return null;

    const path: Coord[] = [];
    const seen = new Set<string>();
    let x: string | undefined = endNode;
    while (x) {
      if (seen.has(x)) break;
      seen.add(x);
      const c = this.coords.get(x);
      if (c) path.push(c);
      const p = prev.get(x);
      if (p == null) break;
      x = p;
    }
    path.reverse();
    return dedupeCoords([sa.coord, ...path, sb.coord]);
  }

  /**
   * Drop the off-network spur at each end (the straight or looping dash
   * from the carriageway to the platform) and finish on the nearest edge.
   */
  anchorLine(geom: Coord[], from: Coord, to: Coord): Coord[] {
    if (geom.length < 2 || this.isEmpty()) return geom;
    const start = this.nearestOnNetwork(from);
    const end = this.nearestOnNetwork(to);
    let g = geom.slice();
    if (start) g = this.trimSpur(g, from, start, true);
    if (end) g = this.trimSpur(g, to, end, false);
    if (start) g = this.extendToSnap(g, start, true);
    if (end) g = this.extendToSnap(g, end, false);
    const out = dedupeCoords(g);
    return out.length >= 2 ? out : geom;
  }

  private trimSpur(geom: Coord[], stop: Coord, snap: NetworkSnap, atStart: boolean): Coord[] {
    const g = geom.slice();
    const reach = Math.max(100, snap.dist + 50);
    while (g.length > 2) {
      const pt = atStart ? g[0] : g[g.length - 1];
      if (haversine(pt, stop) > reach) break;
      const near = this.nearestOnNetwork(pt, 60);
      const off = !near || near.dist > 14;
      if (!off) break;
      if (atStart) g.shift();
      else g.pop();
    }
    if (g.length < 2) return geom;
    const pt = atStart ? g[0] : g[g.length - 1];
    if (haversine(pt, snap.coord) <= 5) {
      if (atStart) g[0] = snap.coord;
      else g[g.length - 1] = snap.coord;
      return g;
    }
    const near = this.nearestOnNetwork(pt, 80);
    const onSnapEdge =
      (near && sameEdge(near, snap)) ||
      haversine(pt, snap.aCoord) < 8 ||
      haversine(pt, snap.bCoord) < 8;
    if (onSnapEdge) {
      if (atStart) g.unshift(snap.coord);
      else g.push(snap.coord);
    }
    return g;
  }

  /** Continue along the carriageway to the closest point, never across a block. */
  private extendToSnap(geom: Coord[], snap: NetworkSnap, atStart: boolean): Coord[] {
    const g = geom.slice();
    const pt = atStart ? g[0] : g[g.length - 1];
    const gap = haversine(pt, snap.coord);
    if (gap <= 6) {
      if (atStart) g[0] = snap.coord;
      else g[g.length - 1] = snap.coord;
      return g;
    }
    if (gap > 70) return g;
    const mid: Coord = [(pt[0] + snap.coord[0]) / 2, (pt[1] + snap.coord[1]) / 2];
    const midNear = this.nearestOnNetwork(mid, 40);
    if (!midNear || midNear.dist > 16) return g;
    if (atStart) g.unshift(snap.coord);
    else g.push(snap.coord);
    return g;
  }

  private link(a: string, b: string, length: number, wayId: string): void {
    const list = this.adj.get(a) ?? [];
    list.push({ to: b, length, wayId });
    this.adj.set(a, list);
  }

  private indexEdge(a: string, b: string, wayId: string): void {
    const ca = this.coords.get(a);
    const cb = this.coords.get(b);
    if (!ca || !cb) return;
    const idx = this.edgeList.length;
    this.edgeList.push({ a, b, wayId });
    for (const key of coverCells(ca, cb)) {
      const bucket = this.grid.get(key);
      if (bucket) bucket.push(idx);
      else this.grid.set(key, [idx]);
    }
  }

  private rebuildSpatial(): void {
    this.edgeList = [];
    this.grid.clear();
    this.wayNodes.forEach((nodes, wayId) => {
      for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i];
        const b = nodes[i + 1];
        const ca = this.coords.get(a);
        const cb = this.coords.get(b);
        if (!ca || !cb || haversine(ca, cb) < 0.2) continue;
        this.indexEdge(a, b, wayId);
      }
    });
  }
}

function sameEdge(a: { a: string; b: string }, b: { a: string; b: string }): boolean {
  return (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function keyOf(c: Coord): string {
  return `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
}

function coverCells(a: Coord, b: Coord): string[] {
  const x0 = Math.floor(a[0] / CELL);
  const y0 = Math.floor(a[1] / CELL);
  const x1 = Math.floor(b[0] / CELL);
  const y1 = Math.floor(b[1] / CELL);
  const keys: string[] = [];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) keys.push(`${x},${y}`);
  }
  return keys;
}

function dedupeCoords(coords: Coord[]): Coord[] {
  const out: Coord[] = [];
  for (const c of coords) {
    if (!out.length || haversine(out[out.length - 1], c) > 0.8) out.push(c);
  }
  if (out.length >= 2) return out;
  if (coords.length >= 2) return [coords[0], coords[coords.length - 1]];
  return out;
}

class MinHeap {
  private a: { id: string; prio: number }[] = [];
  empty(): boolean {
    return this.a.length === 0;
  }
  push(id: string, prio: number): void {
    this.a.push({ id, prio });
    this.up(this.a.length - 1);
  }
  pop(): { id: string; prio: number } | undefined {
    if (this.a.length === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      this.down(0);
    }
    return top;
  }
  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].prio <= this.a[i].prio) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  private down(i: number): void {
    const n = this.a.length;
    for (;;) {
      let s = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < n && this.a[l].prio < this.a[s].prio) s = l;
      if (r < n && this.a[r].prio < this.a[s].prio) s = r;
      if (s === i) break;
      [this.a[s], this.a[i]] = [this.a[i], this.a[s]];
      i = s;
    }
  }
}

export const tramGraph = new TramGraph();
export const roadGraph = new TramGraph();
