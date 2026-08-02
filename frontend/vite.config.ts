import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Offline viewer served on all interfaces so it can be previewed in this
// environment. No backend in Phase 2 — the app loads a parsed out.json.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
