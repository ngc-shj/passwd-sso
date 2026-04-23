/**
 * Audit delivery targets for Phase 3 of the durable audit outbox.
 *
 * Design: interface/implementation separation.
 * - AuditDeliverer: interface that all delivery target implementations satisfy
 * - Each implementation handles protocol-specific details (HMAC, HEC, SigV4)
 * - S3_OBJECT is vendor-neutral: supports any S3-compatible endpoint
 *   (AWS S3, GCS interop, Cloudflare R2, MinIO, etc.)
 */

import { createHmac, createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  validateAndFetch,
  sanitizeForExternalDelivery,
  sanitizeErrorForStorage,
} from "@/lib/http/external-http";
import { getLogger } from "@/lib/logger";

// ─── Interface ────────────────────────────────────────────────

export interface TargetConfig {
  [key: string]: unknown;
}

// ─── Config validation schemas (S-M1 fix) ─────────────────────

const webhookConfigSchema = z.object({
  url: z.url(),
  secret: z.string().min(1),
});

const siemHecConfigSchema = z.object({
  url: z.url(),
  token: z.string().min(1),
});

const s3ObjectConfigSchema = z.object({
  endpoint: z.url(),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

export interface DeliveryPayload {
  id: string;
  tenantId: string;
  action: string;
  scope: string;
  userId: string | null;
  actorType: string;
  metadata: Record<string, unknown>;
  createdAt: string; // ISO 8601
}

/**
 * All deliverers implement this interface.
 * Returns void on success, throws on failure (caller handles retry).
 */
export interface AuditDeliverer {
  deliver(config: TargetConfig, payload: DeliveryPayload): Promise<void>;
}

// ─── SigV4 helpers (S3-compatible API signing) ────────────────

function utcNow(): { dateTime: string; date: string } {
  const now = new Date();
  const dateTime = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const date = dateTime.slice(0, 8);
  return { dateTime, date };
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function buildSigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

/**
 * Compute the SigV4 Authorization header for an S3-compatible PUT request.
 * Works with any S3-compatible endpoint (AWS, R2, GCS interop, MinIO).
 */
function buildSigV4AuthorizationHeader(opts: {
  method: string;
  url: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bodyHash: string;
  dateTime: string;
  date: string;
}): { authorization: string; amzDate: string } {
  const { method, url, region, accessKeyId, secretAccessKey, bodyHash, dateTime, date } = opts;
  const parsed = new URL(url);
  const host = parsed.host;
  const canonicalUri = parsed.pathname || "/";
  const canonicalQueryString = "";

  const canonicalHeaders = [
    `content-type:application/json`,
    `host:${host}`,
    `x-amz-content-sha256:${bodyHash}`,
    `x-amz-date:${dateTime}`,
  ].join("\n") + "\n";

  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = buildSigningKey(secretAccessKey, date, region, "s3");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, amzDate: dateTime };
}

function buildObjectKey(tenantId: string, outboxId: string, createdAt: string): string {
  const d = new Date(createdAt);
  const yyyy = d.getUTCFullYear().toString();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `audit-logs/${tenantId}/${yyyy}/${mm}/${dd}/${outboxId}.json`;
}

// ─── Common delivery helper ───────────────────────────────────

async function fetchOrThrow(
  label: string,
  url: string,
  options: RequestInit & { timeout?: number },
): Promise<Response> {
  let res: Response;
  try {
    res = await validateAndFetch(url, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} delivery failed: ${sanitizeErrorForStorage(msg)}`);
  }
  if (!res.ok) {
    throw new Error(`${label} delivery failed with HTTP ${res.status}`);
  }
  return res;
}

// ─── Implementations ──────────────────────────────────────────

/**
 * Webhook deliverer — HMAC-SHA256-signed POST.
 * Config: { url: string, secret: string }
 */
export const webhookDeliverer: AuditDeliverer = {
  async deliver(config, payload) {
    const parsed = webhookConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error(`Invalid webhook config: ${parsed.error.message}`);
    const { url, secret } = parsed.data;

    const body = JSON.stringify(sanitizeForExternalDelivery(payload));
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    getLogger().info({ outboxId: payload.id, url }, "audit-delivery.webhook.attempt");
    const res = await fetchOrThrow("Webhook", url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": `sha256=${signature}` },
      body,
    });
    getLogger().info({ outboxId: payload.id, status: res.status }, "audit-delivery.webhook.ok");
  },
};

/**
 * SIEM HEC deliverer — Splunk/Datadog HTTP Event Collector.
 * Config: { url: string, token: string }
 */
export const siemHecDeliverer: AuditDeliverer = {
  async deliver(config, payload) {
    const parsed = siemHecConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error(`Invalid SIEM HEC config: ${parsed.error.message}`);
    const { url, token } = parsed.data;

    const hecEvent = {
      event: sanitizeForExternalDelivery(payload),
      time: Math.floor(new Date(payload.createdAt).getTime() / 1000),
      sourcetype: "passwd-sso:audit",
    };
    const body = JSON.stringify(hecEvent);

    getLogger().info({ outboxId: payload.id, url }, "audit-delivery.siem_hec.attempt");
    const res = await fetchOrThrow("SIEM HEC", url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Splunk ${token}` },
      body,
    });
    getLogger().info({ outboxId: payload.id, status: res.status }, "audit-delivery.siem_hec.ok");
  },
};

