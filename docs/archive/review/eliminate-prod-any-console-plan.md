# Plan: eliminate-prod-any-console

Eliminate every `any` and `console.*` from production source under `src/`, then
lock the result behind ESLint so the count cannot regress.

## Project context

- **Type**: web app (Next.js 16 App Router) + workers, part of a multi-client
  security product (web / extension / iOS / CLI).
- **Test infrastructure**: unit + integration (vitest) + E2E (Playwright) + CI/CD
  (7 GitHub Actions workflows, 66 bespoke security gates, `scripts/pre-pr.sh`).
- **Verification environment constraints**:
  - `VC1` — WebAuthn ceremonies (`navigator.credentials.create/get`) cannot run
    in unit tests or headless CI; they need a real authenticator or a virtual
    authenticator (CDP). Classification for the WebAuthn contracts below:
    type-level changes are `verifiable-CI` (tsc + existing mocked unit tests);
    runtime ceremony behavior is `blocked-deferred` — but see the Anti-Deferral
    note under C2, since this change is type-only and emits identical JS.
  - `VC2` — `ImageCapture` / `getDisplayMedia` require a real browser with screen
    capture permission. `verifiable-CI` at type level only; runtime is
    `blocked-deferred` (pre-existing condition, unchanged by this work).
  - `VC3` — `src/lib/env.ts` runs during module initialization before the pino
    logger exists. Its behavior is observable only via process boot, covered by
    existing env tests. `verifiable-CI`.

## Objective

Reduce production-code `any` under `src/` from **22 to 1** — the single remaining
one being `with-request-log.ts`'s `RouteHandler`, which is provably impossible to
retype (see `SC3`) and becomes a *documented, config-scoped* exception rather
than an invisible inline suppression. Reduce production `console.*` under `src/`
from 13 to 0 (3 relocated into two audited sink modules). Make both counts
machine-enforced by ESLint rather than by review attention.

**Count provenance** — the honest number moved twice during planning and the
history matters, because two of the three counts a naive reader would trust were
wrong:

| Source | `any` | Why it was wrong |
|--------|------:|------------------|
| The assessment this work came from | ~1,119 | naive substring grep; counted the English word "any" and words containing it |
| First measurement here | 24 | included 3-4 comment-prose "any" |
| First plan draft | 21 | missed both SCIM `Record<string, any>` sites |
| **Verified** | **22** | `git grep` over `src` excluding tests, then excluding comment lines, then checked file-by-file |

Do not restate the objective as "zero `any`". It is 22 → 1, and the 1 is named.

Non-goal: reducing the counts in test code (82 `any`). Test mocks legitimately
use `any` and rewriting them would lower test readability without lowering risk.

Non-goal: reducing the counts in test code (82 `any`). Test mocks legitimately
use `any` and rewriting them would lower test readability without lowering risk.

## Requirements

### Functional

- No behavior change. Every edit is type-level or swaps a `console.*` call for a
  logger call that writes the same information to the same stream class.
- The client logger must work in the browser bundle, so it must not import
  `pino`, `node:async_hooks`, or any other `node:*` module, directly or
  transitively.
- The client logger must not degrade the existing server-side structured logging:
  server modules keep using `@/lib/logger` (pino).

### Non-functional

- `npx tsc --noEmit` clean, `npx next build` succeeds, `npx vitest run` green.
- ESLint gains two rules scoped to production `src/`, both at `error`.
- No new **inline** `eslint-disable` comments. File-level overrides in
  `eslint.config.mjs` are permitted only for the two sites documented in C4/`SC1`
  (`src/lib/logger/client.ts`, `src/lib/env.ts`); the override list is reviewable
  in one place, an inline disable is not. Existing inline disables are removed
  wherever the underlying `any` is removed.

## Technical approach

### Key finding that shapes the design

TypeScript 5.9's `lib.dom.d.ts` defines **most** of the WebAuthn extension types
this codebase casts around:

- `AuthenticationExtensionsPRFInputs` / `PRFOutputs` / `PRFValues`
- `AuthenticationExtensionsLargeBlobInputs` / `LargeBlobOutputs`
- `CredentialPropertiesOutput` (`credProps`)
- `interface ImageCapture`

**Two exceptions that invalidate a naive "delete the cast" approach.** An earlier
draft of this plan asserted lib.dom covered everything; security review refuted
it and the corrections below are load-bearing:

1. **`minPinLength` is NOT on the output side.** `AuthenticationExtensionsClient`
   `Inputs` has `minPinLength?: boolean` (a request flag), but
   `AuthenticationExtensionsClientOutputs` has only
   `{ appid, credProps, hmacCreateSecret, largeBlob, prf }` — **no `minPinLength`**.
   Verified by reading `lib.dom.d.ts`. `register/verify/route.ts:176` reads
   `clientExtensionResults.minPinLength`, a CTAP2 authenticator output absent from
   both lib.dom's Outputs type and SimpleWebAuthn's `RegistrationResponseJSON`.
   Typing that read against either library type does not compile. It must be read
   off an `unknown`-valued field and narrowed — which is what the existing runtime
   guard already does correctly.
2. **PRF salts cross this wire as hex strings, not `BufferSource`.** Proven by
   `webauthn-client.test.ts:145-167`, which sends
   `extensions.prf.eval.first = "a".repeat(64)`.
   `AuthenticationExtensionsClientInputs` types `first` as `BufferSource`, so the
   DOM type is the **wrong** type for the wire. The hex→ArrayBuffer conversion at
   `webauthn-client.ts:361-375` is precisely the boundary between the two, and the
   wire type must model the hex side.

3. **`@simplewebauthn/server` ships its OWN, narrower DOM declarations.** The
   server files do not see lib.dom's versions at all. From
   `node_modules/@simplewebauthn/server/esm/types/dom.d.ts`:

   ```ts
   export interface AuthenticationExtensionsClientInputs {
     appid?: string; credProps?: boolean; hmacCreateSecret?: boolean; minPinLength?: boolean;
   }                                     // no largeBlob, no prf
   export interface AuthenticationExtensionsClientOutputs {
     appid?: boolean; credProps?: CredentialPropertiesOutput; hmacCreateSecret?: boolean;
   }                                     // no minPinLength, no largeBlob, no prf
   ```

   `RegistrationResponseJSON.clientExtensionResults` is typed with *that*
   interface. Review compiled the plan's original proposals against the real
   dependency and got:

   ```
   TS2339: Property 'minPinLength' does not exist on type 'AuthenticationExtensionsClientOutputs'.
   TS2339: Property 'largeBlob' does not exist on type 'AuthenticationExtensionsClientOutputs'.
   TS2353: 'largeBlob' does not exist in type 'AuthenticationExtensionsClientInputs'.
   ```

   So `webauthn-server.ts:141` needs a **named cast to the library's own
   `AuthenticationExtensionsClientInputs`** (or an intersection adding
   `largeBlob`) — not `any`, but not a bare deletion either. This is a certainty,
   not a contingency.

