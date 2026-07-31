# Coding Deviation Log: harden-cli-tailnet-ssrf

Recorded during Phase 2. Every entry is a departure from the locked plan, with the reason and who decided it.

## VE4 probe result (plan prerequisite, not a deviation)

The plan required a build probe before implementing C5, because C5's design rests on the proxy running in the Node.js runtime and no source read can decide that.

Run: `npx next build`, then inspection of `.next/server/`.

Observed: `middleware-manifest.json` has `middleware: {}` and `sortedMiddleware: []` — an Edge-runtime proxy would be registered there. The proxy entry `.next/server/middleware.js` is CommonJS (`require()`-based Turbopack runtime), and its NFT trace (`middleware.js.nft.json`, 387 files) includes `node_modules/.prisma/client/*` and `node_modules/pg/lib/*` — neither can execute in the Edge runtime.

**Conclusion: Node.js runtime, as expected.** C5 was implemented as specified, and the stale `SECURITY BOUNDARY (intentional)` comment at `access-restriction.ts:160-175` — whose "this runs in Edge runtime where tailscaled WhoIs is unavailable" premise is what kept the gap open — was rewritten.

## D1 — `src/lib/auth/policy/ip-access.ts` modified, though the plan's file list did not include it

**What happened.** Batch B found that `isPrivateIp("64:ff9b::169.254.169.254")` returned `false` even with the new CIDRs in place: `parseIpv6` special-cases RFC 4291 §2.2 form 3 (dotted-quad tail) *only* for the `::ffff:` prefix, so every other mixed-notation address fails to parse and silently matches no CIDR. The sub-agent worked around it inside `external-http.ts` with two private helpers (`canonicalizeIpv6` via the WHATWG URL parser, plus `expandIpv6Groups`).

**Why that was not kept.** That is a second IPv6 parser in the repo — R1, and the plan's own I4.3 says to reuse `isIpInCidr` rather than route around it. The workaround also left the shared matcher broken for every other caller (`isIpAllowed` over tenant CIDR allowlists, `isTailscaleIp`), where the same address form fails closed and would look like an unexplained deny.

**What was done instead.** `parseIpv6` now handles the general form: when the text after the last colon contains a dot, it is parsed as IPv4 and rewritten into the two hex groups it denotes, then parsed normally. `parseIpv6Bytes` is exported so C4's NAT64 decoder can read the embedded IPv4 by byte position. Both private helpers in `external-http.ts` were deleted; `extractNat64Ipv4` and `isPrivateIp` are now four lines each.

**Verification.** `npx vitest run src/lib/http/ src/lib/auth/policy/ src/__tests__/lib/` → 31 files, 699 tests, all pass, including the pre-existing `::ffff:` cases that exercised the old special case.

## D2 — Rule B is narrower than the plan's prose, and that narrowing is load-bearing

The plan defines Rule B as "any template literal whose text matches a shell assignment / `export` / `trap` form and contains an interpolation that is not a call to `shellQuote`". As implemented, the assignment form additionally requires an **ALL-CAPS identifier immediately before `=`**.

Reason: without it the rule fires on two legitimate, already-safe sites — `env.ts`'s `` `${k}=${shellQuote(v)}` `` (the variable *name* is itself an interpolation, validated upstream) and `audit-verify.ts`'s lowerCamelCase diagnostic strings like `` `expected=${expected}` ``, which are not shell syntax at all.

**Consequence, recorded because I3.1 makes Rule B the definition of the C3 class**: an emission site of the form `` `${name}=${value}` `` with a non-constant, non-upper-case variable name is outside the class as implemented. No such site exists today (`env.ts` is the only `${k}=` shape and it discharges through `shellQuote`), but the class boundary is narrower than the plan's sentence reads, and a reviewer should treat the sentence as the intent and the implementation as the enforced set.

## D3 — C7's NAT64 disclosure went to the READMEs, not to a dedicated security document

I7.3 said "wherever this repo documents operator-facing security notes". Batch C's file scope was the two READMEs and the two `TenantAdmin.json` files, so the disclosure landed as a new README bullet rather than in `SECURITY.md`. The content requirement is met; the placement is the weaker of the two options and is worth revisiting if a security-notes page is added later.

## D4 — pre-existing tests that encoded pre-fix behaviour were updated, not preserved

Three sets of assertions asserted the behaviour the plan exists to change, so leaving them green would have meant the fix did not ship:

- `src/__tests__/lib/access-restriction.test.ts` — two tests asserted "CGNAT alone allows" *with a pinned `tailscaleTailnet`*, which I5.3 makes wrong. Split into an unpinned-tailnet case (behaviour genuinely unchanged) plus two new pinned-tailnet WhoIs cases.
- `src/__tests__/lib/tailscale-client.test.ts` — a "multi-segment hostname" case encoded the truncation bug I8.1 removes.
- `cli/src/__tests__/unit/agent.test.ts` — two assertions expected always-quoted output; `shellQuote` leaves shell-safe values (`/tmp/eval.sock`, `4242`) unquoted, which is correct and is what the `/bin/sh` round-trip tests now pin.

## D5 — `access-restriction.test.ts` mock setup refactored

Batch C switched the file from a typed `prisma` import to hoisted mock references, because `vi.mocked(prisma.tenant.findUnique)` failed `tsc` when given only the policy-relevant fields of the full Prisma `Tenant` type. This matches the convention already used by the sibling suite. No assertion semantics changed.

## D6 — a comment in `ip-access.ts` was reworded to keep C6 Rule C green

The D1 comment originally spelled a NAT64 example address literally. Rule C's `64:ff9b` clause is a plain-text tripwire over `src`, so it fired. The comment now names the NAT64 prefixes without spelling one — the gate stays maximally sensitive (no exemption marker was added for it), and nothing about the code changed. Recorded because "the gate fired and the source was edited" is exactly the shape that deserves an audit trail.
