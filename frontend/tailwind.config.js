/** @type {import('tailwindcss').Config} */
// Tailwind maps to the CSS-variable token layer (src/index.css). Components
// reference semantic names (bg, surface, ink, ct, t, live) — never raw hex — so
// the palette lives in exactly one place.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        raised: "var(--raised)",
        grid: "var(--grid)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        ct: "var(--ct)",
        t: "var(--t)",
        live: "var(--live)",
      },
      fontFamily: {
        display: ["Chakra Petch", "system-ui", "sans-serif"],
        body: ["Inter", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      fontVariantNumeric: ["tabular-nums"],
    },
  },
  plugins: [],
};
