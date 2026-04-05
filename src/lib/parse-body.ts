import { NextRequest, NextResponse } from "next/server";
import { z, type ZodSchema } from "zod";
import { API_ERROR } from "@/lib/api-error-codes";

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
      response: NextResponse.json(
        {
          error: API_ERROR.VALIDATION_ERROR,
          details: z.treeifyError(parsed.error),
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, data: parsed.data };
}
