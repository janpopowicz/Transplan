import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/overpass": {
        target: "https://overpass.kumi.systems",
        changeOrigin: true,
        headers: { "User-Agent": "Transplan/1.0 (local public transport planner; OpenStreetMap pedestrian routing)" },
        rewrite: () => "/api/interpreter",
      },
      "/valhalla": {
        target: "https://valhalla1.openstreetmap.de",
        changeOrigin: true,
        rewrite: () => "/route",
      },
    },
  },
});
