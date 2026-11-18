import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/media": "http://127.0.0.1:8787",
      "/r": "http://127.0.0.1:8787",
      "/join": "http://127.0.0.1:8787",
      "/classes": "http://127.0.0.1:8787",
      "/discover": "http://127.0.0.1:8787",
      "/notifications": "http://127.0.0.1:8787",
      "/admin": "http://127.0.0.1:8787",
      "/privacy": "http://127.0.0.1:8787",
      "/telemetry": "http://127.0.0.1:8787",
    },
  },
});
