import { MEAN_ROUTING_WASM } from "./meanRoutingWasm";

interface Adjacency {
  offsets: Uint32Array;
  destinations: Uint32Array;
  costs: Float64Array;
  headway?: Float64Array;
  phase?: Float64Array;
}
interface Geometry {
  nodeCount: number;
  originals: Uint32Array;
  chains: { a: Uint32Array; b: Uint32Array; length: Float64Array; flags: Uint8Array;
    offsets: Uint32Array; nodes: Uint32Array; distances: Float64Array };
  trees: { nodes: Uint32Array; parents: Uint32Array; minutes: Float64Array };
}
interface Exports {
  allocate(bytes: number): number;
  create_solver(...args: number[]): number;
  configure_geometry(...args: number[]): void;
  solve(solver: number, start: number, minutes: number): void;
  restore_geometry(solver: number): number;
}
let compiled: WebAssembly.Module | undefined;

/** The kernel imports only its own linear memory. Graph arrays are copied once
 * per batch; scratch buffers are reused between origins, including heap/events. */
export function createMeanRoutingKernel(count: number, walking: Adjacency, transit: Adjacency,
  boardings: { from: number; to: number; phase: number; headway: number }[], geometry: Geometry) {
  compiled ??= new WebAssembly.Module(Uint8Array.from(atob(MEAN_ROUTING_WASM), (c) => c.charCodeAt(0)));
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 32768 });
  const api = new WebAssembly.Instance(compiled, { env: { memory } }).exports as unknown as Exports;
  const copy = (values: Uint8Array | Uint32Array | Float64Array) => {
    const pointer = api.allocate(values.byteLength);
    new Uint8Array(memory.buffer, pointer, values.byteLength).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    return pointer;
  };
  const pointer = api.create_solver(count,
    copy(walking.offsets), copy(walking.destinations), copy(walking.costs),
    copy(transit.offsets), copy(transit.destinations), copy(transit.costs), copy(transit.headway!), copy(transit.phase!),
    boardings.length, copy(Uint32Array.from(boardings, (b) => b.from)), copy(Uint32Array.from(boardings, (b) => b.to)),
    copy(Float64Array.from(boardings, (b) => b.phase)), copy(Float64Array.from(boardings, (b) => b.headway)));
  const { chains, trees } = geometry;
  api.configure_geometry(pointer, geometry.nodeCount, copy(geometry.originals), chains.a.length,
    copy(chains.a), copy(chains.b), copy(chains.length), copy(chains.flags), copy(chains.offsets), copy(chains.nodes), copy(chains.distances),
    trees.nodes.length, copy(trees.nodes), copy(trees.parents), copy(trees.minutes));
  return {
    solve(start: number, minutes: number) {
      api.solve(pointer, start, minutes);
      const result = api.restore_geometry(pointer);
      // Copy before the next origin reuses scratch memory or grows it.
      return new Float64Array(memory.buffer, result, geometry.nodeCount).slice();
    },
  };
}
