import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND_URL =
  process.env.VITE_API_URL || "https://kspdb-backend-hs6a.onrender.com";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
      "/socket.io": {
        target: BACKEND_URL,
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    allowedHosts: true,
    proxy: {
      "/api": {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
      "/socket.io": {
        target: BACKEND_URL,
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
