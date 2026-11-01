import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createGeocodeHandler } from "./server/geocode.mjs";
import { createNetworkHandler } from "./server/networks.mjs";
import { createOverpassHandler } from "./server/overpass.mjs";

import { securityHeaders } from "./server/security.mjs";
import { createGtfsHandler } from "./server/gtfs.mjs";
const devHeaders = { ...securityHeaders, "Content-Security-Policy": securityHeaders["Content-Security-Policy"]
  .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws:") };

export default defineConfig({
  plugins: [react(), {
    name: "transplan-networks",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => { for (const [key, value] of Object.entries(devHeaders)) res.setHeader(key, value); next(); });
      server.middlewares.use(createGtfsHandler()); server.middlewares.use(createGeocodeHandler()); server.middlewares.use(createOverpassHandler()); server.middlewares.use(createNetworkHandler());
    },
    configurePreviewServer(server) { server.middlewares.use(createGtfsHandler()); server.middlewares.use(createGeocodeHandler()); server.middlewares.use(createOverpassHandler()); server.middlewares.use(createNetworkHandler()); },
  }],
  preview: { host: "127.0.0.1", headers: securityHeaders },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: devHeaders,
  },
});
