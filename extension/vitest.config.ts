import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // fake-indexeddb is loaded globally so background SW startup
    // (hydrateFromSession → getDpopThumbprint) does not throw on
    // ReferenceError("indexedDB") in node-env tests.
    // layout-stub gives jsdom files a stand-in layout (rects, client sizes,
    // checkVisibility); it is a no-op where Element is undefined.
    setupFiles: ["fake-indexeddb/auto", "./src/__tests__/helpers/layout-stub.ts"],
    // Standing order-independence gate (issue #784): every run — dev, pre-pr,
    // CI — samples a fresh random permutation of file and in-file order. On
    // failure the seed line ("Running tests with seed ...") reproduces it via
    // `npx vitest run --sequence.shuffle --sequence.seed=N`.
    sequence: { shuffle: true },
    environmentMatchGlobs: [
      ["**/__tests__/webauthn-bridge-lib.test.ts", "jsdom"],
      ["**/__tests__/dpop-key.test.ts", "jsdom"],
    ],
  },
});
