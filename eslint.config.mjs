import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "next-env.d.ts",
    "coverage/**",
    "extension/**",
    "load-test/**",
  ]),
  {
    // Prevent plain fetch() in client-side code — use fetchApi() instead.
    files: ["src/components/**/*.{ts,tsx}", "src/hooks/**/*.{ts,tsx}"],
    ignores: ["**/*.test.*", "**/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "Use fetchApi() from @/lib/url-helpers instead of plain fetch(). " +
            "fetchApi() automatically prepends NEXT_PUBLIC_BASE_PATH.",
        },
        {
          selector:
            "CallExpression[callee.object.name='window'][callee.property.name='fetch']",
          message:
            "Use fetchApi() from @/lib/url-helpers instead of window.fetch(). " +
            "fetchApi() automatically prepends NEXT_PUBLIC_BASE_PATH.",
        },
        {
          selector: "AssignmentPattern > Identifier.right[name='fetch']",
          message:
            "Do not use plain fetch as a default parameter. " +
            "Use fetchApi from @/lib/url-helpers instead.",
        },
      ],
    },
  },
  {
    // Forbid conditional assertion skip in E2E tests.
    // Wrapping expect() in if-blocks silently skips assertions.
    files: ["e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "IfStatement > BlockStatement > ExpressionStatement > CallExpression[callee.object.name='expect']",
          message:
            "Do not wrap expect() in conditionals — this silently skips assertions. " +
            "Assert unconditionally or use Playwright's built-in waiting/retry.",
        },
        {
          selector:
            "IfStatement > ExpressionStatement > CallExpression[callee.object.name='expect']",
          message:
            "Do not wrap expect() in conditionals — this silently skips assertions. " +
            "Assert unconditionally or use Playwright's built-in waiting/retry.",
        },
      ],
    },
  },
]);

export default eslintConfig;
