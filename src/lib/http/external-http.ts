/**
 * Shared SSRF defense and external HTTP helpers.
 *
 * Extracted from webhook-dispatcher.ts (Phase 3) so that audit delivery
 * targets (SIEM HEC, S3 Object, Webhook) can reuse the same defense.
 *
 * IMPORTANT: Any HTTP client that performs its own DNS resolution
 * bypasses this module's SSRF defense. Always use `validateAndFetch()`
 * instead of raw `fetch()` for external URLs.
 */

import { resolve4, resolve6 } from "node:dns/promises";
import { isIP as netIsIP } from "node:net";
import { Agent as UndiciAgent } from "undici";
import { isIpInCidr } from "@/lib/auth/policy/ip-access";
import { readStreamWithCap } from "@/lib/http/parse-body";
import { METADATA_BLOCKLIST } from "@/lib/audit/audit-logger";
import { safeRecord } from "@/lib/safe-keys";
import { MS_PER_SECOND } from "@/lib/constants/time";

// ─── SSRF Defense ──────────────────────────────────────────────

/**
 * CIDR ranges that must never receive external deliveries.
 * Covers RFC 1918, loopback, link-local, cloud metadata, CGNAT,
 * benchmarking, IETF reserved, and IPv6 equivalents.
 */
export const BLOCKED_CIDRS = [
  // IPv4
  "10.0.0.0/8",         // RFC 1918
  "172.16.0.0/12",      // RFC 1918
  "192.168.0.0/16",     // RFC 1918
  "127.0.0.0/8",        // loopback
  "0.0.0.0/8",          // "this" network
  "169.254.0.0/16",     // link-local + cloud metadata (169.254.169.254)
  "100.64.0.0/10",      // RFC 6598 CGNAT (also Tailscale)
  "192.0.0.0/24",       // RFC 6890 IETF protocol assignments
  "192.0.2.0/24",       // RFC 5737 TEST-NET-1
  "198.18.0.0/15",      // RFC 2544 benchmarking
  "198.51.100.0/24",    // RFC 5737 TEST-NET-2
  "203.0.113.0/24",     // RFC 5737 TEST-NET-3
  "240.0.0.0/4",        // RFC 1112 reserved
  // IPv6
  "::1/128",            // loopback
  "::/128",             // unspecified
  "fe80::/10",          // link-local
  "fc00::/7",           // unique local (ULA)
  "::ffff:0:0/96",      // IPv4-mapped IPv6 (prevents bypass via ::ffff:127.0.0.1)
] as const;

/**
 * Test representative IPs per CIDR block (P3-T2 fix).
 * Exported for test consumption — tests iterate this array with `describe.each`.
 */
export const BLOCKED_CIDR_REPRESENTATIVES: ReadonlyArray<{
  cidr: string;
  ipv4?: string;
  ipv6?: string;
}> = [
  { cidr: "10.0.0.0/8", ipv4: "10.0.0.1" },
  { cidr: "172.16.0.0/12", ipv4: "172.16.0.1" },
  { cidr: "192.168.0.0/16", ipv4: "192.168.1.1" },
  { cidr: "127.0.0.0/8", ipv4: "127.0.0.1" },
  { cidr: "0.0.0.0/8", ipv4: "0.0.0.1" },
  { cidr: "169.254.0.0/16", ipv4: "169.254.169.254" },
  { cidr: "100.64.0.0/10", ipv4: "100.64.0.1" },
  { cidr: "192.0.0.0/24", ipv4: "192.0.0.1" },
  { cidr: "192.0.2.0/24", ipv4: "192.0.2.1" },
  { cidr: "198.18.0.0/15", ipv4: "198.18.0.1" },
  { cidr: "198.51.100.0/24", ipv4: "198.51.100.1" },
  { cidr: "203.0.113.0/24", ipv4: "203.0.113.1" },
  { cidr: "240.0.0.0/4", ipv4: "240.0.0.1" },
  { cidr: "::1/128", ipv6: "::1" },
  { cidr: "::/128", ipv6: "::" },
  { cidr: "fe80::/10", ipv6: "fe80::1" },
  { cidr: "fc00::/7", ipv6: "fd00::1" },
  { cidr: "::ffff:0:0/96", ipv6: "::ffff:127.0.0.1" },
];

/**
 * Check if an IP address belongs to a private/reserved range
 * using the existing CIDR matcher from ip-access.ts.
 */
export function isPrivateIp(ip: string): boolean {
  return BLOCKED_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
}

/** Per-call DNS resolution deadline (see withDnsTimeout). */
export const DNS_RESOLVE_TIMEOUT_MS = 5 * MS_PER_SECOND;

/**
 * Race a DNS resolution against a hard deadline. node:dns/promises resolve4/
 * resolve6 have no built-in per-call timeout, so a slow or hung resolver can
 * block indefinitely and blow any wall-clock budget the caller assumed. The
 * timer is cleared on settle so it never keeps the event loop alive. A no-op
 * catch is attached so an orphaned resolver that rejects AFTER the timeout wins
 * does not surface as an unhandledRejection.
 */
