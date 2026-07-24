import { getLogger } from "@/lib/logger";

/**
 * Boot-time diagnostic for the reverse-proxy / client-IP posture (M2).
 *
 * When the app runs in production with `TRUST_PROXY_HEADERS=false` and no
 * `TRUSTED_PROXIES` configured, forwarded `X-Forwarded-For` headers are ignored
 * (correct fail-closed default against IP spoofing) — but if the app IS behind a
 * proxy, every request then resolves to the proxy's socket IP or to null,
 * collapsing per-IP rate limits. High-risk endpoints now fall back to a small
 * shared unknown-IP budget rather than failing open, so this is not a hole; it
 * is a likely-misconfiguration signal worth surfacing at boot.
 *
 * This intentionally only WARNS: a single-instance deployment with no proxy runs
 * this way legitimately (the socket peer IP is the real client). We cannot infer
 * the topology, so we cannot fail closed here without breaking valid setups.
 *
 * Returns true when a warning was emitted (for testability).
 */
export function warnOnProxyPosture(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return false;

  const trustProxyHeaders = env.TRUST_PROXY_HEADERS === "true";
  const hasTrustedProxies = (env.TRUSTED_PROXIES ?? "").trim().length > 0;

  if (trustProxyHeaders || hasTrustedProxies) return false;

  getLogger().warn(
    {
      trustProxyHeaders: false,
      trustedProxiesConfigured: false,
    },
    "proxy_posture_client_ip_may_be_unavailable: production is not configured to " +
      "trust forwarded client-IP headers (TRUST_PROXY_HEADERS unset/false and no " +
      "TRUSTED_PROXIES). If this app is behind a reverse proxy/load balancer, " +
      "per-IP rate limits will collapse and IP-less high-risk requests fall back " +
      "to the shared unknown-IP budget. Set TRUST_PROXY_HEADERS=true (and, if " +
      "applicable, TRUSTED_PROXIES) only when the app is fronted exclusively by a " +
      "trusted proxy that sets X-Forwarded-For.",
  );
  return true;
}
