# Plan: autofill-console-pii-leak

Closes `SC5` from PR #723 (`refactor(security): route production logging through
audited sinks and eliminate any`).

**Revision 3.** Round 1 replaced the enforcement mechanism (a bespoke ts-morph gate →
ESLint over `extension/`) and reclassified `SC-A` from deferred to in-scope after its
premise was refuted. Round 2 rebuilt the ESLint rule set — every exclusion tried in
rounds 1 and 2 opened a bypass — added a wrapper so the gate cannot go silently
vacuous, and completed two member sets that had been enumerated one deep. See "Round
1 outcome" and "Round 2 outcome".

## Project context

- **Type**: mixed — browser extension (`extension/`, MV3 content scripts + service
  worker) plus repo-level lint/CI tooling.
- **Test infrastructure**: unit + integration + E2E + CI/CD.
  - `extension/` runs its own vitest project (`cd extension && npm test`), node
    environment by default, jsdom per-file via the `@vitest-environment jsdom`
    docblock.
  - Root vitest picks up `scripts/__tests__/**/*.test.mjs`.
  - `scripts/pre-pr.sh` → CI. The `static-checks` job is not path-gated
    (`.github/workflows/ci.yml:163`) and runs `PRE_PR_STATIC_ONLY=1 bash
    scripts/pre-pr.sh`, so a gate placed in pre-pr's unconditional first batch runs
    on every PR — including extension-only ones. Verified: `app_paths` in
    `scripts/pre-pr.sh:32` does **not** include `extension/`, so this ungated job is
    the only thing that would catch a re-introduction.
- **Verification environment constraints**:
  - `VC1` — **Real-browser console observation is `blocked-deferred`.** Proving the
    fix in a real Chrome profile (unpacked extension, a page with a non-matching
    `<select>`, DevTools) is manual and not reproducible in CI. Anti-Deferral
    cost-justification: the observable behaviour reduces to "what string is passed
    to `console.debug`", which jsdom asserts directly (C7). Residual risk after
    C7 + the built-bundle assertion (below) is browser *routing* only, which this
    diff does not change.
  - `VC2` — Firefox/Safari content-script world semantics are not exercised.
    `blocked-deferred`; the fix removes the value from the message entirely, so it
    holds regardless of which console the string lands in.
  - Everything else is `verifiable-CI`.

## Objective

Stop `extension/` from emitting secret or personally-identifying values into any
browser console — autofill identity PII and card expiry in the page-attributed
content-script console, and decrypted vault plaintext in the service-worker
console — and make the removal enforced rather than merely done.

## Background: what was verified

### Member-set derivation (R42)

```bash
rg -n --no-ignore-vcs -g '!**/node_modules/**' -g '!extension/dist/**' \
   'console\s*\.\s*(log|debug|info|warn|error|trace|dir|table)' extension/
