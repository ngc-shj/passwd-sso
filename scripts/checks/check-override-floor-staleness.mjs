#!/usr/bin/env node
/**
 * CI gate: an `overrides` pin must still bound what it was written to bound.
 *
 * `npm audit` reports only advisory bands intersecting the versions **currently
 * in the lockfile**. An override written as a CVE fix therefore keeps reporting
 * clean long after its floor stopped covering the advisory it was written for:
 * `"postcss": ">=8.5.12"` was authored to make 8.5.12 the floor for
 * GHSA-6g55-p6wh-862q, and it still permits 8.5.12–8.5.22 for the two advisories
 * published since. Nothing resolves there today, so nothing reds — until a
 * future resolution lands in the window, unguarded.
 *
 * This gate asks a different question from `npm audit`'s: for every pin in every
 * tracked manifest's `overrides`, does the pin's RANGE intersect the
 * `vulnerable_version_range` of any live GitHub advisory for that same package?
 * A pin that does is stale regardless of what the lockfile resolves.
 *
 * Fail-closed. Every entry the walk yields lands in exactly one of five
 * outcomes — clean, stale, refused, undecidable, not-judged — and everything
 * that is not `clean` or `not-judged` exits non-zero with a named token. There
 * is no silent skip: an unreadable manifest, a manifest-discovery fallback, a
 * `$ref` that does not resolve, a pin semver cannot read, an empty nested scope,
 * a failed or truncated advisory query are each their own refusal.
 *
 * Two traps this file exists to not fall into again:
 *
 *   1. GitHub returns comma-separated bands (`">= 7.0.0, < 7.28.0"`) and
 *      `semver` throws on that form (`Invalid comparator: >=7.0.0,`). Every
 *      range is normalized through `normalizeBand` before every comparison. A
 *      throw out of a comparison is an `undecidable` violation, never a
 *      swallowed error — the first derivation of this class swallowed it and
 *      reported 21 of 21 entries as members.
 *   2. Range containment is delegated to `semver.intersects` — the library npm
 *      resolves with. Three review rounds each shipped a hand-written
 *      "selector form -> version interval" table and each was falsified. Do not
 *      reintroduce one.
 *
 * The manifest walk itself is NOT reimplemented here: `discoverManifests`,
 * `splitOverrideKey` and `collectScopes` come from
 * check-override-key-disjointness.mjs. What is deliberately not inherited is
 * that file's silent-skip behaviour — its `ENOENT -> continue` and its
 * `git ls-files` fallback are correct for its own predicate and are refusals
 * for this one.
 *
 * Network: one GET per distinct queried package name (18 today) plus the
 * canary. The advisory origin comes from a compiled-in default or an explicit
 * `--origin` argument and from nowhere else; an origin arriving through ambient
 * state is refused before any request is made.
 *
 * Usage:
 *   node scripts/checks/check-override-floor-staleness.mjs [flags] [manifest...]
 *     --report              print every walked entry and the per-package
 *                           advisory counts (changes what is printed, never the
 *                           verdict)
 *     --origin=<url>        advisory API origin (default https://api.github.com)
 *     --timeout-ms=<n>      per-request timeout (default 15000)
 *     --retries=<n>         retries after the first attempt, on transport
 *                           errors and 5xx only (default 2)
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import semver from "semver";
import {
  FALLBACK_MANIFESTS,
  collectScopes,
  discoverManifests,
  splitOverrideKey,
} from "./check-override-key-disjointness.mjs";

// ---------------------------------------------------------------------------
// Pure core. Nothing below this point until the "network shell" banner reads a
// file, opens a socket or touches process state — every behavior the gate
// decides is reachable from an exported, network-free function, so the
// self-test can drive it with injected data.
// ---------------------------------------------------------------------------

/** The advisory origin when no `--origin` is given. Pinned, not derived. */
export const DEFAULT_ORIGIN = "https://api.github.com";

/** Fixed; the gate does not paginate, it refuses a truncated list (S8). */
export const PER_PAGE = 100;

/**
 * Ambient variables that can redirect, intercept or instrument THIS process's
 * request. Their presence is refused unconditionally — the subject of the pin is
 * HOW an origin was supplied, not how it is spelled, so there is no "but it
 * points at api.github.com anyway" branch. NODE_OPTIONS is here because it can
 * carry `--import`/`--require`, which neither TLS nor an origin pin stops.
 *
 * Two variables are deliberately NOT here, and both were on the first draft:
 *
 * - `GITHUB_API_URL`. GitHub Actions sets it in EVERY workflow run as a default
 *   environment variable, so refusing on its presence would red this gate on its
 *   first CI run, for a reason that has nothing to do with the tree. It also
 *   cannot redirect anything by itself: it is inert unless code reads it, and
 *   the invariant that this gate never does is enforced structurally instead —
 *   `process.env` is read on exactly one line, the entry point, and the
 *   self-test asserts that count.
 * - `NO_PROXY`. It is a bypass LIST, not a destination; setting it cannot send a
 *   request anywhere new. Corporate and CI environments set it routinely, so
 *   refusing on it is a false red with no threat behind it.
 */
export const AMBIENT_ORIGIN_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
];

