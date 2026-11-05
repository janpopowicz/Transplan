import type { Coord } from "../types";
import { buildAccessibilityGraph, WALK_METERS_PER_MIN, type AccessibilityRequest } from "./pedestrianRouting";
import { buildTimetable } from "./timetable";

import { createMeanRoutingKernel } from "./meanRoutingKernel";

type Graph = ReturnType<typeof buildAccessibilityGraph>;

function adjacency(count: number, from: number[], to: number[], minutes: number[], headways?: number[], phases?: number[]) {
  const offsets = new Uint32Array(count + 1);
  for (const node of from) offsets[node + 1]++;
  for (let i = 1; i <= count; i++) offsets[i] += offsets[i - 1];
  const cursor = offsets.slice(), destinations = new Uint32Array(to.length), costs = new Float64Array(to.length);
  const headway = headways ? new Float64Array(to.length) : undefined;
  const phase = phases ? new Float64Array(to.length) : undefined;
  for (let i = 0; i < from.length; i++) {
    const at = cursor[from[i]]++;
    destinations[at] = to[i]; costs[at] = minutes[i];
    if (headway && phase) { headway[at] = headways![i]; phase[at] = phases![i]; }
  }
  return { offsets, destinations, costs, headway, phase };
}

/** Trim unprotected dead-end trees and contract uniform degree-two chains.
 * All junctions, direction
 * changes, stop attachments, origins and transit states remain explicit.
 * Original edge shortcuts and per-request split connections are preserved. */
function contract(graph: Graph, request: Omit<AccessibilityRequest, "origin">) {
  const { network } = request, n = network.coords.length;
  const degree = new Uint32Array(n), incoming = new Uint32Array(n);
  const unsafe = new Uint8Array(n);
  for (const edge of network.edges) {
    degree[edge.from]++; degree[edge.to]++;
    if (edge.forward) incoming[edge.to]++;
    if (edge.backward) incoming[edge.from]++;
    if (!edge.forward && !edge.backward || edge.from === edge.to) { unsafe[edge.from] = 1; unsafe[edge.to] = 1; }
  }
  const incidentOffsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) incidentOffsets[i + 1] = incidentOffsets[i] + degree[i];
  const incident = new Uint32Array(incidentOffsets[n]), cursor = incidentOffsets.slice();
  network.edges.forEach((edge, i) => { incident[cursor[edge.from]++] = i; incident[cursor[edge.to]++] = i; });
  const protectedNodes = new Uint8Array(graph.nodeCount);
  for (const [from, edges] of graph.extra) {
    protectedNodes[from] = 1;
    for (const edge of edges) protectedNodes[edge.to] = 1;
  }
  protectedNodes[graph.start.node] = 1;
  for (const start of graph.starts) if (start) protectedNodes[start.node] = 1;
  const outgoing = Uint32Array.from(degree, (_, node) => graph.prepared.offsets[node + 1] - graph.prepared.offsets[node]);
  const pruned = new Uint8Array(network.edges.length), queue = new Uint32Array(n);
  const treeNodes: number[] = [], treeParents: number[] = [], treeMinutes: number[] = [];
  let queueHead = 0, queueSize = 0;
  for (let node = 0; node < n; node++) if (!protectedNodes[node] && degree[node] === 1) queue[queueSize++] = node;
  // A leaf without stops/origins cannot improve a path back into the graph.
  // Restore its entire sample profile by adding its fixed access distance.
  while (queueHead < queueSize) {
    const node = queue[queueHead++];
    if (degree[node] !== 1) continue;
    let edgeIndex = incidentOffsets[node];
    while (pruned[incident[edgeIndex]]) edgeIndex++;
    edgeIndex = incident[edgeIndex];
    const edge = network.edges[edgeIndex], parent = edge.from === node ? edge.to : edge.from;
    treeNodes.push(node); treeParents.push(parent);
    treeMinutes.push((edge.from === parent ? edge.forward : edge.backward) ? edge.meters / WALK_METERS_PER_MIN : Infinity);
    pruned[edgeIndex] = 1; degree[node]--; degree[parent]--;
    if (edge.forward) { outgoing[edge.from]--; incoming[edge.to]--; }
    if (edge.backward) { outgoing[edge.to]--; incoming[edge.from]--; }
    if (!protectedNodes[parent] && degree[parent] === 1) queue[queueSize++] = parent;
  }
  const keep = new Uint8Array(graph.nodeCount).fill(1);
  for (let node = 0; node < n; node++) {
    if (protectedNodes[node]) continue;
    if (!degree[node]) { keep[node] = 0; continue; }
    if (degree[node] !== 2 || unsafe[node]) continue;
    if (!(incoming[node] === 2 && outgoing[node] === 2 || incoming[node] === 1 && outgoing[node] === 1)) continue;
    let first = incidentOffsets[node];
    while (pruned[incident[first]]) first++;
    let second = first + 1;
    while (pruned[incident[second]]) second++;
    const a = network.edges[incident[first]], b = network.edges[incident[second]];
    if ((a.from === node ? a.to : a.from) === (b.from === node ? b.to : b.from)) continue;
    keep[node] = 0;
  }
  for (const [from, edges] of graph.extra) {
    keep[from] = 1;
    for (const edge of edges) keep[edge.to] = 1;
  }
  keep[graph.start.node] = 1;
  for (const start of graph.starts) if (start) keep[start.node] = 1;
  const compact = new Int32Array(graph.nodeCount).fill(-1), originals: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) { compact[i] = originals.length; originals.push(i); }
  const walkFrom: number[] = [], walkTo: number[] = [], walkMinutes: number[] = [];
  const addWalking = (from: number, to: number, time: number) => { walkFrom.push(from); walkTo.push(to); walkMinutes.push(time); };
  const visited = pruned.slice();
  const chainA: number[] = [], chainB: number[] = [], chainLength: number[] = [], chainFlags: number[] = [], chainOffsets = [0];
  const interiors: number[] = [], distances: number[] = [];
  for (let start = 0; start < n; start++) if (keep[start]) {
    for (let i = incidentOffsets[start]; i < incidentOffsets[start + 1]; i++) {
      let edgeIndex = incident[i];
      if (visited[edgeIndex]) continue;
      let current = start, length = 0, forward = true, backward = true;
      const begin = interiors.length;
      while (true) {
        const edge = network.edges[edgeIndex]; visited[edgeIndex] = 1;
        const along = edge.from === current, other = along ? edge.to : edge.from;
        forward &&= along ? edge.forward : edge.backward;
        backward &&= along ? edge.backward : edge.forward;
        length += edge.meters / WALK_METERS_PER_MIN;
        if (keep[other]) {
          const a = compact[start], b = compact[other];
          if (forward) addWalking(a, b, length);
          if (backward) addWalking(b, a, length);
          if (interiors.length > begin) {
            chainA.push(a); chainB.push(b); chainLength.push(length); chainFlags.push(Number(forward) | Number(backward) << 1);
            chainOffsets.push(interiors.length);
          }
          break;
        }
        interiors.push(other); distances.push(length);
        let at = incidentOffsets[other];
        while (visited[incident[at]]) at++;
        edgeIndex = incident[at];
        current = other;
      }
    }
  }
  const transitFrom: number[] = [], transitTo: number[] = [], transitMinutes: number[] = [], headways: number[] = [], phases: number[] = [];
  for (const [from, edges] of graph.extra) for (const edge of edges) {
    if (!edge.transit) addWalking(compact[from], compact[edge.to], edge.minutes);
    else {
      transitFrom.push(compact[from]); transitTo.push(compact[edge.to]); transitMinutes.push(edge.minutes);
      headways.push(edge.headway ?? 0); phases.push(edge.phase ?? 0);
    }
  }
  return { compact, originals: Uint32Array.from(originals),
    walking: adjacency(originals.length, walkFrom, walkTo, walkMinutes),
    transit: adjacency(originals.length, transitFrom, transitTo, transitMinutes, headways, phases),
    boardings: graph.boardings.map((b) => ({ ...b, from: compact[b.from], to: compact[b.to] })),
    chains: { a: Uint32Array.from(chainA), b: Uint32Array.from(chainB), length: Float64Array.from(chainLength),
      flags: Uint8Array.from(chainFlags), offsets: Uint32Array.from(chainOffsets),
      nodes: Uint32Array.from(interiors), distances: Float64Array.from(distances) },
    trees: { nodes: Uint32Array.from(treeNodes), parents: Uint32Array.from(treeParents), minutes: Float64Array.from(treeMinutes) } };
}