```

| # | Site | Sink | Argument |
|---|------|------|----------|
| 1 | `extension/src/content/autofill-identity-lib.ts:50` | page-attributed console | `${targetValue}` — an autofill payload field |
| 2 | `extension/src/content/autofill-cc-lib.ts:86` | page-attributed console | `${targetValue}` — expiry month or year |
| 3 | `extension/src/background/index.ts:724` | service-worker console | `err` |
| 4 | `extension/src/background/index.ts:1026` | service-worker console | `err` — **see S1** |

Four call sites, not the six #723 recorded; the "6" counted the two
`typeof console !== "undefined" && console.debug` guard lines as separate grep hits.

Indirect members checked and clear (all three experts re-derived this independently
and agreed): the three tracked `.js` files (`public/offscreen.js`,
`src/content/token-bridge.js`, `src/content/webauthn-interceptor.js`) contain no
`console.*`; neither autofill lib has a `.js` twin, so RT9 does not apply;
`autofill-lib.ts` (login) has no `<select>` handling and no console call. Non-console
sinks were swept as well — interpolated `throw new Error` occurs only in
`lib/crypto*.ts` over AAD metadata, `postMessage` sites carry no payload values, and
`innerHTML` sites in `content/ui/*` are the intended dropdown UI with `escapeHtml`.

### Correction 1 — the card number is never logged

`payload.cardNumber` is written through `setInputValue`
(`autofill-cc-lib.ts:115`), which has no console call. The only logging path,
`setSelectValue`, is reached from exactly two call sites: `expiryMonth` (`:126`)
and `expiryYear` (`:133`).

### Correction 2 — the identity leak is broader than "name and address"

`fillField` (`autofill-identity-lib.ts:70-80`) routes a field to `setSelectValue`
whenever the resolved DOM element is an `HTMLSelectElement`, with no per-field
restriction. All 14 fields it is called with are in the class: `givenName`,
`familyName`, `fullName`, `familyNameKana`, `givenNameKana`, `address`,
`addressLine2`, `city`, `postalCode`, `country`, `region` (`state || nationality`),
`phone`, `email`, `dateOfBirth`.

### Correction 3 — `background/index.ts:1026` leaks decrypted vault plaintext

Revision 1 deferred the two background sites on the premise that they log "an
`Error` object only, no user data". That premise is false. The `catch` at `:1025`
spans a block that parses decrypted vault plaintext:

```ts
const plaintext = await decryptData(data.encryptedBlob, encryptionKey!, aad);
blob = JSON.parse(plaintext) as typeof blob;      // :1011-1012
…
} catch (err) { console.warn("[psso] copy command failed:", err); }   // :1025-1026
```

V8 embeds a window of the *input* in `JSON.parse` `SyntaxError` messages. Verified
by execution on this machine:

```
$ node -e 'try{JSON.parse("{\"username\":\"bob\",\"password\":S3cr3t-Passw0rd-VeryLong}")}catch(e){console.log(e.message)}'
Unexpected token 'S', ..."password":S3cr3t-Pas"... is not valid JSON
```

AES-GCM authentication guarantees the plaintext is *authentic*, not that it is
*JSON*; a legacy or partially-written blob format reaches the parse. Impact: a
credential prefix in the service-worker console, readable by a co-installed
extension holding `debugger`, an enterprise telemetry agent, or a support session.
This is credential material, not PII — it outranks the leak this plan started from.

### Severity of the content-script leak, stated honestly

`extension/manifest.config.ts:63-70` declares one content script
(`src/content/form-detector.ts`) with no `world` key ⇒ MV3 default `ISOLATED`; the
programmatic injections at `background/index.ts:1583` and `:1624` also omit `world`.
The only MAIN-world script is `webauthn-interceptor.js`, which has no console call.
So page JavaScript cannot read the extension's console, and the leak is **not** a
page-readable disclosure. The exposure paths are:

- DevTools / CDP `Runtime.consoleAPICalled`, which reports every world — reachable
  by another installed extension holding `debugger`, by automation harnesses
  (Playwright/Selenium/BrowserStack console capture), and by enterprise
  browser-telemetry agents. The DevTools *UI* log-level filter hides Verbose
  (`console.debug`) by default, but that filter is a frontend concern only — the
  CDP path is unfiltered, so automation and telemetry capture is the dominant
  vector.
- Anyone with DevTools attached to the page, **including after the fact**: Chrome
  replays the renderer's buffered console messages on attach, so a support engineer
  who opens DevTools after a user reports a problem sees the historical PII for that
  page load. Direct screen reading is the secondary vector, and weaker than
  revision 1 claimed, because Verbose is hidden by default.

Not "the page steals the data". Still a password manager writing its user's name,
address, phone, email and date of birth into a log surface attributed to a
third-party page, with no opt-in and no benefit that requires the value.

## Requirements

**Functional**

- F1 — No `console.*` call anywhere under `extension/` passes a value derived from
  an autofill payload, a decrypted vault blob, or any other user secret.
- F2 — The "no option matched" condition remains diagnosable: an operator must still
  be able to tell *which* select failed to match.
- F3 — Silent-failure behaviour is unchanged: no fuzzy/nearest-option matching is
  introduced (`autofill-cc-lib.ts:84` records this as a prior security-review
  decision).
- F4 — Card autofill must not write a fabricated expiry into a payment form.

**Non-functional**

- N1 — The removal is enforced, not merely applied. `extension/` is excluded from
  the root ESLint run (`eslint.config.mjs:23`), so nothing today catches a
  re-introduction.
- N2 — The *exemption list* is the audit surface for "which files may sink"; the
  sink modules' *types* are the audit surface for "what they may sink". Same split
  as `src/`, established by #723.
- N3 — No new dependency tree under `extension/`.

## Technical approach

### Diagnostic value → element identity

The diagnostic keeps a stable, non-secret identifier for the failing control and
drops the value. The identifier is derived from the `<select>` element's own `name` /
`id` — data the page authored and already holds. It is **sanitised before
truncation**: HTML attribute values may carry newlines, ANSI escapes and bidi
controls, and the log surfaces this plan cares about (CI console capture,
telemetry pipelines, support-bundle exports) are exactly the ones where an
attacker-chosen `name` could forge or obscure a `[passwd-sso]`-prefixed line. Note
this is a log-integrity concern, not a disclosure one — the page already knows its
own attribute values. A secondary case supports the same treatment: server-rendered
and SPA forms do build ids from submitted values (`id="pref_東京都"`), so on some
real pages the label can itself carry user-supplied text.

Rejected alternatives, each with the axis that actually decides it:

- *Drop `${targetValue}` and log a bare constant string.* Smallest diff, but with 14
  candidate identity fields and 2 card fields producing the identical message, the
  line stops distinguishing anything. Fails F2. This is the whole reason — the gate
  question is orthogonal and does not enter it.
- *Delete the `console.debug` call entirely.* Guarantees F1, costs all of F2.
- *Dataflow/taint analysis (payload → console).* Rejected because a sound taint pass
  is materially harder to write, and much harder to prove able to fail (RT7), than a
  reference ban. Not rejected on performance: measured, a no-`Program` `ts-morph`
  walk over `extension/src` (118 files) completes in 257 ms, so R45 is not the axis.

### Enforcement: ESLint over `extension/`, not a bespoke gate

Revision 1 specified a bespoke `ts-morph` gate. Round 1 review found it bypassable
in two independent ways that a no-`Program` AST pass cannot close cheaply — it
matched the `console` callee by *spelling* (so `console?.debug?.()`,
`console["debug"]()` and `const c = console` were invisible), and it matched the
permitted labeller by *identifier name* rather than binding (so a local function
named `describeSelect` re-opened the leak while the gate stayed green). Closing both
plus an allowlist re-anchor, a scan-root widening and an empty-scan tripwire took the
gate past 400 lines, which is not proportionate to a tree containing four console
calls.

ESLint over `extension/` is the smaller and stronger answer, and it is the repo's own
established pattern (`eslint.config.mjs:102-118`: `no-console: error` over a glob plus
a file-scoped override list that IS the audit surface).

**Verified by execution, not assumed** — and two rounds of assumptions were wrong, so
every claim below names what was run.

Round 1's security finding asserted that "ESLint's `no-console` is scope-based, so
`const c = console` is caught at the alias site". **False**, confirmed independently
by the security expert's own round-2 probe. Round 2 then proposed a replacement
selector built around `:not(MemberExpression[computed=false] > .property)` — that
exclusion, added to spare `obj.console`, is itself what blinds the rule to
`globalThis.console`, and it missed **10 of 20** bypass forms when executed.

The final rule set carries **no exclusions at all**: the identifier `console` and the
string literal `"console"` may not appear anywhere under `extension/src` /
`extension/public` outside the two sink files.

```js
linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
rules: {
  "no-console": "error",
  "no-restricted-syntax": ["error",
    { selector: "Identifier[name='console']",
      message: "Use the sanctioned sink — content/select-diag-lib.ts or background/log.ts." },
    { selector: "Literal[value='console']",
      message: "String-keyed access to console is banned; use the sanctioned sink." },
  ],
}
```

Executed against `eslint@9.39.5` + `@typescript-eslint/parser`:

| Probe | Result |
|---|---|
| 20 bypass forms — `console.log`, `console?.debug?.()`, `console["warn"]()`, `const c = console`, `const {debug} = console`, `const f = console.debug`, `globalThis`/`self`/`window`.console, `globalThis["console"]`, `(globalThis as T).console`, `globalThis!.console`, `const g = globalThis; g.console`, `globalThis.self.console`, `top!`/`parent`/`frames`.console, `const {console: c} = globalThis`, computed non-literal key, `Reflect.get(globalThis,"console")` | **20/20 caught** |
| The real tree — `eslint --config … extension/src extension/public` | **62 production files linted, exactly the 4 known sites flagged, 0 false positives** |
| `extension/public/offscreen.js`, `src/content/token-bridge.js`, `src/content/webauthn-interceptor.js` actually parsed and linted (not silently skipped) | **all three confirmed present in `--format json` output** |
| `// eslint-disable-next-line no-console, no-restricted-syntax` above a `console.log` | **still errors**, plus the directive itself is reported — `noInlineConfig` closes the comment bypass |

The over-approximation is deliberate and its cost was measured, not assumed: an
object property, type member or class field named `console` would be flagged. The
current tree contains none (`rg "\.console\b"`, `rg "['\"]console['\"]"`,
`rg "\bconsole\s*:"` → zero hits outside the four known sites). A security gate that
declines to carve exceptions for cases it has not observed is the correct default;
each exclusion tried in rounds 1 and 2 opened a bypass, and this is the first
formulation with no hole.

One round-2 claim is corrected here rather than dropped: `const f = console.debug;
f(x)` **is** caught by `no-console` alone — revision 2's table said "missed". Three
other rows in that table were genuine `no-console` misses, so the conclusion stands,
but the table is regenerated from the self-test's own cases (C7) so document and
executable cannot drift again.

**No new dependency tree under `extension/`** (N3). The config lives at the repo
root as `eslint.extension.config.mjs` and is run by the root `eslint` binary, which
already resolves `@typescript-eslint/parser` (present at `node_modules/`, currently
transitive via `eslint-config-next`). C4 promotes it to an explicit root devDependency
rather than relying on a transitive one.

**Empty-scan behaviour comes for free and fails closed** — verified: ESLint exits 2
with "all of the files matching the glob pattern … are ignored" when a target path
matches nothing. The bespoke gate would have needed an `EMPTY_SCAN` tripwire to get
the same property.

## Contracts

### C1 — content-script diagnostic sink

New module `extension/src/content/select-diag-lib.ts`. It is the **only** file under
`extension/src/content/` permitted to reference `console`.

```ts
/** Structural, NOT HTMLSelectElement — see the note below. */
export type SelectIdentity = { readonly name: string; readonly id: string };

