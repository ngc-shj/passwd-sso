import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Vite emits modulepreload links with `crossorigin`, which under
    // chrome-extension:// lands the preload fetch in a different request world
    // than the module graph's own. Chrome then never matches the two, so every
    // preloaded chunk is fetched twice and reported as an unused preload.
    // The chunks still load through the module graph; only the links go away.
    modulePreload: false,
  },
});
