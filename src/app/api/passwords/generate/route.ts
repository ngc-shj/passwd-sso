import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generatePassword, generatePassphrase } from "@/lib/password-generator";
import { generatePasswordSchema, generatePassphraseSchema } from "@/lib/validations";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { z } from "zod";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";

const generateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

const requestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("password") }).merge(generatePasswordSchema),
  z.object({ mode: z.literal("passphrase") }).merge(generatePassphraseSchema),
]);

// POST /api/passwords/generate - Generate a random password or passphrase
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  if (!(await generateLimiter.check(`rl:pw_generate:${session.user.id}`)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }

  // Support legacy requests without mode field
  const input = typeof body === "object" && body !== null && !("mode" in body)
    ? { mode: "password" as const, ...body }
    : body;

  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.flatten());
  }

  const data = parsed.data;
  let password: string;

  try {
    if (data.mode === "passphrase") {
      password = generatePassphrase(data);
    } else {
      password = generatePassword(data);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, message },
      { status: 400 }
    );
  }

  return NextResponse.json({ password });
}

export const POST = withRequestLog(handlePOST);