export const SELECT_DIAG_LABEL_MAX: number;              // 64
export function describeSelect(select: SelectIdentity): string;
export function logNoSelectMatch(select: SelectIdentity): void;
```

The parameter type is the load-bearing decision. An `HTMLSelectElement` transitively
reaches `.value`, `.options`, `.selectedOptions`, `.labels`, `.dataset`,
`.outerHTML`, and `.form.elements[*].value` — and at the moment `logNoSelectMatch`
is called, the card number has already been written (`autofill-cc-lib.ts:114-116`
runs before the expiry select at `:119-137`) and so have `address`/`city`/
`postalCode` (`autofill-identity-lib.ts:104-107` before the `country` select at
`:108`). So inside the one file the lint gate exempts, `${select.form?.elements…}`
would reach the PAN. Narrowing the parameter to `SelectIdentity` makes
`select.value` a **compile error (TS2339)** rather than a prose violation, giving C1
the same type-carried guarantee C3 has. `HTMLSelectElement` is structurally
assignable, so no call site changes.

- `describeSelect` returns the first non-empty of `select.name`, `select.id`, else
  `"(unnamed)"`. It **sanitises then truncates**: characters outside
  `[\p{L}\p{N}_\-.:\[\]]` become `?`, then the result is cut to
  `SELECT_DIAG_LABEL_MAX` with `"…"` appended only when it was actually longer.
  Truncation is **code-point aware** (`[...s].slice(0, MAX).join("")`, not
  `String.prototype.slice`): a `.slice()` cut through an astral character emits a
  lone surrogate, which `JSON.stringify` renders as an unpaired `\uD801` — invalid
  UTF-8 for exactly the telemetry and support-bundle ingests this sanitisation
  exists to protect.
- `logNoSelectMatch` performs the single `console.debug` call with exactly one
  argument, and the message literal is fixed so the built-bundle assertion and the
  unit assertion reference the same string:
  `` `[passwd-sso] No exact match for select: ${describeSelect(select)}` ``.
  It keeps the existing `typeof console !== "undefined" && console.debug` guard.
- Both are pure w.r.t. the DOM: no mutation, no event dispatch.

Why not reuse `getHintString` (`extension/src/content/form-detector-lib.ts:70-88`),
which both detectors already import and whose first two clauses are identical: it
additionally aggregates `placeholder`, `aria-label` and `<label>` text and is
unbounded — a *wider* page-controlled echo surface than `name`/`id`, which is the
opposite of what F1 needs. Recorded so a later refactor does not merge them.

**Invariants**

- `I1` (**type-enforced** by the `SelectIdentity` parameter, + test-enforced by C7) —
  `describeSelect` reads only `name` and `id`. Every other property — `value`,
  `selectedIndex`, `options`, `selectedOptions`, `textContent`, `labels`, `form`,
  `outerHTML`, `dataset`, `getAttribute` — is absent from the parameter type, so
  reading one does not compile. Revision 2 labelled this "lint-enforced by C4",
  which was false: C4 constrains `console` references and says nothing about which
  properties a sink reads. The C7 test is now a second layer, not the only one, and
  its fixture is widened so the `dataset` / `getAttribute` / `aria-label` mutants are
  red too, not just the `value` / option-text ones.
- `I2` (lint-enforced) — no file under `extension/src/content/` other than
  `select-diag-lib.ts` references `console` in any spelling.

**Forbidden patterns**

- `pattern: \$\{targetValue\}` — reason: the payload value must not reach a console
  message.
- `pattern: select\.(value|textContent|selectedIndex|selectedOptions|options|labels|dataset|outerHTML)` in `select-diag-lib.ts` — reason: `I1`.

**Acceptance criteria** (all asserted in
`extension/src/__tests__/content/select-diag.test.ts`, jsdom docblock, inputs built
via `document.body.innerHTML` + `querySelector` — real elements, never object-literal
casts, because a real `HTMLSelectElement` reflects an absent `name` as `""` while a
literal omitting it yields `undefined`, and `||` vs `??` behave identically against
the fake and differently against the real element)

- `<select name="pref">` → `"pref"`.
- `<select id="country">` (no `name`) → `"country"`.
- `<select>` → `"(unnamed)"`.
- The `I1` red-proof, widened so every property in the invariant's enumeration is
  covered by the one case rather than only `value` and option text:
  ```html
  <select data-selected="Nowhereland" aria-label="Nowhereland" title="Nowhereland">
    <option value="Nowhereland" selected>Nowhereland</option>
  </select>
  ```
  with no `name`/`id` → exactly `"(unnamed)"`. Red for `value`, option text,
  `dataset`, `getAttribute`, `aria-label` and `outerHTML` mutants alike. Revision 2's
  narrower fixture was green for the `dataset` and `getAttribute` ones. This is also
  why C1 must not reuse `getHintString`, which reads `aria-label` and `<label>` text
  (`form-detector-lib.ts:77-86`).
- A name of exactly `SELECT_DIAG_LABEL_MAX` characters → returned unchanged, **no**
  trailing `"…"`.
- A name of `SELECT_DIAG_LABEL_MAX + 1` characters → length `SELECT_DIAG_LABEL_MAX + 1`
  and ends with `"…"`. The constant is imported, not hardcoded (RT3); this stays
  non-vacuous because the presence/absence of the ellipsis across the boundary is a
  behaviour no value of the constant satisfies both ways. The test must **not** be
  written as `expect(label).toBe(name.slice(0, MAX) + "…")` — that restates the
  production expression (R22) and is green for `MAX = 0`.
- `<select name="a\nb[2K">` → the label matches
  `/^[\p{L}\p{N}_\-.:[\]?…]*$/u`. A **positive allowlist** assertion, because a
  "contains no C0/C1 or bidi" denylist drifts out of sync with the sanitiser — and
  revision 2's fixture contained neither a bidi character nor an ESC byte (`[`, `2`
  and `K` are all inside the permitted class and survive untouched), so half of that
  assertion could not fail and the ANSI threat it was written for was never driven.
  The fixture must therefore carry a newline, a real ESC byte and a bidi override.
- The emitted label round-trips: `JSON.parse(JSON.stringify(label)) === label`. Red
  for a `String.prototype.slice` implementation that cuts an astral character into a
  lone surrogate. Measured while designing the class: `\p{L}` already excludes Cf and
  combining marks, so bidi overrides, ZWJ, BOM, soft hyphen and combining accents are
  all replaced. The residuals it admits are `U+3164` HANGUL FILLER (renders blank)
  and homoglyphs — both accepted, since an ASCII-only class would mangle
  `id="pref_東京都"`, which is scenario 1 and a JP-first product's normal case.

**Consumer-flow walkthrough**

- Consumer 1 (`extension/src/content/autofill-cc-lib.ts`, `setSelectValue`) calls
  `logNoSelectMatch(select)` for its side effect and reads no return value.
- Consumer 2 (`extension/src/content/autofill-identity-lib.ts`, `setSelectValue`) —
  identical.
- Consumer 3 (`eslint.extension.config.mjs`) consumes the module's *path* as one of
  two entries in the `no-console` override list. Adding a second sink requires
  editing that file — the intended audit surface.

No consumer derives a URL, key or identifier from the label; nothing downstream needs
a field the contract lacks. Contract is consumable.

### C2 — call-site rewrite in both autofill libs

`extension/src/content/autofill-cc-lib.ts:83-89` and
`extension/src/content/autofill-identity-lib.ts:48-53`:

```
- if (typeof console !== "undefined" && console.debug) {
-   console.debug(`[passwd-sso] No exact match for select value: ${targetValue}`);
- }
+ logNoSelectMatch(select);
```

Both files end with **zero** `console` references, so neither needs a lint override.
The early `return` after the call is unchanged; F3 depends on it staying put.

**Invariants**

- `I3` — `targetValue` and `normalizedTarget` appear in no argument to any function
  that reaches a console sink. `normalizedTarget` matters independently:
  `normalizeYearValue("26")` → `"2026"`, so the normalised form is still the value.

**Acceptance criteria**

- Filling an identity form whose `country` is a `<select>` with no matching option
  emits one `console.debug` whose arguments contain `"country"` and do not contain
  the payload value.
- The same for a card form whose `expiryYear` is a non-matching `<select>`.
- Neither fill dispatches `input`/`change` on the select (F3).

### C3 — service-worker diagnostic sink, and the S1 structural fix

New module `extension/src/background/log.ts`. It is the **only** file under
`extension/src/background/` permitted to reference `console`.

```ts
export type BackgroundWarnEvent =
  | "webauthn-interceptor-register-failed"
  | "copy-command-failed";
export type BackgroundErrorCode =
  | "dom-exception" | "type-error" | "syntax-error" | "error" | "unknown";

export function classifyError(err: unknown): BackgroundErrorCode;
export function warnBackground(event: BackgroundWarnEvent, code: BackgroundErrorCode): void;
```

`warnBackground` takes two closed unions and interpolates nothing else — there is no
free-form slot, so the exemption on this file cannot become a leak. This mirrors
`src/lib/boot-stderr.ts`'s contract, and is why the override lands here rather than on
`background/index.ts`, which holds the vault key and every decrypted blob. An
override on a 1600-line file that handles secret material is precisely what #723's
comment (`eslint.config.mjs:109-113`) warns against.

`classifyError` derives the code from the error's **shape**, never its message or
`cause` — the same rule #723 applied when it deleted `describeUnknownError`.

Structural fix for S1. Revision 2 narrowed **one** parse; the member set inside that
`try` is **three** (R42 applied to throw sites, not just to console sites). The
`catch` at `:1025` spans:

| Site | Parses |
|---|---|
| `index.ts:1012` | decrypted **personal** blob plaintext |
| `index.ts:1395` (via `fetchAndDecryptTeamBlob`, reached from `:994`) | decrypted **team** blob plaintext |
| `index.ts:1396` (same function) | decrypted **team** overview plaintext |

Every other `JSON.parse` in the file (`:1077`, `:1255`, `:1497`, `:1530`, `:2253`,
`:2331`) is outside that `try`, and `getCachedEntries` swallows via
`Promise.allSettled`. The team pair additionally escapes to a *second* surface the
console fix does not touch: `index.ts:2270-2276` (`COPY_PASSWORD`) and its
`COPY_TOTP` twin pass the same error to `normalizeErrorCode`, which returns
`err.message` verbatim (`lib/error-utils.ts:8-14`), and `humanizeError` renders an
unmapped code unchanged into a popup toast. The correct pattern already exists in
this file at `:2252-2257`; the team branch simply never got it.

Narrow inside `fetchAndDecryptTeamBlob`, which closes all five of its callers at
once, rather than at the `:994` call site:

```
- return {
-   blob: JSON.parse(blobPlain) as Record<string, unknown>,
-   overview: JSON.parse(overviewPlain) as Record<string, unknown>,
- };
+ try {
+   return {
+     blob: JSON.parse(blobPlain) as Record<string, unknown>,
+     overview: JSON.parse(overviewPlain) as Record<string, unknown>,
+   };
+ } catch {
+   return null;   // already the documented failure return (:1340/1363/1365/1378);
+ }                // every caller branches on null
```

and in the personal path:

```
- blob = JSON.parse(plaintext) as typeof blob;
+ try {
+   blob = JSON.parse(plaintext) as typeof blob;
+ } catch {
+   warnBackground("copy-command-failed", "syntax-error");
+   return;
+ }
```

Note the personal path **warns rather than returning silently**. Revision 2 spent
all of C1 arguing that diagnosability must survive (F2), then deleted the only
signal on the copy path — leaving a keyboard shortcut that does nothing with no
trace, on exactly the corrupt-blob case an operator would need to diagnose. Here
`warnBackground` is leak-proof by construction (two closed unions, no free-form
slot), so there is no reason to treat the two paths differently.

Both kinds of change are needed, not either: narrowing the parses removes the known
plaintext-bearing errors, and routing through the sink removes the free-form `err`
slot that any *future* throw inside that block could reuse.

**Invariants**

- `I4` (lint-enforced) — no file under `extension/src/background/` other than
  `log.ts` references `console`.
- `I5` (type-enforced) — `warnBackground` has no parameter that can carry a
  caller-supplied string. Absence is a compile error, not a runtime one.
- `I6` — no `JSON.parse` of decrypted plaintext may let its `SyntaxError` escape to
  **any** surface: console, `sendResponse`, or `throw`. "A `catch` that logs" was too
  narrow a predicate — it is what let revision 2 satisfy the invariant on one of
  three members while the other two also reached a rendered popup string.

**Forbidden patterns**

- `pattern: console\.\w+\([^)]*err` in `extension/src/background/**` — reason: `I5`;
  an `Error` is a free-form slot.

**Acceptance criteria**

Criteria 1-2 are **type-enforced** (`I5`) — an implementation returning `err.message`
from `classifyError` is a compile error, not a test failure, and `warnBackground`
has no payload in scope to leak. The tests therefore assert the *mapping* and the
*arity*, which are the properties a compiling mutant can still get wrong:

- `classifyError` maps by shape: `SyntaxError` → `"syntax-error"`, `TypeError` →
  `"type-error"`, `DOMException` → `"dom-exception"`, a bare `Error` → `"error"`,
  a non-Error (`"boom"`) → `"unknown"`. A wrong mapping is a real, compiling mutant.
- `warnBackground("copy-command-failed", "syntax-error")` calls `console.warn` once
  with **exactly one** argument — arity is what would notice a future free-form
  second parameter.
- **In `extension/src/__tests__/background-commands.test.ts`, not `log.test.ts`:** a
  decrypted-but-non-JSON blob in the copy path sends no clipboard message, and the
  single `console.warn` emitted contains no substring of the plaintext. This is the
  only one of the three that can go red today (today `JSON.parse` throws into the
  `:1025` catch and `console.warn("[psso] copy command failed:", err)` prints the
  plaintext prefix), and `log.test.ts` cannot reach the command handler. That file
  already mocks `../lib/crypto` with `decryptData: vi.fn()` and drives
  `handler(CMD_COPY_PASSWORD)` end-to-end, so the case is
  `decryptData.mockResolvedValueOnce("not-json")`.
- The team path equivalent: `fetchAndDecryptTeamBlob` returning `null` on a
  non-JSON team blob, with no `console.warn` carrying plaintext.

### C4 — `eslint.extension.config.mjs`

New root-level config plus wiring:

- `eslint.extension.config.mjs` — flat config; `languageOptions.parser` =
  `@typescript-eslint/parser`; `files: ["extension/src/**/*.{ts,tsx,js}",
  "extension/public/**/*.js"]`; `ignores` for `**/__tests__/**` and `**/*.test.*`;
  `linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" }`;
  rules `no-console: "error"` plus the two `no-restricted-syntax` selectors above.