/**
 * S3-compatible object storage deliverer — SigV4-signed PUT.
 *
 * Vendor-neutral: works with any S3-compatible endpoint
 * (AWS S3, Cloudflare R2, Google Cloud Storage interop, MinIO, etc.)
 *
 * Config: {
 *   endpoint: string    // Base URL, e.g. "https://s3.us-east-1.amazonaws.com/my-bucket"
 *                       //   or "https://account.r2.cloudflarestorage.com/my-bucket"
 *                       //   or "https://minio.internal:9000/audit-bucket"
 *   region: string      // Signing region (e.g. "us-east-1", "auto" for R2)
 *   accessKeyId: string
 *   secretAccessKey: string
 * }
 *
 * Object key: audit-logs/<tenantId>/<YYYY>/<MM>/<DD>/<outboxId>.json
 */
export const s3ObjectDeliverer: AuditDeliverer = {
  async deliver(config, payload) {
    const parsed = s3ObjectConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error(`Invalid S3 object config: ${parsed.error.message}`);
    const { endpoint, region, accessKeyId, secretAccessKey } = parsed.data;

    const body = JSON.stringify(sanitizeForExternalDelivery(payload));
    const objectKey = buildObjectKey(payload.tenantId, payload.id, payload.createdAt);
    const objectUrl = `${endpoint.replace(/\/+$/, "")}/${objectKey}`;

    const bodyHash = sha256Hex(body);
    const { dateTime, date } = utcNow();
    const { authorization, amzDate } = buildSigV4AuthorizationHeader({
      method: "PUT", url: objectUrl, region, accessKeyId, secretAccessKey, bodyHash, dateTime, date,
    });

    getLogger().info({ outboxId: payload.id, objectUrl }, "audit-delivery.s3_object.attempt");
    const res = await fetchOrThrow("Object storage", objectUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-amz-content-sha256": bodyHash,
        "x-amz-date": amzDate,
        Authorization: authorization,
      },
      body,
    });
    getLogger().info({ outboxId: payload.id, objectKey, status: res.status }, "audit-delivery.s3_object.ok");
  },
};

// ─── Registry ──────────────────────────────────────────────────

export const DELIVERERS: Record<string, AuditDeliverer> = {
  WEBHOOK: webhookDeliverer,
  SIEM_HEC: siemHecDeliverer,
  S3_OBJECT: s3ObjectDeliverer,
};
