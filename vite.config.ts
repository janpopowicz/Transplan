import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createGeocodeHandler } from "./server/geocode.mjs";
import { createNetworkHandler } from "./server/networks.mjs";
import { createOverpassHandler } from "./server/overpass.mjs";

import { createGtfsHandler } from "./server/gtfs.mjs";

export default defineConfig({
  plugins: [react(), {
    name: "transplan-networks",
    configureServer(server) { server.middlewares.use(createGtfsHandler()); server.middlewares.use(createGeocodeHandler()); server.middlewares.use(createOverpassHandler()); server.middlewares.use(createNetworkHandler()); },
    configurePreviewServer(server) { server.middlewares.use(createGtfsHandler()); server.middlewares.use(createGeocodeHandler()); server.middlewares.use(createOverpassHandler()); server.middlewares.use(createNetworkHandler()); },
  }],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/valhalla": {
        target: "https://valhalla1.openstreetmap.de",
        changeOrigin: true,
        rewrite: () => "/route",
      },
    },
  },
});