- **Override list — the audit surface (N2)**, exactly two entries
  (`extension/src/content/select-diag-lib.ts`, `extension/src/background/log.ts`),
  each setting **both** `"no-console": "off"` **and** `"no-restricted-syntax": "off"`.
  Turning off only `no-console` — as revision 2 specified — leaves selector 1 firing
  on the sinks' own `console` reference, so `npm run lint:extension` would be red on
  the very PR that introduces the gate, and the shortest path to green would be the
  inline disable the gate exists to forbid. Verified by execution against stub sinks:
  `no-console: off` alone → exit 1; both off → exit 0.
- `package.json` — add `@typescript-eslint/parser` to `devDependencies` (already
  installed transitively; this makes the dependency explicit and pinnable, per the
  "every dependency is code you now own" rule), and a script
  `"lint:extension": "node scripts/checks/lint-extension.mjs"`.
- `scripts/checks/lint-extension.mjs` — a thin wrapper, **not** a bare `eslint`
  invocation. It runs `eslint --config eslint.extension.config.mjs --max-warnings=0
  --format json extension/src extension/public`, then fails closed on three
  conditions ESLint's own exit code does not cover:
  - `EMPTY_SCAN` — fewer than 50 files linted (62 today). ESLint exits 0, silently,
    when a `files` glob stops matching while the CLI path arguments still exist —
    verified: mistyping `extension/src/**` to `extensionx/src/**` produced exit 0
    and no output while four real violations went unreported. Exit 2 fires only when
    a CLI *path argument* is missing, which is not the failure mode that matters.
  - `MISSING_COVERAGE` — `extension/public/offscreen.js` absent from the linted set.
    That file receives the cleartext password (`clipboard.ts:36-43` ←
    `index.ts:1022 copyToClipboard(blob.password)`), and it is reached by the second
    `files` branch, which nothing else exercises.
  - Any lint error or warning. `--max-warnings=0` matters independently: a file
    outside the config's base path is reported as a *warning* with exit 0, so
    without it a cwd change would turn the gate into a silent pass.