So the rule is narrower than "the DOM types cover it". Three distinct type
worlds are in play and must not be conflated:

| World | Applies to | Example |
|-------|-----------|---------|
| lib.dom | values the **browser** produced, client-side | `credential.getClientExtensionResults()` in `webauthn-client.ts` |
| `@simplewebauthn/server`'s dom.d.ts | arguments to library functions, server-side | `verifyRegistration(response)`, `generateRegistrationOptions({extensions})` |
| repo-local wire types | JSON that **arrived over the network** | `optionsJSON`, `response.clientExtensionResults` reads in the verify route |

The third world is where every remaining runtime guard lives, because the JSON
came from a client that can lie. F1/F2 below guard against collapsing it into
either of the first two.

The `any` casts are therefore partly residue from an older DOM-lib generation and
partly a genuine wire/DOM boundary that was never modeled. This means:

- **No hand-written `.d.ts` augmentation is needed for PRF, largeBlob, credProps,
  minPinLength, or ImageCapture.** Writing one would shadow the real DOM types
  and is now the *wrong* fix.
- The correct fix is to delete the cast and let the existing DOM type apply,
  adding narrowing only where the value genuinely arrives as untyped JSON.

Two distinct situations remain and must not be conflated:

1. **Browser-API values** — already typed by lib.dom. Delete the cast.
2. **Wire-format JSON** (server → client options, client → server response) —
   genuinely `unknown` at the boundary. These need real narrowing, not a cast.
   `startPasskeyRegistration(optionsJSON: Record<string, unknown>)` receives
   parsed JSON; `toCreationOptions(json: any)` then reads fields off it. The fix
   is a typed wire-shape (`PublicKeyCredentialCreationOptionsJSON`-like local
   type) plus explicit field reads, so a malformed server payload fails at a
   named boundary instead of propagating `any`.

### C-list overview

Contracts are grouped by the mechanism that removes the `any`/`console`, because
the risk profile differs sharply between groups.

## Contracts

### C1 — Client-safe logger module

**Signature** (`src/lib/logger/client.ts`, new file):

```ts
export type ClientLogFields = Record<string, string | number | boolean | null>;

export function clientLogWarn(message: string, fields?: ClientLogFields): void;
export function clientLogError(message: string, fields?: ClientLogFields): void;
```

**Design**:

- Zero imports from `node:*`, `pino`, or `@/lib/logger`. Verified by a forbidden
  -pattern grep (below) and by the fact that the module is imported from client
  components.
- Internally calls `console.warn` / `console.error` exactly once each. This is
  the *only* place in `src/` where `console.*` survives, and it carries a single
  file-scoped `eslint-disable` with a reason comment — the sink has to exist
  somewhere, and concentrating it in one audited file is the point of the change.
- `fields` is a flat scalar record, NOT `unknown`. This makes "someone logs an
  entire response object" a compile error. But shape is only half the problem —
  see the denylist below.
- **Key-name denylist (required, not optional).** The flat-scalar type does NOT
  stop `clientLogWarn("x", { token: extensionToken })` — a string is a scalar.
  The server logger (`src/lib/logger.ts:21-42`) redacts 16 key names; the client
  logger MUST do the same, censoring to `"[REDACTED]"`. Because `ClientLogFields`
  is flat, this is a single `Object.entries` pass — no traversal.

  The client list is a **superset** of the server's, because a browser console is
  a lower-trust sink than stdout: any extension with `debugger` permission can
  read it, and this app allowlists Sentry (`csp-builder.ts:29`), so client console
  output plausibly leaves the machine. Add `email`, `userId`, `sessionToken`,
  `credentialId` on top of the server's 16.

  **Single source of truth**: server and client redaction lists must derive from
  one shared constant. Two hand-maintained copies of one redaction policy is the
  `feedback_effective_default_distributed_contract` shape — they will drift.
- No log-level filtering *inside the logger*: `warn`/`error` only, always emitted.
  **This does not license removing caller-side gates** — see the C1 walkthrough
  for `use-password-entry-detail.ts`, which keeps its `NODE_ENV` guard.

**Invariants**:

- `I1` (app-enforced): the only modules under `src/` containing a `console.*`
  call are `src/lib/logger/client.ts` (the audited sink, C1) and `src/lib/env.ts`
  (pre-logger boot banner, `SC1`). Enforced by ESLint `no-console: error` over
  `src/**` with exactly these two file overrides — the override list IS the
  audit surface, so adding a third requires editing the config and is visible
  in review. Any other `console.*` is a lint error.
- `I2` (app-enforced): `src/lib/logger/client.ts` imports nothing from `node:*`
  or `pino`. Enforced by forbidden-pattern grep and by `next build` succeeding
  with the module reachable from client components.
- `I3` (type-enforced): callers cannot pass non-scalar values in `fields`.
  Enforced by the `ClientLogFields` type.

**Member-set derivation for I1 (R42)**:

Defining primitive — a `console.<method>` call expression in production `src/`:

```bash
git grep -nE 'console\.(log|warn|error|debug|info|trace|table|dir|group|time)' -- 'src' \
  | grep -vE '(\.test\.|\.spec\.|__tests__)'
```

Set A (13 members, measured 2026-07-27):

| # | File | Line | Runtime | Replacement |
|---|------|------|---------|-------------|
| 1 | `src/app/api/passwords/[id]/attachments/route.ts` | 218 | server | `getLogger().warn` |
| 2 | `src/components/settings/security/passkey-credentials-card.tsx` | 256 | client | `clientLogError` |
| 3 | `src/components/team/security/team-rotate-key-button.tsx` | 282 | client | `clientLogError` |
| 4 | `src/hooks/vault/use-password-entry-detail.ts` | 76 | client | `clientLogError` — **keep the `NODE_ENV` guard at L75** |
| 5 | `src/i18n/pick-messages.ts` | 16 | both | see C4 |
| 6 | `src/lib/env.ts` | 44 | server (pre-logger) | move to `boot-stderr.ts` — see C4/`SC1` |
| 7 | `src/lib/key-provider/base-cloud-provider.ts` | 162 | server | `getLogger().warn` |
| 8 | `src/lib/proxy/auth-gate.ts` | 139 | server (Node — see note) | `getLogger().warn` |
| 9 | `src/lib/security/csp-builder.ts` | 37 | both | see C4 |
| 10 | `src/lib/team/team-vault-core.tsx` | 251 | client | `clientLogWarn` |
| 11 | `src/lib/team/team-vault-core.tsx` | 268 | client | `clientLogWarn` |
| 12 | `src/lib/team/team-vault-core.tsx` | 323 | client | `clientLogError` |
| 13 | `src/lib/url-helpers.ts` | 52 | both | see C4 |

**Note on member 8 (`auth-gate.ts:139`)** — runtime and severity both matter here:

