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

type ReadOk = { ok: true; body: unknown };
type ReadFail = { ok: false; tooLarge?: true; invalidJson?: true };
type ReadResult = ReadOk | ReadFail;

/**
 * Read req.body as a stream, accumulating bytes, aborting if cap exceeded.
 * Authoritative guard against chunked-TE bypass (App Router has no platform cap).
 *
 * Exported for routes that need body-size enforcement but cannot use parseBody
 * directly (e.g. mixed application/x-www-form-urlencoded + JSON endpoints).
 */
export async function readJsonWithCap(
  req: NextRequest,
  maxBytes: number,
): Promise<ReadResult> {
  // Pre-check content-length when present (cheap early reject)
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false, tooLarge: true };
  }

  const reader = req.body?.getReader();
  if (!reader) {
    // No body — try the original parse to get standard "empty body" behavior
    try {
      const body = await req.json();
      return { ok: true, body };
    } catch {
      return { ok: false, invalidJson: true };
    }
  }

  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
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
  } catch {
    return { ok: false, invalidJson: true };
  }

  const text = new TextDecoder().decode(Buffer.concat(chunks));
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