- `scripts/pre-pr.sh` — one `queue_step "Static: extension no-console" npm run
  lint:extension` in the unconditional first batch (alongside
  `Static: console-sinks` at `:282`). `queue_step` records argv and `run_batch` reads
  `wait "${pids[i]}"` per index with no pipe (verified by reading
  `scripts/pre-pr.sh:184-268`), so the exit status is read directly (R44).
- `scripts/pre-pr.sh:32` `app_paths` and `.github/workflows/ci.yml:46` — add
  `eslint\.extension\.config\.` / `"eslint.extension.config.*"`. Neither currently
  matches (`eslint.config.*` ≠ `eslint.extension.config.mjs`), so a PR editing
  **only** that file — which is exactly what adding a third override entry looks
  like — would take `RUN_WEB=0` locally and `app: false` in CI, skipping the
  self-test on the one PR shape where the gate's correctness is at stake. The two
  filters must stay in lockstep (R33).

`extension/public/**` is in scope deliberately. `extension/public/offscreen.js:11-19`
receives the cleartext password (`clipboard.ts:36-43` ← `index.ts:1022
copyToClipboard(blob.password)`) and writes it into a textarea; it is shipped code
handling secret material and has no console call today. Leaving it out would repeat
the revision-1 error of drawing the boundary at where the leak is rather than where
the class can appear.

**Invariants**

- `I7` — the override list has exactly two entries, both of which are typed sinks
  with no free-form slot. A third entry is a review event by construction.
- `I8` — the run fails closed on an empty or partial scan **because
  `lint-extension.mjs` asserts a linted-file floor and named coverage**, not because
  ESLint does. Revision 2 claimed the latter; measured, ESLint exits 0 and silently
  on a `files` glob that stops matching.
- `I9` — an inline `eslint-disable` cannot suppress either rule. `noInlineConfig`
  makes the directive inert and `reportUnusedDisableDirectives` reports it, so the
  bypass is loud rather than silent. Revision 2 listed this as a forbidden pattern
  with no mechanism; verified, a single comment zeroed the whole gate.

**Acceptance criteria**

- `npm run lint:extension` exits 0 against the tree after C1-C3, C5, C6, and reports
  62 files linted.
- It exits 1 on a fixture containing any of the 20 bypass forms.
- It exits 1 on `console.log(x)` placed under `extension/public/`.
- It exits 0 on `obj.console`, `obj["console"]`, `{ console: 1 }`, `console2`,
  `interface { console: boolean }`, `type { console: string }`,
  `class { console = 1 }` — **no**: with the final exclusion-free selector set these
  are all *errors*. The false-positive criterion is instead: **the real tree lints
  clean apart from the four known sites**, which is the measurement that matters and
  which was verified (62 files, 0 unexpected findings).
- It exits 1 on a fixture carrying `// eslint-disable-next-line no-console`.
- It exits 1 (`EMPTY_SCAN`) when the `files` glob is mistyped so nothing matches.
- It exits 1 (`MISSING_COVERAGE`) when `extension/public/**` drops out of `files`.

**Consumer-flow walkthrough**

- Consumer 1 (`scripts/pre-pr.sh`) reads the process exit status directly.
- Consumer 2 (CI `static-checks`) inherits via `pre-pr.sh`; no workflow edit needed
  — verified against `ci.yml:159-228`.
