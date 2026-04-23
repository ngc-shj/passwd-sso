import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generatePassword, generatePassphrase } from "@/lib/password-generator";
import { generateRequestSchema } from "@/lib/validations";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";

const generateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

// POST /api/passwords/generate - Generate a random password or passphrase
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await generateLimiter.check(`rl:pw_generate:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, generateRequestSchema);
  if (!result.ok) return result.response;

  const data = result.data;
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
