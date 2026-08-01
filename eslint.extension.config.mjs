// Lint config for `extension/`, run separately from the root `eslint.config.mjs`.
//
// Why separate: the root config is built on eslint-config-next and puts
// `extension/**` in globalIgnores (eslint.config.mjs:23) — the extension is a Vite
// MV3 build, not a Next app, so the Next presets do not apply to it. That left the
// extension with NO lint at all, which is how autofill payload values reached the
// page-attributed console (SC5 from #723).
//
// Scope is narrow on purpose: this file enforces one invariant — no console outside
// the two sanctioned sinks. A fuller extension lint config is deliberately deferred
// (see docs/archive/review/autofill-console-pii-leak-plan.md, SC-B).
//
// Run via `npm run lint:extension`, which goes through
// scripts/checks/lint-extension.mjs — never invoke eslint directly here. The wrapper
// asserts that the scan was non-empty and that extension/public/ was covered;
// ESLint exits 0 silently when a `files` glob stops matching while the CLI path
// arguments still exist, so its exit code alone cannot tell "clean" from "scanned
// nothing".

import parser from "@typescript-eslint/parser";

// Every `console` spelling is banned by REFERENCE, with no exclusions. Two earlier
// designs carved out `console` in property position so `obj.console` would not be
// flagged; that same exclusion is what blinds the rule to `globalThis.console`,
// `top.console`, `(globalThis as T).console` and `const g = globalThis; g.console`.
// Verified by execution: the exclusion-free form catches all 20 known statically
// spelled bypasses and produces zero findings across the real production files
// beyond the sanctioned sinks. An identifier or string literal named `console` for
// an unrelated purpose would be flagged — none exists, and a security gate should
// not carve exceptions for cases it has not observed.
//
// Scope of the guarantee: every STATICALLY SPELLED reference. A key assembled at
// runtime (`globalThis["cons" + "ole"]`, `atob(...)`, `Reflect.get` with a computed
// key) evades both selectors, and no rule short of taint analysis would catch it.
// That is out of this gate's threat model, which is accidental re-introduction —
// an accidental `console.debug` never looks like `atob("Y29uc29sZQ==")`.
const CONSOLE_REFERENCE_SELECTORS = [
  {
    selector: "Identifier[name='console']",
    message:
      "console is banned in extension code. Use the sanctioned sink: " +
      "src/content/select-diag-lib.ts (content scripts) or src/background/log.ts " +
      "(service worker). Both take closed types so a payload cannot be passed.",
  },
  {
    selector: "Literal[value='console']",
    message:
      "String-keyed access to console (globalThis[\"console\"], Reflect.get) is " +
      "banned. Use the sanctioned sink — see src/content/select-diag-lib.ts.",
  },
];

const config = [
  {
    // Every executable extension is listed. A file whose extension is absent here
    // does NOT fail closed uniformly: .mjs/.cjs are matched by ESLint's implicit
    // default config, so they lint with an empty rule set, emit nothing, and still
    // count toward the wrapper's file floor — a console call in one would ship
    // green. (.jsx / a .ts under public/ do fail closed, via a null-ruleId warning.)
    files: [
      "extension/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "extension/public/**/*.{js,mjs,cjs}",
    ],
    ignores: ["**/__tests__/**", "**/*.test.*"],
    languageOptions: { parser },
    // Without noInlineConfig a single `// eslint-disable-next-line` zeroes this
    // gate — verified. reportUnusedDisableDirectives then makes the attempt loud
    // instead of silent.
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-console": "error",
      "no-restricted-syntax": ["error", ...CONSOLE_REFERENCE_SELECTORS],
    },
  },
  {
    // The two sanctioned sinks — this list IS the audit surface. Adding a third
    // entry is a review event by construction.
    //
    // Neither can leak: both take closed string unions and nothing else, so
    // there is no free-form slot for a caller — or a page — to widen. Passing a
    // DOM node or any page-derived string does not compile.
    //
    // BOTH rules must be off. Disabling only `no-console` leaves the
    // Identifier[name='console'] selector firing on the sinks' own reference, which
    // would make this gate red on the PR that introduces it — and the shortest path
    // to green would be the inline disable the gate exists to forbid.
    files: [
      "extension/src/content/select-diag-lib.ts",
      "extension/src/background/log.ts",
    ],
    rules: {
      "no-console": "off",
      "no-restricted-syntax": "off",
    },
  },
];

export default config;
