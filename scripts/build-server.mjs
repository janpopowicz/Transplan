import { build } from "esbuild";
await build({ entryPoints: ["server/start.mjs"], outfile: "dist-server/index.mjs", bundle: true, banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, platform: "node", format: "esm", target: "node22" });
