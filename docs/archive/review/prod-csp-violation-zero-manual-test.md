# Manual test plan: prod-csp-violation-zero

R35 Tier-2 (Critical). Two deployment artifacts change:

- **`Dockerfile`** — the builder stage now applies `patches/sonner+2.0.8.patch`
  and refuses the build if the patch is absent, the tool is missing, the
  resolved sonner version drifts, or the patch marker did not reach the emitted
  client bundle. This runs on the path that produces the shipped image.
- **`.github/workflows/ci.yml`** — the `app` paths filter gains `patches/**`,
  `.npmrc` and `instrumentation-client.ts` (and loses a `instrumentation.ts`
  entry that matched no file); the E2E job's `if:` no longer skips when the
  `changes` job fails or is skipped.

Everything below was run on 2026-09-27 unless marked *not run*.

## Pre-conditions

- Docker available; the repository at the branch head.
- `docker compose` services not required for the image build.
- For the CI half: a scratch branch pushed to the fork/remote, or
  `act`-equivalent. The CI assertions below are **not run** locally — see
  "Deferred" at the end.

## Steps and expected results

### T1 — the image builds and the patch reaches the shipped bundle

```bash
docker build -t passwd-sso:csp-t1 .
```

Expected: build succeeds. The verification `RUN` steps are silent when healthy
and the build proceeds past `next build`.

Status: **RUN, and it caught a real defect on the first attempt.** The version
assertion was written as `require('sonner/package.json')`, which throws
`ERR_PACKAGE_PATH_NOT_EXPORTED` because sonner's `exports` map lists only `"."`
and `"./dist/styles.css"`. The same check had passed locally, where it was
written against a relative path — and a relative path bypasses the exports
field. Fixed to read the manifest with `readFileSync`; a missing manifest still
exits non-zero (`ENOENT`, verified unpiped).

Re-run after the fix: **build succeeds** (`passwd-sso:csp-t1`, 691 MB). All
five guards executed inside the image build:

```
#16 RUN test -d patches && [ -n "$(ls -A patches)" ]        → pass
#17 RUN test -x node_modules/.bin/patch-package             → pass
#18 RUN node_modules/.bin/patch-package --error-on-fail     → "sonner@2.0.8 ✔"
#19 RUN node -e "... readFileSync ... !== '2.0.8' ..."      → pass
#22 RUN per-sonner-chunk marker check                       → pass
```

The lesson is the same class the whole plan kept hitting: a check verified in
one resolution context is not verified in the one that ships.

### T2 — an empty `patches/` fails the build, loudly and by name

```bash
mkdir -p /tmp/csp-t2 && cp -a . /tmp/csp-t2/repo && rm -f /tmp/csp-t2/repo/patches/*
docker build -t passwd-sso:csp-t2 /tmp/csp-t2/repo
```

Expected: build **fails** at the first guard with
`SONNER_PATCHES_DIR_EMPTY: patches/ missing or empty in the builder stage`.
It must not proceed to `next build`.

Status: **not run** in Docker; the guard's shell form was executed directly
against an empty scratch directory and produced the message (deviation log D8).
Its healthy arm ran inside the image build as step #16.

### T3 — a patch that no longer applies fails the build

```bash
# in a scratch copy, corrupt the hunk context
sed -i 's/let head = document.head/let HEAD = document.head/' patches/sonner+2.0.8.patch
docker build .
```

Expected: `patch-package --error-on-fail` exits non-zero and the build fails.
Without `--error-on-fail` patch-package warns and exits 0 outside CI, which is
exactly the silent-drop this flag exists to prevent.

Status: **not run**.

### T4 — a sonner version bump fails the build even if the patch still applies

```bash
# in a scratch copy
npm pkg set dependencies.sonner=2.0.9 && npm install --package-lock-only
docker build .
```

Expected: build fails with
`SONNER_VERSION_DRIFT: expected 2.0.8, got 2.0.9`.

This is the case `--error-on-fail` alone does **not** cover: a release that
leaves `__insertCSS`'s surrounding lines untouched applies cleanly.

