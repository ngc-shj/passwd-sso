import { defineConfig } from "vite";
import { FILL_LISTENERS_FILE } from "./src/background/fill-listeners-file";

// Second build pass: src/content/fill-listeners.ts as one self-contained
// classic script, written into the dist/ the main build just produced. See
// fill-listeners.ts for why it cannot be a CRXJS module chunk.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    modulePreload: false,
    lib: {
      entry: "src/content/fill-listeners.ts",
      formats: ["iife"],
      name: "passwdSsoFillListeners",
      fileName: () => FILL_LISTENERS_FILE,
    },
  },
});
