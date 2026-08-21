import { defineConfig } from "vite";

// Plain TypeScript SPA, no framework — matches the old system's
// no-framework Index.html, just with real tooling (types, a bundler,
// module boundaries) instead of one 9000-line inline <script> block.
//
// `base` is only set to the GitHub Pages project-page path
// (https://<user>.github.io/SGO/) during `vite build` — `npm run dev`
// keeps serving from `/` so the local dev server is unaffected.
export default defineConfig(({ command }) => ({
  root: ".",
  base: command === "build" ? "/SGO/" : "/",
  build: {
    outDir: "dist",
  },
}));
