import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Prisma compiles `{ equals: v, mode: "insensitive" }` to an unescaped ILIKE, so
// `_` / `%` in v act as wildcards (prisma-filters.ts). Shared by every block that
// sets no-restricted-syntax for src/, since a later block's options replace an
// earlier one's for the files both match.
const INSENSITIVE_EQUALS_RESTRICTION = {
  // Sibling combinators in both orders: the two keys of one object literal,
  // written as identifiers or as quoted keys. A `mode` supplied through a
  // variable or a spread is not visible to a syntax selector — that residue is
  // what the prisma-filters.ts guidance covers.
  selector: [
    ":matches(Property[key.name='equals'], Property[key.value='equals']) ~ " +
      ":matches(Property[key.name='mode'], Property[key.value='mode'])[value.value='insensitive']",
    ":matches(Property[key.name='mode'], Property[key.value='mode'])[value.value='insensitive'] ~ " +
      ":matches(Property[key.name='equals'], Property[key.value='equals'])",
  ].join(", "),
  message:
    "`equals` with mode: \"insensitive\" is an unescaped ILIKE. Use { in: [value], mode: \"insensitive\" } " +
    "for an exact case-insensitive match (see src/lib/prisma/prisma-filters.ts).",
};

// Every programmatic clipboard write of a secret — including secret-bearing
// URLs (share links with `#key=`, Send links, invite links) — goes through
// copySecretToClipboard (src/lib/clipboard/copy-secret.ts), which bounds how
// long the value stays there. A best-effort tripwire: a computed or template
// property name, Reflect.get, an alias (`const cd = e.clipboardData`) or an
// untyped navigator alias is not visible to a syntax selector; review covers
// that residue. Reading pasted text (`clipboardData.getData`) is not a write and
// is not matched.
const CLIPBOARD_MESSAGE =
  "Write to the clipboard only through copySecretToClipboard (src/lib/clipboard/copy-secret.ts), " +
  "which clears the value after a timeout.";
const CLIPBOARD_RESTRICTIONS = [
  "MemberExpression[property.name='clipboard']",
  "MemberExpression[property.value='clipboard']",
  "ObjectPattern > Property[key.name='clipboard']",
  "ObjectPattern > Property[key.value='clipboard']",
  "MemberExpression[property.name='execCommand']",
  "CallExpression[callee.object.property.name='clipboardData'][callee.property.name='setData']",
].map((selector) => ({ selector, message: CLIPBOARD_MESSAGE }));

// A toast is user-facing text, so its first argument must come from a
// translator: a string or template literal there — directly, or as an arm of a
// `?:`, `??` or `||` — ships untranslated.
const LITERAL_TYPE = "/^(Literal|TemplateLiteral)$/";
const TOAST_LITERAL_RESTRICTION = {
  selector:
    "CallExpression:matches([callee.name='toast'], [callee.object.name='toast'])" +
    ":matches(" +
    [
      `[arguments.0.type=${LITERAL_TYPE}]`,
      `[arguments.0.type='ConditionalExpression'][arguments.0.consequent.type=${LITERAL_TYPE}]`,
      `[arguments.0.type='ConditionalExpression'][arguments.0.alternate.type=${LITERAL_TYPE}]`,
      `[arguments.0.type='LogicalExpression'][arguments.0.left.type=${LITERAL_TYPE}]`,
      `[arguments.0.type='LogicalExpression'][arguments.0.right.type=${LITERAL_TYPE}]`,
    ].join(", ") +
    ")",
  message: "Toast text must be translated: pass t(\"key\"), not a string or template literal.",
};

const NON_TEST_IGNORES = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"];

// The root runtime files ship in the same bundles as src/ and get the same rules.
const ROOT_RUNTIME_FILES = [
  "proxy.ts",
  "instrumentation-client.ts",
  "sentry.client.config.ts",
  "sentry.server.config.ts",
];

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
  // no-restricted-syntax layout. A later block's options REPLACE an earlier
  // one's for every file both match, so each block below restates every set
  // that must still apply to its files:
  //   1. src/** and scripts/**, tests included: INSENSITIVE_EQUALS.
  //   2. Non-test src/** outside src/lib/clipboard/**, plus the root runtime
  //      files: INSENSITIVE_EQUALS + clipboard + toast.
  //   3. Non-test components/hooks: fetch + INSENSITIVE_EQUALS + clipboard +
  //      toast.
  // src/lib/clipboard/** is the one sanctioned writer, so it keeps block 1 only.
  // copySecretWithoutClear is restricted under no-restricted-imports — a
  // different rule key, so it does not take part in this replacement.
  // scripts/__tests__/eslint-clipboard-and-toast.test.mjs pins every set on
  // every block.
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,mts}"],
    rules: {
      "no-restricted-syntax": ["error", INSENSITIVE_EQUALS_RESTRICTION],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}", ...ROOT_RUNTIME_FILES],
    ignores: [...NON_TEST_IGNORES, "src/lib/clipboard/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        INSENSITIVE_EQUALS_RESTRICTION,
        ...CLIPBOARD_RESTRICTIONS,
        TOAST_LITERAL_RESTRICTION,
      ],
    },
  },
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
        INSENSITIVE_EQUALS_RESTRICTION,
        ...CLIPBOARD_RESTRICTIONS,
        TOAST_LITERAL_RESTRICTION,
      ],
    },
  },
  {
    // The non-clearing copy is for a value the user is told to keep. Restricted
    // by import name, so an alias (`as c`) and a namespace import are caught
    // too; the `**/` group catches relative specifiers. A dynamic import() is
    // not visible to this rule.
    files: ["src/**/*.{ts,tsx}", ...ROOT_RUNTIME_FILES],
    ignores: NON_TEST_IGNORES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/clipboard/copy-secret", "**/lib/clipboard/copy-secret"],
              importNames: ["copySecretWithoutClear"],
              message:
                "copySecretWithoutClear leaves the secret on the clipboard indefinitely. " +
                "Use copySecretToClipboard.",
            },
          ],
        },
      ],
    },
  },
  {
    // The one sanctioned non-clearing caller: the recovery key, which the user
    // is instructed to store permanently. Like the no-console sinks below, this
    // list IS the audit surface. It re-declares no no-restricted-syntax set, so
    // the clipboard and toast rules still apply to this file.
    files: ["src/components/vault/recovery-key-dialog.tsx"],
    rules: {
      "no-restricted-imports": "off",
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
    // The two sanctioned console sinks. Neither can see a secret: client.ts
    // redacts by denylist before writing; boot-stderr.ts takes a closed
    // BootDiagnostic union and renders the text itself, so a caller has no
    // free-form slot. Both exist so this exemption does NOT land on
    // src/lib/env.ts, which holds every secret in process.env.
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