async function withDnsTimeout<T>(p: Promise<T>, hostname: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  p.catch(() => {});
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS resolution timed out: ${hostname}`)),
          DNS_RESOLVE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve hostname and reject private/reserved IPs to prevent SSRF.
 * Returns the list of validated public IPs for use in IP pinning.
 */
export async function resolveAndValidateIps(url: string): Promise<string[]> {
  const parsed = new URL(url);

  // S-m1 fix: reject non-HTTP schemes explicitly
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // M3 defense-in-depth: IP-literal detection goes through net.isIP() so
  // we accept only the canonical RFC 3986 / RFC 5952 form. Node's URL
  // parser already canonicalizes octal (`0177.0.0.1`), hex (`0x7f.0.0.1`),
  // 32-bit decimal (`2130706433`), and short forms (`127.1`) to dotted-
  // quad BEFORE parsed.hostname is set, so the SSRF check sees the
  // canonical form and isPrivateIp catches loopback variants correctly.
  // The defensive netIsIP-then-malformed-reject path below is here in
  // case (a) a future Node release loosens that canonicalization, or
  // (b) this module is ported to a runtime whose URL parser is more
  // permissive. Loose `/^[\d.]+$/` would have been a false sense of
  // safety; net.isIP() is the authoritative check.
  //
  // Note on bracketed IPv6: Node's URL parser keeps the surrounding
  // brackets on hostname for `[::1]`-style literals; strip them before
  // net.isIP() so we still recognize the form.
  const ipForCheck = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const ipVersion = netIsIP(ipForCheck);
  if (ipVersion !== 0) {
    if (isPrivateIp(ipForCheck)) throw new Error(`Private IP rejected: ${hostname}`);
    return [hostname];
  }
  if (/^[\d.]+$/.test(hostname)) {
    // Hostname looks like an IPv4 literal but failed net.isIP() — octal,
    // zero-padded, or partial form (`010.0.0.1`, `0177.0.0.1`, `127.1`
    // when not pre-canonicalized by the URL parser). Refuse rather than
    // gamble on DNS or undici's parsing.
    throw new Error(`Malformed IP literal rejected: ${hostname}`);
  }

  // Bound DNS resolution so a slow/hung resolver cannot extend the caller's
  // wall-clock past its own timeout budget. Node's resolve4/resolve6 have no
  // built-in per-call deadline; without this cap the webhook delivery worker's
  // per-item worst-case model (fetch timeout + backoffs) would understate the
  // real time an item can hold its claim lease, risking a reaper re-claim +
  // duplicate delivery. Applies to every external-HTTP caller (SSRF defense).
  //
  // A and AAAA run CONCURRENTLY, each under its OWN DNS_RESOLVE_TIMEOUT_MS
  // deadline, then awaited together with allSettled. The total wall-clock ceiling
  // is ~DNS_RESOLVE_TIMEOUT_MS (not 2×, since they overlap), AND a family that
  // resolves fast is USED even if the other family hangs to its own timeout — a
  // single shared timeout around the pair would discard the good result when
  // either family hangs. Each family's failure (no records OR timeout) is
  // independently swallowed; only when BOTH yield nothing do we fail closed.
  const ips: string[] = [];
  const [v4, v6] = await Promise.allSettled([
    withDnsTimeout(resolve4(hostname), hostname),
    withDnsTimeout(resolve6(hostname), hostname),
  ]);
  if (v4.status === "fulfilled") ips.push(...v4.value);
  if (v6.status === "fulfilled") ips.push(...v6.value);

  if (ips.length === 0) throw new Error(`DNS resolution failed: ${hostname}`);

  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error(`Hostname ${hostname} resolves to private IP: ${ip}`);
    }
  }

  return ips;
}

/**
 * Create an undici Agent that pins connections to pre-validated IPs,
 * eliminating the DNS rebinding TOCTOU window between validation and fetch.
 */
export function createPinnedDispatcher(hostname: string, validatedIps: string[]): UndiciAgent {
  let index = 0;
  return new UndiciAgent({
    connect: {
      // Preserve TLS certificate validation via SNI
      servername: hostname,
      lookup: (_origin, _opts, cb) => {
        const ip = validatedIps[index % validatedIps.length];
        index++;
        cb(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]);
      },
    },
  });
}

// ─── Validated Fetch ───────────────────────────────────────────

const EXTERNAL_USER_AGENT = "passwd-sso-delivery/1.0";

/**
 * Fetch a URL with full SSRF defense: DNS validation, IP pinning,
 * redirect blocking. All external deliverers MUST use this instead
 * of raw `fetch()`.
 */
export async function validateAndFetch(
  url: string,
  options: RequestInit & { timeout?: number },
): Promise<Response> {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;

  const validatedIps = await resolveAndValidateIps(url);
  const dispatcher = createPinnedDispatcher(hostname, validatedIps);

  try {
    return await fetch(url, {
      ...options,
      headers: {
        "User-Agent": EXTERNAL_USER_AGENT,
        ...options.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeout ?? 10 * MS_PER_SECOND),
      // @ts-expect-error -- Node.js fetch supports undici dispatcher
      dispatcher,
    });
  } finally {
    dispatcher.destroy();
  }
}

/** Buffered result of a body-reading validated fetch. */
export interface ValidatedFetchResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  /** Response body, fully read before the pinned dispatcher was destroyed. */
  body: Buffer;
}

/**
 * Like {@link validateAndFetch}, but for callers that need the response BODY.
 *
 * `validateAndFetch` destroys the pinned dispatcher in its `finally` as soon as
 * the headers resolve — reading the body from the returned `Response` afterwards
 * throws `ClientDestroyedError` (the dispatcher owns the connection). This
 * variant reads the body fully WHILE the dispatcher is still alive, then returns
 * the buffered bytes. `maxBytes` caps the read to bound memory; the body stream
 * is aborted and `RangeError` thrown once the cap is exceeded.
 */
export async function validateAndFetchBuffered(
  url: string,
  options: RequestInit & { timeout?: number; maxBytes: number },
): Promise<ValidatedFetchResult> {
  const { maxBytes, ...fetchOptions } = options;
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;

  const validatedIps = await resolveAndValidateIps(url);
  const dispatcher = createPinnedDispatcher(hostname, validatedIps);

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      headers: {
        "User-Agent": EXTERNAL_USER_AGENT,
        ...fetchOptions.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(fetchOptions.timeout ?? 10 * MS_PER_SECOND),
      // @ts-expect-error -- Node.js fetch supports undici dispatcher
      dispatcher,
    });

    // Read the body NOW, before `finally` destroys the dispatcher. Stream-cap
    // via the shared primitive so an oversized upstream body is aborted
    // mid-read (not buffered whole then rejected).
    if (!res.body) {
      throw new RangeError("validateAndFetchBuffered: response has no body");
    }
    const read = await readStreamWithCap(res.body, maxBytes);
    if (!read.ok) {
      throw new RangeError(
        `validateAndFetchBuffered: body exceeded maxBytes (${maxBytes})`,
      );
    }
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: read.bytes,
    };
  } finally {
    dispatcher.destroy();
  }
}

// ─── Sanitization ──────────────────────────────────────────────

/**
 * Business PII keys to strip from external delivery payloads.
 * Superset of METADATA_BLOCKLIST (crypto keys) plus business PII.
 *
 * Renamed from WEBHOOK_METADATA_BLOCKLIST for Phase 3 reuse.
 */
export const EXTERNAL_DELIVERY_METADATA_BLOCKLIST = new Set([
  ...METADATA_BLOCKLIST,
  "email",
  "targetUserEmail",
  "reason",
  "incidentRef",
  "displayName",
  "justification",
  "requestedScope",
  // Network identifiers stay in top-level columns; strip if accidentally written into metadata
  "ip",
  "userAgent",
]);

/**
 * Recursively strip keys listed in EXTERNAL_DELIVERY_METADATA_BLOCKLIST.
 * Extracted from webhook-dispatcher.ts sanitizeWebhookData for Phase 3 reuse.
 */
export function sanitizeForExternalDelivery(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeForExternalDelivery).filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const entries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (!EXTERNAL_DELIVERY_METADATA_BLOCKLIST.has(k)) {
        const sanitized = sanitizeForExternalDelivery(v);
        if (sanitized !== undefined) {
          entries.push([k, sanitized]);
        }
      }
    }
    return safeRecord(entries);
  }
  return value;
}

// ─── Error sanitization ────────────────────────────────────────

const CREDENTIAL_PATTERNS = [
  /[?&](?:token|key|secret|password|api_key|apikey|access_token)=[^&\s]*/gi,
  /Bearer\s+[^\s,]+/gi,
  /Basic\s+[A-Za-z0-9+/=]+/gi,
  /Splunk\s+[^\s,]+/gi,
  /AWS4-HMAC-SHA256\s+Credential=[^\s,]+/gi,
];

/**
 * Strip credential patterns from error messages before storage
 * in `lastError` columns (P3-S5 fix).
 */
export function sanitizeErrorForStorage(message: string, maxLength = 1024): string {
  let sanitized = message;

  // Strip URL query parameters that may contain credentials
  sanitized = sanitized.replace(
    /https?:\/\/[^\s]+/g,
    (url) => {
      try {
        const parsed = new URL(url);
        if (parsed.search) {
          parsed.search = "";
          return `${parsed.toString()} [query params redacted]`;
        }
        return url;
      } catch {
        return url;
      }
    },
  );

  for (const pattern of CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }

  return sanitized.slice(0, maxLength);
}