- Consumer 3 (`scripts/checks/check-gate-selftest-coverage.sh`) — **applies, and
  that is now deliberate.** Its member set (1) is `ls scripts/checks/*.sh
  *.mjs` (`:123`), so placing the wrapper at `scripts/checks/lint-extension.mjs`
  puts the gate inside the meta-gate's scope and makes `scripts/__tests__/`
  `lint-extension.test.mjs` a CI-enforced requirement — the self-test cannot be
  deleted silently. Revision 2 put the invocation directly in `pre-pr.sh`, which
  matched neither member set and left the self-test unprotected. The config file
  itself (`eslint.extension.config.mjs`, repo root) is outside both member sets;
  the `app_paths` / `ci.yml` filter additions above are what keep *it* covered.

### C5 — combined-expiry guard (pre-existing defect, R34)

`extension/src/content/autofill-cc-lib.ts:119-122`. The split-expiry branch guards on
payload presence; the combined branch does not:

```ts
if (fields.expiryFormat === "combined" && fields.expiryCombined) {
  const combined = formatCombinedExpiry(payload.expiryMonth, payload.expiryYear, format);
  setInputValue(fields.expiryCombined, combined);
} else {
  if (fields.expiryMonth && payload.expiryMonth) { … }   // guarded
  if (fields.expiryYear  && payload.expiryYear)  { … }   // guarded
}
```

Only the card number is required upstream (`background/index.ts:1565-1576`:
`expiryMonth: blob.expiryMonth ?? ""`), and `formatCombinedExpiry("", "", "MM/YY")`
yields `"00/00"` via `"".padStart(2, "0")` (`cc-form-detector-lib.ts:163-181`). So a
card entry saved without an expiry writes the literal `00/00` into a single `MM/YY`
checkout field and dispatches `input`/`change`/`keyup`/`blur`, overwriting whatever
the user typed.

The file is in this diff, so Anti-Deferral puts it in scope. Fix mirrors the split
branch:

```
- if (fields.expiryFormat === "combined" && fields.expiryCombined) {
+ if (fields.expiryFormat === "combined" && fields.expiryCombined
+     && payload.expiryMonth && payload.expiryYear) {
```

**Acceptance criteria**

Three empty-expiry cases, not one — the defect class is the whole conjunction, and
the partial cases are equally destructive (today `("12","")` yields `"12/00"`). The
split branch cannot pick up the slack: `detectCreditCardFields` forces
`expiryMonth`/`expiryYear` to `null` whenever `hasCombined`
(`cc-form-detector-lib.ts:239-246`), so the `else` branch is a guaranteed no-op for
combined forms and cannot fabricate a partial write either.

- `("", "")`, `("12", "")`, `("", "2030")` — each leaves `field.value === ""` (red
  today: `"00/00"`, `"12/00"`, `"00/30"`).
- Each also asserts **no events dispatched**: `field.addEventListener("change", fn)`
  → `expect(fn).not.toHaveBeenCalled()`. `setInputValue` fires four events
  (`input`/`change`/`keyup`/`blur`, `autofill-cc-lib.ts:33-36`), and a page listener
  reacting to a phantom fill is the user-visible half of scenario 6 — revision 2
  stated "events untouched" in the criterion but assigned no assertion.
- A real expiry still fills, across all four formats `detectExpiryFormat` returns
  (`MM/YY`, `MM/YYYY`, `MMYY`, `MMYYYY` — `cc-form-detector-lib.ts:147-161`, selected
  by `placeholder` or `maxLength ∈ {7,5,6,4}`). Verified: `formatCombinedExpiry`
  consumes both month and year in all four, so no format legitimately uses only one
  — the guard narrows no working path.

### C6 — drop the unused `idNumber` from the identity payload

`extension/src/background/index.ts:1618` sends `idNumber: blob.idNumber ?? ""` and
`extension/src/types/messages.ts:233` declares it, but `performIdentityAutofill`
never reads it (`rg 'idNumber' extension/src/content/` → no matches). A national-ID
or passport number therefore crosses into the page's renderer process for no
functional reason. The surrounding code already applies this discipline —
`autofill-cc-lib.ts:143` wipes `payload.cvv` immediately after use — so the omission
is inconsistent with the file's own minimisation pattern.

**Three** edits, not two. `rg 'idNumber' extension/src` returns four hits:
`background/index.ts:1528` (the local decrypted-blob type — stays), `:1618` (payload
construction — remove), `types/messages.ts:233` (type member — remove), and
`__tests__/content/autofill-identity.test.ts:45` (the `payload()` factory — remove).
The test hit is not optional: the factory returns `IdentityAutofillPayload`, and a
trailing spread does not suppress TypeScript's excess-property freshness check, so
leaving it is `TS2353`. It is nevertheless invisible to every command in the
verification table except the plan's own grep, because `extension/tsconfig.json`
excludes `src/__tests__` and vitest transpiles types away — **nothing statically
checks the extension test tree**, which is worth knowing beyond this contract.

**Acceptance criteria**

- `rg 'idNumber' extension/src` returns only `background/index.ts:1528`.
- Identity autofill still fills every field it filled before. Verified this claim
  rather than assuming it: across the 14 identity tests all 14 fillable fields are
  asserted, and `idNumber` was never among them — so the removal is genuinely
  invisible to behaviour. (Revision 2 cited "the existing 29 tests"; 29 is both
  autofill files combined, the identity file has 14.)

### C7 — tests

**`extension/src/__tests__/content/select-diag.test.ts`** (new, jsdom docblock) —
the seven C1 acceptance criteria, constant imported (RT3).

**`extension/src/__tests__/content/autofill-identity.test.ts`** and
**`autofill-cc.test.ts`** (existing) — C2 and C5 regressions. Fixture requirements,
each of which round 1 proved necessary:

- The fixture must satisfy the detector or nothing runs:
  `identity-form-detector-lib.ts:272` returns `null` when `fieldCount < 2`, and
  `cc-form-detector-lib.ts:236` returns `null` when there is no card number. So the
  identity fixture carries `<input autocomplete="tel">` alongside the country
  `<select>`, and the card fixture carries `<input autocomplete="cc-number">`
  alongside the year `<select>`. Without this the denial assertion passes against
  nothing.
- Each `<select>` leads with `<option value="">…</option>`, matching every existing
  fixture, so "unchanged" is `""`. With a `JP`/`US`-only list the browser
  auto-selects index 0 and `expect(select.value).toBe("JP")` would be satisfied by
  both the correct early `return` and by a fuzzy match picking the first option —
  it could not distinguish the behaviour F3 forbids from the one it requires.
- F3 is additionally pinned by a listener, not only by the value:
  `select.addEventListener("change", onChange)` → `expect(onChange).not.toHaveBeenCalled()`.
  `setSelectValue` dispatches `input`+`change` only on the match path, so this asserts
  the `return` itself.
- Assertions run over **all** arguments of **every** recorded call, not `calls[0][0]`:
  a future edit to `logNoSelectMatch(select)` → `console.debug(msg, targetValue)`
  would re-leak while a first-argument assertion stayed green. Arity is pinned
  (`toHaveLength(1)`) for the same reason. Asserting over every call rather than
  pinning the count at 1 also keeps the test correct if the fixture later grows a
  second `<select>` — the count is not the security property.