- *Runtime*: the module declares no `export const runtime`, and it imports
  `resolveUserTenantId` (Prisma) transitively, so it executes on the Node
  runtime, not Edge. `getLogger()` (pino) is therefore safe. Confirmed by
  reading the import graph, not assumed — pre-screening flagged Edge-runtime
  `console` stripping as a risk and this is the check that closes it.
- *Severity*: this call fires exactly when the session response is missing
  passkey fields and the code substitutes a **fail-closed** bundle
  (`requirePasskey: true, hasPasskey: false`). It is the only signal that a
  fail-closed substitution happened. Losing it would make a security-relevant
  degradation silent. The replacement MUST preserve both the message and the
  `missing` field list, and MUST NOT be throttled or level-demoted.

Indirect members the symbol grep misses, checked explicitly:
- aliased console (`const c = console`) — grep `= console\b` → 0 hits.
- `globalThis.console` / `window.console` — grep → 0 hits in `src/`.
- Test-only `console` in `src/**/__tests__` — deliberately out of set A.

**Forbidden patterns**:

- `pattern: from "pino"` in `src/lib/logger/client.ts` — reason: pulls
  `node:async_hooks` into the browser bundle.
- `pattern: node:` in `src/lib/logger/client.ts` — reason: same.
- `pattern: fields\?: unknown` in `src/lib/logger/client.ts` — reason: defeats I3.

**Acceptance criteria**:

- `git grep -c 'console\.' src/lib/logger/client.ts` returns 2 (one warn, one error).
- Set A above is reduced to exactly the entries C4 declares as KEEP.
- `next build` succeeds with `clientLogError` imported from a client component.

**Consumer-flow walkthrough** (C1 defines a module API consumed elsewhere):

- Consumer `passkey-credentials-card.tsx` (path:
  `src/components/settings/security/passkey-credentials-card.tsx:256`) calls
  `clientLogError("[WebAuthn] Registration failed", { error: <message string> })`
  and uses nothing from the return value (void). It currently passes the raw
  `err` object to `console.error`; the new signature forces it to extract
  `err instanceof Error ? err.message : "unknown"` first — this is the intended
  tightening, since `err` from a WebAuthn ceremony can carry a `DOMException`
  whose fields are UA-specific.
- Consumer `team-rotate-key-button.tsx` (path:
  `src/components/team/security/team-rotate-key-button.tsx:282`) already narrows
  to `e instanceof Error ? e.message : "unknown error"` — reads the same shape,
  no change to its narrowing needed.
- Consumer `use-password-entry-detail.ts` (path:
  `src/hooks/vault/use-password-entry-detail.ts:76`) passes a `wrapped` error
  object, reduced to `{ message }` scalars per I3.

  **The `process.env.NODE_ENV === "development"` guard at line 75 MUST be
  preserved verbatim around the new call.** This is the only one of the 13
  members that is production-suppressed today. Dropping it would move a
  vault-entry-detail decrypt error from dev-only into the production browser
  console — the highest-sensitivity path in the set. Required-pattern:
  `NODE_ENV === "development"` must still appear in this file after the change.
- Consumer `team-vault-core.tsx` — **the three sites are NOT uniform**; an
  earlier draft characterized all three as flat-scalar object calls, which is
  wrong for `:323`:
  - `:251` — `console.warn("[getTeamEncryptionKey] member-key request failed",
    { teamId, status, error })`. Flat scalars → satisfies I3 directly.
  - `:268` — same shape, version-mismatch fields. Satisfies I3.
  - `:323` — **a single interpolated template string, no second argument**:
    `` console.error(`[getTeamEncryptionKey] failed teamId=${teamId} stage=${stage} error=${errorText}`) ``.
    It does not fit `(message, fields)` as-is. Decompose it into
    `clientLogError("[getTeamEncryptionKey] failed", { teamId, stage, error: errorText })`.

    This changes the string the existing test asserts on
    (`expect.stringContaining("stage=parse_member_key")` at
    `team-vault-core.test.tsx:335`). The test must move to asserting the
    **fields** — `objectContaining({ stage: "parse_member_key" })` — which is a
    strictly stronger assertion than substring-matching an interpolated string.
    Pre-authorized edit; degrading it to bare `toHaveBeenCalled()` is forbidden.

### C2 — WebAuthn client: replace `any` with DOM types + typed wire shapes

**Files**: `src/lib/auth/webauthn/webauthn-client.ts` (12 sites),
`src/lib/auth/webauthn/webauthn-server.ts` (1 site).

**Signatures**:

```ts
// PRF salts cross the wire as HEX STRINGS. This is deliberately NOT
// AuthenticationExtensionsPRFInputs (which types `first` as BufferSource) —
// see "Key finding" exception 2. Proven by webauthn-client.test.ts:145-167.
type PrfInputsWire = {
  eval?: { first: string; second?: string };
  evalByCredential?: Record<string, { first: string; second?: string }>;
};
type ExtensionsWire = { prf?: PrfInputsWire; [k: string]: unknown };

// Wire shape received from the server (parsed JSON, not browser types).
type CreationOptionsWire = {
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: { id: string; type: string; transports?: string[] }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: ExtensionsWire;
};

type RequestOptionsWire = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: { id: string; type: string; transports?: string[] }[];
  userVerification?: UserVerificationRequirement;
  extensions?: ExtensionsWire;
};

function toCreationOptions(json: CreationOptionsWire): PublicKeyCredentialCreationOptions;
function toRequestOptions(json: RequestOptionsWire): PublicKeyCredentialRequestOptions;
```

**Boundary rule**: `toCreationOptions` / `toRequestOptions` convert hex → ArrayBuffer
at exactly one place (the existing lines 361-375). Everything upstream of that
conversion is `*Wire` (hex strings); everything downstream is DOM types
(`BufferSource`). No type may straddle both.

- `startPasskeyRegistration` / `startPasskeyAuthentication` keep their public
  `Record<string, unknown>` parameter (callers pass parsed JSON), and narrow to
  the wire type at the top of the function via an explicit `asCreationOptionsWire`
  / `asRequestOptionsWire` type-guard-ish reader that throws a named error on a
  missing required field. This is the R-rule-compliant replacement for
  `json: any`: `unknown` narrowed explicitly, not cast.
- `(publicKeyOptions as any).extensions = …` → plain assignment; `extensions` is
  already `AuthenticationExtensionsClientInputs | undefined` on the DOM type.
- `credential.getClientExtensionResults() as any` → returns
  `AuthenticationExtensionsClientOutputs`; read `.prf?.results?.first`, which is
  `BufferSource | undefined`. `new Uint8Array(prfResults.first as ArrayBuffer)`
  becomes a `BufferSource` narrowing (`ArrayBuffer` vs `ArrayBufferView`) — this
  is a real distinction the old cast hid.
- `(optionsJSON as any).extensions?.prf` → read from the narrowed wire type.
- `extensions: any = { ...publicKeyOptions.extensions }` →
  `AuthenticationExtensionsClientInputs`.
