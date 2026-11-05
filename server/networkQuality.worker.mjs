import { Worker, parentPort, workerData } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";
import { calculateNetworkQualityAsync, prepareNetworkQualityModel, calculatePreparedNetworkQualityAsync, combineNetworkQualityParts } from "../src/lib/networkQuality.ts";
import { NETWORK_QUALITY_PLACES } from "../src/lib/networkQualityPlaces.ts";

async function calculate() {
  const { request, source, workers = 1, indices, model } = workerData;
  const origins = (model?.places ?? request.places ?? NETWORK_QUALITY_PLACES).reduce((n, p) => n + p.points.length, 0);
  if (workers <= 1) {
    const included = indices && new Set(indices);
    const calculate = model ? calculatePreparedNetworkQualityAsync : calculateNetworkQualityAsync;
    return calculate(model ?? request, () => setImmediate(), (completed, total) => {
      if (!included || included.has(completed - 1)) parentPort.postMessage({ kind: "progress", completed, total });
    }, indices);
  }
  const children = [];
  let completed = 0;
  try {
    // Share only prepared numeric graphs/raster. Cloning hundreds of thousands
    // of OSM objects and rebuilding their spatial index per shard costs more
    // than the searches; these arrays are immutable in every worker.
    const prepared = share(prepareNetworkQualityModel(request));
    const parts = await Promise.all(Array.from({ length: Math.min(workers, origins) }, (_, shard) => {
      const indices = Array.from({ length: origins }, (_, i) => i).filter((i) => i % workers === shard);
      return new Promise((resolve, reject) => {
        const worker = new Worker(source, { eval: true, workerData: { model: prepared, indices } });
        children.push(worker);
        let settled = false;
        worker.on("message", (message) => {
          if (message.kind === "progress") parentPort.postMessage({ kind: "progress", completed: ++completed, total: origins });
          else if (message.kind === "result") { settled = true; resolve({ indices, result: message.result }); }
          else { settled = true; reject(new Error("Quality shard failed")); }
        });
        worker.on("error", reject);
        worker.on("exit", () => { if (!settled) reject(new Error("Quality shard exited")); });
      });
    }));
    return combineNetworkQualityParts(parts);
  } finally { await Promise.all(children.map((child) => child.terminate())); }
}

function share(value) {
  if (ArrayBuffer.isView(value)) {
    const buffer = new SharedArrayBuffer(value.byteLength);
    new Uint8Array(buffer).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return new value.constructor(buffer);
  }
  if (Array.isArray(value)) return value.map(share);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, share(child)]));
  return value;
}
calculate().then((result) => parentPort.postMessage({ kind: "result", result }))
  .catch(() => parentPort.postMessage({ kind: "error" }));
