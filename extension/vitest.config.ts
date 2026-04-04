import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    environmentMatchGlobs: [
      ["**/__tests__/webauthn-bridge-lib.test.ts", "jsdom"],
    ],
  },
});
