/** Keep the graph and an in-flight download alive when the analysis panel closes. */
let worker: Worker | undefined;
let requestId = 0;
export function getIsochroneWorker(): Worker {
  return worker ??= new Worker(new URL("./isochrones.worker.ts", import.meta.url), { type: "module" });
}
export function nextIsochroneRequestId() { return ++requestId; }
export function resetIsochroneWorker() {
  worker?.terminate();
  worker = undefined;
}
