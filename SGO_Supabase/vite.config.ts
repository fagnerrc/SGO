import { defineConfig } from "vite";

// Plain TypeScript SPA, no framework — matches the old system's
// no-framework Index.html, just with real tooling (types, a bundler,
// module boundaries) instead of one 9000-line inline <script> block.
//
// This app is deployed two places, which need different `base` paths:
// Vercel (https://grupo-quintao-sgo.vercel.app/, served from the domain
// root — base `/`) and GitHub Pages (https://fagnerrc.github.io/SGO/, a
// project-page path — base `/SGO/`). Neither platform's build environment
// variable is reliable to detect generically, so the GitHub Actions
// workflow sets VITE_BASE_PATH=/SGO/ explicitly; Vercel doesn't set it, so
// it falls back to `/`, which is already correct for it. `npm run dev`
// always serves from `/` regardless.
export default defineConfig(({ command }) => ({
  root: ".",
  base: command === "build" ? (process.env.VITE_BASE_PATH ?? "/") : "/",
  build: {
    outDir: "dist",
  },
}));
