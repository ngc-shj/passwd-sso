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
    // Throwaway git-ignored worktree copies (Claude Code agent worktrees) that
    // duplicate the whole repo, incl. node_modules/require-based files. They are
    // not project source for the root config to lint — without this, local
    // `eslint .` reports thousands of errors from .claude/worktrees that CI
    // (fresh checkout, no .claude) never sees.
    ".claude/**",
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
  {
    // Keep diagnostics out of raw console calls in production source.
    //
    // Only `no-console` is added here — `@typescript-eslint/no-explicit-any` is
    // ALREADY error repo-wide via eslint-config-next/typescript, and
    // re-declaring it under a test-excluding block would invite a future
    // "simplification" that quietly drops enforcement for test code.
    //
    // Client code routes through `@/lib/logger/client` (which redacts by key
    // name); server code through `@/lib/logger` (pino). The two overrides below
    // are the only sanctioned raw sinks, and that list IS the audit surface —
    // adding a third requires editing this file, which is visible in review.
    // Note the ignore list deliberately does NOT contain `src/**/e2e/**`: in
    // this repo "E2E" also means end-to-end *encryption* (see
    // components/share/share-e2e-entry-view.tsx), so a future `src/lib/e2e/`
    // would be production crypto code silently exempted. Playwright specs live
    // in the repo-root `e2e/` directory, outside this glob entirely.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // The client logger redacts `fields` by key name but emits `message`
    // verbatim, so an interpolated message routes a value around the denylist.
    // Keep variable data in `fields` — enforced, not just documented.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^clientLog(Warn|Error)$/] > TemplateLiteral:first-child[expressions.length>0]",
          message:
            "clientLogWarn/clientLogError take a CONSTANT message; only `fields` is redacted. " +
            "Move interpolated values into the second argument.",
        },
      ],
    },
  },
  {
    // The two sanctioned console sinks. Neither can see a secret: client.ts
    // redacts by denylist before writing; boot-stderr.ts takes a plain string
    // and exists so this exemption does NOT land on src/lib/env.ts, which holds
    // every secret in process.env.
    files: ["src/lib/logger/client.ts", "src/lib/boot-stderr.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Route handlers have varying signatures; TypeScript's contravariant
    // parameter positions make a non-any constraint impossible here (verified:
    // `readonly unknown[]` yields TS2345). See the explanatory comment in the
    // file. A file-scoped override rather than an inline disable, so the
    // exception stays on the reviewable audit surface.
    files: ["src/lib/http/with-request-log.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
