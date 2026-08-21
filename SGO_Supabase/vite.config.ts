import { defineConfig } from "vite";

// Plain TypeScript SPA, no framework — matches the old system's
// no-framework Index.html, just with real tooling (types, a bundler,
// module boundaries) instead of one 9000-line inline <script> block.
export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
  },
});
