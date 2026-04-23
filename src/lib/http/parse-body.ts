import { NextRequest, NextResponse } from "next/server";
import { type ZodSchema } from "zod";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { zodValidationError } from "@/lib/http/api-response";

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
 * Parse and validate a JSON request body against a Zod schema.
 *
 * Combines the 3-step pattern used across 60+ route handlers:
 *   1. try { await req.json() } catch → 400 INVALID_JSON
 *   2. schema.safeParse(body)
 *   3. if (!success) → 400 VALIDATION_ERROR with details
 *
 * Usage:
 *   const result = await parseBody(req, mySchema);
 *   if (!result.ok) return result.response;
 *   const { data } = result;  // typed as T
 */
export async function parseBody<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
): Promise<ParseResult<T>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: API_ERROR.INVALID_JSON },
        { status: 400 },
      ),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: zodValidationError(parsed.error),
    };
  }

  return { ok: true, data: parsed.data };
}