- **But universal quantification over `spy.mock.calls` is vacuously true at zero
  calls**, which is the same hole the fixture fix closed from the other side. So the
  set carries a reachability floor and a type pin:
  `expect(spy.mock.calls.length).toBeGreaterThan(0)` and, per call,
  `expect(args.every(a => typeof a === "string")).toBe(true)`. The type pin is not
  decoration: `console.debug(msg, select)` passing the *element* renders as
  `[object HTMLSelectElement]` under a `join`, so a string-only assertion would stay
  green while DevTools/CDP serialise the live node including its selected value.
  Without the floor, one regex edit in `identity-form-detector-lib.ts` makes the
  fixture undetectable again and the whole assertion set goes quietly green.
- Payload values are chosen so a leak of the **normalised** form is textually
  distinguishable from a leak of the raw form (`I3`): the card fixture uses
  `expiryYear: "99"` (`normalizeYearValue("99")` → `"2099"`) and asserts neither
  `"99"` nor `"2099"` appears; the identity fixture asserts both `"Nowhereland"` and
  `"nowhereland"`. With revision 2's `"2099"` the two leaks were the same string and
  `I3` had no assertion that could tell them apart.
- Entry point is `performIdentityAutofill` / `performCreditCardAutofill`, never an
  exported `setSelectValue` (RT5).
- `const spy = vi.spyOn(console, "debug").mockImplementation(() => {})` inside the
  test, with `afterEach(() => vi.restoreAllMocks())` added to both files.
  `extension/vitest.config.ts` sets no `restoreMocks`/`clearMocks`, and `vi.spyOn` on
  an already-spied method returns the existing mock with its history intact — without
  this the assertions become order-dependent, and without `mockImplementation` the
  diagnostic prints into every later test's output.
- `RS4`: synthetic values only — `"Nowhereland"`, `"2099"`, `"555-0100"`,
  `"4111111111111111"`.

**Red-proof (RT7), stated per assertion.** Against pre-C2 code the red is carried by
exactly two assertions — "arguments contain the select name" (today's message has no
label) and "arguments do not contain the payload value". `toHaveLength(1)` and the
`change`-listener assertion are green both before and after; they are vacuity guards,
not the proof. C5's red is `expect(field.value).toBe("")` against today's `"00/00"`.

**`extension/src/__tests__/background/log.test.ts`** (new) — the three C3 acceptance
criteria.

**`scripts/__tests__/lint-extension.test.mjs`** (new) — RT7 for C4, and required by
`check-gate-selftest-coverage.sh` (see C4 Consumer 3).

The fixture harness is the part revision 2 got wrong, and it fails *silently* in the
direction that matters. ESLint 9 resolves `files` globs against **cwd**, and reports
a file outside the config's base path as a *warning with exit 0*. So fixtures written
to a flat temp dir produce exit 0 for every case: the positive cases fail loudly
(good), but any case asserting exit 0 passes for the wrong reason, permanently.

Two harnesses were probed and both work; the plan specifies the first:

1. **`--stdin --stdin-filename`** with a virtual path inside the glob
   (`extension/src/content/probe.ts`, `extension/public/probe.js`), `cwd: REPO_ROOT`,
   `--format json`. No file is written anywhere. Verified: `console.log(x)` →
   `["no-restricted-syntax","no-console"]`; `const c = console; c.log(x)` →
   `["no-restricted-syntax"]`; the disable-directive fixture → still errors.
2. A temp tree shaped `<tmp>/extension/src/content/…` with `cwd: <tmp>`.

Assert the **rule-id set**, not only the exit status — a run that linted nothing and
a run that linted and found nothing are otherwise indistinguishable, which is the
exact vacuity this self-test exists to rule out. Cases: one per bypass form, one per
`files` branch (`extension/src` and `extension/public`), the `ignores` branch
(`extension/src/x.test.ts` → clean, proving the test exemption is scoped), the
inline-disable case, and `EMPTY_SCAN` / `MISSING_COVERAGE` driven against
`lint-extension.mjs` with a deliberately mistyped glob. The spelling table in this
plan is generated from these cases so document and executable cannot drift.

## Testing strategy

| Layer | Command | Covers |
|-------|---------|--------|
| Extension unit | `cd extension && npm test` | C1, C2, C3, C5, C6 |
| Lint self-test | `npx vitest run scripts/__tests__/lint-extension-config.test.mjs` | C4 |
| Lint | `npm run lint:extension` | C4 against the real tree |
| Type | `cd extension && npx tsc --noEmit` | C1, C3 signatures |
| Build + bundle assertion | `cd extension && npm run build`, then `! grep -r "No exact match for select value:" extension/dist` and `grep -rq "No exact match for select:" extension/dist` | that the *shipped artifact*, not just the source, lost the literal — the one automatable part of VC1 |
| Full | `bash scripts/pre-pr.sh` | wiring, no regression elsewhere |

`npx next build` is **not** required: the diff touches `extension/`, `scripts/`, and
root lint config only — no `src/` file. Recorded so the skip is a decision, not an
omission.

## Considerations & constraints

### Scope contract

- `SC-A` — **withdrawn.** Revision 1 deferred the two `background/` sites; the
  security expert refuted the premise and the functionality expert independently
  reached the same conclusion. Now C3.
- `SC-B` — **partially withdrawn.** Revision 1 deferred ESLint for `extension/` on
  the stated ground that it would require "a sweep of every pre-existing violation
  across the whole extension source tree". Measured, the sweep is four call sites.
  C4 introduces `no-console` + the console-reference ban. What remains deferred is
  the *rest* of a lint config for `extension/` — type-aware rules, React rules,
  `no-explicit-any`. Owner: a future standalone PR. Worst case of deferring: latent
  quality issues in extension code, none security-bearing. Likelihood: certain that
  some exist. Cost to fix: a full config plus a violation sweep across 118 files,
  well over 30 minutes, and it would bury this diff.
- `SC-C` — **the near-duplicate `setSelectValue` in the two autofill libs is not
  commonised** (R1). Owner: future refactor PR. Worst case: a future fix applied to
  one copy and not the other. Likelihood: low — C2 touches both and C7 tests both
  separately. Cost to fix: rewriting a security-reviewed silent-failure matcher
  inside a log-hygiene PR, which would make the diff unreviewable as a privacy fix.
- `SC-D` — **RT9 twin drift does not apply**, verified: none of the three tracked
  `.js` files contains a `console.*` call and neither autofill lib has a `.js` twin.
  Unlike revision 1, this is *not* used to conclude those files need no attention —
  C4's scan covers `extension/public/**` precisely because coverage and current
  contents are different questions.

### Risks

- `RK1` — `no-restricted-syntax` messages are terse. Each selector carries a message
  naming the sink module to use, so a contributor who hits it has a pointer.
- `RK2` — Truncating at 64 characters could make two selects on a pathological page
  produce the same label. Accepted: the label is a debugging aid, not an identifier.
