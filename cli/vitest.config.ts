import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    // vi.stubEnv stubs are auto-restored after each test (test-hygiene gate
    // forbids direct process.env mutation; the root app wires this via setup.ts)
    unstubEnvs: true,
  },
});
