import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createOverpassHandler } from "./overpass.mjs";
import { createGeocodeHandler } from "./geocode.mjs";
import { createNetworkHandler } from "./networks.mjs";
import { createGtfsHandler } from "./gtfs.mjs";
import { noBody, queryParams, safeHandler, UUID } from "./security.mjs";

export function createAppHandler({ root = resolve("dist"), networkOptions, overpassOptions, geocodeOptions, gtfsOptions } = {}) {
  root = resolve(root);
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
  const handlers = [createGtfsHandler(gtfsOptions), createGeocodeHandler(geocodeOptions), createOverpassHandler(overpassOptions), createNetworkHandler(networkOptions)];
  const staticFiles = safeHandler(async (req, res, _next, url) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    noBody(req);
    queryParams(url, url.pathname === "/" || url.pathname === "/index.html" ? { network: (v) => UUID.test(v), write: (v) => UUID.test(v) } : {});
    const file = resolve(root, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    let info;
    try { info = await stat(file); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") { res.writeHead(404).end(); return; } throw error; }
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Content-Length": info.size,
      "Cache-Control": extname(file) === ".html" ? "no-store" : "public, max-age=3600" });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });
  return safeHandler(async (req, res) => {
    async function dispatch(index) {
      if (index === handlers.length) return staticFiles(req, res);
      return handlers[index](req, res, () => dispatch(index + 1));
    }
    return dispatch(0);
  });
}
export function createAppServer(options) {
  const server = createServer({ maxHeaderSize: 16384 }, createAppHandler(options));
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  return server;
}
