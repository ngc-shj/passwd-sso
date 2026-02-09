import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generatePassword, generatePassphrase } from "@/lib/password-generator";
import { generatePasswordSchema, generatePassphraseSchema } from "@/lib/validations";
import { createRateLimiter } from "@/lib/rate-limit";
import { z } from "zod";

const generateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

const requestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("password") }).merge(generatePasswordSchema),
  z.object({ mode: z.literal("passphrase") }).merge(generatePassphraseSchema),
]);

// POST /api/passwords/generate - Generate a random password or passphrase
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await generateLimiter.check(`rl:pw_generate:${session.user.id}`))) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Support legacy requests without mode field
  const input = typeof body === "object" && body !== null && !("mode" in body)
    ? { mode: "password" as const, ...body }
    : body;

  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;
  let password: string;

  if (data.mode === "passphrase") {
    password = generatePassphrase(data);
  } else {
    password = generatePassword(data);
  }

  return NextResponse.json({ password });
}
