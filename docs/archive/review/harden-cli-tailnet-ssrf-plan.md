# Plan: harden-cli-tailnet-ssrf

Date: 2026-07-31
Branch: `fix/harden-cli-tailnet-ssrf`
Origin: security review of `main` @ 9e59ccda4 (2 Medium, 2 Low; no Critical/High)

## Project context

- **Type**: mixed — Next.js web app (`src/`), Node CLI (`cli/`), browser extension, iOS
- **Test infrastructure**: unit (vitest) + integration (real Postgres) + E2E (Playwright) + CI/CD (GitHub Actions)
- **Verification environment constraints**

  | ID | Constraint | Consequence |
  |----|-----------|-------------|
  | VE1 | CI runners are `ubuntu-latest` / `macos-latest` only — no Windows runner (`.github/workflows/ci.yml`) | The Windows browser-launch path cannot be *executed* anywhere in CI. Verification is limited to asserting the argv vector a pure function produces. A real `rundll32` launch is `blocked-deferred`. |
  | VE2 | `tailscaled` LocalAPI (unix socket `/run/tailscale/tailscaled.sock`) is not present on CI runners | WhoIs behaviour is verified against a mocked transport in CI. Real two-tailnet isolation (peer from tailnet B denied on tenant with tailnet A) requires two Tailscale accounts and is `blocked-deferred`. Single-tailnet positive/negative paths are `verifiable-local` on the developer machine, which runs `tailscale serve`. |
  | VE3 | No NAT64/DNS64 network available in dev or CI | NAT64 handling is verified by address-classification unit tests over literal addresses; end-to-end delivery through a real NAT64 gateway is `blocked-deferred`. |
  | VE4 | The runtime the Next.js proxy executes in is a build-time property, not readable from source | C5 depends on the proxy running in the Node.js runtime. A build probe (below) must confirm it before C5 is implemented. |

## Objective

Close the four findings the security review raised, and close each one as a *class* rather than as the reported instance:

| Finding | Severity | Instance | Class |
|---------|----------|----------|-------|
| F1 | Medium | `cmd /c start "" <url>` re-parses the URL (`cli/src/lib/oauth.ts:355-362`) | any CLI process launch whose target is a shell interpreter and whose arguments carry non-literal data |
| F2 | Medium | Session/cookie paths verify CGNAT membership but not the tenant's tailnet (`src/lib/auth/policy/access-restriction.ts:176` vs `:299`) | one predicate ("is this peer allowed for this tenant") decided by two adjudicators with different semantics |
| F3 | Low | IPv6 transition addresses (NAT64, 6to4, Teredo) bypass the SSRF blocklist (`src/lib/http/external-http.ts:28`) | address forms that *carry* a blocked IPv4 inside them — closed for the standardized prefixes; operator-assigned NAT64 prefixes remain open by declaration (SC2, disclosed under I7.3) |
| F4 | Low | Socket paths interpolated into `eval $(...)` output without POSIX quoting (`cli/src/commands/agent.ts:243-245`, `cli/src/commands/agent-decrypt.ts:348-350`) | every CLI stdout line that emits shell syntax — `eval`-ed or copy-pasted; membership is defined by C6 Rule B, not by this list (see I3.1) |

## Findings verified against the code

Each finding was reproduced against the source before planning. Two corrections to the review's framing:

1. **F1 is also a functional defect, not only a security one.** An OAuth authorization URL always contains `&` (`response_type=code&client_id=...`). `cmd.exe` treats `&` as a command separator, so the Windows launch truncates the URL at the first parameter and attempts to execute the remainder. The security impact (attacker-chosen server URL → local command execution) and the availability impact share one root cause and one fix.

2. **F2's in-code rationale is stale.** The `SECURITY BOUNDARY (intentional)` comment at `access-restriction.ts:160-175` justifies the gap with "This check runs in Edge runtime where tailscaled WhoIs (Unix socket) is unavailable." That premise is very likely false today: `access-restriction.ts` already imports `@/lib/prisma` (pg driver adapter) and `verifyTailscalePeer` (which imports `node:http`), and both `src/lib/proxy/page-route.ts` and `src/lib/proxy/api-route.ts` import it. A module graph containing `pg` and `node:http` cannot execute in the Edge runtime, and the application works — so the proxy is already a Node.js-runtime proxy (Next.js 16 default). **VE4 probe required before C5 is implemented** (see Technical approach).

3. **F4's helper already exists.** `cli/src/commands/env.ts:130` defines a private `shellEscape`. The `agent` / `agent --decrypt` emitters do not use it. This is a helper-adoption gap (R1/R17), not a missing utility — the fix promotes the existing function rather than writing a second one.

## Requirements

**Functional**

- FR1 The browser launch opens the full authorization URL unmodified on Windows, macOS and Linux.
- FR2 `passwd-sso agent --eval` / `agent --decrypt --eval` output remains directly `eval`-able and continues to export the same three shell constructs (socket variable, PID variable, EXIT trap). The same guarantee applies to the foreground-mode copy-paste hints, which are shell syntax the user pastes into a shell — the distinction between "eval-ed" and "pasted" describes who invokes the parser, not whether one runs.
- FR3 Outbound delivery to a public destination reachable only via NAT64 continues to work; a NAT64 address embedding a private/metadata IPv4 is refused.
- FR4 A browser session from a peer in the tenant's own tailnet keeps working after C5.

**Non-functional**

- NFR1 No new runtime dependency in `cli/` — the module header of `cli/src/lib/oauth.ts` declares built-ins only, and that constraint stands.
- NFR2 The tailnet verification added by C5 must not add a WhoIs round trip per request beyond the existing 30 s per-IP cache in `tailscale-client.ts`.
- NFR3 Every fail-closed denial C5 introduces must have a recovery path that does not require `tailscaled` to be reachable.

## Technical approach

### VE4 probe — run before implementing C5

```bash
npx next build 2>&1 | tee /tmp/build-probe.txt
grep -iE 'proxy|middleware' /tmp/build-probe.txt
node -e 'const m=require("./.next/server/middleware-manifest.json");console.log(JSON.stringify(m.middleware,null,2).slice(0,2000))'
```

Record the observed runtime in the deviation log. Branch:

