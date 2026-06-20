import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT for GitHub Pages project sites (e.g. surferyogi.github.io/connex):
// `base` must be "/<repo-name>/". Change "connex" below if your repo differs.
// For a user/root site or local preview, set base to "/".
export default defineConfig({
  base: "/connex/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
});
