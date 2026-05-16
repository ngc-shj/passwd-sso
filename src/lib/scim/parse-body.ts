import type { NextRequest, NextResponse } from "next/server";
import { type ZodSchema } from "zod";
import { readJsonWithCap } from "@/lib/http/parse-body";
import { MAX_JSON_BODY_BYTES } from "@/lib/validations/common.server";
import { scimError } from "@/lib/scim/response";

type ScimParseOk<T> = { ok: true; data: T };
type ScimParseFail = { ok: false; response: NextResponse };
export type ScimParseResult<T> = ScimParseOk<T> | ScimParseFail;

/**
 * SCIM equivalent of parseBody from @/lib/http/parse-body.
 *
 * Uses readJsonWithCap for byte-cap enforcement (same security posture as C8),
 * but maps failures to RFC 7644 §3.12 SCIM error format instead of the standard
 * JSON API error envelope. SCIM clients (Azure AD, Okta, directory sync) require
 * { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status, detail }.
 *
 * Usage:
 *   const result = await scimParseBody(req, myScimSchema);
 *   if (!result.ok) return result.response;
 *   const { data } = result;  // typed as T
 */
export async function scimParseBody<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
  options?: { maxBytes?: number },
): Promise<ScimParseResult<T>> {
  const maxBytes = options?.maxBytes ?? MAX_JSON_BODY_BYTES;
  const read = await readJsonWithCap(req, maxBytes);

  if (!read.ok) {
    if (read.tooLarge) {
      return { ok: false, response: scimError(413, "Request body too large") };
    }
    return { ok: false, response: scimError(400, "Invalid JSON") };
  }

  const parsed = schema.safeParse(read.body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return { ok: false, response: scimError(400, issues) };
  }

  return { ok: true, data: parsed.data };
}