- **Node.js runtime (expected)** → implement C5 as specified: the WhoIs verification moves into `checkAccessRestriction`, and every caller (proxy page route, proxy API route, `enforceAccessRestriction`) inherits it.
- **Edge runtime (unexpected)** → C5 changes shape: `checkAccessRestriction` keeps its Edge-safe body, and the tailnet verification is instead added to the Node-side session paths (`checkAuth`'s session-only branch, plus a Node-runtime segment gate for `/dashboard/*`). Re-open the contract in Phase 1 rather than improvising in Phase 2.

The probe is required because C5's whole design rests on a runtime property that source reading cannot decide — the same reason the skill demands a real-DB probe for isolation-level designs.

### F1 — separate the launch decision from the launch

`openBrowser` currently decides *and* spawns in one function, which is why it has no tests. Split it: a pure `browserLaunchCommand(url, platform)` returns the argv vector, and `openBrowser` spawns whatever that returns. The Windows vector stops going through `cmd.exe`:

```
win32:  rundll32.exe  ["url.dll,FileProtocolHandler", url]
darwin: open          [url]
other:  xdg-open      [url]
```

`rundll32 url.dll,FileProtocolHandler` is the documented shell-free way to hand a URL to the default handler. Its argument is a plain argv element — Node's `spawn` with `shell:false` passes it through CRT quoting, and no command interpreter re-parses it, so `&`, `|`, `<`, `>`, `^`, `%`, `!` lose their meaning. `FileProtocolHandler` will also open a *file* path, so the function refuses any URL whose scheme is not `http:`/`https:` — the scheme check belongs in the launcher, not only in the caller, because the launcher is the thing that hands the string to the OS.

### F1b — narrow what a server URL may be

`validateServerUrl` today checks scheme and loopback only. A server URL is a base URL that the CLI concatenates endpoint paths onto; credentials, a query string or a fragment in it are never meaningful and are how a hostile value smuggles content into the composed URL. Reject them, and reject a URL whose pathname is not `/` or a plain prefix path.

### F3 — classify the address the packet will actually reach

`isPrivateIp` is the single choke point: `resolveAndValidateIps` calls it both for IP literals and for every A/AAAA record. Two changes there:

1. Extend `BLOCKED_CIDRS` with transition ranges that no legitimate delivery target uses: `2001::/32` (Teredo — a tunnel endpoint whose embedded IPv4 is obfuscated), `2002::/16` (6to4), `::/96` (IPv4-compatible, deprecated by RFC 4291 §2.5.5.1), `100::/64` (RFC 6666 discard-only), and `64:ff9b:1::/48` (RFC 8215 local-use NAT64 — see below for why this one is blocked rather than decoded).
2. For the **well-known** NAT64 prefix `64:ff9b::/96`, extract the embedded IPv4 and re-run the IPv4 blocklist against it. Blocking this prefix outright would be simpler but would break every destination in a DNS64 network: `resolveAndValidateIps` rejects the whole hostname if *any* resolved address is private, and in a DNS64 network the synthesized AAAA for an ordinary public host sits in this prefix. Extraction rejects `64:ff9b::169.254.169.254` while leaving `64:ff9b::93.184.216.34` reachable, which is why it is preferred here over the blunt option.

**Why the two NAT64 prefixes are treated differently.** RFC 6052 §2.1 fixes the layout for the well-known prefix: it is `/96`, and the IPv4 address is the last 32 bits — there is nothing to assume. RFC 8215 §5, which reserves `64:ff9b:1::/48`, says the opposite about its own prefix: nodes "must not ... make any assumptions regarding the syntax or properties of those addresses (e.g., the existence and location of embedded IPv4 addresses) or the type of associated translation mechanism." Decoding it per RFC 6052's `/48` row would therefore be a guess, and a wrong guess reads a private destination as public — the exact failure C4 exists to prevent. Where the layout is guaranteed we decode; where it is explicitly not guaranteed we deny. Other RFC 6052 prefix lengths are out of scope (SC4).

**Residual, disclosed rather than implied away.** A NAT64 deployment using an operator-assigned prefix (the common enterprise case, discovered by clients via RFC 7050) is neither blocked nor decoded by this contract, because the prefix is not knowable from the address alone. F3 is therefore closed for the standardized prefixes only; the residual is recorded in SC2 and must appear in the operator documentation C7 owns, so the class-closure claim in the Objective table is not read as broader than what ships.

### F4 — one quoting helper, one trap-construction rule

Promote `shellEscape` from `cli/src/commands/env.ts` to `cli/src/lib/shell-quote.ts` and adopt it at every emission site. The trap line needs more than per-value quoting: the payload is itself a shell command inside a quoted argument, so the *composed inner command* is quoted as a whole rather than assembled from separately-quoted fragments inside hand-written quotes.

```
const inner = `kill ${shellQuote(String(pid))} 2>/dev/null; rm -f ${shellQuote(socketPath)}`;
console.log(`trap ${shellQuote(inner)} EXIT;`);
```

Hand-written `'...'` around an interpolation is the defect; a value containing `'` terminates the literal early. `shellQuote` emits `'\''` for embedded quotes, so nesting it once for the value and once for the composed command is correct at both levels.

The double application is deliberate and is not redundant: the trap line is parsed **twice** — once by the shell that runs `eval`, which must read the whole body as one word, and again by the shell that executes the body when the trap fires, which must read the path as one word. Quoting only the composed command would leave the inner `rm -f <path>` unquoted at trap-execution time. C3's acceptance criteria therefore assert the trap *body* behaviour, not only the emitted text.

### F2/C5 — collapse two adjudicators into one

`checkAccessRestriction` (CGNAT membership) and `enforceAccessRestriction` (CGNAT membership **and** WhoIs tailnet match) decide the same predicate with different semantics; the weaker one is reachable by every browser session. Move the WhoIs block into `checkAccessRestriction`, immediately after the CGNAT check, and delete it from `enforceAccessRestriction`. Ordering is preserved: `allowedCidrs` is still evaluated first and still short-circuits to `allowed: true`, which is what makes NFR3 satisfiable — an operator locked out by an unreachable `tailscaled` recovers by adding a CIDR, with no dependency on Tailscale.

`verifyTailscalePeer` fails closed on socket errors, timeouts and unparseable responses. That is the correct default and is unchanged; what changes is the blast radius, which is why NFR3 and the RT10 allow-side tests are contract obligations rather than nice-to-haves.

## Contracts

### C1 — shell-free browser launch

**File**: `cli/src/lib/oauth.ts`

```ts
export type BrowserLaunch = { cmd: string; args: string[] };
/** Pure: decide the argv vector for opening `url` on `platform`. */
export function browserLaunchCommand(url: string, platform: NodeJS.Platform): BrowserLaunch | null;
export function openBrowser(url: string): boolean;  // unchanged signature
```

`openBrowser` passes `process.platform` and nothing else — the platform parameter exists so the Windows vector is assertable from a Linux runner (VE1), not as a caller-supplied option.

**Control class**: `enforceable boundary`. The constrained actor is the URL string; after the change no command interpreter parses it, so there is no metacharacter to escape and no enumeration of dangerous characters to keep complete. **Adjudication authority**: the OS process-creation argument vector — not a regex over the URL.

**Invariants**

- I1.1 No member of the returned `cmd` set is a command interpreter. Member-set derivation: `rg -n 'spawn\(|execFile\(|execSync\(|exec\(' cli/src` → every launch site; each must pass a literal command name and pass data only through `args`. Current members: `cli/src/lib/oauth.ts` (this contract), `cli/src/commands/agent.ts:233` and `cli/src/commands/agent-decrypt.ts:337` (both `spawn(process.execPath, ...)` — compliant), `cli/src/lib/clipboard.ts:68,70` (`execSync` with `shell:"/bin/sh"` but **literal** command strings and no interpolation — compliant, and C6 must not flag it), `cli/src/commands/run.ts:120` (`spawn` without `shell`, passing the user's own `-- <command>` argv — compliant; note the file's header comment claims `execFile`, which is stale and is corrected while the file is in scope for C6's Rule A).
- I1.2 `browserLaunchCommand` returns `null` for any URL whose scheme is not `http:` or `https:`; `openBrowser` returns `false` in that case without spawning.
- I1.3 `openBrowser` contains no platform branch of its own — every platform decision lives in `browserLaunchCommand`, so the tested function is the production primitive (RT5).

**Forbidden patterns**

- `pattern: /spawn\(\s*["']cmd["']/` — reason: launching `cmd.exe` re-parses arguments with shell semantics.
- `pattern: /shell:\s*true/` in `cli/src` — reason: the same, via Node's own shell wrapper.

**Acceptance criteria**

- `browserLaunchCommand("https://h/a?b=1&c=2", "win32")` → `{cmd:"rundll32.exe", args:["url.dll,FileProtocolHandler","https://h/a?b=1&c=2"]}`, with the URL present as one intact argv element.
- Same for `darwin`/`linux` with `open`/`xdg-open`.
- `browserLaunchCommand("file:///etc/passwd", "win32")` → `null`.

### C2 — server URL narrowing

**File**: `cli/src/lib/oauth.ts`

```ts
export function validateServerUrl(url: string): void;  // signature unchanged; throws on more inputs
```

**Control class**: `fail-closed verification gate` — it cannot pass without deciding, and every unparseable or unexpected form throws. **Adjudication authority**: the WHATWG `URL` parser, whose parsed components are read directly (`username`, `password`, `search`, `hash`), never a regex over the raw string.

**Invariants**

- I2.1 A URL with `username` or `password` set is rejected.
- I2.2 A URL with a non-empty `search` or `hash` is rejected.
- I2.3 Existing behaviour is unchanged for the accepted set: `https://*` accepted, `http://` accepted only for `localhost` / `127.0.0.1` / `[::1]`.
- I2.4 `hostname` matches `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$` (case-insensitive) or begins with `[`, and `pathname` matches `^(/[A-Za-z0-9._~-]+)*/?$`. Both are *narrower than the WHATWG URL parser*, which is the point: `new URL("https://a&calc")` succeeds with `hostname === "a&calc"`, and `new URL("https://h/a&b")` keeps the raw `&` in the path, because neither `&` nor `,` is a forbidden host code point or a path percent-encode set member. The composed authorization URL is built by string concatenation (`${serverUrl}${MCP_AUTHORIZE_ENDPOINT}`, `cli/src/lib/oauth.ts:415`), so anything the parser tolerates in the host or path is carried into it verbatim. Without I2.4 the F1b narrowing this contract exists to provide is prose only.

  Two acceptances inside I2.4 are deliberate and recorded rather than left implicit: the pathname charset admits a literal `..` segment, and the bracket branch admits any IPv6 literal the URL parser accepts (including IPv4-mapped forms). Neither is a vector here — C1 hands the composed URL to the OS as a single argv element regardless of its content, and I2.3 still restricts `http:` to loopback — but this plan's convention is to name residuals rather than let a reader infer they were considered.

  A `hostname` beginning with `[` is accepted with no further pattern matching, and the reason is stated rather than left to the implementer: the URL Standard's host parser produces that form only for a syntactically valid IPv6 address, and `new URL()` throws before I2.4 ever runs otherwise. The adjudication authority for that branch is the parser, exactly as C2's control class declares — substituting a hand-written IPv6 regex here would reintroduce the surface-form matching this contract is built to avoid.

**Forbidden patterns**

- `pattern: url.includes("@")` — reason: userinfo detection must read `parsed.username`, not scan the raw string.

**Acceptance criteria**: `https://evil@real.example`, `https://h/?x=1`, `https://h/#f`, `https://a&calc`, `https://h/a,b`, `https://h/a&b` all throw; `https://h`, `https://h/base`, `https://h/base/v2`, `http://localhost:3001` all pass.

### C3 — one POSIX quoting helper, adopted everywhere

**File**: new `cli/src/lib/shell-quote.ts`; consumers `cli/src/commands/env.ts`, `cli/src/commands/agent.ts`, `cli/src/commands/agent-decrypt.ts`

```ts
/** Quote `s` so that a POSIX shell reads it back as exactly one word equal to `s`. */
export function shellQuote(s: string): string;
```

**Control class**: `enforceable boundary` for the value; the emitted token cannot be read as anything but that literal word. **Adjudication authority**: `/bin/sh` itself — the round-trip test executes the quoted token through a real shell rather than asserting against an expected quoting spelling.

**Invariants**

- I3.1 Every stdout line that emits shell syntax interpolates non-literal values only through `shellQuote` — whether the user is documented to `eval` it or to copy-paste it, because both end up parsed by a shell.

  **Membership is defined by C6 Rule B, not by a list in this plan.** This member-set has now expanded twice under review: 8 lines in the first derivation, 9 after `agent-decrypt.ts:419` was found, 10 after `agent.ts:187` (`console.log(\`  export SSH_AUTH_SOCK=${socketPath}\`)` — no quoting at all, so C3's `/'\$\{/` forbidden pattern would not have caught it either). Two expansions is the accretion signature: the boundary was never derived from the primitive, it was read off files, so the next missed member is likely still unwritten. Per the R42 escalation, the AST gate becomes the class definition and the enumeration stops being authoritative — C6 Rule B matches `console.log` of a template literal carrying shell syntax with an interpolation not discharged by `shellQuote`, over all of `cli/src`, and whatever it reports IS the member set.

  The list below is therefore a *snapshot of the gate's current output*, recorded so implementation has a starting point and so a reader can see what changed; it is not the contract. Snapshot: `env.ts:118`, `env.ts:124` (already compliant, the source of the promoted helper) and the eight sites to fix — `agent.ts:187`, `agent.ts:243`, `agent.ts:244`, `agent.ts:245`, `agent-decrypt.ts:348`, `agent-decrypt.ts:349`, `agent-decrypt.ts:350`, `agent-decrypt.ts:419`. `unlock.ts:55,74` emit bare newlines and carry no value — the gate does not match them.

  The contract closes when C6 Rule B is green over `cli/src` **and** its self-test has been shown able to go red, not when this list is exhausted.
- I3.2 A trap payload is composed first and quoted once as a whole; no hand-written quote characters surround an interpolation.
- I3.3 `env.ts` keeps its behaviour — the promoted function is the same function, moved, not a reimplementation (R1).
- I3.4 Each foreground-mode hint block (`agent.ts:184-190`, `agent-decrypt.ts:416-420`) is extracted into a pure function that takes the socket path and returns the lines to print, called from the surrounding callback. This mirrors C1's split of `browserLaunchCommand` from `openBrowser`, and for the same reason: `agent-decrypt.ts:419` sits inside a `server.listen` callback in `startForegroundAgent`, whose trailing `await new Promise(() => {})` never settles, so the line is unreachable from a test that awaits the command. Extracting the decision from the I/O makes the emitted text assertable without `net`, without a listening socket, and without a promise that never resolves.

**Forbidden patterns**

- `pattern: /'\$\{/` in `cli/src/commands/agent*.ts` — reason: a hand-written single quote immediately before an interpolation is the defect being fixed.

**Acceptance criteria**

- For each of a fixed adversarial value set — `a b`, `a'b`, `a"b`, `$(id)`, `` `id` ``, `a;rm -rf /`, `a\nb`, `a&b`, `~/x`, `!x`, `` — `sh -c "printf '%s' $(shellQuote(v))"` prints exactly `v`.
- `agent --eval` output for a socket path containing a space and a single quote is `eval`-able and leaves `$SSH_AUTH_SOCK` exactly equal to the path.
- Firing the emitted trap in a real shell removes exactly that path and nothing else: `sh -c "$(emitted trap line); exit"` against a temp directory containing both `a'b c.sock` and a decoy file leaves the decoy intact.

### C4 — IPv6 transition addresses classified by what they carry

**File**: `src/lib/http/external-http.ts`

```ts
export const BLOCKED_CIDRS: readonly string[];                    // extended
export const BLOCKED_CIDR_REPRESENTATIVES: ReadonlyArray<{cidr:string; ipv4?:string; ipv6?:string}>;  // extended in lockstep
/** Extract the IPv4 embedded in a well-known-prefix (64:ff9b::/96) NAT64 address, or null. */
export function extractNat64Ipv4(ip: string): string | null;
export function isPrivateIp(ip: string): boolean;                 // now also checks the embedded IPv4
```

**Control class**: `fail-closed verification gate`. It decides on every resolved address and rejects on any parse failure. **Adjudication authority**: `net.isIP` + the existing `isIpInCidr` byte-prefix matcher; NAT64 extraction reads fixed bit positions from the parsed 16-byte form, never a string pattern.

**Invariants**

- I4.1 `BLOCKED_CIDRS` and `BLOCKED_CIDR_REPRESENTATIVES` stay in lockstep — every new CIDR gets a representative, since the representative array is what `describe.each` iterates (RT3; a CIDR with no representative is an untested blocklist entry).
- I4.2 `isPrivateIp(x)` is true whenever `extractNat64Ipv4(x)` yields an address that `isPrivateIp` rejects.
- I4.3 Every outbound fetch **whose destination host can be influenced by tenant or user input** goes through the SSRF defense, so every such call inherits C4. Member-set derivation: `rg -n '\bfetch\(' src --glob '!**/*.test.ts' --glob '!**/*.test.tsx'` → set A, then drop the matches that are comments rather than calls (`external-http.ts:9,221`, `safe-href.ts:7`, `client-events.ts:172` at the time of writing). No count is asserted here: the first draft of this invariant carried a fabricated cardinality, and a number that nobody re-runs is exactly the kind of claim R42 exists to distrust — the command above is the contract, its output at implementation time is the set. Note the second glob: `!**/*.test.ts` alone does not exclude `.test.tsx`, which is how a component test leaked into an earlier derivation. A member is discharged only by one of these five named categories, and anything outside them is a finding:

  | Discharge | Members |
  |-----------|---------|
  | (a) inside `external-http.ts` itself | `validateAndFetch`, `validateAndFetchBuffered` |
  | (b) composes `resolveAndValidateIps` + `createPinnedDispatcher` manually rather than via the wrapper | `src/lib/webhook-dispatcher.ts:128` |
  | (c) same-origin internal self-call | `src/lib/proxy/auth-gate.ts:82`, `src/lib/url-helpers.ts:73`, the proxy's `/api/internal/audit-emit` call |
  | (d) fixed vendor hostname — the host is a compile-time literal, no input reaches it | `watchtower/hibp/route.ts:58` (`api.pwnedpasswords.com`), `audit/anchor-destinations/github-release-destination.ts:46,63,95` (`api.github.com` + an upload URL GitHub itself returns), `directory-sync/azure-ad.ts:36` (`GRAPH_ORIGIN` constant; the tenant id appears only as a path segment), `directory-sync/google-workspace.ts:116,176,242`, `services/tailscale-client.ts:131` (loopback LocalAPI) |
  | (e) tenant-supplied host bounded by an anchored allowlist, re-validated on every call | `directory-sync/okta.ts:98,175` — `orgUrl` is typed by a tenant admin and constrained by `OKTA_ORG_RE = /^https:\/\/[a-zA-Z0-9-]+\.okta(preview)?\.com\/$/` (`okta.ts:46`), with pagination pinned to the same origin (`:62-70`). This is a *different control* from (d) — an input-validation allowlist, not a literal — and it is split out precisely so that a later refactor "simplifying" it alongside the genuine (d) members cannot silently drop the only thing holding the boundary. |

  The earlier form of this invariant claimed every fetch went through `validateAndFetch`, which the grep contradicts. The categories above are the honest statement: the SSRF defense guards *attacker-influenceable destinations*, and each other call site is discharged by a named, checkable property rather than by not having been looked at.

**Forbidden patterns**

- `pattern: /64:ff9b/` outside `external-http.ts` and its test — reason: NAT64 knowledge must not spread to a second classifier (R48).

**Acceptance criteria**

- `isPrivateIp("64:ff9b::169.254.169.254")` → `true`; `isPrivateIp("64:ff9b::10.0.0.1")` → `true`.
- `isPrivateIp("64:ff9b::93.184.216.34")` → `false` (FR3 — public destinations behind NAT64 keep working). This negative case is the one that distinguishes extraction from a blunt prefix block; a blunt implementation fails it.
- `isPrivateIp("64:ff9b:1:c0a8:0:100::")` → `true`, and so is every other address under `64:ff9b:1::/48`, by prefix membership rather than by decoding. The test asserts a *second* address in that prefix whose RFC-6052 `/48` decode would be public (`64:ff9b:1:5db8:d8:2200::`, decoding to `93.184.216.34`) is **also** blocked — that pair is what proves the prefix is blocked outright rather than decoded. An earlier draft of this criterion used `64:ff9b:1::a:0:c0a8:1` and claimed it embedded `192.168.0.1`; it decodes to `0.0.10.0`, which lands in the already-blocked `0.0.0.0/8` and would have passed no matter what the implementation did.
- `isPrivateIp("2001::1")`, `isPrivateIp("2002:7f00:1::")`, `isPrivateIp("::127.0.0.1")`, `isPrivateIp("100::1")` → all `true`.
- `extractNat64Ipv4` returns `null` for any address outside `64:ff9b::/96`, including `64:ff9b:1::/48` — the `/48` prefix must never reach the decoder.
- `resolveAndValidateIps` rejects a hostname whose AAAA is a NAT64 address embedding `169.254.169.254`.

### C5 — one adjudicator for the tenant access predicate

**File**: `src/lib/auth/policy/access-restriction.ts`

```ts
export async function checkAccessRestriction(
  tenantId: string,
  clientIp: string | null,
): Promise<AccessCheckResult>;          // signature unchanged; tailnet verification folded in
export async function enforceAccessRestriction(
  req: NextRequest, userId: string, tenantIdOverride?: string, actorType?: ActorType,
): Promise<NextResponse | null>;        // signature unchanged; duplicate WhoIs block removed
```

**Control class**: `fail-closed verification gate`. `verifyTailscalePeer` returns `false` on socket error, timeout, non-200, unparseable JSON and missing node name; each of those denies. It is not an `enforceable boundary` — an operator with host access can point `TAILSCALE_SOCKET`/`TAILSCALE_API_BASE` elsewhere. **Adjudication authority**: `tailscaled`'s LocalAPI WhoIs response, not the source IP range.

**Invariants**

- I5.1 Every code path that decides tenant access evaluates the same predicate. Member-set derivation: `rg -l 'checkAccessRestriction|enforceAccessRestriction' src --glob '!**/*.test.ts'` → set A = **27 files**, not the 9 an earlier truncated (`| head -40`) derivation produced:

  `src/lib/auth/policy/access-restriction.ts` (the adjudicator itself), `src/lib/proxy/page-route.ts`, `src/lib/proxy/api-route.ts`, `src/lib/auth/session/check-auth.ts`, `src/lib/scim/with-scim-auth.ts`, `src/lib/mcp/oauth-server.ts`, and the route handlers `api/extension/{bridge-code,key/reset,token,token/exchange,token/refresh}`, `api/mcp/{route,token}`, `api/mobile/{authorize,autofill-token,cache-rollback-report,favicon,favicon-pref,token,token/refresh}`, `api/tenant/access-requests`, `api/v1/{passwords,passwords/[id],tags,vault/status}`, `api/vault/{delegation/check,ssh/sign-authorize}`.

  One of those 27 is a false positive of the same kind I4.3 filters out: `src/lib/mcp/oauth-server.ts:173` matches inside a JSDoc comment and contains no call (its real caller, `api/mcp/token/route.ts`, is counted separately). Apply the comment-vs-call filter here too — the count is 27 *files matched*, not 27 call sites, and the distinction is the same one that made the earlier fabricated cardinality worthless.

  Two consequences. First, the behaviour change C5 introduces reaches every real caller, not just the two proxy entry points — including `api/extension/bridge-code/route.ts:177`, which calls `checkAccessRestrictionWithAudit` directly and is the extension-pairing path, so the R-a rollout risk covers browser-extension pairing as well as dashboard access. Second, and this is what makes the invariant enforceable rather than aspirational: a separate grep for `isTailscaleIp|tailscaleTailnet|100\.64\.0\.0` across `src/` (excluding `access-restriction.ts`, `ip-access.ts`, `tailscale-client.ts`) returns the policy-editing UI, the policy route's input validation, and `lib/http/external-http.ts:36,66` — the last being C4's own CGNAT blocklist entry, a coincidental string match on the CIDR rather than a second adjudicator. **No member holds a private copy of the adjudication.** Every real caller funnels through `checkAccessRestriction`, which is why the behavioural proof belongs at that choke point rather than being replicated 27 times (see the C5 rows in Testing strategy). The full output is recorded here rather than summarized, because "returns only X" was written twice in this plan about commands that also returned Y (R50).
- I5.2 `allowedCidrs` is evaluated before the Tailscale branch and short-circuits — this is the NFR3 recovery path and must be asserted by a test, not only by reading the code.
- I5.3 The WhoIs check runs only when `policy.tailscaleEnabled && policy.tailscaleTailnet` — a tenant that enabled Tailscale without pinning a tailnet keeps today's CGNAT-only semantics, which is an explicit operator choice and not a regression.
- I5.4 Denial reasons stay stable for audit consumers: `"Tailscale tailnet mismatch"` for a WhoIs failure, distinct from `"Tailscale verification failed"` for a non-CGNAT source. Both become named constants in `access-restriction.ts` rather than repeated literals, since after C5 each is written from one place and asserted from several (R2).
- I5.6 The WhoIs cache (`tailscale-client.ts:31`, keyed by IP, 30 s TTL) stays keyed by IP. The cached value is *the tailnet that IP belongs to*, which is a property of the address as `tailscaled` sees it and takes no tenant input; the per-tenant comparison happens after the lookup, against `policy.tailscaleTailnet`. Adding the expected tailnet to the key would not change any verdict — it would only fragment the cache. What the key cannot bound is staleness: an address reassigned to a peer in a different tailnet is verified against the previous peer's tailnet for up to 30 s. That window is accepted and recorded here rather than silently inherited, because C5 is what makes this cache load-bearing for browser sessions; it is bounded by the TTL, applies equally to the allow and deny directions, and shortening it would cost a WhoIs round trip per request (NFR2).

  One assumption this rests on is external and is named rather than inherited silently, in the same spirit as the NAT64 residual in SC2: a per-tenant `tailscaleTailnet` comparison against a single shared `tailscaled` only makes sense if each tenant's devices are visible to that daemon, which for independent tailnets means node sharing. The reasoning above holds within one netmap snapshot — one daemon cannot coherently route the same `100.x.y.z` to two peers — but it assumes the control plane does not hand the same CGNAT address to peers in two different tailnets shared into this daemon. If an operator runs that topology, confirm the assumption before relying on tailnet isolation for it; the TTL is not the control that would save you.
- I5.5 `checkAccessRestriction` needs no new parameter: `verifyTailscalePeer(ip, expectedTailnet)` takes the client IP, which the function already has, and the expected tailnet, which it already reads from `getTenantAccessPolicy(tenantId)`. No signature change, and no peer identity is resolved by the caller.

**Consumer-flow walkthrough** (`AccessCheckResult` is consumed outside the producer)

- Consumer `src/lib/proxy/page-route.ts:119` reads `{ allowed }` and uses it to return `403 Forbidden` for `/dashboard/*` and `/admin/*`. It does not read `reason`. **After C5 it must additionally surface nothing new** — the audit emission happens inside `checkAccessRestrictionWithAudit`, so the page route needs no change beyond inheriting the stricter result.
- Consumer `src/lib/proxy/api-route.ts:128` reads `{ allowed }` and maps it to `API_ERROR.ACCESS_DENIED` with `Cache-Control: no-store`. Same conclusion: no shape change.
- Consumer `src/app/api/extension/bridge-code/route.ts:177` reads `{ allowed }` from a direct `checkAccessRestrictionWithAudit` call and refuses to issue the extension bridge code when denied. It does not read `reason`. No shape change; it inherits the stricter verdict like the two proxy consumers, and it is the reason R-a's rollout note names extension pairing alongside dashboard access.
- Consumer `enforceAccessRestriction` (`:279`) reads `{ allowed, reason }` and writes `reason` into the audit metadata. After C5 it must **not** re-run WhoIs; it receives the tailnet verdict through `reason` and emits it unchanged, which is why I5.4 pins the string.
- Consumer `src/__tests__/lib/access-restriction.test.ts` and `src/lib/auth/policy/access-restriction.test.ts` read `{ allowed, reason }` directly; both need new cases rather than shape changes.

**Forbidden patterns**

- `pattern: /verifyTailscalePeer/` appearing more than once in `src/lib/auth/policy/access-restriction.ts` — reason: two call sites is the R48 divergence this contract exists to remove.

**Acceptance criteria**

- Session path, tenant with `tailscaleTailnet: "acme"`, peer whose WhoIs reports `host.acme.ts.net.` → allowed.
- Same tenant, peer whose WhoIs reports `host.other.ts.net.` → denied, audit `reason: "Tailscale tailnet mismatch"`, and the denial is reachable through `page-route` (403) and `api-route` (`ACCESS_DENIED`).
- Same tenant, `tailscaled` unreachable → denied (fail-closed).
- Same tenant with the client IP inside `allowedCidrs` → allowed **without** a WhoIs call (assert the mock was not called).
- Tenant with `tailscaleEnabled` but no `tailscaleTailnet` → CGNAT-only behaviour unchanged.

### C8 — tailnet extraction must handle a multi-label tailnet name

**File**: `src/lib/services/tailscale-client.ts`

```ts
function extractTailnetFromFqdn(fqdn: string): string | null;  // signature unchanged; parsing corrected
```

**Control class**: `fail-closed verification gate` — it is the parsing step of C5's gate, and every unparseable form returns `null`, which denies. **Adjudication authority**: the structure of the MagicDNS FQDN (`<node>.<tailnet>.ts.net.`), read by position from the end, not a fixed label count.

**Why this is in scope.** `extractTailnetFromFqdn` (`tailscale-client.ts:66-77`) returns `parts[parts.length - 3]` — exactly one label before `ts.net`. A domain-verified Tailscale organization's tailnet name is its domain (`example.com`), so its nodes appear as `host.example.com.ts.net.` and the current code extracts `"com"`. The tenant policy field accepts dotted names — `src/app/api/tenant/policy/route.ts:353` validates `tailscaleTailnet` against `/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/`, which permits dots — so an admin can store `example.com` today and the comparison at `tailscale-client.ts:187` can never match it.

Before C5 this misparse was confined to Bearer/API-key/SCIM callers. C5 makes it authoritative for every browser session across all 27 members of I5.1's set, turning a narrow defect into a tenant-wide lockout for exactly the organizations most likely to use a verified domain. Fixing it is not scope creep: C5 cannot ship a correct fail-closed gate on top of a parser that mis-reads the value it compares.

**Invariants**

- I8.1 The tailnet name is everything between the leading node label and the trailing `ts.net` — `parts.slice(1, -2).join(".")` — so both `host.tail1234.ts.net.` → `tail1234` and `host.example.com.ts.net.` → `example.com` are correct. The *trailing* boundary is read by position from the end and is therefore label-count independent; the *leading* boundary is fixed at exactly one label, which relies on Tailscale enforcing single-label machine names so MagicDNS can compose the FQDN unambiguously. That reliance is stated because it is an assumption, not a derivation: a two-label node name would fold its second label into the extracted tailnet, which fails closed (the garbled value matches no configured tailnet) but would be a confusing denial.
- I8.2 The trailing-`ts.net` and minimum-length guards are unchanged; anything not ending in `ts.net` still returns `null` and therefore denies.
- I8.3 Comparison stays an exact, case-normalized string equality against `policy.tailscaleTailnet`. No suffix, prefix or "last label" matching — a suffix match would let an unrelated `evil.example.com` tailnet satisfy a policy of `example.com`.

**Acceptance criteria**

- `extractTailnetFromFqdn("laptop.tail1234.ts.net.")` → `"tail1234"` (unchanged behaviour for the common case).
- `extractTailnetFromFqdn("laptop.example.com.ts.net.")` → `"example.com"` (today: `"com"`).
- `extractTailnetFromFqdn("laptop.example.com")` → `null`; `extractTailnetFromFqdn("ts.net")` → `null`.
- A tenant with `tailscaleTailnet: "com"` is **not** satisfied by a peer from `host.example.com.ts.net.` (I8.3 — this is the case the old truncation would have wrongly allowed).

### C6 — CI gate for the CLI shell-safety class

**File**: new `scripts/checks/check-cli-shell-safety.mjs`, wired into `scripts/pre-pr.sh` and the static-checks CI job

**Control class**: `fail-closed verification gate` over `cli/src`. It parses rather than greps, and an unparseable file is an error, not a skip. **Adjudication authority**: the TypeScript AST (ts-morph, no Program — consistent with the repo's other AST gates), not a regex over source text.

Two rules, derived rather than enumerated:

- **Rule A (launch)**: a `spawn`/`exec`/`execSync`/`execFile*` call whose command argument is a shell interpreter (`cmd`, `cmd.exe`, `sh`, `bash`, `powershell`, `pwsh`) **or** whose options object sets `shell: true`/a shell path, where any argument contains a template interpolation or a non-literal expression. A launch with only literal strings is allowed — this is what keeps `clipboard.ts:68,70` green while `oauth.ts`'s old form is red.
- **Rule B (emission)**: **any** template literal in `cli/src` whose text matches a shell assignment / `export` / `trap` form and contains an interpolation that is not a call to `shellQuote`. The rule deliberately does **not** anchor on `console.log`: I3.4 moves two of the member lines into pure functions that *return* their lines for a caller to print, and a `console.log`-anchored pattern would stop matching exactly the two sites the plan moved — the gate would go green because the code became invisible to it, not because it became safe. The literal is the defect; the sink is incidental. Numeric-typed interpolations are not exempt by type — the discharge is the call, so `child.pid` gets quoted like anything else. Per I3.1 this rule **is** the definition of the C3 member set; it must match an interpolation whether or not the surrounding text has hand-written quotes (`agent.ts:187` has none, `agent.ts:243` has them, and both are members).
- **Rule C (single adjudicator) — a tripwire, not a boundary**: over `src`, `verifyTailscalePeer` is referenced from at most one site outside `services/tailscale-client.ts`; the literal `64:ff9b` appears only in `lib/http/external-http.ts` and its test; and `/localapi/v0/whois` appears only in `services/tailscale-client.ts`. These are C4's and C5's forbidden patterns, which without a rule are review-time wishes.

  Its class is declared honestly because the difference matters (R49): Rule C counts *references to names*, and the repo's AST gates match callee text without binding resolution, so an import alias (`verifyTailscalePeer as vtp`), an indirect call through a captured reference, and above all **an independently written WhoIs-and-compare implementation that never mentions the name** all pass it. That last case is the literal R48 shape — it is how the original two-adjudicator split arose — so Rule C must not be cited as closing the class. The `/localapi/v0/whois` clause exists because it is the one string a reimplementation cannot avoid; it raises the bar from "must not call the function" to "must not talk to the API", which is the closest a name-based check gets. The real closure remains C5's structural collapse to one verdict site plus review; Rule C's job is to make a regression noisy, not impossible.

  Scan roots: Rules A/B over `cli/src`, Rule C over `src`, each overridable by its own variable (`CLI_SHELL_SAFETY_ROOT`, `SRC_ADJUDICATOR_ROOT`) — one variable cannot present two differently-shaped fixture subtrees to a self-test, and the sibling precedent (`check-operator-echo-escaped.mjs`, single `OPERATOR_ECHO_CHECK_ROOT` + fixed `SCAN_ROOT`) only covers the single-root case.

**Invariants**

- I6.1 The gate is proven able to fail (RT7) by a **repeatable sibling self-test**, not by a one-time manual mutation. `scripts/checks/check-gate-selftest-coverage.sh` — wired at `scripts/pre-pr.sh:342` and therefore running in the CI `static-checks` job — requires every `scripts/checks/*.{sh,mjs}` file to have a sibling `scripts/__tests__/<base>.test.mjs` or a reasoned entry in `scripts/checks/gate-selftest-debt.txt`. Wiring C6 without the self-test makes that meta-gate emit `MISSING_GATE_SELFTEST` and exit 1 on the very PR that adds C6. So C6 ships with `scripts/__tests__/check-cli-shell-safety.test.mjs`, following the `check-operator-echo-escaped.test.mjs` convention: fixtures written to a temp directory, the gate `spawnSync`-ed against them. **Every rule needs its own red fixture** — the meta-gate only checks that the file exists, not that it covers each rule, so a self-test that exercises A and B while leaving C unproven satisfies CI while the untested rule can silently never fire, which is the exact failure the meta-gate's own header describes. Required fixtures:

  | Rule | Expect exit 1 | Expect exit 0 |
  |------|---------------|---------------|
  | A | `spawn("cmd", ["/c","start","",url])` | `execSync("pbcopy < /dev/null")` — literal args, the `clipboard.ts` shape |
  | B | a template literal `` `trap ... ${x} ...` `` with a bare interpolation, in a `return` position as well as under `console.log` | the same literal with `${shellQuote(x)}` |
  | C | a second file referencing `verifyTailscalePeer`; a second file containing `64:ff9b`; a second file containing `/localapi/v0/whois` | the real single-site shape |
- I6.2 The gate is wired into the authoritative gate, not merely authored — `scripts/pre-pr.sh` **and**, through it, the CI `static-checks` job (`.github/workflows/ci.yml`, which runs `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`). There is no repo-wide "is every check queued" meta-gate to lean on: `scripts/checks/check-orphaned-checks.sh` does not exist, and `check-gate-selftest-coverage.sh` verifies self-test presence, not wiring. The wiring is therefore asserted mechanically inside C6's own self-test: `grep -q check-cli-shell-safety scripts/pre-pr.sh`.
- I6.3 The scan roots default to `cli/src` (Rules A/B) and `src` (Rule C), declared as constants, each overridable by its own environment variable (`CLI_SHELL_SAFETY_ROOT` / `SRC_ADJUDICATOR_ROOT`, mirroring `OPERATOR_ECHO_CHECK_ROOT`'s purpose) so the self-test can point each rule at its own scratch fixture tree instead of the real repo. The nearest sibling gate (`scripts/checks/check-operator-echo-escaped.mjs`, `SCAN_ROOT = "scripts"`) covers a *different* class (display escaping of operator text) and a different root — it is structural precedent, not existing coverage for this class.

**Acceptance criteria**: `scripts/__tests__/check-cli-shell-safety.test.mjs` passes; the gate is green on the fixed tree and on `clipboard.ts` as-is; `check-gate-selftest-coverage.sh` stays green after C6 is wired.

### C7 — documentation of the boundary that remains

**Files**: `README.md` / `README.ja.md` Tailscale section; `messages/en/TenantAdmin.json` and `messages/ja/TenantAdmin.json` (`tailscaleEnabledHelp`, `tailscaleTailnetHelp`); the operator-facing security documentation for I7.3

**Control class**: `detection or audit only` — this contract changes no runtime behaviour.

**Invariants**

- I7.1 No user-facing string claims a control **different** from what C5 implements — in either direction (R49). Over-claiming misleads an operator into skipping a control; under-claiming misleads them into adding a redundant one to compensate for a gap that no longer exists. Named members:
  - `README.md:63` / `README.ja.md:63` — describe the feature without the CGNAT-vs-tailnet distinction; revise.
  - `messages/en/TenantAdmin.json:90` / `messages/ja/TenantAdmin.json:90` (`tailscaleEnabledHelp`, rendered at `tenant-access-restriction-card.tsx:243`) — currently read "browser access is allowed from any source in the Tailscale network address range; the tailnet name below is verified only for API/token access". This is an accurate description of the gap F2 exists to close, and C5 makes it **false**; it must be rewritten in the same commit that lands C5, or the product ships documentation telling admins to compensate for a bypass that no longer exists.
  - `messages/en/TenantAdmin.json:93` / `messages/ja/TenantAdmin.json:93` (`tailscaleTailnetHelp`) — "the tailnet name to verify for API/token connections" carries the same stale scope, and its example (`"example"` for `hostname.example.ts.net`) must also be reconciled with C8: a domain-verified tailnet name is dotted (`example.com`), and the help text should not imply single-label only.
- I7.2 The lockout recovery path (add a CIDR to `allowedCidrs`; it is evaluated first) is documented next to the tailnet setting, in both languages. Japanese copy uses 保管庫 for "vault" where the term appears.
- I7.3 The NAT64 residual from C4 (operator-assigned prefixes are neither blocked nor decoded) appears in the operator-facing security documentation, so the shipped artifact does not imply a broader closure than C4 delivers.

**Acceptance criteria**: `rg -ni 'tailscale|tailnet' README.md README.ja.md messages/en/*.json messages/ja/*.json src/components/settings/security/tenant-access-restriction-card.tsx` — every hit either matches the implemented semantics or is corrected in this branch.

Two spellings of this command were wrong before this one, and both failed *silently in the direction of green*, which is why the exact command is pinned here. `rg -n 'tailnet' README*` returns zero hits while the under-specified lines at `README.md:63` / `README.ja.md:63` say "Tailscale". And `messages/*.json` matches nothing at all — the translations live in `messages/en/` and `messages/ja/` (120 files), so in zsh the unmatched glob aborts the whole command before any file is read, and the run looks clean because it produced no findings rather than because there were none. Re-run the pinned command and confirm it returns a non-empty result before treating this criterion as satisfied (R50).

## Go/No-Go Gate

| ID | Subject | Must land no later than | Status |
|----|---------|------------------------|--------|
| C1 | Shell-free browser launch (`browserLaunchCommand` + `openBrowser`) | — | locked |
| C2 | `validateServerUrl` rejects userinfo / query / fragment / non-DNS host / non-plain path | — | locked |
| C3 | Shared `shellQuote`, adopted across the class C6 Rule B defines (snapshot: eight agent-side sites) | with C6 | locked |
| C4 | NAT64 decoding for the well-known prefix + IPv6 transition ranges blocked | — | locked |
| C5 | Single adjudicator for the tenant access predicate (WhoIs on session paths) | **after C8** | locked |
| C6 | `check-cli-shell-safety.mjs` (Rules A/B over `cli/src`, Rule C over `src`), self-tested and wired | with C3 | locked |
| C7 | Documentation matches the implemented control class, in both directions | **with C5** | locked |
| C8 | `extractTailnetFromFqdn` handles a multi-label tailnet name | before C5 | locked |

All eight contracts are `locked`: plan review closed at round 3 (see `harden-cli-tailnet-ssrf-review.md`, "Convergence assessment"). A contract flips back to `pending` if implementation materially changes its signature, invariants, forbidden-pattern list, or acceptance criteria.

**The ordering column is part of the gate, not a note.** Two dependencies have production consequences and were prose-only in an earlier draft, which is exactly how a sequencing error ships:

- **C8 before C5** — C5 extends the tailnet check to every browser session. On top of the current extractor, a tenant whose tailnet name is dotted (any domain-verified organization) is denied unconditionally, so C5-without-C8 converts a token-path defect into a tenant-wide lockout. C5 may not be marked done while C8 is pending. (R-d.)
- **C7 with C5** — `tailscaleEnabledHelp` currently tells admins that the tailnet is verified for API/token access only, and instructs them to compensate with `allowedCidrs`. C5 makes that false. Shipping the behaviour without the copy leaves the product actively advising a workaround for a gap that no longer exists.
- **C3 with C6** — the gate defines C3's member set (I3.1). Landing the fixes without the gate leaves the class enumerated again; landing the gate without the fixes turns CI red.

## Testing strategy

| Contract | Test | Why it can fail |
|----------|------|-----------------|
| C1 | `cli/src/__tests__/unit/oauth-launch.test.ts` — `browserLaunchCommand` over {win32, darwin, linux} × {plain URL, URL with `&|<>^%!`, `file://`} | Asserts the argv vector element-by-element; the old `cmd` form produces a different vector and fails. Platform is a parameter, so the Windows case runs on Linux CI (VE1 mitigation). |
| C2 | extend `cli/src/__tests__/unit/oauth.test.ts` | Each rejected form is asserted to throw with a distinct message; the current implementation accepts them and fails. |
| C3 | `cli/src/__tests__/unit/shell-quote.test.ts` — round-trip through a real `/bin/sh` for the adversarial value set | Not a string-equality assertion against an expected quoting: the shell is the oracle, so a wrong-but-plausible quoting fails. |
| C3 | `agent.ts` sites → extend `cli/src/__tests__/unit/agent.test.ts`; `agent-decrypt.ts` sites → extend `cli/src/__tests__/unit/agent-decrypt.test.ts`. Assert the emitted lines for a socket path containing `'` and a space, via the I3.4 pure functions | `agent.test.ts:9-16` mocks the whole `agent-decrypt` module (`vi.mock("./agent-decrypt.js", ...)`), so assertions written there for the four `agent-decrypt` sites would run against the mock and stay green with the fix reverted — the same false-positive shape T2 caught for the proxy tests. Each file's assertions belong in that file's own test. The I3.4 extraction is what makes the *foreground* sites reachable at all — the daemon-mode sites (`agent-decrypt.ts:348-350`) are a different problem: they live in a `child.on("message", ...)` callback inside the non-exported `forkDaemon`, and `agent-decrypt.test.ts` currently mocks `node:child_process` with an unconfigured `spawn`, so nothing reaches them. Replicate the fake-child scaffolding `agent.test.ts:232-269` already uses for the equivalent `agent.ts` block (captured event handlers, `vi.mocked(spawn).mockReturnValue(fakeChild)`, then fire `handlers["message"]` by hand). Without that, C6 Rule B would prove `shellQuote` is *called* at those three lines while nothing proves it is called with the right value. |
| C3 / C6 | the gate is the coverage claim, not the test list | Because I3.1 delegates membership to C6 Rule B, per-site tests pin *behaviour* while the gate pins *completeness*. Neither substitutes for the other, and a green gate on a tree where the tests were never extended is not a pass. |
| C8 | extend **both** `src/lib/services/tailscale-client.test.ts` and `src/__tests__/lib/tailscale-client.test.ts` — `laptop.tail1234.ts.net.` → `tail1234`, `laptop.example.com.ts.net.` → `example.com`, non-`ts.net` → `null`, and a policy of `"com"` NOT satisfied by `host.example.com.ts.net.` | The dotted case fails against today's `parts[length-3]`; the last assertion is the one that stops the fix from becoming a suffix match. Two suites cover this function through the same test-only alias `_extractTailnetFromFqdn` (exported at `tailscale-client.ts:203`); extending only the one the contract names leaves the other as a stale twin (RT9). |
| C7 | a unit test over the shipped translations: `messages/{en,ja}/TenantAdmin.json`'s `tailscaleEnabledHelp` / `tailscaleTailnetHelp` must not contain the stale scope phrases (`API/token`, `APIアクセス`) | C7's acceptance grep is a one-time human command; nothing would notice a later edit reintroducing the stale claim. A forbidden-substring assertion over the two files is cheap, runs in `app-ci` with every other vitest test, and fails loudly if the copy regresses — a real mechanism for the one invariant in this plan that otherwise had none. |
| C4 | extend `src/lib/http/external-http.test.ts` via the existing `describe.each(BLOCKED_CIDR_REPRESENTATIVES)` plus explicit NAT64 cases incl. the **public**-embedded negative case | The negative case (`64:ff9b::93.184.216.34` → allowed) is what stops the fix from degenerating into "block the prefix"; a blunt implementation fails it. |
| C5 | extend `src/lib/auth/policy/access-restriction.test.ts`: mismatch→deny (asserting the audit row and its `reason`, not only the boolean), match→allow, socket-down→deny, CIDR-precedence→allow **and `verifyTailscalePeer` not called** | The allow-side and precedence cases are RT10 obligations — a deny-only suite would pass against an implementation that denies everyone. This file mocks `verifyTailscalePeer` (one level below the function under test), so it can observe whether `checkAccessRestriction` calls it. |
| C5 | **no new assertions in** `src/lib/proxy/page-route.test.ts` / `api-route.test.ts` | Both files `vi.mock` the whole `@/lib/auth/policy/access-restriction` module (`page-route.test.ts:19-21`, `api-route.test.ts:9-11`), so no line C5 changes executes there. A test written at that boundary would pass identically with C5 reverted — a false-positive test, and worse than no test because it reads as proof of inheritance. Inheritance is instead established structurally by I5.1 (no member holds a private adjudicator) and behaviourally at the choke point in the row above. |
| C6 | `scripts/__tests__/check-cli-shell-safety.test.mjs` — fixture tree via `CLI_SHELL_SAFETY_ROOT`, asserting exit 1 on each violating fixture, exit 0 on the clean and `clipboard.ts`-shaped fixtures, and `grep -q check-cli-shell-safety scripts/pre-pr.sh` for wiring | RT7 — an authored-but-unproven gate reports PASS by never firing, and `check-gate-selftest-coverage.sh` rejects the PR outright if this file is absent. |

Full-suite obligations before any commit: `npx vitest run`, `npx next build`, `bash ~/.claude/hooks/check-pre-pr.sh run`.

## Considerations & constraints

**Risks**

- **R-a (C5, deployment behaviour change)**: tenants that already set `tailscaleEnabled` + `tailscaleTailnet` and reach the app through a path where `tailscaled` is not queryable will lose browser access on deploy. Mitigation: I5.2 recovery path, documented in C7, plus a release note. This is the accepted cost of the fail-safe default the user selected; it is not deferred.
- **R-b (C1)**: `rundll32 url.dll,FileProtocolHandler` cannot be executed in CI (VE1). If it turns out to misbehave on a real Windows host, the fallback is `explorer.exe <url>` — also shell-free — not a return to `cmd /c start`.
- **R-d (C8, a pre-existing lockout being fixed rather than introduced)**: any tenant whose `tailscaleTailnet` is a dotted, domain-verified name is *already* unable to pass the token/Bearer tailnet check today, because the extractor truncates to the last label. C8 fixes that. Two consequences for rollout: such tenants may see token-path access start working that previously failed, and — because C5 extends the same check to browser sessions — shipping C5 without C8 would convert a narrow token-path defect into a full lockout for exactly those tenants. C8 is therefore a prerequisite of C5, not an independent nicety, and the Go/No-Go gate must not lock C5 while C8 is pending.
- **R-c (C4)**: a NAT64-only deployment that reaches a destination through a *non-standard* NAT64 prefix is unaffected by this change in either direction; such prefixes are neither blocked nor extracted (SC2/SC4).

**Scope contract**

| ID | Deliberately out of scope | Owner |
|----|---------------------------|-------|
| SC1 | Adopting an `open`-style npm dependency for browser launching | rejected by NFR1; revisit only if C1's fallback also fails on real Windows |
| SC2 | Full IPv6 special-purpose registry enumeration (ORCHIDv2, SRv6 `5f00::/16`, documentation prefixes), **and operator-assigned NAT64 prefixes** | future hardening issue; C4 covers the standardized ranges that carry or tunnel an IPv4. An operator-assigned NAT64 prefix cannot be recognized from the address alone, so closing it would need a configured prefix list — deliberately not introduced here (a new env var pulls in `env-schema.ts`, `.env.example` and the `check:env-docs` drift gate for a deployment shape this project has no evidence of running). Disclosed to operators under I7.3 instead of silently implied closed. |
| SC3 | Egress firewall rules blocking metadata/private destinations at the network layer | deployment/runbook concern, not application code |
| SC4 | RFC 6052 `/40`, `/48`, `/56`, `/64` NAT64 embedding decoders | only the `/96` well-known prefix has an RFC-guaranteed layout worth decoding; `64:ff9b:1::/48` is blocked by prefix instead of decoded (RFC 8215 §5), and the remaining lengths belong to operator-assigned prefixes covered by SC2 |
| SC5 | Extending C6's rules to `src/`, `scripts/`, `extension/` | `scripts/` has its own gate for a different class; a shell-emission class does not exist in `src/` |

## User operation scenarios

1. **Windows CLI login** — `passwd-sso login --server https://vault.example` on Windows 11. The default browser opens the full authorization URL including every query parameter; nothing is executed by a shell. Previously the URL was truncated at the first `&`.
2. **Hostile server URL** — `passwd-sso login --server 'https://a&calc'`. The WHATWG parser *accepts* this (`hostname === "a&calc"`), so the rejection comes from C2's I2.4 hostname pattern, not from `new URL` throwing. And even for a value that satisfies I2.4, C1 guarantees no command interpreter ever sees the composed URL — the two contracts are layered deliberately, since neither alone is the boundary.
3. **Agent with an awkward runtime dir** — `XDG_RUNTIME_DIR="/run/user/1000/my dir"`, then `eval $(passwd-sso agent --eval)`. `$SSH_AUTH_SOCK` ends up exactly equal to the path, `ssh-add -l` works, and the EXIT trap removes the right socket. Previously the line split at the space.
4. **Tenant on Tailscale, peer from another tailnet** — a browser on a different tailnet with a CGNAT source IP loads `/ja/dashboard`. Previously: 200. After C5: 403, with `ACCESS_DENIED` audited as `Tailscale tailnet mismatch`.
5. **Operator locked out** — `tailscaled` is unreachable from the app container after a deploy. The operator adds their office CIDR to `allowedCidrs` through a path that does not depend on Tailscale, and regains access; the CIDR branch is evaluated first.
6. **Webhook to a NAT64-only destination** — a tenant webhook targets a public host whose only route is NAT64. Delivery still succeeds (FR3). The same tenant pointing a webhook at `64:ff9b::169.254.169.254` is refused before the connection is made.

## Implementation Checklist

Derived in Phase 2 Step 2-1. Every entry was produced by a command re-run at implementation time, not copied from the contracts.

### Files to modify

| File | Contract | Change |
|------|----------|--------|
| `cli/src/lib/shell-quote.ts` *(new)* | C3 | `shellQuote` promoted verbatim from `env.ts:130` |
| `cli/src/commands/env.ts` | C3 | delete the private copy, import the shared one (I3.3) |
| `cli/src/lib/oauth.ts` | C1, C2 | `browserLaunchCommand` extracted; `openBrowser` delegates; `validateServerUrl` gains I2.4 |
| `cli/src/commands/agent.ts` | C3, I3.4 | `:187` hint block → pure function; `:243-245` quoted |
| `cli/src/commands/agent-decrypt.ts` | C3, I3.4 | `:419` hint block → pure function; `:348-350` quoted |
| `cli/src/commands/run.ts` | C6 Rule A | stale `execFile` header comment corrected to `spawn` |
| `src/lib/http/external-http.ts` | C4 | `BLOCKED_CIDRS` extended, `extractNat64Ipv4` added, `isPrivateIp` checks the embedded IPv4 |
| `src/lib/services/tailscale-client.ts` | C8 | `extractTailnetFromFqdn` multi-label |
| `src/lib/auth/policy/access-restriction.ts` | C5 | WhoIs folded into `checkAccessRestriction`; duplicate removed from `enforceAccessRestriction`; reason constants |
| `messages/{en,ja}/TenantAdmin.json` | C7 | `tailscaleEnabledHelp`, `tailscaleTailnetHelp` |
| `README.md`, `README.ja.md` | C7 | line 63 |
| `scripts/checks/check-cli-shell-safety.mjs` *(new)* | C6 | Rules A/B over `cli/src`, Rule C over `src` |
| `scripts/pre-pr.sh` | C6 | `queue_step "Static: cli-shell-safety"` in the static batch |

### Test files (R19 — all trees enumerated, not just the obvious one)

`cli/src/__tests__/unit/{oauth,agent,agent-decrypt,env}.test.ts`; `src/lib/http/external-http.test.ts`; `src/lib/auth/policy/access-restriction.test.ts`; `src/__tests__/lib/access-restriction.test.ts`; **both** `src/lib/services/tailscale-client.test.ts` and `src/__tests__/lib/tailscale-client.test.ts` (T9 — parallel suites over the same `_extractTailnetFromFqdn` alias); new `scripts/__tests__/check-cli-shell-safety.test.mjs`; new translation-copy assertion (C7).

Explicitly **not** extended: `src/lib/proxy/{page,api}-route.test.ts` (T2 — they mock the module C5 changes).

### Shared utilities to reuse (R1/R17 — no reimplementation)

- `shellEscape` at `cli/src/commands/env.ts:130` — promote, do not rewrite.
- `isIpInCidr` at `src/lib/auth/policy/ip-access.ts:216` — already handles arbitrary IPv6 prefixes; C4 adds CIDR strings, not a new matcher.
- `BLOCKED_CIDR_REPRESENTATIVES` — `external-http.test.ts:67-68` already asserts lockstep with `BLOCKED_CIDRS`; every new CIDR needs a representative or that test fails.
- `verifyTailscalePeer` — already imported by `access-restriction.ts`; C5 moves the call, it does not add a client.
- `MS_PER_SECOND` / `MS_PER_MINUTE` from `src/lib/constants/time` — for any new duration.
- Gate scaffolding: `scripts/checks/check-operator-echo-escaped.mjs` (ts-morph 28, no Program) and its self-test `scripts/__tests__/check-operator-echo-escaped.test.mjs`.

### CI gate parity (Step 2-1 item 7)

`extract-ci-checks.sh` yields 13 gates: `lint`, `typecheck`, `check:bypass-rls`, `check:crypto-domains`, `check:env-docs`, `check:migration-drift`, `check:team-auth-rls`, three `licenses:check:*:strict`, `check-state-mutation-centralization.sh`, `check-tls-fixture-expiry.sh`, `refactor-phase-verify.mjs`. All are queued by `scripts/pre-pr.sh`, which the `static-checks` CI job runs as `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` — **no parity gap, nothing to defer**.

One gate fires on *new files specifically* and is the reason C6's self-test is not optional: `check-gate-selftest-coverage.sh` (`pre-pr.sh:342`) requires `scripts/__tests__/check-cli-shell-safety.test.mjs` to exist the moment `check-cli-shell-safety.mjs` is added.

### Duplicate-implementation scan (Step 2-1 item 2)

- Two suites cover `_extractTailnetFromFqdn` (T9) — both updated.
- Two suites cover access restriction (`src/lib/auth/policy/access-restriction.test.ts`, `src/__tests__/lib/access-restriction.test.ts`) — both updated.
- No `.js`/`.ts` twin exists for any file in this diff (the extension's twin problem does not reach `cli/` or `src/lib/`).