- `webauthn-server.ts:141` `} as any` on the extensions object literal →
  the object is `{ credProps, minPinLength, largeBlob }`, all present on
  `AuthenticationExtensionsClientInputs`. Verify against the
  `@simplewebauthn/server` `GenerateRegistrationOptionsOpts` extension field type;
  if that library's type is narrower than lib.dom, keep a *narrow* named cast to
  the library's own exported type rather than `any`.

**Invariants**:

- `I4` (behavior): **enumerated**, not a blanket "emitted JS unchanged" claim —
  the blanket form was false in an earlier draft and would have made the
  "existing tests pass" oracle unsound wherever it was violated. The complete
  list of runtime-behavior changes in C2/C3:

  | # | Site | Change | Test obligation |
  |---|------|--------|-----------------|
  | 1 | wire readers in `webauthn-client.ts` | new call frames + a named throw on missing required fields | RT8 table (see Testing strategy) |
  | 2 | `qr-capture-dialog.tsx:113` | new `"ImageCapture" in window` feature detect | new test stubbing `window` without `ImageCapture` |
  | 3 | PRF `first` read (`:319`, `:425`) | **none if the `as ArrayBuffer` cast is retained** — preferred | none; if a narrowing is introduced instead, the two-variant mock is mandatory |

  Every other C2/C3 edit is a pure cast erasure with byte-identical emit.
  Anywhere this table is empty, "existing tests pass unchanged" is a valid
  oracle; anywhere it has a row, a new test is owed.
- `I5` (security): the PRF salt path continues to hex-decode the *server-supplied*
  salt and never derives it client-side. Removing the casts must not change which
  of the three PRF channels wins (server `extensions.prf` > `evalByCredential` >
  `prfSalt`).

  **Concretely**: for the exact payload in `webauthn-client.test.ts:145-167`,
  `serverPrfExt` MUST remain `!== undefined`. If it becomes `undefined`, control
  falls to the `else if (prfSalt || evalByCredential)` branch at line 376 and a
  **client-constructed salt silently replaces the server-bound one** — changing
  the HKDF input at `derivePrfWrappingKey`, hence the vault secret-key wrapping
  key. That is a security downgrade, not a test failure.

  **Red-proof for I5**: `webauthn-client.test.ts` "(C8 case 1) passes server-built
  extensions.prf through verbatim" is the designated guard. It asserts the decoded
  salt round-trips to `SERVER_V1_SALT`. If that test goes red during C2, **the
  type is wrong, not the test** — do not edit it. See the C5 note on this.

**Forbidden patterns**:

- `pattern: as any` in `src/lib/auth/webauthn/*.ts` — reason: the whole point.
- `pattern: declare global` in any new file — reason: lib.dom already defines
  these; augmenting would shadow the real types and silently diverge.

**Acceptance criteria**:

- `git grep -c 'any' src/lib/auth/webauthn/webauthn-client.ts` → 0 type-`any`.
- All existing webauthn unit tests pass unchanged (no test edits permitted in
  this contract — a test edit means behavior changed).
- PRF channel-priority tests still green.

**Anti-Deferral for VC1**: the ceremony itself is `blocked-deferred` in CI, but
because C2 is type-only and asserts `I4` (identical emitted JS), the residual
risk is the wire-shape reader's new throw path. That path IS unit-testable
without an authenticator (feed a malformed options object) and is covered in C5.
Cost of full runtime verification: a CDP virtual-authenticator E2E harness,
which does not exist today and is out of scope (`SC2`).

### C3 — Remaining `any` sites outside WebAuthn

| Site | Current | Fix |
|------|---------|-----|
| `src/app/api/webauthn/register/verify/route.ts:137` | `verifyRegistration(response as any, …)` | `verifyRegistration` already declares `response: RegistrationResponseJSON` at `webauthn-server.ts:147`, so this cast is **redundant** — deleting it is safe once `response` is narrowed to a compatible shape. This is the ONLY site in this route where a library type applies. |
| same file :162,170,176,182 | `(response as any).response?.transports` etc. | read off a **locally-declared wire type with `unknown`-valued extension fields**, NOT `RegistrationResponseJSON` and NOT `AuthenticationExtensionsClientOutputs`. `minPinLength` exists on neither (Key finding exception 1). Keep every runtime guard in the I6 table — the narrowing IS the validation, since the Zod schema passes `response` through as `unknown`. |
| `src/components/passwords/dialogs/qr-capture-dialog.tsx:113` | `new (window as any).ImageCapture(track)` | lib.dom declares `ImageCapture` (incl. the constructor `declare var`), so `new ImageCapture(track)` compiles. **Add `"ImageCapture" in window` but fall through to the EXISTING `qrCaptureFailed` message** — do not introduce a new "unsupported" string. Today's `catch` already maps the Firefox `TypeError` to that localized message, so the user-visible behavior is unchanged and **no new i18n keys are needed**. An earlier draft promised a new "clear unsupported error", which would have been an unlisted `messages/{en,ja}.json` dependency and a user-visible change inside a "no behavior change" contract |
| `src/components/settings/security/passkey-credentials-card.tsx:206` | `(responseJSON as any).response?.transports` | narrow via the registration-response wire type from C2 |
| `src/lib/http/with-request-log.ts:25` | `type RouteHandler = (...args: any[]) => Promise<Response>` | **KEEP as the one documented exception (`SC3`) — decided, not contingent.** Review compiled the proposed `readonly unknown[]` form: `TS2345: Type 'unknown' is not assignable to type 'Request'`. Under `strictFunctionTypes` parameter positions are contravariant, so `H extends RouteHandler` requires `H` assignable to `RouteHandler`; widening the param to `unknown` is exactly backwards, and `readonly` constrains the tuple, not element variance. The existing comment at L21-23 is correct. Add a **file-scoped config override**, not an inline disable, so it stays on the reviewable audit surface |
| `src/app/api/scim/v2/Users/route.ts:45` | `let prismaWhere: Record<string, any>` | `Prisma.TenantMemberWhereInput` |
| `src/lib/services/scim-user-service.ts:254` | `const updateData: Record<string, any>` | `Prisma.TenantMemberUpdateInput` |
| `src/workers/audit-outbox-worker.ts:73` | `setBypassRlsGucs(client: any)` | accepts `PrismaClient \| Prisma.TransactionClient`; both expose `$executeRaw`. Type as a structural minimum: `{ $executeRaw: PrismaClient["$executeRaw"] }` |

Four occurrences matched by the audit grep are the English word "any" inside
comments (`user-session-invalidation.ts:101`, `csrf-gate.ts:10`,
`team-password-service.ts:385`, `read-api-error-body.ts:29`) — not code, no action.

**Why the SCIM sites were missed, and the lesson.** The first draft's grep was
`(: any\b|as any\b|<any>|any\[\])`, which does not match `Record<string, any>` —
the `any` there is a type *argument*, preceded by `, ` and followed by `>`. Two
live sites were invisible to it. The corrected derivation adds `Record<string, any>`
and `any>`, and was cross-checked per-file rather than by total count:

