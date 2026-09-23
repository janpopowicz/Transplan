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
        target: "https://overpass.openstreetmap.fr",
        changeOrigin: true,
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
