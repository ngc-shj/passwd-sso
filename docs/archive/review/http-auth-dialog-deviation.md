# Coding Deviation Log: http-auth-dialog

- **D1 — `savedUrlOrigins` lives in `background/entry-origins.ts`** (not `index.ts`). `background/http-auth.ts` needs it, and importing it from `index.ts` would create an import cycle. It is also directly table-testable there.
- **D2 — `fetchAndDecryptEntry` is exported from `index.ts`** for direct tests. `initHttpAuth` receives it as a dependency.
- **D3 — the pending intent also completes at SW start** (`completePendingIntent(null)`, using `permissions.contains`). VE2 saw Chrome restart the SW right after the grant, so `onAdded` may never reach a listener.
- **D4 — the prompt GET/DECIDE failsafe responses carry `error: "INTERNAL_ERROR"`.** The sender-gate table test must tell the failsafe apart from an unknown-id answer.
- **D5 — the background suites that import `index.ts` keep their old mocks.** Every new chrome call is guarded. C6 and the wiring are covered in the new `http-auth-wiring.test.ts`.
- **D6 — `lib/http-auth-bindings.ts` imports `warnBackground`** (the sanctioned console sink), because the options page also runs `releasePermissions`.
- **D7 — `minimum_chrome_version: "120"`.** The source is MDN onAuthRequired (`asyncBlocking` "Supported from Chrome 120"). Chrome's reference names no version for `webRequestAuthProvider`.
- **D8 — `check-dist-hygiene.mjs` also fails when the built manifest's `web_accessible_resources` names the auth-prompt page.** This is stricter than the plan.
- **D9 — the copy paths keep their own fetch and decrypt (self-check R17).** The copy-command lookup and the `COPY_PASSWORD` and `COPY_TOTP` handlers decrypt the blob only. `fetchAndDecryptEntry` also decrypts the overview and fails with `INVALID_ENTRY` when that fails, so swapping it in would add a decrypt and a new failure mode to the copy paths. Moving them over is a behaviour change outside this feature's contracts. They stay as they are, and a follow-up can adopt the helper with an option to skip the overview.
- **D10 — bindings carry the vault `userId` (self-check R39, account boundary).**
  - C4 answers `{}` for another account's binding, or a binding with no account.
  - The options page labels such bindings "another account".
  - `GET_STATUS` returns `userId` to extension pages, null while locked.
  - A repeat registration short-circuits only for the same unlocked account.
- **D11 — the server URL rule is enforced at the shared sinks (self-check R43/R52).**
  - The rule: https, or http only on localhost/127.0.0.1.
  - `optional_host_permissions` gained `http://*/*`, which made a stored non-loopback http server URL grantable.
  - The rule (`lib/server-url.ts`, moved from the options page) now guards five sinks: `ensureHostPermission`, `swFetchAuthenticated`, `swFetch`, `getValidServerUrl`, and the token-bridge registration.
