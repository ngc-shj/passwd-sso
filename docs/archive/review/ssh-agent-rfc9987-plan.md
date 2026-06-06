# Plan: ssh-agent-rfc9987 — RFC 9987 conformance + audited per-signature SSH agent

## Project context

- **Type**: mixed — a CLI tool (`cli/`, Node/TypeScript) plus a server surface (Next.js App Router route handler + Prisma).
- **Test infrastructure**: unit + integration (vitest) + CI/CD. CLI has `cli/src/__tests__/`; server has co-located `*.test.ts` and a real-DB integration suite (`npm run test:integration`).
- **Verification environment constraints** (each contract's manual-test path is classified against this list):
  - **VC1 — real OpenSSH client handshake**: `session-bind@openssh.com` is only emitted by a real `ssh`/`ssh-add` against the agent socket. The signature-over-session-id verification path (C6) cannot be exercised by unit tests with synthetic input alone for true end-to-end fidelity. Classification: unit-testable with **captured golden vectors** (verifiable-local); full live handshake = `blocked-deferred` to manual test (`ssh -T`, `ssh-add -l`). Cost-justification: capturing a live session-bind frame once and committing it as a fixture is < 30 min and gives `verifiable-local` coverage of the parser+verifier; only the live-ssh wiring is deferred.
  - **VC2 — Unix domain socket**: agent is Unix-socket only (no Windows). Socket-permission and TOCTOU paths are `verifiable-local` on Linux/macOS CI runners.
  - **VC3 — server reachability for per-sign authorize**: the audited signing path (C3/C7) requires the server reachable. Unit tests mock `apiRequest`; the live round-trip against a running server is `blocked-deferred` to manual test. Cost: integration-test addition deferred (see SC2).
  - **VC4 — TTY for CONFIRM**: the interactive confirmation (C8) requires a controlling terminal; CI has none. The TTY prompt is tested by mocking the prompt function (`verifiable-local`); a real terminal prompt is `blocked-deferred` to manual test.

## Objective

Bring the existing vault-backed SSH agent (`cli/src/commands/agent.ts`, `cli/src/lib/ssh-agent-*.ts`) into conformance with **RFC 9987 (SSH Agent Protocol)**, and add an **audited, per-signature server-authorization** layer plus **agent-forwarding hijack protection** (`session-bind@openssh.com`) and a **per-key confirmation** path (`requireReprompt`).

The agent currently implements only `REQUEST_IDENTITIES (11)` and `SIGN_REQUEST (13)`, loads all keys at startup, and signs locally with **zero server interaction and no audit trail**. The decrypt agent (`agent-decrypt.ts`) already performs per-request server authorization; this plan brings the SSH agent to parity and aligns its wire protocol with the now-published RFC.

## Requirements

### Functional

1. **RFC 9987 conformance** (scope item, user-selected):
   - Honor `REMOVE_ALL_IDENTITIES (19)` "regardless of policy" (RFC mandate) — clear in-memory keys, return `SSH_AGENT_SUCCESS (6)`.
   - Implement the extension mechanism `SSH_AGENTC_EXTENSION (27)`: support the `query` extension (advertise supported extension names) and `session-bind@openssh.com`; reply with an **empty `SSH_AGENT_FAILURE`** to unknown extensions (RFC requirement).
   - Add the missing response constants (`SSH_AGENT_SUCCESS=6`, `SSH_AGENT_EXTENSION_FAILURE=28`, `SSH_AGENT_EXTENSION_RESPONSE=29`).
   - Continue to refuse `ADD_IDENTITY`/`REMOVE_IDENTITY`/`LOCK`/`UNLOCK`/smartcard ops with `SSH_AGENT_FAILURE` (read-only agent — RFC-compliant).
   - Update the source reference from `draft-miller-ssh-agent` to `RFC 9987`.
2. **Agent-forwarding safety** (scope item): parse and **cryptographically verify** the `session-bind@openssh.com` extension, store the binding (host-key fingerprint, is-forwarding flag) **per socket connection**, and carry it into the audit metadata of every subsequent signature on that connection.
3. **Audited per-signature authorization** (scope item, user-selected model): before performing each `SIGN_REQUEST`, the agent calls a new server endpoint that (a) authorizes the operation against the live state of the vault entry and (b) emits an audit event. Authorized → sign locally → return signature. Denied or unreachable → `SSH_AGENT_FAILURE` (fail-closed).
4. **Confirmation flow** (scope item): keys whose vault entry has `requireReprompt = true` require explicit per-signature user confirmation via the controlling TTY. No TTY available → fail-closed deny with a logged reason.

### Non-functional

- **Threat-model honesty (explicit)**: the private key is decrypted into the agent's memory (this is unchanged and unavoidable for an SSH agent). Per-signature server authorization therefore **cannot** prevent a *compromised agent process* from signing locally — a process holding the key can always sign. The security value of per-sign authorize is precisely scoped to: (i) **audit** of honest-agent signatures, (ii) **honest-agent revocation/policy** (a deleted/archived entry, travel mode, or tenant policy makes the honest agent decline immediately rather than only at next restart). This boundary MUST be stated in code comments and docs; the plan does NOT claim per-sign authorize defends against a malicious client. Likewise, `host`/`fingerprint` fields the agent reports to the server are **client-asserted** (the server cannot re-derive them: the public key lives in the E2E-encrypted blob). For the **honest** agent they are accurate because the agent verifies the `session-bind` signature locally (C6); they are audit metadata, not server-enforced security claims.
- Response ordering on a connection MUST remain strictly sequential (RFC: the agent processes requests in order and replies in order). Introducing an `await` (server round-trip) into the message loop MUST NOT allow a later request's reply to overtake an earlier one.
- Server-side gate (NOT token-level least privilege in v1 — see C2 "Token scope reality" + SC6): the authorize endpoint requires a dedicated `ssh:sign` scope, so a token lacking `ssh:sign` is rejected (403) and SSH signing is a distinct explicit grant. Honesty note: the v1 SSH-agent token shares the single `CLI_SCOPES` token and therefore still carries `credentials:use` (it CAN decrypt in v1); a sign-only token without decrypt is deferred to SC6. This avoids overclaiming a least-privilege property the single-token CLI does not deliver.

## Technical approach

- **Server**: one new route handler `POST /api/vault/ssh/sign-authorize`, mirroring the auth/scope/rate-limit/audit shape of `src/app/api/vault/delegation/check/route.ts`. Route-handler auth (`authOrToken` + `hasUserId`), `ssh:sign` scope, 120/min rate limit, fail-closed on Redis-unavailable.
- **Audit**: two new actions `SSH_KEY_SIGN` (granted) and `SSH_KEY_SIGN_DENIED` (refused), in a new `SSH` audit-action group (PERSONAL + TENANT scopes), with en/ja labels and the exhaustive-coverage tests updated.
- **Scope**: new `MCP_SCOPE.SSH_SIGN = "ssh:sign"`, risk level `"use"`, consent-UI descriptions (en/ja), and added to the CLI's requested scope set.
- **CLI protocol layer**: extend `ssh-agent-protocol.ts` with the missing constants and builders; refactor `ssh-agent-socket.ts` so each connection owns a binding-state object and the message loop awaits the (now async) sign path while preserving order.
- **CLI session-bind**: new module `cli/src/lib/ssh-session-bind.ts` parses + verifies the extension payload, reusing existing key-parsing helpers where possible.
- **CLI authorizer**: new module `cli/src/lib/ssh-sign-authorizer.ts` wraps the `apiRequest` call to the new endpoint.
- **CLI confirm**: new helper `cli/src/lib/ssh-confirm.ts` prompts on `/dev/tty`; absence of a TTY → deny.

---

## Contracts

### C1 — Audit actions `SSH_KEY_SIGN` / `SSH_KEY_SIGN_DENIED` and `group:ssh` action group

- **Signatures**:
  - **`prisma/schema.prisma`** `enum AuditAction` (line 868): add members `SSH_KEY_SIGN`, `SSH_KEY_SIGN_DENIED` + a new Prisma migration (`npm run db:migrate`, run against the dev DB before PR per R21). **[R1F1 — this was missing in round 1; `AUDIT_ACTION` is `} as const satisfies Record<AuditAction, AuditAction>` at audit.ts:207, so the const-object will not compile without the enum members, and `logAuditAsync` inserts into a DB enum column.]**
  - `AUDIT_ACTION.SSH_KEY_SIGN = "SSH_KEY_SIGN"`, `AUDIT_ACTION.SSH_KEY_SIGN_DENIED = "SSH_KEY_SIGN_DENIED"` (`src/lib/constants/audit/audit.ts`).
  - `AUDIT_ACTION_GROUP.SSH = "group:ssh"` (new group key — **must follow the `"group:<camel>"` convention**, e.g. `DELEGATION: "group:delegation"` at audit.ts:411; a bare `"SSH"` breaks the i18n group-label derivation `group.split(":")[1].charAt(0)` in `audit-log-keys.test.ts:40`). **[R1T1/F2]**
- **Scope decision** (resolves R1 F3+F4): SSH signing audit rows are emitted **PERSONAL-scope only** (C3 uses `personalAuditBase`, mirroring delegation/check). The `group:ssh` group is registered **only in `AUDIT_ACTION_GROUPS_PERSONAL`** — NOT TENANT, NOT TEAM, NOT `TENANT_WEBHOOK_EVENT_GROUPS`. Tenant-scope governance/webhook delivery of SSH signing is deferred (SC3). This keeps display-group membership consistent with the scope that is actually emitted, and avoids flooding tenant audit logs with per-`git push` rows.
- **Invariants**:
  - **type-enforced + schema-enforced** (strongest form): both actions are members of the Prisma `enum AuditAction` (DB rejects unknown values) AND satisfy the `Record<AuditAction, AuditAction>` constraint on the const-object (compile error if absent).
  - **app-enforced**: both actions appear in `AUDIT_ACTION_VALUES`, belong to the `group:ssh` group under `AUDIT_ACTION_GROUPS_PERSONAL` (satisfies the "every action belongs to ≥1 scope group" test, `audit.test.ts:215`).
  - **app-enforced**: each action has an i18n label key (key === action string) AND the group has a `groupSsh` label, in both `messages/en/AuditLog.json` and `messages/ja/AuditLog.json`.
- **Forbidden patterns**:
  - `pattern: SSH_KEY_SIGN` in `audit.ts` const-object but absent from the Prisma enum or `AUDIT_ACTION_VALUES` — reason: compile/runtime failure + R12 coverage gap.
  - `pattern: AUDIT_ACTION_GROUP.SSH\s*=\s*"SSH"` (bare value, no `group:` prefix) — reason: breaks i18n group-label derivation.
  - `pattern: ボルト|ボールト` in new ja labels — reason: ja "vault" must be 保管庫 only.
- **Acceptance criteria**:
  - `npx vitest run src/lib/constants/audit/audit.test.ts src/__tests__/i18n/audit-log-keys.test.ts` passes (VALUES↔AUDIT_ACTION alignment, ≥1-scope-group, per-action en+ja label, `groupSsh` en+ja group label).
  - ja labels use 保管庫 / no katakana; en labels user-domain ("SSH key signed" / "SSH key signing denied"), no internal jargon (R37).
  - **Consumer-flow walkthrough**:
    - Consumer A (audit-log filter UI + `AUDIT_ACTION_GROUPS_PERSONAL`) reads action→`group:ssh` mapping + i18n keys to render/label. Required: PERSONAL group membership + per-action label + `groupSsh` label — all present.
    - Consumer B (webhook subscription, `TENANT_WEBHOOK_EVENT_GROUPS` at audit.ts:734) — **explicitly NOT a consumer in v1**: display and subscription groupings diverge (R11 — verified hand-picked definition); SSH signing is PERSONAL-scope so it is not tenant-webhook-deliverable by construction (SC3).

### C2 — New scope `ssh:sign`

- **Signatures** (`src/lib/constants/auth/mcp.ts`):
  - `MCP_SCOPE.SSH_SIGN = "ssh:sign"`; `McpScope` union gains the member automatically (derived type).
  - `MCP_SCOPE_RISK[MCP_SCOPE.SSH_SIGN] = "use"`.
- **Locked four-file edit set** (R1 F7 — `MCP_SCOPES = Object.values(MCP_SCOPE)` at mcp.ts:19, so well-known/DCR-register/consent-gate/authorize-gate/mcp-client-card all auto-pick-up; only these need manual edits):
  1. `src/lib/constants/auth/mcp.ts` — `MCP_SCOPE.SSH_SIGN` + `MCP_SCOPE_RISK` entry.
  2. `messages/en/McpConsent.json` — `scopeDescriptions["ssh:sign"]`.
  3. `messages/ja/McpConsent.json` — `scopeDescriptions["ssh:sign"]` (保管庫, no katakana).
  4. `cli/src/lib/oauth.ts` — `CLI_SCOPES` (line 19, single constant feeding the register payload, token, and authorize URL).
- **Token scope reality** (R2 F11 — honest reframing; the round-1 "must exclude `credentials:use`" criterion was architecturally impossible): the CLI mints **one** OAuth token for ALL commands via the shared `CLI_SCOPES` constant (`oauth.ts:19`, feeds register/token/authorize). `decrypt`/`agent-decrypt` legitimately need `credentials:use` (delegation create gates on it, `delegation/route.ts:131`), so the SSH-agent token unavoidably carries it too in v1. The security property delivered is therefore NOT "an SSH token cannot decrypt" but: **`ssh:sign` is a distinct server-side gate** — the sign-authorize route rejects any token lacking `ssh:sign` (403), so SSH signing requires explicit grant. The converse minimization (a sign-only token without decrypt) requires per-command/sub-token scoping — out of scope for the single-token CLI (deferred, SC6). This is stated as a cost/limitation, not claimed as a least-privilege property the architecture does not deliver.
- **Invariants**:
  - **type-enforced**: `MCP_SCOPE_RISK` is `Record<McpScope, ScopeRiskLevel>` — compile error if the new member is missing. `mcp.test.ts:22-31` additionally asserts key parity (belt-and-suspenders).
  - **app-enforced**: `scopeDescriptions` en+ja entries exist. **No CI gate** — the consent form degrades to `scopeDescriptions?.[scope] ?? scope` (`consent-form.tsx:139`), so a missing description silently shows the raw `ssh:sign` string. This is a manual checklist item.
- **Forbidden patterns**:
  - `pattern: "ssh:sign"` as a string literal outside `mcp.ts` and the i18n key in `McpConsent.json` — reason: scope strings reference the `MCP_SCOPE` constant (const-object rule).
- **Acceptance criteria**:
  - `MCP_SCOPE_RISK[MCP_SCOPE.SSH_SIGN] === "use"`; add the matching assertion to `mcp.test.ts`.
  - `CLI_SCOPES` includes `ssh:sign` (it retains `credentials:use` for decrypt/agent-decrypt — see "Token scope reality").
  - **Existing-token migration (R1 F6)**: granted scopes are frozen on issued tokens; after upgrade, an agent using a pre-`ssh:sign` token gets `403 unauthorized` (scope-insufficient) on every sign → fail-closed deny. The CLI authorizer (C7) MUST distinguish this scope-deny (`401/403 unauthorized`) from an entry-deny (`403 entry_not_found`) and print a clear "re-run `passwd-sso login` to grant SSH signing" message. Documented in the manual-test plan + user scenarios.

### C3 — Server endpoint `POST /api/vault/ssh/sign-authorize`

- **Signature** (route handler, file `src/app/api/vault/ssh/sign-authorize/route.ts`):
  - Method: `POST`. Auth: `authOrToken(request, MCP_SCOPE.SSH_SIGN)` then `hasUserId` guard (rejects SA / null-userId mcp tokens).
  - Request body (Zod schema — keyId regex NOT `.uuid()`, per R1 F5/S3, because PasswordEntry IDs are mixed CUID/UUID):
    ```
    {
      keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)  // PasswordEntry id (CUID or UUID), mirrors delegation/check
      fingerprint: z.string().max(100)                   // "SHA256:<base64>" — client-asserted audit metadata only
      host: z.object({
        hostKeyFingerprint: z.string().max(100),         // from VERIFIED session-bind (C6)
        forwarded: z.boolean(),                          // is_forwarding flag — AUDIT-ONLY in v1 (server ignores for authz)
      }).optional()
    }
    ```
  - Success response (200): `{ authorized: true }` — **intentionally omits** `sessionId`/`expiresAt` from the delegation/check mirror (no session object in the per-sign model; R1 F8).
  - Failure responses:
    - 401 `{ authorized: false, reason: "unauthorized" }` — no/failed auth
    - 403 `{ authorized: false, reason: "unauthorized" }` — scope insufficient or no userId
    - 403 `{ authorized: false, reason: "entry_not_found" }` — entry missing, **owned by a different user**, not `SSH_KEY`, archived, or soft-deleted
    - 400 `{ authorized: false, reason: "invalid_params" }` — body validation failed
    - 429 `{ authorized: false, reason: "rate_limit" }` — > 120/min per userId
    - 503 `{ authorized: false, reason: "service_unavailable" }` — Redis unavailable (fail-closed)
- **Invariants**:
  - **app-enforced (authz boundary)**: the entry lookup uses the delegation/check pattern exactly (R1 S1 — verified `route.ts:118-137`): `withBypassRls(prisma, (tx) => tx.passwordEntry.findFirst({ where: { id: keyId, userId, entryType: "SSH_KEY", isArchived: false, deletedAt: null } }), BYPASS_PURPOSE.CROSS_TENANT_LOOKUP)`. The `userId` predicate (sourced from the authenticated token, never the body) is the authorization boundary; a `keyId` owned by another user returns `entry_not_found`.
  - **app-enforced (actor attribution, R1 S2)**: both audit emissions set `actorType: resolveActorType(authResult)` (`audit.ts:100`) so agent signatures are recorded as `MCP_AGENT`, not the `HUMAN` default.
  - **app-enforced (audit)**: emits exactly one `logAuditAsync` per call — `SSH_KEY_SIGN` (PERSONAL scope) on grant, `SSH_KEY_SIGN_DENIED` (PERSONAL scope) on entry/policy denial. NOT on 400/401/scope-insufficient (malformed/unauthenticated, mirrors delegation/check). The **503 fail-closed path is audited by the shared `checkRateLimitOrFail` helper** (`emitRateLimitFailClosed`, R2 S12); the **429 throttle path returns the envelope WITHOUT a dedicated audit row** (matches delegation/check — the only rate-limit audit action is `RATE_LIMIT_FAIL_CLOSED`, fired solely on fail-closed). Neither uses `SSH_KEY_SIGN_DENIED`. Metadata: `{ fingerprint, host: { hostKeyFingerprint?, forwarded? } }`.
  - **app-enforced (fail-closed)**: any unexpected error path returns `authorized: false`, never `true`. `forwarded` is **audit-only end-to-end** — the server records it but never uses it in the authz decision in v1 (R1 S5; enforcement deferred SC4).
- **Forbidden patterns**:
  - `pattern: assertOrigin` in this route — reason: cookieless Bearer route; proxy CSRF gate does not apply (route is not in the pre-auth cookieless exception list).
  - `pattern: authorized:\s*true` on any code path that did not pass the `withBypassRls` entry-ownership lookup — reason: fail-open authorization bug.
  - `pattern: z\.string\(\)\.uuid\(\)` on `keyId` — reason: rejects legacy CUID entry IDs (R1 F5).
- **Acceptance criteria** + **Consumer-flow walkthrough** (response consumed by the CLI authorizer C7):
  - Consumer (path: `cli/src/lib/ssh-sign-authorizer.ts`) reads `{ authorized }` and treats any non-200 / `authorized !== true` / network error as **deny**. It DOES read `reason` for one purpose only: distinguishing scope-deny (`"unauthorized"` on 401/403) from entry-deny (`"entry_not_found"`) to print the re-login hint (R1 F6). Required fields: `authorized: boolean`, `reason: string` (on failures). Walkthrough satisfied.
  - Route test (reuse the delegation/check harness — verified portable, mocks `authOrToken`/prisma/`withBypassRls`/rate-limiter/`logAuditAsync`) covers: authorized happy path (audit `SSH_KEY_SIGN` with `actorType: MCP_AGENT` emitted), **another user's keyId → entry_not_found** (R1 S1), archived entry, soft-deleted entry, wrong entryType, scope-insufficient (403), invalid body incl. CUID-format keyId ACCEPTED + `.uuid()`-would-reject case (400 only for truly malformed), rate-limit (429), and **503 fail-closed (mandatory, R1 T4** — simulate via `mockRateLimiterCheck.mockResolvedValue({ redisErrored: true })`).

### C4 — Protocol constants + builders (`cli/src/lib/ssh-agent-protocol.ts`)

- **Signatures** (additions; keep existing exports unchanged):
  - Constants: `SSH_AGENT_SUCCESS = 6`, `SSH_AGENTC_REMOVE_ALL_IDENTITIES = 19`, `SSH_AGENTC_EXTENSION = 27`, `SSH_AGENT_EXTENSION_FAILURE = 28`, `SSH_AGENT_EXTENSION_RESPONSE = 29`.
  - `buildSuccess(): Buffer` — frames a single `SSH_AGENT_SUCCESS` byte.
  - `buildExtensionResponse(payload: Buffer): Buffer` — frames `SSH_AGENT_EXTENSION_RESPONSE` + contents.
  - `readExtensionRequest(msgBuf: Buffer): { extName: string; rest: Buffer }` — parse type-byte + extension name string, return remaining bytes.
  - Reuse existing `readString`/`encodeString`/`frameMessage`.
- **Invariants**:
  - **app-enforced**: numeric constants match RFC 9987 exactly (6/19/27/28/29). Verified by a unit test asserting the literal values (guards against silent drift / R29).
- **Citation (R1 S8 — RESOLVED/verified)**: RFC 9987 = "Secure Shell (SSH) Agent Protocol" (confirmed against rfc-editor.org); SUCCESS=6, REMOVE_ALL_IDENTITIES=19, EXTENSION=27, EXTENSION_FAILURE=28, EXTENSION_RESPONSE=29 confirmed. Safe to replace the `draft-miller` reference.
- **Forbidden patterns**:
  - `pattern: draft-miller` in `cli/src/lib/ssh-agent-*.ts` after this change — reason: reference must be RFC 9987 (R29 citation accuracy).
- **Acceptance criteria**: unit test asserts each new builder's byte layout (length prefix + type + body) and the constant values.

### C5 — Connection-scoped message dispatch (`cli/src/lib/ssh-agent-socket.ts`)

- **Signatures** (refactor):
  - Introduce `type ConnectionContext = { binding: SessionBinding | null }` where `SessionBinding = { hostKeyFingerprint: string; forwarded: boolean }`.
  - `handleMessage` becomes `async handleMessage(msgBuf: Buffer, ctx: ConnectionContext): Promise<Buffer>` (async because SIGN now awaits authorize/confirm).
  - **Export `handleConnection` (and `handleMessage`) for unit testing** (R2 T7), mirroring `agent-decrypt.ts` (`agent-decrypt-ipc.test.ts` imports `handleConnection` directly) — the ordering/isolation/dispatch tests must drive the real path (RT5), which requires the export seam; currently both are module-private.
  - `handleConnection(socket)` creates one `ConnectionContext` per connection and processes messages through a **single in-flight drain promise** guarded by an `isProcessing` flag (R1 F9): the `data` handler appends the chunk to the per-connection buffer then calls a guarded `void drain()`; `drain` loops draining complete frames, `await`-ing each `handleMessage` and writing its reply **before** dequeuing the next frame; if `handleMessage` rejects, the drain writes `buildFailure()` for that frame and continues (does not strand later buffered frames); the 256 KB size cap is checked **before** enqueue and remains reachable while a sign is awaiting.
- **Dispatch table** (message type → behavior):
  - `REQUEST_IDENTITIES (11)` → unchanged (`buildIdentitiesAnswer`).
  - `SIGN_REQUEST (13)` → resolve key by blob; if not found → `FAILURE`. If key's entry `requireReprompt` → run C8 confirm (deny on fail). Call C7 authorize with `ctx.binding`; if not authorized → `FAILURE`. Else `signData` locally → `buildSignResponse`.
  - `REMOVE_ALL_IDENTITIES (19)` → `clearKeys()`, return `buildSuccess()`.
  - `EXTENSION (27)` → parse name (C4). `query` → `buildExtensionResponse` listing `["query", "session-bind@openssh.com"]` (SSH string-array encoding). `session-bind@openssh.com` → C6 verify+store on `ctx`; success → `buildSuccess()`, verify-fail → `buildFailure()`. Unknown name → `buildFailure()` (empty SSH_AGENT_FAILURE, RFC requirement).
  - default / `ADD_*` / `REMOVE_IDENTITY` / `LOCK` / `UNLOCK` / smartcard → `buildFailure()`.
- **Invariants**:
  - **app-enforced**: replies are written in request order per connection (single in-flight drain; no `socket.write` from an overtaking handler). Ordering test (R1 T5, vacuous-pass guarded): enqueue BOTH frames while the first frame's authorize is still pending (test holds a deferred promise), assert `socket.write` call-count is 0 while pending (proves the second frame did not overtake), then resolve and assert reply order. The test drives the real `handleConnection` `data` path (RT5), not a bypassing helper.
  - **app-enforced**: the per-connection binding does NOT leak across connections (each `handleConnection` owns its `ctx`). Isolation test (R2 T8 — observe via behavior, not internal field): connection A sends `session-bind` then SIGN; connection B sends SIGN; assert the injected `authorizeSign` spy received A's host fingerprint for A's call and `binding: null` for B's call.
  - **app-enforced**: existing DoS guard (256 KB cap) and socket-dir TOCTOU checks are preserved.
- **Forbidden patterns**:
  - `pattern: let buffer = Buffer` paired with a synchronous `while` loop that calls `socket.write` without awaiting — reason: ordering regression once SIGN is async (the original sync loop must be replaced by the awaiting queue).
- **Acceptance criteria**: unit tests for REMOVE_ALL→SUCCESS+keys cleared, unknown extension→FAILURE, query→EXTENSION_RESPONSE with both names, reply-ordering under a slow async sign, per-connection binding isolation.

### C6 — session-bind verification (`cli/src/lib/ssh-session-bind.ts`)

- **Net-new crypto note (R1 T3/F11/S4)**: the repo has **no** SSH-wire-format public-key verifier (`openssh-key-parser.ts` parses *private* keys; `ssh-key-agent.ts` only signs). C6 is therefore net-new crypto, not a "reuse existing helpers" task.
- **Signatures**:
  - `parseSessionBind(rest: Buffer): { hostKeyBlob: Buffer; sessionId: Buffer; signature: Buffer; isForwarding: boolean }` — parse the `session-bind@openssh.com` payload (string hostkey, string session-identifier, string signature, bool is_forwarding), reusing `readString` framing.
  - `sshWirePublicKeyToKeyObject(blob: Buffer): { key: KeyObject; keyType: string }` — **new, tested unit**: convert an SSH wire-format public-key blob (ssh-ed25519 32B point / rsa-sha2 e,n / ecdsa-sha2-nistp* curve+point) into a Node `KeyObject`. Returns the parsed `keyType` so the verifier can bind algorithm↔key type. Unsupported type → throw (caught by `verifySessionBind` → false).
  - `verifySessionBind(parsed): boolean` — verify `signature` is a valid signature by `hostKeyBlob` over `sessionId` (OpenSSH PROTOCOL.agent: host proves session control). Supports ssh-ed25519, rsa-sha2-256/512, ecdsa-sha2-nistp256/384/521.
  - `fingerprintPublicKey(blob: Buffer): string` — "SHA256:<base64>" of the public key blob (audit + identities reuse).
- **Invariants**:
  - **app-enforced (algorithm binding, R1 S4)**: `verifySessionBind` reads the host-key type from `hostKeyBlob`, selects the verify primitive from THAT type, and returns `false` if the signature blob's embedded algorithm name is inconsistent with the host-key type. No downgrade via attacker-chosen algorithm name.
  - **app-enforced (fail-closed)**: an invalid, malformed, or unsupported-key-type session-bind returns `false` → the agent returns `FAILURE` to the extension and does NOT store a binding. Audit metadata is never populated from an unverified host claim (prevents honest-agent audit poisoning by a forwarded host — the stated purpose of C6).
  - **app-enforced**: a verified binding with `isForwarding = true` is recorded and reported to the server; v1 does not locally block forwarding and the server does not enforce on it either (audit-only end-to-end, SC4).
- **Forbidden patterns**:
  - `pattern: \.verify\([^)]*\)\s*\|\|\s*true` or any acceptance branch returning `true` without a successful crypto `verify` — reason: fail-open signature check.
- **Acceptance criteria** (R1 T3 golden-vector design):
  - One **captured** real session-bind frame (ed25519, captured offline once and committed as a fixture — VC1; the in-repo test only parses+verifies it, no live ssh) → verifies true; **and flipping one byte of the captured frame's signature → false** (R2 T9 — guards the captured path itself against a stub verifier, not only the synthetic paths).
  - **Synthetic** per-key-type vectors generated in-test (build a known pubkey blob, sign the sessionId with the matching private key via `node:crypto`) for rsa-sha2-256/512 and ecdsa-sha2-nistp256 → verify true; flip one byte of session-id or signature → false.
  - Algorithm-mismatch vector (ed25519 hostkey blob + rsa-sha2-256 signature algorithm name) → false.
  - Unsupported key type → false (not throw, caught internally).

### C7 — Per-sign authorizer (`cli/src/lib/ssh-sign-authorizer.ts`)

- **Signature**:
  - `authorizeSign(args: { keyId: string; fingerprint: string; binding: SessionBinding | null }): Promise<boolean>` — POSTs to `/api/vault/ssh/sign-authorize` via `apiRequest`; returns `true` only on HTTP 200 with `authorized === true`; logs and returns `false` on any other status, malformed body, or network error (**fail-closed**).
- **Invariants**:
  - **app-enforced**: no caching — one authorize call per signature (matches the decrypt agent's no-cache policy; immediate revocation + complete audit). A short-TTL cache is explicitly rejected (see Considerations).
  - **app-enforced**: `fingerprint` is computed from the loaded key's public-key blob (C6 `fingerprintPublicKey`), not from any client-supplied SIGN_REQUEST field.
  - **app-enforced (R1 F6)**: on a deny, the authorizer inspects `reason` — `"unauthorized"` (401/403, scope-insufficient on a stale token) emits a one-time "re-run `passwd-sso login` to grant SSH signing" hint; `"entry_not_found"` / other reasons log normally. The hint is rate-limited to once per agent run to avoid spamming per-sign.
- **Forbidden patterns**:
  - `pattern: catch\s*\{[^}]*return true` — reason: an error path must never grant.
- **Acceptance criteria**: unit tests (mock `apiRequest`, precedent `agent-decrypt.test.ts:17-20`): 200+authorized→true; 403 `unauthorized`→false + re-login hint; 403 `entry_not_found`→false, no hint; 503→false; network throw→false; malformed JSON→false.

### C8 — Confirmation gate (`cli/src/lib/ssh-confirm.ts`)

- **Signature** (R1 T2 — use the established TTY-detection precedent + dependency injection, NOT a raw `/dev/tty` open which has no mock precedent and is absent in CI/VC4):
  - `confirmSign(keyLabel: string, deps?: { isTTY?: boolean; prompt?: (q: string) => Promise<string> }): Promise<boolean>` — gate on `process.stdin.isTTY` (precedent `unlock.ts:38`); when a TTY is present, `prompt` (default = a readline-based reader, injectable for tests) asks `Allow SSH signing with "<keyLabel>"? [y/N]`; resolve `true` only on explicit yes. No TTY → resolve `false` (fail-closed) after a one-line stderr explanation. Injecting `prompt`/`isTTY` makes yes/no/no-TTY all deterministically `verifiable-local`.
- **Invariants**:
  - **app-enforced**: only invoked for keys whose entry `requireReprompt === true`; keys without it skip confirmation. `LoadedSshKey.requireReprompt` is a **required `boolean`** populated at load time (C9).
  - **app-enforced (R1 F10/S6 reconciled)**: `requireReprompt` is always serialized by the passwords list (verified `passwords/route.ts:123,211`), so the field is present. Defensive default: if the loaded value is `undefined`/non-boolean (serializer regression), treat as `true` (deny-side), with a test. There is no per-key "unreadable column" case in the actual data flow — if the whole list fetch fails the agent does not start (existing behavior).
  - **app-enforced**: no-TTY/explicit-no → deny (fail-closed). Confirmation is not cached (each signature re-confirms).
- **Forbidden patterns**:
  - `pattern: requireReprompt[^=]*\?\?\s*false` — reason: a non-boolean `requireReprompt` must default deny-side (`true`), never permissive `false`.
- **Acceptance criteria**: unit tests (inject `isTTY`/`prompt`): yes→true, no→false, no-TTY→false; non-boolean `requireReprompt`→treated as reprompt (deny-side); a non-reprompt key never calls `confirmSign`.

### C9 — Key loading carries entry metadata (`cli/src/lib/ssh-key-agent.ts`, `cli/src/commands/agent.ts`)

- **Signatures**:
  - `LoadedSshKey` gains `entryId: string` (already present per exploration — confirm) and `requireReprompt: boolean`.
  - `loadKey(...)` signature extended to accept `requireReprompt` (or set it post-load).
  - `agent.ts` reads `requireReprompt` from the SSH_KEY entry list — **already serialized** (verified `passwords/route.ts:123,211`), so no serializer extension is needed; just map it onto the loaded key.
- **Invariants**:
  - **app-enforced**: every loaded key has a resolvable `entryId` (confirm it already exists on `LoadedSshKey` during implementation) and a required `requireReprompt: boolean`; the socket handler maps `keyBlob → LoadedSshKey → {entryId, requireReprompt, fingerprint}` for the authorize + confirm calls.
- **Acceptance criteria**: a loaded key exposes `entryId`, `requireReprompt`, and a fingerprint; existing key-loading tests still pass.

### C10 — Wiring + docs (`cli/src/commands/agent.ts`, `CLAUDE.md` endpoint table)

- **Signatures / changes**:
  - `agent.ts` passes the authorize + confirm dependencies into the socket server (dependency injection so the socket module stays testable without real HTTP/TTY). Preferred shape: `startAgent({ authorizeSign, confirmSign })` or module-level setters mirroring `setEncryptionKey`.
  - Add the new endpoint row to the `#### Vault` table in `CLAUDE.md`.
- **Invariants**:
  - **app-enforced**: when the vault locks (existing 5 s `checkLock`), keys are cleared and the agent stops — unchanged.
- **Acceptance criteria**: `npx vitest run` (CLI + server) green; `npx next build` succeeds; `CLAUDE.md` lists `/api/vault/ssh/sign-authorize`.

---

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|---------------------------------------------------------------|--------|
| C1  | Audit actions SSH_KEY_SIGN / _DENIED + group:ssh (PERSONAL)   | locked |
| C2  | New scope ssh:sign (shared-token reality, SC6)                | locked |
| C3  | POST /api/vault/ssh/sign-authorize                            | locked |
| C4  | Protocol constants + builders (RFC 9987)                      | locked |
| C5  | Connection-scoped async message dispatch (+test export)      | locked |
| C6  | session-bind parse + crypto verify (algorithm-bound)         | locked |
| C7  | Per-sign authorizer (fail-closed)                            | locked |
| C8  | Confirmation gate (requireReprompt, isTTY+DI)               | locked |
| C9  | Key loading carries entryId + requireReprompt                | locked |
| C10 | Wiring + CLAUDE.md endpoint doc                              | locked |

All contracts `locked` after 3 review rounds converged (round 3: testing clean; functionality+security flagged the same residual line-37 overclaim, now reconciled and propagation-swept). Ready for Phase 2.

## Testing strategy

- **CLI unit (vitest), one test file per new/changed module (R1 T6)**: `ssh-agent-protocol.test.ts` (C4 builders/constants), `ssh-agent-socket.test.ts` (C5 dispatch table: REMOVE_ALL→SUCCESS+cleared, unknown-extension→FAILURE, query→EXTENSION_RESPONSE, vacuous-guarded ordering, connection-isolation, mid-queue-error continuation), `ssh-session-bind.test.ts` (C6 parse+verify, captured ed25519 vector + synthetic rsa/ecdsa vectors + algorithm-mismatch + unsupported-type), `ssh-sign-authorizer.test.ts` (C7 fail-closed matrix + reason-based re-login hint), `ssh-confirm.test.ts` (C8 yes/no/no-TTY/non-boolean via injected deps), key-metadata load (C9).
- **Server unit (vitest)**: sign-authorize route matrix (C3 — reuse the delegation/check harness; incl. another-user keyId → entry_not_found, 503 mandatory, CUID keyId accepted), audit action coverage (C1 — `audit.test.ts` + `audit-log-keys.test.ts`), scope risk-map completeness (C2 — `mcp.test.ts`).
- **Migration (R1 F1/R21)**: the new Prisma migration for the two `AuditAction` enum members MUST be generated and run against the dev DB before PR (`npm run db:migrate`), not only asserted by integration tests.
- **i18n**: en/ja per-action labels + `groupSsh` group label (C1, auto-checked by `audit-log-keys.test.ts`); consent-UI scope description presence (C2 — manual checklist, no CI gate).
- **Manual test plan** (`docs/archive/review/ssh-agent-rfc9987-manual-test.md`, Tier-1 — CLI daemon, no auth-flow deployment artifact, but VC1/VC3/VC4 live paths): `eval $(passwd-sso agent --eval)` → `ssh-add -l` (REQUEST_IDENTITIES) → `ssh -T git@github.com` (session-bind + authorize + sign) → verify an `SSH_KEY_SIGN` audit row appears server-side; archive the entry and confirm next sign is denied; foreground `requireReprompt` key prompts on TTY. Two-filter rule applied: only the live-ssh handshake, the live audit-row check, and the TTY prompt (VC1/VC3/VC4) are manual; everything else is automated.

## Considerations & constraints

- **Per-sign latency / server dependency**: each signature adds one HTTP round-trip; if the server is unreachable, signing fails closed and `ssh` cannot authenticate. This is an accepted consequence of the user-selected audited model. **No authorization cache** is used (immediate revocation + complete audit outweigh the round-trip cost; SSH typically issues one sign per connection).
- **Threat model**: per-sign authorize is an honest-agent audit/revocation control, NOT a defense against a compromised agent holding the decrypted key (see Non-functional). Stated to avoid over-claiming.

### Scope contract

- **SC1** — Offline / `--local` unaudited signing mode (current behavior preserved as an explicit opt-in): deferred. v1 ships audited-only; offline use is a future enhancement tracked here. Owner: future issue.
- **SC2** — Live integration test of the authorize round-trip against a running server (VC3): deferred to the integration suite; v1 covers the route with mocked-DB route tests + manual test. Owner: `test:integration` follow-up.
- **SC3** — Team-vault SSH keys (`/api/teams/[teamId]/...`) and a TEAM-scope `SSH` audit group: deferred. v1 is personal-vault only. Owner: future PR (parallels the personal/team commonization initiative).
- **SC4** — Agent-side *enforcement* of forwarding restrictions (locally refusing to sign for forwarded connections, or per-key "no-forward" policy): deferred. v1 verifies + records the `forwarded` flag and forwards it to the server; it does not locally block. Owner: future PR.
- **SC5** — `SSH_AGENTC_LOCK`/`UNLOCK (22/23)` mapping to vault lock/unlock: deferred (read-only agent refuses with FAILURE, RFC-compliant). Owner: future enhancement.
- **SC6** — Per-command / sub-token scope minimization so the SSH agent can run with a sign-only token (`ssh:sign` + `passwords:read` + `vault:unlock-data`, no `credentials:use`): deferred. v1 uses the single shared `CLI_SCOPES` token (R2 F11). Owner: future PR (CLI token architecture).

## Implementation Checklist (Step 2-1)

**Server (Batch A):**
- `prisma/schema.prisma` — add `SSH_KEY_SIGN`, `SSH_KEY_SIGN_DENIED` to `enum AuditAction` (after `DELEGATION_CHECK`, ~line 138 of enum).
- `prisma/migrations/<ts>_add_ssh_key_sign_audit_actions/migration.sql` — mirror `20260606000000_add_bulk_purge_audit_action/migration.sql` (`ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS ...`). Run `npm run db:migrate` on dev DB (R21).
- `src/lib/constants/audit/audit.ts` — add 2 actions (after :165), to `AUDIT_ACTION_VALUES` (after :352), `AUDIT_ACTION_GROUP.SSH = "group:ssh"` (after :411), new `group:ssh` array in `AUDIT_ACTION_GROUPS_PERSONAL` only (after :536). NOT TENANT/TEAM/webhook.
- `messages/en/AuditLog.json` + `messages/ja/AuditLog.json` — `SSH_KEY_SIGN`, `SSH_KEY_SIGN_DENIED` action labels + `groupSsh` group label (ja: 保管庫, no katakana).
- `src/lib/constants/auth/mcp.ts` — `MCP_SCOPE.SSH_SIGN = "ssh:sign"` (after :15) + `MCP_SCOPE_RISK` entry `"use"` (after :32).
- `messages/en/McpConsent.json` + `messages/ja/McpConsent.json` — `scopeDescriptions["ssh:sign"]` (after :15).
- `src/app/api/vault/ssh/sign-authorize/route.ts` — NEW. Mirror `src/app/api/vault/delegation/check/route.ts` (auth/scope/rate-limit/withBypassRls/audit), POST + body schema.
- `src/app/api/vault/ssh/sign-authorize/route.test.ts` — NEW. Reuse delegation/check/route.test.ts harness.
- `src/lib/constants/audit/audit.test.ts`, `src/lib/constants/auth/mcp.test.ts` — extend coverage assertions.
- `CLAUDE.md` — add `/api/vault/ssh/sign-authorize` to the Vault endpoint table.

**CLI protocol+crypto (Batch B):**
- `cli/src/lib/ssh-agent-protocol.ts` — add constants (6/19/27/28/29), `buildSuccess`, `buildExtensionResponse`, `readExtensionRequest`; update `draft-miller`→RFC 9987.
- `cli/src/lib/ssh-session-bind.ts` — NEW: `parseSessionBind`, `sshWirePublicKeyToKeyObject`, `verifySessionBind` (algorithm-bound, fail-closed), `fingerprintPublicKey`. Reuse JWK builders from `openssh-key-parser.ts`.
- `cli/src/__tests__/unit/ssh-agent-protocol.test.ts` (extend), `cli/src/__tests__/unit/ssh-session-bind.test.ts` (NEW).

**CLI wiring (Batch C, after B):**
- `cli/src/lib/ssh-sign-authorizer.ts` — NEW: `authorizeSign` (fail-closed + reason-based re-login hint).
- `cli/src/lib/ssh-confirm.ts` — NEW: `confirmSign` (isTTY gate + injectable prompt/isTTY deps).
- `cli/src/lib/ssh-key-agent.ts` — add `requireReprompt: boolean` to `LoadedSshKey` (entryId already present :19), extend `loadKey`.
- `cli/src/lib/ssh-agent-socket.ts` — connection-scoped `ConnectionContext`, async single-in-flight drain, dispatch table (REMOVE_ALL/EXTENSION/query/session-bind/SIGN-with-authorize+confirm), **export `handleConnection`+`handleMessage`**.
- `cli/src/commands/agent.ts` — read `requireReprompt`, inject `authorizeSign`/`confirmSign` into the socket server, fingerprint mapping.
- `cli/src/__tests__/unit/ssh-sign-authorizer.test.ts`, `ssh-confirm.test.ts`, `ssh-agent-socket.test.ts` — NEW.

**Reuse (R1/R17 — do NOT reimplement):** `authOrToken`/`hasUserId`, `withBypassRls`+`BYPASS_PURPOSE.CROSS_TENANT_LOOKUP`, `createRateLimiter`/`checkRateLimitOrFail`, `logAuditAsync`+`personalAuditBase`+`resolveActorType`, `apiRequest`, `readString`/`encodeString`/`frameMessage`, JWK construction in `openssh-key-parser.ts`, `process.stdin.isTTY` (precedent `unlock.ts:38`).

**Manual-test artifact (R35 Tier-1):** `docs/archive/review/ssh-agent-rfc9987-manual-test.md` — VC1/VC3/VC4 live paths.

## User operation scenarios

1. **Normal git over SSH**: `eval $(passwd-sso agent --eval)`; `git push`. ssh sends session-bind (verified, stored), then SIGN_REQUEST → authorize 200 → sign → push succeeds; an `SSH_KEY_SIGN` audit row records the host-key fingerprint.
2. **Revoked key mid-session**: user archives the SSH_KEY entry in the web UI; the running agent's next sign for that key gets `entry_not_found` → `FAILURE` → ssh falls through to the next identity or fails. An `SSH_KEY_SIGN_DENIED` row is recorded.
3. **High-security key**: entry has `requireReprompt`; user runs the agent in **foreground**; each `git push` prompts `Allow SSH signing with "deploy@prod"? [y/N]` on the terminal. In detached `--eval` mode the same key's signing is denied (no TTY) with a logged hint to run foreground.
4. **Forwarded agent**: `ssh -A bastion` then `git` on the bastion; the forwarded SIGN_REQUEST carries `forwarded: true` in the binding → audit records it; v1 still authorizes (SC4 enforcement deferred).
5. **`ssh-add -D`** (REMOVE_ALL_IDENTITIES): agent clears in-memory keys, returns SUCCESS; subsequent `ssh-add -l` shows none until agent restart.
6. **Unknown extension / older client**: a client probing an unsupported extension gets an empty `SSH_AGENT_FAILURE` and continues normally (RFC graceful-failure).
