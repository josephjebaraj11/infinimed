import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the dashboard runs on :5173 and proxies the dashboard API to the server, so the
// session cookie stays same-origin. In production the server serves the built app at /app.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/dashboard-api": { target: process.env.INFINIMED_API ?? "http://localhost:4000", changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