Status: **not run** in Docker with a real 2.0.9; the assertion was executed
directly with a stubbed version and produced the message (deviation log D8),
and its healthy arm ran inside the image build as step #19 — after T1 caught
that the first form of this very assertion could not run there at all.

### T5 — the marker check distinguishes "patch absent" from "subject absent"

Two separate failures, two separate messages:

- patch absent → `SONNER_PATCH_MARKER_ABSENT: <chunk> carries sonner but not the CSP-nonce patch`
- sonner not in the bundle at all → `SONNER_PATCH_UNVERIFIABLE: sonner not found in .next/static/chunks — bundle layout changed`

Status: **run** — outside Docker against real build output and a mutated copy
of it (both messages observed; deviation log D8), and the healthy path now also
ran *inside* the image build against the real emitted bundle (step #22 of T1).

Note the defect this check was rewritten to avoid: a directory-wide grep for
`meta[name="csp-nonce"]` is green whether or not the patch applied, because the
app's own `src/lib/ui/csp-nonce.ts` compiles the same selector into a different
chunk. Measured: 3 chunks carry the marker, 2 carry sonner. The check is
therefore per sonner chunk.

### T6 — the running image serves a strict CSP and produces no violations

```bash
docker run --rm -p 3100:3000 --env-file <prod-ish env> passwd-sso:csp-t1
E2E_BASE_URL=http://localhost:3100 npx playwright test e2e/tests/csp-strict.spec.ts
```

Expected: 10 passed, 0 violations, with BOTH self-tests green — the collector
positive control and the style-attribute counter's — so the zero is not vacuous.

Status: **run against a local production build, not against the image** —
`npx next build && next start` on port 3010 with `NEXT_PUBLIC_BASE_PATH=""`,
chromium 1243, against the throwaway `passwd_sso_e2e` database seeded by the
existing `global-setup` — 10/10 passed. The image-based run is the part still
owed.

### T7 — the CI paths filter triggers on a patch-only change

Push a branch whose only change is a comment inside
`patches/sonner+2.0.8.patch`.

Expected: `app-ci` and `E2E: Playwright` both run. Before this change they did
not — no filter listed `patches/**`.

Status: **not run**.

### T8 — the E2E job runs when the `changes` job cannot decide

Force the `changes` job to fail on a scratch branch (e.g. point
`dorny/paths-filter` at a nonexistent base ref).

Expected: `E2E: Playwright` **runs** rather than being skipped. Previously the
empty outputs made every `== 'true'` comparison false and the job was skipped
while reporting as non-blocking.

Status: **not run**.

## Rollback

Every change is additive and revertible by file:

| Artifact | Rollback |
|----------|----------|
| `Dockerfile` | revert the builder-stage block; the image then builds exactly as before, shipping unpatched sonner (i.e. back to the V3 defect) |
| `patches/` + `postinstall` | delete the directory and the script entry; `npm ci` stops applying it |
| `ci.yml` filter | revert; patch-only PRs stop triggering app jobs |
| `ci.yml` E2E `if:` | revert; an unresolved filter silently skips the gate again |

No database migration, no persisted state, no data transformation — nothing to
roll forward or backfill. A rollback restores the previous behaviour exactly.

## Adversarial scenarios (Tier-2 requirement)

**A1 — the patch is silently dropped.** An attacker (or an ordinary dependency
bump) removes or invalidates `patches/sonner+2.0.8.patch`. Without the marker
check the image ships unpatched and the only symptom is unstyled toasts, which
nobody treats as a security signal. With it, the build fails at the point the
artifact is produced. Covered by T2, T3, T5.

**A2 — the guard is bypassed by dropping `--ignore-scripts`.** The tempting
"fix" when the explicit patch step misbehaves is to let `postinstall` do it by
removing `--ignore-scripts` from `Dockerfile`, which re-enables every
dependency's install script inside the image build.

The plan's original forbidden-pattern for this was red-proved **dead** — it
matched nothing, on the exact mutated input it existed to reject. What ships
instead is `scripts/checks/check-dockerfile-ignore-scripts.sh`, with a 13-case
sibling self-test, queued in `pre-pr.sh` and therefore run by CI's always-on
`static-checks` job. It flattens `\`-continuations, splits each `RUN` on `&&`,
and requires `--ignore-scripts` on every `npm ci|install|i|add` segment.
Executed: green on the real Dockerfile (3 invocations), red on each of five
mutants (flag stripped; `npm install`; `npm i`; a continuation-line install; a
compound RUN where only one segment drops it), and two distinct refusals for
the two cannot-run cases.

**Residual risk, stated plainly:** the gate reads the Dockerfile, so an install
that reaches the image by another route — a base image that bakes one in, a
`COPY`d script the build executes — is outside its subject. Nothing in this
repository does that today.

**A3 — `npx` reaches the network during the image build.** `npx patch-package`
falls back to a registry fetch when the binary is absent from
`node_modules/.bin`, which would make the step that authorises the shipped
image an unpinned download. Mitigated: the step probes `test -x` first and
invokes the binary by path, matching how every other tool in this Dockerfile is
handled.

**A4 — a second `get-nonce` copy.** `setNonce` writes a module global that
`react-style-singleton` reads. If npm ever hoists two copies, the write and the
read address different modules, the scroll-lock stylesheet loses its nonce, and
nothing in the build or the type-checker fails. Mitigated by declaring
`get-nonce` as a direct dependency at an exact version. **Residual: no gate
asserts single-copy resolution.** The CSP gate's Radix-overlay case observes
the consequence, which is the recovery path.

**A5 — the nonce is read from a carrier an attacker controls, or read back out
of one.** Two directions, and the honest answer differs for each.

*Writing a wrong nonce in.* An attacker with HTML injection could insert
`<script nonce="attacker-value">`. CSP blocks the injected script from
executing, and the injected element would additionally have to be the first
`script[nonce]` in document order to win the read. Even then the consequence is
a wrong nonce on the app's own runtime styles — a denial of styling, not an
escalation, because the response CSP still carries the real nonce and an
attacker-chosen value admits nothing.

*Reading the real nonce out.* `<meta name="csp-nonce">` publishes it in a
serialisable attribute, deliberately outside the platform's nonce-hiding, and
the patched sonner and `react-style-singleton` write it back as a visible
`nonce` attribute on script-created `<style>` elements (hiding applies only to
parser-inserted nodes). It was measured as not exploitable — an
`innerHTML`-injected `<script>` does not execute, so an HTML-injection-only
attacker cannot read the meta with script; CSS attribute-selector exfiltration
needs an injected `<style>` or a cross-origin `<link>`, both of which
`style-src 'self' 'nonce-…'` refuses; and `<head>` children are outside the
render tree, so a `background-image` on the meta never fetches.

**But that is a conjunction of conditions, not an invariant.** `img-src 'self'
data: https:` does permit dangling-markup exfiltration to an arbitrary https
host, and the `<meta>` is the first child of `<head>`, ahead of any plausible
body injection point — that ordering is doing real work. A change that moves
the meta, or introduces a head-region injection sink, touches this. Record it
in `docs/security/threat-model.md` §5 as the condition the nonce carrier
depends on.

**A6 — DCR narrowing as a denial of service.** C9 refuses `http://[::1]:…`
redirect URIs. A client that works today only because nobody uses IPv6 loopback
will now fail at registration. This is deliberate and is the recoverable
failure; the alternative was completing consent, writing an authorization audit
row, and never delivering the redirect. The refusal message names the reason
and points at `127.0.0.1`.

## Deferred

T1 is **run and green** (and caught one defect). T5's healthy arm ran inside
the image.

Still **not run**: T3 (corrupt the patch hunk in Docker), T4 (a real 2.0.9 in
Docker), T6's image half, T7 and T8. T3/T4 each need a scratch copy of the
repository and another full image build; T7/T8 need a pushed branch and a
GitHub Actions run, which no local harness reproduces. Every one of those
guards has had its logic executed against real and mutated inputs (deviation
log D8), so what remains unproven is only that the same logic behaves
identically in a container and in Actions — and T1 has now demonstrated that
this gap is not hypothetical.

**The highest-value thing a reviewer can do before merge**: confirm T7 and T8
on the PR itself, since those are the two that no local run can substitute
for.
