import type { Coord, TramTrack } from "../types";
import { haversine, nearestPointOnLine } from "./geo";

interface Edge {
  to: string;
  length: number;
  wayId: string;
}

export class TramGraph {
  private adj = new Map<string, Edge[]>();
  private coords = new Map<string, Coord>();
  private wayNodes = new Map<string, string[]>();

  clear(): void {
    this.adj.clear();
    this.coords.clear();
    this.wayNodes.clear();
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
  }

  nearestNode(p: Coord, maxM = 160): string | null {
    let best: string | null = null;
    let bestD = maxM;
    this.coords.forEach((c, k) => {
      const d = haversine(p, c);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best) return best;

    let snapKey: string | null = null;
    let snapDist = maxM;
    this.wayNodes.forEach((nodes) => {
      const line = nodes.map((n) => this.coords.get(n)!).filter(Boolean);
      if (line.length < 2) return;
      const near = nearestPointOnLine(p, line);
      if (near.dist < snapDist) {
        snapDist = near.dist;
        snapKey = nodes[near.index] ?? null;
      }
    });
    return snapKey;
  }

  route(from: Coord, to: Coord): Coord[] | null {
    const s = this.nearestNode(from);
    const t = this.nearestNode(to);
    if (!s || !t) return null;
    if (s === t) return [from, to];

    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const heap = new MinHeap();
    dist.set(s, 0);
    heap.push(s, 0);

    while (!heap.empty()) {
      const cur = heap.pop();
      if (!cur) break;
      if (cur.id === t) break;
      const best = dist.get(cur.id) ?? Infinity;
      if (cur.prio > best) continue;
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

    if (!dist.has(t)) return null;
    const path: Coord[] = [];
    let x: string | undefined = t;
    while (x) {
      path.push(this.coords.get(x)!);
      if (x === s) break;
      x = prev.get(x);
    }
    path.reverse();
    if (haversine(from, path[0]) > 2) path.unshift(from);
    if (haversine(to, path[path.length - 1]) > 2) path.push(to);
    return path;
  }

  private link(a: string, b: string, length: number, wayId: string): void {
    const list = this.adj.get(a) ?? [];
    list.push({ to: b, length, wayId });
    this.adj.set(a, list);
  }
}

function keyOf(c: Coord): string {
  return `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
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
