import { build } from "esbuild";
const worker = await build({ entryPoints: ["server/networkQuality.worker.mjs"], bundle: true,
  platform: "node", format: "cjs", target: "node22", write: false });
await build({ entryPoints: ["server/start.mjs"], outfile: "dist-server/index.mjs", bundle: true,
  define: { __TRANSPLAN_QUALITY_WORKER__: JSON.stringify(worker.outputFiles[0].text) }, external: ["esbuild"],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  platform: "node", format: "esm", target: "node22" });