/** The two variables the gate is allowed to read for authentication. */
export const TOKEN_VARS = ["GITHUB_TOKEN", "GH_TOKEN"];

/**
 * Positive control (S12 layer 2). Asserted structurally — present, not
 * withdrawn, and carrying a band for its package that contains this version.
 * Severity and the exact band string are deliberately NOT asserted: a re-split
 * or a re-classification upstream is not a channel failure.
 */
export const CANARY = {
  ghsaId: "GHSA-rgw5-rvv9-x895",
  pkg: "brace-expansion",
  vulnerableVersion: "5.0.8",
};

/** S10's partition. Every walked entry lands in exactly one. */
export const OUTCOME = {
  CLEAN: "clean",
  STALE: "stale",
  REFUSED: "refused",
  UNDECIDABLE: "undecidable",
  NOT_JUDGED: "not-judged",
};

/** Outcomes that make the process exit non-zero (I-3.5). */
const FAILING_OUTCOMES = new Set([OUTCOME.STALE, OUTCOME.REFUSED, OUTCOME.UNDECIDABLE]);

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const MAX_LINE_LENGTH = 2000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * GitHub writes a conjunction as `">= 2.0.0, < 2.1.4"`; semver's grammar uses a
 * space. `semver.intersects` THROWS on the comma form rather than returning
 * false, so a missing normalization does not read as "no overlap" — it reads as
 * a crash, which is why the regression case for this sits on the allow side of
 * the self-test.
 */
export function normalizeBand(range) {
  return String(range).replace(/,\s*/g, " ").trim();
}

/** The one range predicate (N3). Throws are the caller's to name, not swallow. */
export function rangesIntersect(pinRange, bandRange) {
  return semver.intersects(normalizeBand(pinRange), normalizeBand(bandRange));
}

/**
 * True when the pin permits arbitrarily high versions, so "raise the floor"
 * alone is not a complete remedy (S6). Asked of semver rather than by reading
 * the range's characters.
 */
export function isUnboundedAbove(pinRange) {
  return semver.intersects(normalizeBand(pinRange), ">=9999.0.0");
}

// --- command line (P-4) ----------------------------------------------------

/**
 * Flags are distinguished from manifest paths, and an unrecognized flag is a
 * named refusal rather than being taken as a path. The sibling gate's
 * `main(process.argv.slice(2))` treats every argument as a path, so `--report`
 * would become a path, fail to read, and be skipped — reporting clean.
 */
export function parseArgs(argv) {
  const result = { report: false, origin: null, timeoutMs: 15000, retries: 2, paths: [], refusals: [] };
  for (const arg of argv) {
    if (arg === "--report") {
      result.report = true;
      continue;
    }
    const flag = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (flag) {
      const [, name, value] = flag;
      if (name === "origin") {
        result.origin = value;
        continue;
      }
      if (name === "timeout-ms" || name === "retries") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          result.refusals.push(`REFUSED_BAD_FLAG_VALUE: --${name}=${value} is not a non-negative integer`);
          continue;
        }
        if (name === "timeout-ms") result.timeoutMs = n;
        else result.retries = n;
        continue;
      }
      result.refusals.push(`REFUSED_UNKNOWN_FLAG: ${arg}`);
      continue;
    }
    if (arg.startsWith("-")) {
      result.refusals.push(`REFUSED_UNKNOWN_FLAG: ${arg}`);
      continue;
    }
    result.paths.push(arg);
  }
  return result;
}

/**
 * S11. Two sources and no third: the compiled-in default, or an explicit
 * argument. Reading `process.env` is REQUIRED here — it is how the ambient
 * refusal is implemented — and this is the only place the gate consults it
 * besides the token read.
 */
