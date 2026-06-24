import { NextRequest, NextResponse } from "next/server";
import { type ZodSchema } from "zod";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, zodValidationError } from "@/lib/http/api-response";
import { MAX_JSON_BODY_BYTES } from "@/lib/validations/common.server";

/**
 * Parse and validate URL query parameters against a Zod schema.
 *
 * Flattens URLSearchParams into a plain object (multi-value keys become arrays)
 * before calling safeParse. Returns a 400 VALIDATION_ERROR response on failure.
 *
 * Usage:
 *   const result = parseQuery(req, mySchema);
 *   if (!result.ok) return result.response;
 *   const { data } = result;
 */
export function parseQuery<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
): ParseResult<T> {
  const params = req.nextUrl.searchParams;
  const obj: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    obj[key] = values.length > 1 ? values : values[0];
  }
  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    return { ok: false, response: zodValidationError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

type ParseOk<T> = { ok: true; data: T };
type ParseFail = { ok: false; response: NextResponse };
export type ParseResult<T> = ParseOk<T> | ParseFail;

/**
 * Cheap advisory pre-check: true when a present Content-Length header declares
 * more than `maxBytes`. Used by routes that read form-urlencoded / raw bodies
 * (and so cannot use readJsonWithCap) to early-reject oversized requests. NOT a
 * substitute for the streaming cap — a missing/lying header still requires the
 * authoritative guard (readJsonWithCap, or an after-read length check).
 */
export function exceedsDeclaredContentLength(
  req: NextRequest,
  maxBytes: number,
): boolean {
  const contentLength = req.headers.get("content-length");
  if (!contentLength) return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n > maxBytes;
}

/**
 * Gate a multipart/form-data upload on its declared Content-Length BEFORE
 * calling req.formData(), which buffers the entire multipart body into memory
 * with no platform cap. Unlike JSON/text bodies we cannot stream-cap formData()
 * (the App Router parser owns the stream), so the only pre-parse defense is the
 * declared length — and a body without one is rejected fail-closed.
 *
 * Browsers always set Content-Length on form uploads, so requiring it does not
 * break the legitimate UI path; it closes the chunked / no-Content-Length DoS
 * vector. Returns a 413 response when the header is missing, unparseable, or
 * declares more than maxBytes; null when the request may proceed to formData().
 */
export function rejectOversizedMultipart(
  req: NextRequest,
  maxBytes: number,
): NextResponse | null {
  const contentLength = req.headers.get("content-length");
  if (!contentLength) {
    return errorResponse(API_ERROR.PAYLOAD_TOO_LARGE);
  }
  const declared = Number(contentLength);
  if (!Number.isFinite(declared) || declared > maxBytes) {
    return errorResponse(API_ERROR.PAYLOAD_TOO_LARGE);
  }
  return null;
}

type ReadBytesOk = { ok: true; bytes: Uint8Array };
type ReadBytesFail = { ok: false; tooLarge?: true; noStream?: true };
type ReadBytesResult = ReadBytesOk | ReadBytesFail;

/**
 * Read req.body as a stream, accumulating bytes, aborting the moment the running
 * total exceeds `maxBytes`. This is the authoritative guard against the
 * chunked-Transfer-Encoding bypass: the App Router has no platform body cap and
 * a missing/lying Content-Length header makes the cheap pre-check useless, so
 * the only durable defense is to stop reading once the cap is crossed.
 *
 * This is the byte-level primitive that readJsonWithCap / readFormWithCap build
 * on. Use it directly only when a route needs the raw bytes (e.g. a
 * replay-vs-retry body hash); otherwise reach for the typed helpers below.
 */
/**
 * Stream-read any ReadableStream of bytes (a request OR an upstream response
 * body) under a byte cap, aborting the moment the running total exceeds
 * `maxBytes`. Returns `{ ok: false, tooLarge: true }` instead of buffering the
 * whole body first — the cap must reject BEFORE memory is spent, not after.
 *
 * This is the byte-level primitive shared by readBytesWithCap (inbound request
 * bodies) and validateAndFetchBuffered (outbound response bodies).
 */
export async function readStreamWithCap(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; tooLarge: true }> {
  const reader = stream.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

export async function readBytesWithCap(
  req: NextRequest,
  maxBytes: number,
): Promise<ReadBytesResult> {
  // Pre-check content-length when present (cheap early reject)
  if (exceedsDeclaredContentLength(req, maxBytes)) {
    return { ok: false, tooLarge: true };
  }

  if (!req.body) {
    // No body stream — reachable only when tests mock req.body=null or for
    // GET/HEAD. In production App Router POST handlers req.body is always a
    // ReadableStream. Without a stream we cannot enforce the byte cap, so we
    // fail closed and let the caller decide how to surface it.
    return { ok: false, noStream: true };
  }

  return readStreamWithCap(req.body, maxBytes);
}

type ReadTextOk = { ok: true; text: string };
type ReadTextFail = { ok: false; tooLarge?: true };
type ReadTextResult = ReadTextOk | ReadTextFail;

/**
 * Stream-read a request body as UTF-8 text under a byte cap. Used by routes that
 * consume application/x-www-form-urlencoded bodies (OAuth token/revoke), which
 * cannot use readJsonWithCap. The streaming cap is authoritative — unlike a bare
 * exceedsDeclaredContentLength pre-check, it defends against chunked bodies that
 * omit Content-Length.
 *
 * A noStream result (test-only req.body=null) is reported as ok:false; the form
 * is then empty, which the caller rejects as invalid_request downstream.
 */
export async function readFormWithCap(
  req: NextRequest,
  maxBytes: number,
): Promise<ReadTextResult> {
  const read = await readBytesWithCap(req, maxBytes);
  if (!read.ok) {
    return read.tooLarge ? { ok: false, tooLarge: true } : { ok: false };
  }
  return { ok: true, text: new TextDecoder().decode(read.bytes) };
}

type ReadOk = { ok: true; body: unknown };
type ReadFail = { ok: false; tooLarge?: true; invalidJson?: true };
type ReadResult = ReadOk | ReadFail;

/**
 * Read req.body as a stream, accumulating bytes, aborting if cap exceeded, then
 * JSON-parse the result. Authoritative guard against chunked-TE bypass.
 *
 * Exported for routes that need body-size enforcement but cannot use parseBody
 * directly (e.g. mixed application/x-www-form-urlencoded + JSON endpoints).
 */
export async function readJsonWithCap(
  req: NextRequest,
  maxBytes: number,
): Promise<ReadResult> {
  const read = await readBytesWithCap(req, maxBytes);
  if (!read.ok) {
    if (read.tooLarge) return { ok: false, tooLarge: true };
    // No body stream — reachable only in tests that hand-craft a req without a
    // ReadableStream (production POST handlers always have one). If a
    // content-length header is present we honor the cap pre-check (already run
    // in readBytesWithCap) and fall back to req.json(); otherwise fail closed.
    if (read.noStream && req.headers.get("content-length")) {
      try {
        return { ok: true, body: await req.json() };
      } catch {
        return { ok: false, invalidJson: true };
      }
    }
    return { ok: false, invalidJson: true };
  }

  const text = new TextDecoder().decode(read.bytes);
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, invalidJson: true };
  }
}