```bash
git grep -nE '\bany\b' -- 'src/**/*.ts' 'src/**/*.tsx' \
  | grep -vE '(\.test\.|\.spec\.|__tests__|/e2e/)' \
  | grep -vE '//.*\bany\b|\*.*\bany\b' \
  | grep -E '(: any|as any|<any>|any\[\]|Record<string, any>|any>)'
```

This is the R42 failure mode in miniature: a member-set derived from a
hand-written pattern rather than from every syntactic position the construct can
occupy. The independent cross-check is the **19 `eslint-disable` comments** (C5)
— every suppressed site must correspond to a fixed site, so the disable count
going 19 → 1 catches any member the type-position grep still misses.

**Invariants**:

- `I6` (security, app-enforced): every runtime narrowing currently guarding a
  client-supplied WebAuthn value survives the retyping. The DOM types describe
  what a *browser* produces; this route receives a **network payload** from a
  client that can lie. `response` is `z.record(z.string(), z.unknown())` — nothing
  is field-validated by the schema, so these inline guards ARE the validation.

  **Member-set (R42), derived from the code, not from prose.** An earlier draft
  listed 4; the actual set is 10. Security review caught the gap. This table is
  the implementer checklist:

  | # | Line | Guard | Deleting it causes |
  |---|------|-------|--------------------|
  | G1 | 160 | `VALID_TRANSPORTS` allowlist (6 values) | arbitrary transport strings persisted |
  | G2 | 163-165 | `typeof t === "string" && VALID_TRANSPORTS.has(t)` filter | same |
  | G3 | 162 | `rawTransports: unknown[] = … ?? []` | `transports: "usb"` (string) → `.filter` throws → 500 |
  | G4 | 171 | `typeof rawRk === "boolean" ? rawRk : null` | type-confusion write to `discoverable` |
  | G5 | 178-179 | `typeof rawMinPin === "number" && Number.isInteger && >= PIN_LENGTH_MIN && <= PIN_LENGTH_MAX` | **feeds G10 — see below** |
  | G6 | 183-184 | `typeof rawLargeBlob === "boolean" ? rawLargeBlob : null` | type-confusion write to `largeBlobSupported` |
  | G7 | 195 | `PER_CRED_SALT_HEX_RE.test(perCredentialSalt)` | tampered Redis salt persisted |
  | G8 | 111-119 | Redis challenge envelope shape checks | malformed envelope accepted |
  | G9 | 226-228 | fail-closed `if (!userInfo.tenant) throw` | PIN policy silently skipped |
  | G10 | 230-232 | `minPinLength < requireMinPin` → reject | — (it is the consumer) |

  **G5 → G10 is the load-bearing pair.** `minPinLength` is attacker-supplied.
  G5 constrains it to a sane integer; G10 enforces the tenant's
  `requireMinPinLength` policy against it. Delete G5 and a client sends
  `minPinLength: 999`, sailing past G10 — **a tenant authz-policy bypass.** The
  trap is that after retyping, `clientExtensionResults.minPinLength` does not
  exist on any library type (see Key finding exception 1), so the cheapest way to
  make line 176 compile is to delete the read and its guard. Do not. Read it off
  an `unknown`-typed field and keep every narrowing.

  This is the single highest-risk item in the plan.

**Required patterns** (inverse forbidden-pattern — each MUST still appear in
`src/app/api/webauthn/register/verify/route.ts` after the change; one grep per
guard in the I6 table, because a checklist nobody greps is a checklist nobody
follows):

| Guard | Required literal |
|-------|------------------|
| G1/G2 | `VALID_TRANSPORTS` |
| G3 | `?? []` on the transports read |
| G4 | `typeof rawRk` |
| G5 | `Number.isInteger`, `PIN_LENGTH_MIN`, `PIN_LENGTH_MAX` |
| G6 | `typeof rawLargeBlob` |
| G7 | `PER_CRED_SALT_HEX_RE` |
| G9 | `if (!userInfo.tenant)` |
| G10 | `requireMinPin` |

**Forbidden patterns**:

- `pattern: as any` in this route — reason: the point of the change.
- `pattern: as RegistrationResponseJSON` applied to the *extension reads* —
  reason: that type does not carry `minPinLength`/`largeBlob` in the read shape;
  using it there forces either a delete or a re-cast.

### C4 — `console.*` sites that cannot use either logger

`src/lib/env.ts:44`, `src/lib/security/csp-builder.ts:37`,
`src/lib/url-helpers.ts:52`, `src/i18n/pick-messages.ts:16`.

