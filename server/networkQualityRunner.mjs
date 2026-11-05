import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import * as developmentModule from "node:module";
import { availableParallelism, freemem } from "node:os";

// Production embeds the separately bundled worker; dev compiles it once lazily.
// esbuild is only needed by the development path and the build script.
let sourcePromise;
async function workerSource() {
  if (typeof __TRANSPLAN_QUALITY_WORKER__ !== "undefined") return __TRANSPLAN_QUALITY_WORKER__;
  sourcePromise ??= Promise.resolve().then(() => {
    const { build } = developmentModule.createRequire(resolve("package.json"))("esbuild");
    return build({ entryPoints: [resolve("server/networkQuality.worker.mjs")],
      bundle: true, platform: "node", format: "cjs", target: "node22", write: false });
  })
    .then((result) => result.outputFiles[0].text).catch((error) => { sourcePromise = undefined; throw error; });
  return sourcePromise;
}

/** CPU-heavy searches run outside the HTTP event loop. The handler bounds this
 * to one job with at most four compute workers; all workers terminate on exit. */
export async function runNetworkQuality(request, _yieldBetweenOrigins, progress, options = {}) {
  const source = await workerSource();
  const automatic = request.network.coords.length >= 50000
    ? Math.max(1, Math.min(4, availableParallelism(), Math.floor(freemem() / (1536 * 1024 * 1024)))) : 1;
  const workers = options.workers ?? automatic;
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error("Invalid quality worker count");
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { request, source, workers } });
    const timer = setTimeout(() => finish(new Error("Quality calculation timed out")), 15 * 60_000);
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    }
    worker.on("message", (message) => {
      if (message.kind === "progress") progress(message.completed, message.total);
      else if (message.kind === "result") finish(null, message.result);
      else finish(new Error("Quality calculation failed"));
    });
    worker.on("error", (error) => finish(error));
    worker.on("exit", () => finish(new Error("Quality worker exited before returning a result")));
  });
}