/**
 * Parse and validate a JSON request body against a Zod schema.
 *
 * Combines the 3-step pattern used across 60+ route handlers:
 *   1. Stream-read body with byte cap → 413 PAYLOAD_TOO_LARGE if exceeded
 *   2. JSON parse → 400 INVALID_JSON on failure
 *   3. schema.safeParse(body) → 400 VALIDATION_ERROR with details
 *
 * The default cap is MAX_JSON_BODY_BYTES (1 MB). Routes that handle larger
 * payloads (e.g. bulk imports, attachment migrations) should pass an explicit
 * maxBytes override via options.
 *
 * Usage:
 *   const result = await parseBody(req, mySchema);
 *   if (!result.ok) return result.response;
 *   const { data } = result;  // typed as T
 */
export async function parseBody<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
  options?: { maxBytes?: number },
): Promise<ParseResult<T>> {
  const maxBytes = options?.maxBytes ?? MAX_JSON_BODY_BYTES;
  const read = await readJsonWithCap(req, maxBytes);

  if (!read.ok) {
    if (read.tooLarge) {
      return { ok: false, response: errorResponse(API_ERROR.PAYLOAD_TOO_LARGE) };
    }
    return { ok: false, response: errorResponse(API_ERROR.INVALID_JSON) };
  }

  const parsed = schema.safeParse(read.body);
  if (!parsed.success) {
    return {
      ok: false,
      response: zodValidationError(parsed.error),
    };
  }

  return { ok: true, data: parsed.data };
}
