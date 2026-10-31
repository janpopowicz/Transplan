import { build } from "esbuild";
await build({ entryPoints: ["server/index.mjs"], outfile: "dist-server/index.mjs", bundle: true, platform: "node", format: "esm", target: "node22" });
