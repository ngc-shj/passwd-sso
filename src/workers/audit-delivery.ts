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
import {
  validateAndFetch,
  sanitizeForExternalDelivery,
  sanitizeErrorForStorage,
} from "@/lib/external-http";
import { getLogger } from "@/lib/logger";

// ─── Interface ────────────────────────────────────────────────

export interface TargetConfig {
  [key: string]: unknown;
}

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

// ─── Implementations ──────────────────────────────────────────

/**
 * Webhook deliverer — HMAC-SHA256-signed POST.
 *
 * Config: { url: string, secret: string }
 */
export const webhookDeliverer: AuditDeliverer = {
  async deliver(config, payload) {
    const log = getLogger();
    const sanitized = sanitizeForExternalDelivery(payload);
    const body = JSON.stringify(sanitized);

    const secret = typeof config.secret === "string" ? config.secret : "";
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    log.info({ outboxId: payload.id, url: config.url }, "audit-delivery.webhook.attempt");

    let res: Response;
    try {
      res = await validateAndFetch(String(config.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": `sha256=${signature}`,
        },
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Webhook delivery failed: ${sanitizeErrorForStorage(msg)}`);
    }

    if (!res.ok) {
      throw new Error(
        `Webhook delivery failed with HTTP ${res.status}`,
      );
    }

    log.info({ outboxId: payload.id, status: res.status }, "audit-delivery.webhook.ok");
  },
};

/**
 * SIEM HEC deliverer — Splunk/Datadog HTTP Event Collector.
 *
 * Config: { url: string, token: string }
 */
export const siemHecDeliverer: AuditDeliverer = {
  async deliver(config, payload) {
    const log = getLogger();
    const sanitized = sanitizeForExternalDelivery(payload);
    const hecEvent = {
      event: sanitized,
      time: Math.floor(new Date(payload.createdAt).getTime() / 1000),
      sourcetype: "passwd-sso:audit",
    };
    const body = JSON.stringify(hecEvent);

    const token = typeof config.token === "string" ? config.token : "";
    log.info({ outboxId: payload.id, url: config.url }, "audit-delivery.siem_hec.attempt");

    let res: Response;
    try {
      res = await validateAndFetch(String(config.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Splunk ${token}`,
        },
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`SIEM HEC delivery failed: ${sanitizeErrorForStorage(msg)}`);
    }

    if (!res.ok) {
      throw new Error(
        `SIEM HEC delivery failed with HTTP ${res.status}`,
      );
    }

    log.info({ outboxId: payload.id, status: res.status }, "audit-delivery.siem_hec.ok");
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
    const log = getLogger();
    const sanitized = sanitizeForExternalDelivery(payload);
    const body = JSON.stringify(sanitized);

    const endpoint = typeof config.endpoint === "string" ? config.endpoint : "";
    const region = typeof config.region === "string" ? config.region : "us-east-1";
    const accessKeyId = typeof config.accessKeyId === "string" ? config.accessKeyId : "";
    const secretAccessKey =
      typeof config.secretAccessKey === "string" ? config.secretAccessKey : "";

    const objectKey = buildObjectKey(payload.tenantId, payload.id, payload.createdAt);
    // Normalize: strip trailing slash from endpoint, prepend slash to key
    const normalizedEndpoint = endpoint.replace(/\/+$/, "");
    const objectUrl = `${normalizedEndpoint}/${objectKey}`;

    const bodyHash = sha256Hex(body);
    const { dateTime, date } = utcNow();

    const { authorization, amzDate } = buildSigV4AuthorizationHeader({
      method: "PUT",
      url: objectUrl,
      region,
      accessKeyId,
      secretAccessKey,
      bodyHash,
      dateTime,
      date,
    });

    log.info({ outboxId: payload.id, objectUrl }, "audit-delivery.s3_object.attempt");

    let res: Response;
    try {
      res = await validateAndFetch(objectUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-amz-content-sha256": bodyHash,
          "x-amz-date": amzDate,
          Authorization: authorization,
        },
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Object storage delivery failed: ${sanitizeErrorForStorage(msg)}`);
    }

    if (!res.ok) {
      throw new Error(
        `Object storage delivery failed with HTTP ${res.status} for key ${objectKey}`,
      );
    }

    log.info({ outboxId: payload.id, objectKey, status: res.status }, "audit-delivery.s3_object.ok");
  },
};

// ─── Registry ──────────────────────────────────────────────────

export const DELIVERERS: Record<string, AuditDeliverer> = {
  WEBHOOK: webhookDeliverer,
  SIEM_HEC: siemHecDeliverer,
  S3_OBJECT: s3ObjectDeliverer,
};
