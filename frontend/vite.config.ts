import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Offline viewer served on all interfaces so it can be previewed in this
// environment. No backend in Phase 2 — the app loads a parsed out.json.
// base: "/" for local dev/preview; the Pages build sets VITE_BASE="/2D/" so
// assets resolve under https://<user>.github.io/2D/. All in-app asset fetches
// go through import.meta.env.BASE_URL, so they follow this automatically.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
