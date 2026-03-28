import { type NextRequest, NextResponse } from "next/server";
import { validateMcpToken } from "@/lib/mcp/oauth-server";
import { handleMcpRequest } from "@/lib/mcp/server";

export async function POST(req: NextRequest) {
  // Validate MCP access token
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
      { status: 401 },
    );
  }

  const tokenResult = await validateMcpToken(bearer);
  if (!tokenResult.ok) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  const response = await handleMcpRequest(body, tokenResult.data);
  return NextResponse.json(response);
}

// SSE endpoint for server-initiated messages (basic support)
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const tokenResult = await validateMcpToken(bearer);
  if (!tokenResult.ok) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Basic SSE stream — sends a single endpoint event then closes
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode("event: endpoint\ndata: /api/mcp\n\n"));
      controller.close();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