export function resolveOrigin(argOrigin, env) {
  const ambient = AMBIENT_ORIGIN_VARS.filter((name) => (env?.[name] ?? "") !== "");
  if (ambient.length > 0) {
    return {
      refusal:
        `REFUSED_AMBIENT_ORIGIN: ${ambient.join(", ")} set — the advisory origin comes from the ` +
        `compiled-in default or --origin=<url> and from nowhere else. Unset these and re-run, ` +
        `or pass the origin explicitly.`,
    };
  }
  const origin = argOrigin ?? DEFAULT_ORIGIN;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { refusal: `REFUSED_BAD_ORIGIN: '${origin}' is not an absolute URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { refusal: `REFUSED_BAD_ORIGIN: '${origin}' is not an http(s) origin` };
  }
  return { origin: origin.replace(/\/+$/, "") };
}

/**
 * `discoverManifests` returns its FALLBACK_MANIFESTS array object — by
 * reference — when `git ls-files` does not answer. A degraded-but-plausible
 * manifest list is correct for the disjointness gate and is a refusal here: a
 * gate that silently checked three guessed paths would report clean on a
 * workspace it never saw.
 */
export function discoveryRefusal(discovered) {
  if (discovered === FALLBACK_MANIFESTS) {
    return (
      "REFUSED_MANIFEST_DISCOVERY_FALLBACK: `git ls-files` did not answer, so manifest discovery " +
      "fell back to a hardcoded list — a workspace outside that list would be unchecked and " +
      "reported clean. Run inside a git checkout, or name the manifests as arguments."
    );
  }
  return null;
}

// --- the walk (P-1) --------------------------------------------------------

/**
 * npm's `$name` pin means "use the version this manifest already asks for".
 * A bare `$` means the key's own package name. Unresolvable is a refusal: an
 * unresolved `$ref` silently pins nothing.
 */
export function resolveRefPin(pin, key, manifestJson) {
  if (typeof pin !== "string" || !pin.startsWith("$")) return { value: pin };
  const target = pin.slice(1) || splitOverrideKey(key).name;
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifestJson?.[field]?.[target];
    if (typeof declared === "string") {
      if (declared.startsWith("$")) {
        return {
          refusal: `REFUSED_BAD_REF: '${pin}' resolves to '${declared}', which is itself a $ref`,
        };
      }
      return { value: declared, via: `${field}.${target}` };
    }
  }
  return {
    refusal: `REFUSED_BAD_REF: '${pin}' names '${target}', which this manifest does not declare in ${DEPENDENCY_FIELDS.join("/")}`,
  };
}

/** A pin becomes a comparable range, or a named refusal. Never a skip. */
export function pinToRange(pin, key, manifestJson) {
  if (typeof pin !== "string") {
    return {
      refusal: `REFUSED_NON_RANGE_PIN: pin is ${Array.isArray(pin) ? "an array" : typeof pin}, not a version range`,
    };
  }
  const resolved = resolveRefPin(pin, key, manifestJson);
  if (resolved.refusal) return { refusal: resolved.refusal };
  if (!semver.validRange(resolved.value)) {
    return { refusal: `REFUSED_NON_RANGE_PIN: semver cannot read '${resolved.value}' as a range` };
  }
  return { range: resolved.value, via: resolved.via };
}

/**
 * Turn already-read manifest sources into the flat list of entries to judge.
 * `sources` is `[{path, ok:true, json} | {path, ok:false, detail}]` — reading
 * the files is the shell's job, so this stays pure and injectable.
 *
 * S1: an object-valued key is a scope opener, excluded from pin judgement
 * BECAUSE its nested scope yielded at least one judged entry — not because of
 * its `typeof`. A scope that yielded nothing is a refusal. An array value is
 * never recursed into (the walker already refuses that), so it arrives here as
 * a pin and is refused by `pinToRange`.
 */
export function collectEntries(sources) {
  const entries = [];
  for (const source of sources) {
    const manifest = source.path;
    if (!source.ok) {
      entries.push({
        manifest,
        scopePath: "-",
        key: "-",
        pkg: null,
        pin: null,
        kind: "manifest",
        outcome: OUTCOME.REFUSED,
        refusal: `REFUSED_MANIFEST_UNREADABLE: ${manifest}: ${source.detail}`,
      });
      continue;
    }
    const overrides = source.json?.overrides;
    if (!overrides) continue;

    const scopes = collectScopes(overrides, "overrides");
    const byScopePath = new Map(scopes.map((s) => [s.scopePath, s]));

    for (const scope of scopes) {
      for (const [name, keyed] of scope.byPackage) {
        for (const { key, pin } of keyed) {
          const base = { manifest, scopePath: scope.scopePath, key, pkg: name, pin, depth: scope.depth };
          if (isPlainObject(pin)) {
            const child = byScopePath.get(`${scope.scopePath} > ${key}`);
            const yielded = Boolean(child) && (child.byPackage.size > 0 || child.selfPins.length > 0);
            entries.push(
              yielded
                ? { ...base, kind: "scope-opener", outcome: OUTCOME.NOT_JUDGED }
                : {
                    ...base,
                    kind: "scope-opener",
                    outcome: OUTCOME.REFUSED,
                    refusal: `REFUSED_EMPTY_SCOPE: '${key}' opens a nested scope that yields no pin and no '.' self-pin, so nothing carries its verdict`,
                  },
            );
            continue;
          }
          entries.push({ ...base, kind: "pin", ...pinToRange(pin, key, source.json) });
        }
      }

      for (const { key, pin } of scope.selfPins) {
        const base = { manifest, scopePath: scope.scopePath, key, pkg: scope.parentName, pin, depth: scope.depth };
        if (scope.depth === 0) {
          entries.push({
            ...base,
            kind: "self-pin",
            outcome: OUTCOME.REFUSED,
            refusal: "REFUSED_TOP_LEVEL_SELF_PIN: '.' at the top level addresses no parent package",
          });
          continue;
        }
        if (isPlainObject(pin)) {
          entries.push({
            ...base,
            kind: "self-pin",
            outcome: OUTCOME.REFUSED,
            refusal: "REFUSED_NON_RANGE_PIN: a '.' self-pin whose value is an object pins nothing",
          });
          continue;
        }
        // The subject is the scope's carried parentName, never scopePath split
        // back apart: `{"pkg@1": {".": "^1.0.0"}}` is judged against `pkg`, and
        // the advisory API answers 200 [] for `pkg@1` — a silent green.
        entries.push({ ...base, kind: "self-pin", ...pinToRange(pin, scope.parentKey ?? key, source.json) });
      }

      for (const { key, range, pin } of scope.unparseable) {
        entries.push({
          manifest,
          scopePath: scope.scopePath,
          key,
          pkg: splitOverrideKey(key).name,
          pin,
          depth: scope.depth,
          kind: "unparseable",
          outcome: OUTCOME.REFUSED,
          refusal: `REFUSED_UNPARSEABLE_SELECTOR: '${key}' has a selector semver cannot parse ('${range}'), so which versions its pin '${pin}' governs is undecidable`,
        });
      }
    }
  }
  return entries;
}

/**
 * The distinct package names to query. A scope opener's parent IS queried even
 * though it is not judged (S1) — so a `"."` self-pin appearing under it later is
 * decided from data already fetched, and the report's per-package count covers
 * it. Refused entries need no advisories.
 */
export function packagesToQuery(entries) {
  const names = new Set();
  for (const entry of entries) {
    if (entry.refusal) continue;
    if (entry.kind !== "pin" && entry.kind !== "self-pin" && entry.kind !== "scope-opener") continue;
    if (typeof entry.pkg === "string" && entry.pkg.length > 0) names.add(entry.pkg);
  }
  return [...names];
}

// --- the API boundary (P-1) -----------------------------------------------

/**
 * Fail-closed shape validation on a live response. This — not the committed
 * fixture — is what bounds a field rename or a type change upstream; a static
 * file cannot detect a rename it was recorded before.
 */
export function checkResponseShape(body) {
  if (!Array.isArray(body)) {
    return { ok: false, token: "UNDECIDABLE_RESPONSE_SHAPE", detail: `expected an array, got ${body === null ? "null" : typeof body}` };
  }
  for (let i = 0; i < body.length; i++) {
    const a = body[i];
    if (!isPlainObject(a)) {
      return { ok: false, token: "UNDECIDABLE_RESPONSE_SHAPE", detail: `element ${i} is not an object` };
    }
    if (typeof a.ghsa_id !== "string" || a.ghsa_id.length === 0) {
      return { ok: false, token: "UNDECIDABLE_RESPONSE_SHAPE", detail: `element ${i} has no string ghsa_id` };
    }
    if (!(a.withdrawn_at === null || typeof a.withdrawn_at === "string")) {
      return { ok: false, token: "UNDECIDABLE_RESPONSE_SHAPE", detail: `${a.ghsa_id}: withdrawn_at is neither null nor a string` };
    }
    if (!Array.isArray(a.vulnerabilities)) {
      return { ok: false, token: "UNDECIDABLE_RESPONSE_SHAPE", detail: `${a.ghsa_id}: vulnerabilities is not an array` };
    }
    for (const v of a.vulnerabilities) {
      if (!isPlainObject(v)) {
        return { ok: false, token: "UNDECIDABLE_RESPONSE_SHAPE", detail: `${a.ghsa_id}: a vulnerabilities element is not an object` };
      }
      if (typeof v.vulnerable_version_range !== "string") {
        return { ok: false, token: "UNDECIDABLE_RESPONSE_SHAPE", detail: `${a.ghsa_id}: vulnerable_version_range is not a string` };
      }
      if (!(v.first_patched_version === null || typeof v.first_patched_version === "string")) {
        return { ok: false, token: "UNDECIDABLE_RESPONSE_SHAPE", detail: `${a.ghsa_id}: first_patched_version is neither null nor a string` };
      }
    }
  }
  return { ok: true };
}

/**
 * S8. A `rel="next"` LINK RELATION, not a `"next"` substring — a header
 * carrying only `rel="prev"` or `rel="last"` is not truncation, and a summary
 * or URL containing the word would false-red a substring test. A full page with
 * no link relation at all is also truncation: absence at the ceiling is the
 * ambiguous case, and this gate refuses the ambiguity rather than guessing.
 */
export function isTruncated(linkHeader, itemCount, perPage = PER_PAGE) {
  const hasNext = /(^|,)\s*<[^>]*>\s*;[^,]*\brel\s*=\s*"?next"?/i.test(linkHeader ?? "");
  if (hasNext) return { truncated: true, reason: 'the response carries a rel="next" link relation' };
  if (itemCount >= perPage) {
    return {
      truncated: true,
      reason: `the response is a full page (${itemCount} of per_page=${perPage}) with no link relation, so whether more exist is undecidable`,
    };
  }
  return { truncated: false };
}

/**
 * S3. Exact equality on `package.name`, in the npm ecosystem only. Prefix
 * matching is wrong in both directions — `hono` / `@hono/node-server` share a
 * prefix and are different subjects, and `lodash` / `lodash-es` is the pair
 * that makes a prefix test discriminating in the self-test. A vulnerabilities
 * entry with no `package.name` is a refusal, not a skip.
 */
export function extractBands(advisory, pkg) {
  const bands = [];
  const problems = [];
  for (const v of advisory?.vulnerabilities ?? []) {
    const name = v?.package?.name;
    if (typeof name !== "string") {
      problems.push(
        `UNDECIDABLE_BAND_WITHOUT_PACKAGE_NAME: ${advisory?.ghsa_id ?? "<no id>"} carries a vulnerabilities entry with no package.name`,
      );
      continue;
    }
    if (v?.package?.ecosystem !== "npm") continue;
    if (name !== pkg) continue;
    bands.push({
      packageName: name,
      range: v.vulnerable_version_range,
      firstPatched: v.first_patched_version ?? null,
    });
  }
  return { bands, problems };
}

/**
 * API shape -> the shape the judgement reads. Withdrawn advisories are excluded
 * from the live set and NAMED, so the exclusion is visible in report mode
 * rather than being an invisible subtraction (S4). `type: "unreviewed"` is kept
 * (S7) — dropping it would fail open on real npm CVEs — and tagged so a reader
 * of the violation line knows what they are looking at.
 */
export function transformAdvisories(list, pkg) {
  const live = [];
  const withdrawnIds = [];
  const problems = [];
  for (const advisory of list ?? []) {
    if (advisory?.withdrawn_at != null) {
      withdrawnIds.push(advisory.ghsa_id);
      continue;
    }
    const { bands, problems: bandProblems } = extractBands(advisory, pkg);
    problems.push(...bandProblems);
    if (bands.length === 0) continue;
    live.push({
      id: advisory.ghsa_id,
      type: advisory.type ?? null,
      severity: advisory.severity ?? null,
      summary: typeof advisory.summary === "string" ? advisory.summary : "",
      bands,
    });
  }
  return { live, withdrawnIds, problems };
}

/**
 * S12 layer 1 — per-package integrity, needing no baseline: every advisory the
 * API returns for `affects=X` must carry at least one npm band for X. The API
 * answers `200 []` for a nonexistent and for a malformed `affects`, so an empty
 * list cannot be evidence that a query was understood; this rule is what
 * notices a response that is well-formed but is not about the package asked
 * for. Vacuously true on an empty list, which a genuinely advisory-free package
 * (`@crxjs/vite-plugin`) needs.
 */
export function checkPackageIntegrity(list, pkg) {
  const problems = [];
  for (const advisory of list ?? []) {
    const { bands } = extractBands(advisory, pkg);
    if (bands.length > 0) continue;
    const seen = (advisory?.vulnerabilities ?? [])
      .map((v) => `${v?.package?.ecosystem ?? "?"}:${v?.package?.name ?? "?"}`)
      .join(", ");
    problems.push(
      `UNDECIDABLE_PACKAGE_INTEGRITY: ${advisory?.ghsa_id ?? "<no id>"} was returned for affects=${pkg} but carries no npm band for ${pkg} (bands: ${seen || "none"}) — a foreign-ecosystem or foreign-package response is not an answer about ${pkg}`,
    );
  }
  return problems;
}

/**
 * S12 layer 2. Two DISTINCT refusals so the operator knows which happened:
 * the channel is dead (the advisory is not in the response at all), or the
 * constant has gone stale (it is there, but the property this gate asserts no
 * longer holds — review the constant, not the tree).
 */
export function checkCanary(fetched, canary = CANARY) {
  if (!fetched || fetched.ok !== true) {
    return {
      ok: false,
      token: "CANARY_QUERY_FAILED",
      message: `CANARY_QUERY_FAILED: the ${canary.pkg} query did not return a usable response, so the positive control could not run`,
    };
  }
  const found = fetched.advisories.find((a) => a?.ghsa_id === canary.ghsaId);
  if (!found) {
    return {
      ok: false,
      token: "CANARY_CHANNEL_DEAD",
      message: `CANARY_CHANNEL_DEAD: ${canary.ghsaId} is absent from the ${canary.pkg} response — the advisory channel is not answering, so a clean run proves nothing`,
    };
  }
  if (found.withdrawn_at != null) {
    return {
      ok: false,
      token: "CANARY_CONSTANT_STALE",
      message: `CANARY_CONSTANT_STALE: ${canary.ghsaId} is present but was withdrawn at ${found.withdrawn_at} — pick a new positive control; the tree is not the problem`,
    };
  }
  const { bands } = extractBands(found, canary.pkg);
  const covering = bands.filter((b) => semver.satisfies(canary.vulnerableVersion, normalizeBand(b.range)));
  if (covering.length === 0) {
    return {
      ok: false,
      token: "CANARY_CONSTANT_STALE",
      message: `CANARY_CONSTANT_STALE: ${canary.ghsaId} is present and live but no longer carries a ${canary.pkg} band containing ${canary.vulnerableVersion} (bands: ${bands.map((b) => `'${b.range}'`).join(", ") || "none"}) — pick a new positive control; the tree is not the problem`,
    };
  }
  return { ok: true, message: `positive control: ${canary.ghsaId} live, ${canary.pkg} band '${covering[0].range}' contains ${canary.vulnerableVersion}` };
}

// --- retry policy ----------------------------------------------------------

/**
 * Transport errors and 5xx are retried; 401/403/429 never are. Retrying a rate
 * limit deepens it, and a rejected token must be distinguishable from an
 * exhausted budget — 403 is both, so the remaining-quota header decides.
 */
export function retryDecision({ transportError = false, status = null, rateLimitRemaining = null, attempt = 1, maxAttempts = 3 }) {
  const more = attempt < maxAttempts;
  if (transportError) {
    return more
      ? { retry: true, token: null }
      : { retry: false, token: "UNDECIDABLE_TRANSPORT", detail: `no response after ${maxAttempts} attempt(s)` };
  }
  if (status >= 200 && status < 300) return { retry: false, token: null };
  if (status === 401) {
    return { retry: false, token: "UNDECIDABLE_TOKEN_REJECTED", detail: "HTTP 401 — the credential was rejected; this is not a rate limit" };
  }
  if (status === 429 || (status === 403 && String(rateLimitRemaining) === "0")) {
    return { retry: false, token: "UNDECIDABLE_RATE_LIMITED", detail: `HTTP ${status} with x-ratelimit-remaining=${rateLimitRemaining} — the budget is exhausted; retrying deepens it. Set GITHUB_TOKEN or GH_TOKEN` };
  }
  if (status === 403) {
    return { retry: false, token: "UNDECIDABLE_TOKEN_REJECTED", detail: "HTTP 403 with quota remaining — the credential was rejected or lacks scope" };
  }
  if (status >= 500) {
    return more
      ? { retry: true, token: null }
      : { retry: false, token: "UNDECIDABLE_SERVER_ERROR", detail: `HTTP ${status} after ${maxAttempts} attempt(s)` };
  }
  return { retry: false, token: "UNDECIDABLE_HTTP_STATUS", detail: `HTTP ${status}` };
}

// --- judgement (P-2) -------------------------------------------------------

/**
 * Keyed by package name, and a Map rather than a plain object on purpose:
 * `JSON.parse` makes `__proto__` an own property, and a plain object gives
 * `store["constructor"]` a truthy non-array hit — a package named for an
 * Object.prototype member would be judged against a function.
 */
export function buildAdvisoryCache(pairs) {
  return new Map(pairs);
}

/**
 * The synchronous core. `advisoryCache` maps a package name to
 * `{ok:true, advisories}` or `{ok:false, token, detail}`. A package in the walk
 * but absent from the cache, or present as a failure, is `undecidable` — never
 * clean (I-3.4).
 */
export function judge(entries, advisoryCache) {
  return entries.map((entry) => {
    if (entry.outcome) return { ...entry };
    if (entry.refusal) return { ...entry, outcome: OUTCOME.REFUSED };

    if (!advisoryCache.has(entry.pkg)) {
      return {
        ...entry,
        outcome: OUTCOME.UNDECIDABLE,
        refusal: `UNDECIDABLE_NOT_FETCHED: no advisory query result for ${entry.pkg}`,
      };
    }
    const fetched = advisoryCache.get(entry.pkg);
    if (!fetched || fetched.ok !== true) {
      return {
        ...entry,
        outcome: OUTCOME.UNDECIDABLE,
        refusal: `${fetched?.token ?? "UNDECIDABLE_FETCH_FAILED"}: ${entry.pkg}: ${fetched?.detail ?? "the advisory query did not return a usable response"}`,
      };
    }

    const { live, withdrawnIds, problems } = transformAdvisories(fetched.advisories, entry.pkg);
    if (problems.length > 0) {
      return { ...entry, outcome: OUTCOME.UNDECIDABLE, refusal: `${problems[0]} (judging ${entry.pkg})`, withdrawnIds };
    }

    const hits = [];
    for (const advisory of live) {
      for (const band of advisory.bands) {
        let intersects;
        try {
          intersects = rangesIntersect(entry.range, band.range);
        } catch (err) {
          // Explicitly named, never swallowed: the comma-band trap arrives here
          // as a throw, and a swallowed throw reads as "no overlap".
          return {
            ...entry,
            outcome: OUTCOME.UNDECIDABLE,
            refusal: `UNDECIDABLE_COMPARISON_THREW: comparing pin '${entry.range}' against ${advisory.id} band '${band.range}' threw: ${err?.message ?? err}`,
            withdrawnIds,
          };
        }
        if (intersects) hits.push({ advisory, band });
      }
    }

    if (hits.length === 0) {
      return { ...entry, outcome: OUTCOME.CLEAN, withdrawnIds, liveCount: live.length };
    }
    return {
      ...entry,
      outcome: OUTCOME.STALE,
      hits,
      withdrawnIds,
      liveCount: live.length,
      requiredFloor: requiredFloor(hits),
    };
  });
}

/**
 * `max(first_patched_version)` over the intersecting bands — which is why the
 * two `postcss` pins both land on 8.5.23 despite carrying different band sets.
 * A band with no patched version cannot be raised past, so the answer is a
 * named absence rather than the max of the rest (S5).
 */
export function requiredFloor(hits) {
  const unpatched = hits.filter((h) => h.band.firstPatched == null);
  if (unpatched.length > 0) {
    return { floor: null, unpatchedIds: [...new Set(unpatched.map((h) => h.advisory.id))] };
  }
  let best = null;
  for (const { band } of hits) {
    const candidate = semver.coerce(band.firstPatched)?.version ?? band.firstPatched;
    if (best === null || semver.gt(candidate, best)) best = candidate;
  }
  return { floor: best, unpatchedIds: [] };
}

// --- output (P-5) ----------------------------------------------------------

/**
 * GitHub Actions reads a `::`-prefixed line as a workflow command, and advisory
 * summaries are attacker-adjacent text that ends up on this gate's stdout. A
 * leading `::` is refused (marked, not printed as-is), control characters are
 * stripped and the line is capped — but `<`, `>`, quotes and a legitimate band
 * (`">= 2.0.0, < 2.1.4"`) must survive intact, because that is the operator's
 * diagnostic.
 */
export function sanitizeLine(line) {
  const parts = String(line).split(/\r?\n/);
  return parts
    .map((part) => {
      // Stripped character-by-character rather than with a regex: a control
      // class written as a regex literal is exactly the kind of thing a lint
      // suppression gets attached to, and `<`, `>` and quotes must pass through.
      let out = "";
      for (const ch of part) {
        const code = ch.codePointAt(0);
        if (code < 0x20 || code === 0x7f) continue;
        out += ch;
      }
      if (out.startsWith("::")) out = `[REFUSED_WORKFLOW_COMMAND]${out.slice(2)}`;
      if (out.length > MAX_LINE_LENGTH) out = `${out.slice(0, MAX_LINE_LENGTH)}…[truncated]`;
      return out;
    })
    .join(" ⏎ ");
}

function describeEntry(row) {
  const subject = row.pkg ? `${row.pkg}` : "<no package>";
  const pin = typeof row.pin === "string" ? `'${row.pin}'` : JSON.stringify(row.pin);
  const via = row.via ? ` (via ${row.via} -> '${row.range}')` : "";
  return `${row.manifest} ${row.scopePath}: '${row.key}' pins ${subject}@${pin}${via}`;
}

/** The lines that make the run fail. Printed under every flag (P-5). */
export function formatViolationLines(rows) {
  const lines = [];
  for (const row of rows) {
    if (!FAILING_OUTCOMES.has(row.outcome)) continue;
    if (row.outcome !== OUTCOME.STALE) {
      lines.push(`${row.outcome.toUpperCase()}: ${describeEntry(row)} — ${row.refusal}`);
      continue;
    }
    const detail = row.hits
      .map(
        (h) =>
          `${h.advisory.id}${h.advisory.type === "unreviewed" ? " [unreviewed]" : ""} [${h.advisory.severity ?? "?"}] band '${h.band.range}'${h.band.firstPatched ? ` -> ${h.band.firstPatched}` : " -> NO_PATCHED_VERSION"} (${h.advisory.summary})`,
      )
      .join("; ");
    const floor = row.requiredFloor;
    let remedy;
    if (floor.floor === null) {
      remedy = `NO_PATCHED_VERSION on ${floor.unpatchedIds.join(", ")} — there is no floor to raise to: bound the pin below the band, or drop the dependency`;
    } else if (isUnboundedAbove(row.range)) {
      remedy = `required floor >= ${floor.floor}; the pin is unbounded above, so either raise the floor above the band or bound the pin below it`;
    } else {
      remedy = `required floor >= ${floor.floor}`;
    }
    lines.push(`STALE: ${describeEntry(row)} — intersects ${row.hits.length} live advisory band(s): ${detail}. ${remedy}`);
  }
  return lines;
}

/**
 * Report mode. Every walked entry with its outcome, plus the per-package
 * advisory counts and the named withdrawn ids (S4, S12 layer 3). Changes what
 * is printed and never the verdict — the caller computes the exit status from
 * the same rows either way.
 */
export function formatReportLines(rows, advisoryCache) {
  const manifests = [...new Set(rows.map((r) => r.manifest))];
  const lines = [`walked ${rows.length} entry/entries across ${manifests.length} manifest(s)`];
  for (const row of rows) {
    const suffix =
      row.outcome === OUTCOME.STALE
        ? ` intersects ${row.hits.map((h) => h.advisory.id).join(", ")}; required floor ${row.requiredFloor.floor ?? "NO_PATCHED_VERSION"}`
        : row.refusal
          ? ` ${row.refusal}`
          : "";
    lines.push(`  [${row.outcome}] ${describeEntry(row)} kind=${row.kind}${suffix}`);
  }
  lines.push(`advisory queries: ${advisoryCache.size}`);
  for (const [pkg, fetched] of advisoryCache) {
    if (fetched?.ok !== true) {
      lines.push(`  ${pkg}: QUERY FAILED (${fetched?.token ?? "unknown"})`);
      continue;
    }
    const { live, withdrawnIds } = transformAdvisories(fetched.advisories, pkg);
    const withdrawn = withdrawnIds.length > 0 ? ` (withdrawn, skipped: ${withdrawnIds.join(", ")})` : "";
    lines.push(`  ${pkg}: ${fetched.advisories.length} advisory/advisories returned, ${live.length} live band-carrying${withdrawn}`);
  }
  const counts = new Map();
  for (const row of rows) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  lines.push(
    `outcomes: ${Object.values(OUTCOME)
      .map((o) => `${o}=${counts.get(o) ?? 0}`)
      .join(" ")}`,
  );
  return lines;
}

/** P-5: identical under every flag. */
export function exitCodeFor(rows, extraViolations = []) {
  if (extraViolations.length > 0) return 1;
  return rows.some((r) => FAILING_OUTCOMES.has(r.outcome)) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Network shell. The only asynchronous code, the only I/O, and the only reader
// of process state (P-2). Everything it decides, it decides by calling one of
// the pure exports above.
// ---------------------------------------------------------------------------

function readManifestSources(paths) {
  return paths.map((path) => {
    try {
      return { path, ok: true, json: JSON.parse(readFileSync(path, "utf8")) };
    } catch (err) {
      // NOT the sibling gate's `ENOENT -> continue`: a named path that cannot
      // be read is a refusal here, so a mistyped scratchpad path cannot report
      // clean.
      return { path, ok: false, detail: err?.message ?? String(err) };
    }
  });
}

async function fetchAdvisories(pkg, { origin, token, timeoutMs, retries }) {
  const url = `${origin}/advisories?ecosystem=npm&affects=${encodeURIComponent(pkg)}&per_page=${PER_PAGE}`;
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "passwd-sso-override-floor-staleness",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const maxAttempts = retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const decision = retryDecision({ transportError: true, attempt, maxAttempts });
      if (decision.retry) continue;
      return { ok: false, token: decision.token, detail: `${decision.detail}: ${err?.message ?? err}` };
    }

    const decision = retryDecision({
      status: response.status,
      rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
      attempt,
      maxAttempts,
    });
    if (decision.retry) continue;
    if (decision.token) return { ok: false, token: decision.token, detail: decision.detail };

    let body;
    try {
      body = await response.json();
    } catch (err) {
      return { ok: false, token: "UNDECIDABLE_RESPONSE_NOT_JSON", detail: err?.message ?? String(err) };
    }

    const shape = checkResponseShape(body);
    if (!shape.ok) return { ok: false, token: shape.token, detail: shape.detail };

    const truncation = isTruncated(response.headers.get("link"), body.length);
    if (truncation.truncated) {
      return { ok: false, token: "UNDECIDABLE_TRUNCATED", detail: truncation.reason };
    }

    const integrity = checkPackageIntegrity(body, pkg);
    if (integrity.length > 0) {
      return { ok: false, token: "UNDECIDABLE_PACKAGE_INTEGRITY", detail: integrity[0] };
    }

    return { ok: true, advisories: body };
  }
  /* c8 ignore next */
  return { ok: false, token: "UNDECIDABLE_TRANSPORT", detail: "retry loop exhausted" };
}

export async function run(argv, env, { stdout = console.log, stderr = console.error } = {}) {
  const emit = (sink, line) => sink(sanitizeLine(line));
  const args = parseArgs(argv);
  const hardRefusals = [...args.refusals];

  const originResult = resolveOrigin(args.origin, env);
  if (originResult.refusal) hardRefusals.push(originResult.refusal);

  let paths = args.paths;
  if (paths.length === 0) {
    const discovered = discoverManifests();
    const refusal = discoveryRefusal(discovered);
    if (refusal) hardRefusals.push(refusal);
    paths = discovered;
  }

  if (hardRefusals.length > 0) {
    emit(stderr, "override floor staleness gate refused to run:");
    for (const r of hardRefusals) emit(stderr, `  - ${r}`);
    return 1;
  }

  const entries = collectEntries(readManifestSources(paths));
  if (entries.length === 0) {
    emit(stderr, "override floor staleness gate refused to run:");
    emit(
      stderr,
      `  - REFUSED_EMPTY_WALK: no override entry of any kind was found across ${paths.length} manifest(s) (${paths.join(", ")}) — a walk that yields nothing cannot be evidence that nothing is stale`,
    );
    return 1;
  }

  const token = TOKEN_VARS.map((name) => env?.[name]).find((v) => typeof v === "string" && v.length > 0) ?? null;
  const fetchOptions = { origin: originResult.origin, token, timeoutMs: args.timeoutMs, retries: args.retries };

  const names = [...new Set([...packagesToQuery(entries), CANARY.pkg])];
  const pairs = [];
  for (const name of names) {
    pairs.push([name, await fetchAdvisories(name, fetchOptions)]);
  }
  const advisoryCache = buildAdvisoryCache(pairs);

  const rows = judge(entries, advisoryCache);

  let canary;
  try {
    canary = checkCanary(advisoryCache.get(CANARY.pkg));
  } catch (err) {
    canary = { ok: false, token: "CANARY_COMPARISON_THREW", message: `CANARY_COMPARISON_THREW: ${err?.message ?? err}` };
  }
  const extraViolations = canary.ok ? [] : [canary.message];

  if (args.report) {
    for (const line of formatReportLines(rows, advisoryCache)) emit(stdout, line);
    emit(stdout, canary.ok ? canary.message : `POSITIVE CONTROL FAILED: ${canary.message}`);
  }

  const violations = [...formatViolationLines(rows), ...extraViolations];
  const code = exitCodeFor(rows, extraViolations);

  if (code !== 0) {
    emit(stderr, "override floor staleness gate failed:");
    for (const v of violations) emit(stderr, `  - ${v}`);
    emit(stderr, "");
    emit(
      stderr,
      "See docs/security/dependency-cve-response.md Step 4 — raise the pin's floor to at or above the highest first_patched_version over its intersecting bands, or bound the pin below them.",
    );
    return code;
  }
  emit(stdout, `override floor staleness gate passed (${rows.length} override entry/entries, ${advisoryCache.size} package(s) queried).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
