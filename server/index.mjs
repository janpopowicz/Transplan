import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createOverpassHandler } from "./overpass.mjs";
import { createGeocodeHandler } from "./geocode.mjs";
import { createNetworkHandler } from "./networks.mjs";

import { createGtfsHandler } from "./gtfs.mjs";

const root = resolve("dist");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
const networks = createNetworkHandler();
const overpass = createOverpassHandler();
const geocode = createGeocodeHandler();
const gtfs = createGtfsHandler();
const server = createServer((req, res) => {
  void gtfs(req, res, () => { void geocode(req, res, () => { void overpass(req, res, () => { void networks(req, res, async () => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
      const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
      const info = await stat(file);
      if (!info.isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Content-Length": info.size, "X-Content-Type-Options": "nosniff" });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404).end(); }
  }); }); }); });
});
server.requestTimeout = 30000;
server.listen(Number(process.env.PORT || 3000), process.env.HOST || "0.0.0.0", () => {
  console.log(`Transplan: http://localhost:${server.address().port}`);
});
