import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // fake-indexeddb is loaded globally so background SW startup
    // (hydrateFromSession → getDpopThumbprint) does not throw on
    // ReferenceError("indexedDB") in node-env tests.
    setupFiles: ["fake-indexeddb/auto"],
    environmentMatchGlobs: [
      ["**/__tests__/webauthn-bridge-lib.test.ts", "jsdom"],
      ["**/__tests__/dpop-key.test.ts", "jsdom"],
    ],
  },
});
