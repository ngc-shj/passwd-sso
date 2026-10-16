# Coding Deviation Log: http-auth-dialog

- **D1 — `savedUrlOrigins` lives in `background/entry-origins.ts`** (not `index.ts`). `background/http-auth.ts` needs it, and importing it from `index.ts` would create an import cycle. It is also directly table-testable there.
- **D2 — `fetchAndDecryptEntry` is exported from `index.ts`** for direct tests. `initHttpAuth` receives it as a dependency.
- **D3 — the pending intent also completes at SW start** (`completePendingIntent(null)`, using `permissions.contains`). VE2 saw Chrome restart the SW right after the grant, so `onAdded` may never reach a listener.
- **D4 — the prompt GET/DECIDE failsafe responses carry `error: "INTERNAL_ERROR"`.** The sender-gate table test must tell the failsafe apart from an unknown-id answer.
- **D5 — the background suites that import `index.ts` keep their old mocks.** Every new chrome call is guarded. C6 and the wiring are covered in the new `http-auth-wiring.test.ts`.
- **D6 — `lib/http-auth-bindings.ts` imports `warnBackground`** (the sanctioned console sink), because the options page also runs `releasePermissions`.
- **D7 — `minimum_chrome_version: "120"`.** The source is MDN onAuthRequired (`asyncBlocking` "Supported from Chrome 120"). Chrome's reference names no version for `webRequestAuthProvider`.
- **D8 — `check-dist-hygiene.mjs` also fails when the built manifest's `web_accessible_resources` names the auth-prompt page.** This is stricter than the plan.
