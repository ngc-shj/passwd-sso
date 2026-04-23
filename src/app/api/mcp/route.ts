import { type NextRequest, NextResponse } from "next/server";
import { validateMcpToken } from "@/lib/mcp/oauth-server";
import { handleMcpRequest } from "@/lib/mcp/server";
import { extractClientIp } from "@/lib/auth/ip-access";
import { BASE_PATH } from "@/lib/url-helpers";
import { withRequestLog } from "@/lib/http/with-request-log";

async function handlePOST(req: NextRequest) {
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

  const ip = extractClientIp(req);
  const response = await handleMcpRequest(body, tokenResult.data, ip);
  return NextResponse.json(response);
}

// SSE endpoint for server-initiated messages (basic support)
async function handleGET(req: NextRequest) {
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
      controller.enqueue(enc.encode(`event: endpoint\ndata: ${BASE_PATH}/api/mcp\n\n`));
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

export const POST = withRequestLog(handlePOST);
export const GET = withRequestLog(handleGET);
