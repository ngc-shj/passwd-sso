import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { generatePassword, generatePassphrase } from "@/lib/password-generator";
import { generatePasswordSchema, generatePassphraseSchema } from "@/lib/validations";
import { z } from "zod";

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