- `RK3` — `@typescript-eslint/parser` moves from transitive to direct. If a future
  `eslint-config-next` bump changes its major, the extension lint breaks
  independently of the app lint. That is the intended trade: an explicit dependency
  that can be pinned beats an implicit one that can vanish.
- `RK4` — `select-diag-lib.ts` enters both content bundles. It is ~25 lines of pure
  code; the build step in the verification set confirms no module-resolution
  surprise.

## User operation scenarios

1. **Japanese checkout, prefecture `<select>`.** Vault holds `region: "Tōkyō"`, page
   options are `東京都`. No match → today the page console shows `Tōkyō`; after, the
   select's `name`, e.g. `pref`.
2. **US checkout, `<select name="state">` with two-letter codes.** Vault holds
   `California` → today logged verbatim.
3. **Card form, `<select name="cc-exp-year">` listing `25`–`30`.** Vault expiry
   `2031`; `normalizeYearValue` yields `2031`, no option matches → today logged.
4. **Date of birth as three `<select>`s.** A partial mismatch logs the raw DOB
   component — the case that makes "name and address" an understatement.
5. **Anonymous `<select>`** (no `name`, no `id`) → label `"(unnamed)"`; the message
   still confirms a select failed, which is the floor of F2.
6. **Card entry with no expiry, checkout with one `MM/YY` field.** Today the field is
   overwritten with `00/00` after the user typed a real expiry; after C5 it is left
   alone.
7. **Hostile page** sets `name="&#10;[passwd-sso] vault unlocked: user=admin@corp.example"`
   on a `<select>` and offers no matching option. Today's message would carry the
   forged line into any console-capturing CI or telemetry pipeline; after C1 the
   newline is replaced and the label is truncated.
8. **Copy-password on an entry whose decrypted blob is not valid JSON.** Today the
   service-worker console shows `Unexpected token 'S', ..."password":S3cr3t-Pas"...`;
   after C3 the command returns silently.
9. **Regression scenario.** A contributor adds `const c = console; c.log(payload.email)`
   to a content script. `npm run lint:extension` fails in pre-pr before the PR opens —
   the spelling the revision-1 gate would have missed.

## Round 1 outcome

12 Testing findings (T1-T12), 11 Security (S1-S11), 9 Functionality (F1-F9).
Three findings converged across all three experts (allowlist keyed by `path:line`),
and four across two experts. Dispositions:

| Findings | Disposition |
|---|---|
| F1 / T9 / S5 (allowlist `path:line`), F2 / S4 (labeller by name not binding), S3 (console spelling class), S2 / T12 (scan root excludes `public/`), T8 / S7 (empty-scan tripwire), F4 (C4 consumer walkthrough), F8 (gate over-built) | Resolved by replacing the bespoke gate with C4. None of these mechanisms exists any more. |
| S1 / F9 (SC-A premise false) | C3. `SC-A` withdrawn. |
| F5 (`00/00` combined expiry) | C5. |
| S8 (`idNumber` over-transmission) | C6. |
| S6 (unsanitised label), S10 (`I1` denylist too narrow) | C1 — sanitise-then-truncate; `I1` red-proved positively in C7. |
| T1 / F3 (fixtures unreachable), T2 / S11 (first-argument-only), T3 (vacuous F3 assertion), T4 (no test file / jsdom), T5 (`I1` untested), T6 (truncation boundary), T10 (spy not restored) | C7. |
| T7 (gate clauses un-red-proved) | Resolved by C4 + its self-test, which exercises every spelling. |
| T11 (built-bundle grep) | Testing strategy. |
| S9 (threat-model text), F6 (rejected-alternative justifications), F7 (`getHintString`) | Plan prose corrected above. |

One round-1 claim was itself refuted and is recorded rather than silently dropped:
S3's supporting statement that ESLint's `no-console` catches `const c = console` is
false, verified by execution. The finding's *conclusion* (spelling-based matching is
bypassable) stands and is what C4's `no-restricted-syntax` selectors exist to close.

## Round 2 outcome

13 Testing findings (T13-T21 plus five round-1 reopens), 7 Security (S12-S18),
10 Functionality (F10-F19). Convergence was high: three experts independently found
the gate could go silently vacuous, and two each found the `eslint-disable` bypass,
the incomplete `JSON.parse` member set, the unsatisfiable override block, the
under-specified self-test harness, and the third `idNumber` site.

| Findings | Disposition |
|---|---|
| F10 / S14 (override must disable both rules), F13 / S14 (inline-disable bypass), F17 / S15 (selector residuals), F16 (TS-shape false positives), S17 (wrong table row) | C4 — rule set rebuilt with no exclusions and `noInlineConfig`, re-verified by execution: 20/20 bypass forms caught, 0 false positives across 62 real files. |
| F11 / T8 / S18 (gate silently vacuous), T12 (`public` branch untested), T17 (self-test unscheduled) | C4 — `scripts/checks/lint-extension.mjs` wrapper with `EMPTY_SCAN` / `MISSING_COVERAGE` / `--max-warnings=0`; wrapper placement brings the meta-gate into play; `app_paths` + `ci.yml` filters added. |
| F12 / S13 (1 of 3 `JSON.parse` sites), F18 (diagnosability discarded), T14 (criterion in the wrong file) | C3. |
| S12 / T5 (sink takes the whole DOM graph) | C1 — parameter narrowed to `SelectIdentity`; `I1` becomes type-enforced. |
| S16 / T18 (sanitiser residuals, vacuous fixture) | C1 — code-point truncation, positive-allowlist assertion, JSON round-trip. |
| T1 (vacuous at zero calls), T19 (`normalizedTarget` indistinguishable), T20 (type-carried criteria presented as tests), T21 (unspecified message literal), T16 / F14 (self-test harness) | C7 / C1. |
| T15 (expiry class one member short) | C5 — three cases plus event assertions. |
| T13 / F15 (third `idNumber` site) | C6. |
| F19 (seven contracts is a grab-bag; cut C5) | **Kept in scope by explicit user decision.** The expert's reasoning is sound — a payment-form fill-behaviour change reads differently from a log-hygiene change — and its fallback advice is followed: the PR subject names the expiry fix, and C5's tests live in their own `describe` block. |

Two round-2 claims were themselves refuted by execution and are recorded rather than
adopted: S15's proposed selector (built on
`:not(MemberExpression[computed=false] > .property)`) misses 10 of the 20 bypass
forms, because the exclusion that spares `obj.console` is the same one that blinds
the rule to `globalThis.console`; and S17 correctly caught that revision 2's own
table had a wrong row. Both are why the final rule set carries no exclusions at all.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Content-script diagnostic sink (`select-diag-lib.ts`) | locked |
| C2 | Call-site rewrite in both autofill libs | locked |
| C3 | Service-worker sink + `JSON.parse` narrowing (S1) | locked |
| C4 | `eslint.extension.config.mjs` + `scripts/checks/lint-extension.mjs` + wiring | locked |
| C5 | Combined-expiry guard (F5) | locked |
| C6 | Drop unused `idNumber` from identity payload (S8) | locked |
| C7 | Tests | locked |