/** Exact mean accessibility on a contracted graph. Removed geometry vertices
 * are restored from endpoint sample profiles, including samples that approach
 * a street from different ends. No sampling/resolution reduction is used. */
export function prepareMeanAccessibilityModel(request: Omit<AccessibilityRequest, "origin" | "scenario" | "departureMinute">, origins: Coord[]) {
  if (!request.network.edges.length) throw new Error("Brak dróg pieszych OSM.");
  const input = { ...request, origin: request.network.coords[request.network.edges[0].from] };
  const graph = buildAccessibilityGraph(input, buildTimetable(request.lines, request.period), [], origins);
  const reduced = contract(graph, request), count = reduced.originals.length;
  const model = { count, walking: reduced.walking, transit: reduced.transit, boardings: reduced.boardings,
    geometry: { nodeCount: graph.nodeCount, originals: reduced.originals, chains: reduced.chains, trees: reduced.trees },
    starts: graph.starts.map((start) => start ? { ...start, node: reduced.compact[start.node] } : null) };
  return { graph, model };
}

export function createMeanAccessibilitySolver(model: ReturnType<typeof prepareMeanAccessibilityModel>["model"]) {
  const kernel = createMeanRoutingKernel(model.count, model.walking, model.transit, model.boardings, model.geometry);
  return {
    calculate(index: number) {
      const start = model.starts[index];
      return start ? { times: kernel.solve(start.node, start.minutes), originSnapMeters: start.distance } : null;
    },
  };
}

export function prepareMeanAccessibilityBatch(request: Omit<AccessibilityRequest, "origin" | "scenario" | "departureMinute">, origins: Coord[]) {
  const { graph, model } = prepareMeanAccessibilityModel(request, origins);
  const solver = createMeanAccessibilitySolver(model);
  return {
    graph,
    searchNodeCount: model.count,
    calculate(index: number) {
      const result = solver.calculate(index);
      if (!result) return null;
      const { times, originSnapMeters } = result;
      return { coords: graph.coords, xy: graph.xy, walkEdges: graph.walkEdges, times, project: graph.project,
        activeLines: graph.activeLines, unconnectedStops: graph.missed.size,
        stopTimes: new Map([...graph.ground].map(([id, node]) => [id, times[node]])), originSnapMeters };
    },
  };
}
