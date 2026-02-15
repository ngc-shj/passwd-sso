import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(
    { status: "alive" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