Decision per site (to be confirmed during implementation by checking each
module's actual import graph):

- `env.ts:44` — the banner must still reach stderr before any logger exists
  (VC3), but a **file-level `no-console: off` on `env.ts` is not acceptable**:
  that module calls `envSchema.safeParse(process.env)` and therefore has
  `AUTH_SECRET`, `MASTER_KEY`, DB passwords and `JACKSON_API_KEY` in scope. A
  permanent blanket exemption on the highest-secret-density file in the repo
  would leave a future `console.log(result.data)` completely ungated — the exact
  hole this whole change exists to close.

  **Extract instead**: new `src/lib/boot-stderr.ts`, two lines, takes a `string`
  and writes it. That file goes on the override list; `env.ts` stays under
  `no-console: error` with no exception. The secret-bearing module keeps the gate;
  only a module that cannot see secrets is exempt.

  Also pin the content: the banner is built from `issue.path.join(".")` and
  `issue.message` only — variable *names*, not values. It MUST never interpolate
  `process.env` values or `result.data`. (Zod messages for `invalid_literal` /
  `invalid_enum_value` can embed a received value, so this is a real constraint,
  not a formality.)
- `csp-builder.ts:37` — **third permanent KEEP, not a `clientLogWarn` target.**
  An earlier draft grouped it with the two below; that was wrong. Verified: the
  call sits at **top-level module scope** (not inside a function), guarded by
  `if (_isProd && _rawCspMode !== _cspMode)`. It fires during module
  initialization — structurally the same situation as `env.ts` (VC3) — and it is
  an *operator* signal about a server env var, so a browser-oriented client
  logger is the wrong sink even setting aside init ordering. It also fires only
  when `NODE_ENV === "production"`, the least testable and most damaging path
  for a logger-init bug. Route it to `boot-stderr.ts` alongside the env banner.

- `url-helpers.ts:52`, `pick-messages.ts:16` — genuinely fine for `clientLogWarn`:
  both are **inside functions** and both are already env-gated
  (`NODE_ENV !== "production"` / `=== "development"`). **Those gates must be
  preserved** — same requirement as member 4 (`use-password-entry-detail.ts`).
  Dropping `pick-messages`'s gate would start emitting namespace warnings in
  production browser consoles. Required-pattern: the `NODE_ENV` comparison must
  still appear in each file after the change.

**Invariant `I7`**: after C4, the only `console.*` in `src/` are the two inside
`src/lib/logger/client.ts` and the one inside `src/lib/boot-stderr.ts` (which
serves both the env banner and the CSP-mode warning). ESLint enforces this via
`no-console: error` with exactly **two** file overrides — the override list IS
the audit surface.

Because the override list gives *no* protection inside the exempt files, each
gets a pinned count enforced in CI (a `scripts/checks/` guard), so a second
console call in either is a red build rather than a silent pass:

- `git grep -c 'console\.' src/lib/logger/client.ts` → exactly 2
- `git grep -c 'console\.' src/lib/boot-stderr.ts` → exactly 1

`csp-builder.test.ts` currently asserts on a `console.warn` spy; after routing
through `boot-stderr.ts` it must assert on that module instead (see the C1/C4
test-edit table). Note the CSP warning fires at module-init under
`NODE_ENV === "production"`, so the test's existing env manipulation must be
preserved — this is one of the 6 pre-authorized test edits, not a regression.

### C5 — ESLint enforcement + tests

**Measured starting state — an earlier draft of this contract was wrong about
it, and the correction changes what the work IS:**

```
$ npx eslint --print-config src/lib/url-helpers.ts
@typescript-eslint/no-explicit-any: [2]     ← ALREADY error, repo-wide
no-console:                         undefined ← genuinely absent
```

`no-explicit-any` is already enforced at `error` via `eslint-config-next/typescript`.
The 22 production `any`s survive **because 19 inline `eslint-disable` comments
suppress them**, not because the rule is missing. So:

- **Only ONE rule is actually new: `no-console`.**
- The `any` half of this contract is **not "turn on a rule"** — it is **"delete
  19 suppressions"**, which only succeeds if the underlying `any` is genuinely
  fixed by C2/C3. That is a strictly stronger obligation and a much better
  acceptance signal, because it cannot be satisfied by config alone.

**Member-set of the 19 suppressions (R42)** — the defining primitive:

```bash
git grep -n 'eslint-disable.*no-explicit-any' -- 'src' \
  | grep -vE '(\.test\.|\.spec\.|__tests__)'
```

This count must go **19 → 1** (the survivor being `with-request-log.ts`, `SC3`).
It is red today and green only after C2/C3 land, so it is a real gate.

**ESLint additions** to `eslint.config.mjs`:

```js
{
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "src/**/e2e/**"],
  rules: {
    // no-explicit-any is NOT re-declared here — it is already error repo-wide
    // via eslint-config-next/typescript. Re-declaring it under a block that
    // excludes tests would invite a future "simplification" that drops
    // enforcement for test code.
    "no-console": "error",
  },
},
{
  // The only two modules permitted a raw console sink. Neither can see a
  // secret: client.ts redacts by denylist, boot-stderr.ts takes a string.
  files: ["src/lib/logger/client.ts", "src/lib/boot-stderr.ts"],
  rules: { "no-console": "off" },
},
```

Note `src/lib/env.ts` is deliberately **absent** from the override list — see C4.

**Invariants**:

- `I8` (app-enforced): a newly added `any` or `console.*` in production `src/`
  fails `npm run lint`, hence fails CI.

**Gate wiring — verified, not assumed** (a rule added to a config that no
authoritative gate runs would enforce nothing):

- CI: `.github/workflows/ci.yml:271` → `run: npm run lint`.
- Local pre-PR: `scripts/pre-pr.sh:719` → `queue_step "Lint" npx eslint .`.

Both invoke the shipped `eslint.config.mjs`, so the C5 rules take effect in both
paths. Note `extension/` sits in the config's `globalIgnores`, which is why
`SC5` defers it rather than claiming coverage.

**RT7 obligation — the gate must be proven able to fail.**

An earlier draft of this contract prescribed copying a file to the **scratchpad**
(outside the repo) and running eslint on it. That procedure was executed during
plan review and is **vacuous** — reproduced verbatim:

```
$ npx eslint <scratchpad>/probe.ts
  0:0  warning  File ignored because outside of base path
✖ 1 problem (0 errors, 1 warning)
EXIT=0
```

ESLint's flat config refuses to lint outside its base path: a **warning**, and
**exit 0**. The `files: ["src/**/*.{ts,tsx}"]` glob can never match an
out-of-tree path. An implementer told to "capture the two error lines" would
have found none and been tempted to fabricate them. This is exactly
`feedback_silent_gate_makes_green_tree_diff_vacuous`.

**Correct procedure — must be run in-tree, and the gate's OWN exit status read
(R44: never through a pipe):**

```bash
mkdir -p src/lib/__redproof_tmp__
cp src/lib/url-helpers.ts src/lib/__redproof_tmp__/probe.ts
printf '\nconst x: any = 1;\nconsole.log(x);\n' >> src/lib/__redproof_tmp__/probe.ts
npx eslint src/lib/__redproof_tmp__/probe.ts > /tmp/redproof.txt 2>&1
echo "ESLINT_EXIT=$?"          # MUST be 1
rm -rf src/lib/__redproof_tmp__ # residue check afterwards (R21)
```

Verified against the **pre-change** config: `ESLINT_EXIT=1`, with
`@typescript-eslint/no-explicit-any` firing and **`no-console` NOT firing** —
which is itself the evidence for the F2 correction above (only `no-console` is
new). After C5 lands, the same probe must report **both** rule IDs.

Acceptance for the red-proof: the deviation log records (a) the nonzero exit
status read directly from eslint, and (b) both rule IDs present post-change.
A capture showing only output lines and no exit status does not satisfy this.

**Scope proof (F8 from review) — the override list must also be proven.** Three
captures, not one:
1. a probe under `src/lib/__redproof_tmp__/` → **errors** (rule reaches prod code)
2. a probe copy of `src/lib/logger/client.ts` with an extra `console.log` →
   **no `no-console` error** (override is active where intended)
3. a probe under a `__tests__/` path → **no `no-console` error** (ignores work)

Note the probe path is created and removed inside the same procedure; the real
source is never mutated (`feedback_mutation_proof_on_throwaway_only`), and a
residue grep for `__redproof_tmp__` runs afterwards.

**Testing strategy**:

- `src/lib/logger/client.test.ts` (new), three obligations:

  1. **`clientLogWarn` calls `console.warn` exactly once with the message and
     fields.** Sound and red-provable — spy on `console` directly (legitimate
     here: `client.ts` is the one file where `console` IS the intended sink).
  2. **Redaction**: `clientLogWarn("m", { token: "abc" })` emits `[REDACTED]`,
     never `abc`. Red-proof: delete a denylist entry, confirm red.
  3. **No `node:*` in the transitive import graph.** An earlier draft specified
     this as "a static import-graph assertion" — as stated it is **not
     implementable and cannot fail**: under vitest's Node environment,
     `import pino from "pino"` resolves fine, so a test that merely imports the
     module is green either way. And a text grep on one file cannot see the
     *transitive* edge, which is the actual risk (R-B: pull-in via the
     `@/lib/logger` barrel).

     Implement it as a real AST walk instead — ts-morph is already used for
     gates here (`project_ast_guard_tsmorph_no_program`): resolve
     `src/lib/logger/client.ts`, follow relative imports transitively, and fail
     on any specifier matching `^node:` or equal to `pino` / `@/lib/logger`.

     **RT7 red-proof (mandatory)**: point the walker at a scratchpad copy with
     `import "node:async_hooks";` added and confirm it goes red. Without that
     proof this test is indistinguishable from `expect(true).toBe(true)`.
- **C2 PRF `BufferSource` branch (RT1 — highest testing risk).** The existing
  mock at `webauthn-client.test.ts:136-138` returns
  `first: new Uint8Array([1,2,3,4]).buffer` — an **`ArrayBuffer`**. lib.dom types
  `first` as `BufferSource = ArrayBuffer | ArrayBufferView`. If the implementer
  writes the narrowing as
  `first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer)`,
  the mock takes branch A and passes — while a **real authenticator returning an
  `ArrayBufferView` takes branch B, which no test ever executes**. Per `VC1`, CI
  can never reach a real authenticator, so the unexercised branch stays
  unverified forever. Failure mode: corrupted PRF-derived wrapping key → **vault
  fails to unlock after passkey sign-in**.

  **Requirement**: parameterize the mock over BOTH variants — add a fixture
  returning `first: new Uint8Array([1,2,3,4])` (a view, not `.buffer`) — and
  assert `Array.from(prfOutput)` equals `[1,2,3,4]` in both cases. This mock
  edit is **pre-authorized**; it does not trip the "test edit = behavior
  changed" rule.

  Simpler alternative worth preferring: keep the existing
  `new Uint8Array(first as ArrayBuffer)` cast, which compiles, emits identical
  JS, and introduces no branch at all. Review confirmed the uncast form does not
  compile (`TS2769`), so retaining the cast is the *only* zero-behavior-change
  option. **Prefer this**; only introduce a narrowing if there is a concrete
  reason, and then the two-variant mock above is mandatory.

- **C2 wire-shape reader throws (RT8).** The plan must name the required-field
  set, because existing fixtures constrain it tightly:
  `webauthn-client.test.ts:356-361` calls `startPasskeyRegistration` with only
  `{ rp, user, challenge, pubKeyCredParams: [] }`, and lines 173-253 call
  `startPasskeyAuthentication` with only `{ challenge, rpId, allowCredentials }`.
  A reader that requires more than that reds six existing tests.

  Specify the throw tests as a table with columns: **(a) malformed input,
  (b) error today, (c) named error after.** Only rows where (b) ≠ (c) count
  toward RT8 — `missing challenge` and `missing user` already throw `TypeError`
  today, so a bare `.rejects.toThrow()` on those passes before AND after and is
  vacuous. Each qualifying row must be red-proven against the pre-change code.
**The "existing tests pass unchanged" rule applies to C2/C3 ONLY.** An earlier
draft applied it to the whole change; that is wrong and would have actively
misled the implementer. Corrected scoping:

**C2/C3 (type-only)** — existing tests must pass unchanged. A required test edit
IS the signal that the edit was not type-only. Two pre-authorized exceptions:

- The PRF mock must gain an `ArrayBufferView` fixture (see below) — a legitimate
  coverage addition, not a symptom.
- New wire-reader throw tests (see the table requirement below).

**C1/C4 (console replacement)** — the rule is INVERTED: **6 test files spy on
the global `console` and MUST be edited**, because a spy on `console` cannot
observe a call routed through a logger module. Enumerated:

| Test file | Asserts | Required new target |
|-----------|---------|---------------------|
| `src/lib/url-helpers.test.ts` | `warn` called w/ message | `clientLogWarn` mock |
| `src/lib/security/csp-builder.test.ts` | `warn` called w/ message | see C4 (stays `console`) |
| `src/lib/team/team-vault-core.test.tsx` | `warn`/`error` w/ **fields** | `clientLogWarn`/`clientLogError` mock |
| `src/lib/team/team-vault-context.test.tsx` | console spy | follow core |
| `src/app/api/passwords/[id]/attachments/route.test.ts` | `warn` called (weak) | `getLogger().warn` mock |
| `src/hooks/use-travel-mode.test.tsx` | console spy | verify whether in scope |

**Forbidden weakening**: an edit that degrades
`toHaveBeenCalledWith(msg, objectContaining({...}))` to bare
`toHaveBeenCalled()` is a coverage regression, not a migration. The
`team-vault-core` assertions are the only tests pinning the *field contents* of
that failure log — they must keep asserting fields.

**Coverage reality for the 13 console sites** — stating this because "existing
tests pass" would otherwise imply coverage that does not exist:

- **asserted today** (5): members 1, 9, 10, 12, 13
- **executed but NOT asserted** (1): member 8 — `auth-gate.ts:139`, the
  fail-closed signal the plan calls highest-severity. `auth-gate.test.ts`
  contains **zero** `spyOn(console)` (verified). Its `it.each` fail-closed block
  asserts only the returned bundle.
- **not reachable / not asserted** (7): members 2, 3, 4, 5, 6, 7, 11. Member 7
  (`base-cloud-provider.ts:162`) sits inside a method the test mocks out
  entirely, so it is unverifiable by the suite.

**New coverage obligation**: C1 must add an assertion to `auth-gate.test.ts`'s
existing fail-closed `it.each` that the warn fired with the `missing` array —
red-proven by deleting the call and confirming red. Shipping the plan's
highest-severity site with zero verification is not acceptable.

### C6 — Pre-implementation checks and orchestrator verification

**R19 — logger mock shapes.** 95 test files `vi.mock("@/lib/logger", ...)`.
Three members route to `getLogger().warn` (members 1, 7, 8). A mock returning
only `{ info, error }` makes the new call throw
`getLogger(...).warn is not a function` in an unrelated route test, surfacing far
from its cause. **Before implementing C4**, enumerate the mock shape in the test
files covering those three sites and add `warn` where absent:

```bash
git grep -ln 'vi.mock("@/lib/logger"' -- 'src' | xargs grep -L 'warn'
```

Note member 7 (`base-cloud-provider.ts:162`) sits inside `logStaleWarning`,
which `base-cloud-provider.test.ts:76` mocks out wholesale — that site is
**unverifiable by the suite** and must be reviewed by reading, not by running.

**R21 — orchestrator obligations.** If any part of this is delegated to a
sub-agent, the orchestrator itself re-runs (never delegates, never reads through
a pipe — R44):

- `npx eslint .` — read exit status directly
- `npx vitest run`
- `npx next build`
- residue greps:
  - `git grep -n 'console\.' -- src | grep -v test` → only the 3 sanctioned sinks
  - `git grep -c 'eslint-disable.*no-explicit-any' -- src | grep -v test` → 1
  - `git grep -rn '__redproof_tmp__' .` → **empty** (red-proof probe removed)
- confirm no sub-agent mutated a real source file while red-proving
  (`feedback_r21_subagent_production_mutation_residue_grep`)

## Considerations & constraints

### Scope contract

- `SC1` — the env-validation boot banner keeps a raw stderr write, but moves out
  of `src/lib/env.ts` into `src/lib/boot-stderr.ts` (C4). Owner: none (permanent,
  by design). Cost-justification: routing it through pino requires the logger to
  initialize before env validation, inverting a deliberate dependency order; the
  failure it reports is a boot-time misconfiguration that must print even if
  logging is itself misconfigured. The extraction means the permanent exemption
  lands on a module that cannot see a secret, rather than on the module that
  holds all of them.
- `SC2` — CDP virtual-authenticator E2E harness for WebAuthn ceremonies. Owner:
  future issue. Not created by this work; C2 is type-only so it does not increase
  the need for one.
- `SC3` — `with-request-log.ts`'s `RouteHandler` **stays `any`**. Decided, with
  compiler output as evidence, not deferred:
  `TS2345: Type 'unknown' is not assignable to type 'Request'`. Under
  `strictFunctionTypes`, `H extends RouteHandler` requires `H` to be assignable
  to `RouteHandler`; parameter positions are contravariant, so widening to
  `unknown` is precisely backwards, and `readonly` constrains the tuple rather
  than element variance. `never[]` fails on arity for the mirror-image reason.
  The existing comment at L21-23 already says this and is correct.

  Disposition: a **file-scoped override in `eslint.config.mjs`**, not an inline
  disable — inline disables are invisible to the audit surface, which is the
  property C5 exists to establish. The PR reports "**21 removed, 1 documented
  exception**", never "zero".
- `SC4` — test-code `any` (82 occurrences) is deliberately untouched.
- `SC5` — `extension/` is out of scope. Measured 2026-07-27: 6 production
  `console.*`, **0** production `any`. Of the 6, four are
  `console.debug` guarded by a `typeof console !== "undefined"` feature check in
  the autofill select-matching path (`autofill-cc-lib.ts:85-86`,
  `autofill-identity-lib.ts:49-50`) and log only a select element's target value;
  two are error `console.warn` in `background/index.ts:724,1026`. Reasons for
  deferring: (a) `extension/` is in the root ESLint `globalIgnores`, so the C5
  rules cannot reach it without a separate config — a distinct piece of work;
  (b) `project_extension_no_eslint` records that the extension has no ESLint
  setup at all; (c) `project_extension_parallel_impl` means edits there must be
  applied to both the `.js` production file and its `-lib.ts` twin, which is the
  RT9 twin-drift hazard and deserves its own reviewed change. Owner: future issue.
  Not a live secret-leak: none of the 6 sites logs a credential, token, or vault
  value. Re-verify that claim before closing the future issue.
- `SC6` — `cli/` is out of scope. Measured 2026-07-27: 48 `console.*`, of which
  **45 are `console.log`** — a CLI's legitimate stdout, not diagnostic logging.
  Routing those through a logger would be wrong, not an improvement. The 4
  `console.error` calls are CLI error output on stderr, also correct. No action.

### Risks

- **R-A (highest)**: deleting a runtime narrowing because the type now looks
  safe. `credProps.rk` / `minPinLength` / `largeBlob.supported` / `transports`
  arrive over the network from a client that can lie. Mitigation: I6 +
  required-pattern greps in C3.
- **R-B**: the client logger pulls pino transitively via a barrel import
  (`@/lib/logger` re-export). Mitigation: I2 forbidden-pattern grep + `next build`
  must succeed; the existing repo memory `project_client_shared_constants_no_node_imports`
  documents this exact failure mode.
- **R-C**: `ImageCapture` is absent in Firefox. The current `as any` hid this;
  using the real type makes the absence visible but does not create it.
  Mitigation: feature-detect before constructing (the code path already sits in a
  try/catch, but a `TypeError: ImageCapture is not a constructor` currently
  surfaces as a generic error).
- **R-D**: `next build` may typecheck differently from `tsc --noEmit` for client
  components. Both must be run (project CLAUDE.md already mandates `next build`).

## User operation scenarios

1. User registers a passkey on Chrome with PRF support → registration succeeds,
   PRF wrapping key derived, vault auto-unlock works. (Exercises C2 happy path.)
2. User registers a security key without PRF → `prfOutput` is null, fallback
   passphrase path used. (Exercises the `undefined` branches the casts hid.)
3. User signs in with a passkey on a second device using per-credential salts →
   `evalByCredential` channel wins over top-level `eval`. (Exercises I5.)
4. A hostile client POSTs `clientExtensionResults.credProps.rk = "yes"` (string,
   not boolean) → server stores `discoverable: null`, does not crash. (Exercises
   I6 — the check that must survive.)
5. User captures a QR code on Firefox (no `ImageCapture`) → sees a clear
   "unsupported" error rather than a stack trace. (Exercises R-C.)
6. Operator boots the app with an invalid env var → banner prints to stderr
   before any logger exists. (Exercises SC1.)

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Client-safe logger (`logger/client.ts`) + key-name denylist | locked |
| C2 | WebAuthn client: wire types (hex) vs DOM types, PRF priority preserved | locked |
| C3 | Remaining `any` sites incl. SCIM ×2; `RouteHandler` is `SC3` | locked |
| C4 | `console.*` routing; 3 permanent sinks (`client.ts` ×2, `boot-stderr.ts` ×1) | locked |
| C5 | `no-console` (the only new rule) + 19→1 disable removal + in-tree red-proof | locked |
| C6 | Logger-mock enumeration + orchestrator re-verification | locked |

Round 1 closed all findings. Summary of what changed and why it mattered:

| # | Finding | Correction |
|---|---------|------------|
| 1 | `@simplewebauthn/server` ships **its own narrower DOM types** — no `minPinLength`/`largeBlob` on Outputs | Three type worlds separated (lib.dom / library / repo wire types) |
| 2 | PRF salts cross the wire as **hex strings**, not `BufferSource` | `PrfInputsWire` declared; wrong type would have silently downgraded the salt |
| 3 | I6 listed 4 runtime guards; the code has **10** | Full G1–G10 table + per-guard required-pattern greps |
| 4 | `no-explicit-any` was **already `error`** repo-wide | Real work is deleting 19 suppressions, not adding a rule |
| 5 | The red-proof ran **out-of-tree → exit 0, zero errors** | Rewritten in-tree, exit status read directly |
| 6 | "Existing tests pass unchanged" is **false for C1/C4** — 6 files spy on `console` | Rule scoped to C2/C3; expected test-edit table added |
| 7 | The `any` count was 21 | Actually **22** — `Record<string, any>` was invisible to the first grep |
