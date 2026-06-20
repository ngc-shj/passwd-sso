/**
 * Helpers for building Request objects and parsing responses
 * in Next.js App Router route handler tests.
 */

import { NextRequest } from "next/server";

export function createRequest(
  method: string,
  url: string = "http://localhost:3000/api/test",
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    searchParams?: Record<string, string>;
  } = {}
): NextRequest {
  const { body, headers = {}, searchParams = {} } = options;

  const urlObj = new URL(url);
  for (const [key, value] of Object.entries(searchParams)) {
    urlObj.searchParams.set(key, value);
  }

  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  return new NextRequest(urlObj.toString(), init as ConstructorParameters<typeof NextRequest>[1]);
}

/**
 * Creates a NextRequest from FormData for multipart upload tests.
 * Note: Do NOT set Content-Type header manually — the boundary is auto-generated.
 *
 * A real browser sets Content-Length on form uploads, and route handlers gate
 * on it (rejectOversizedMultipart fails closed when it is absent). undici does
 * NOT set Content-Length for a streamed FormData body, so we serialize the body
 * once to compute and set it — mirroring the browser wire shape. Pass
 * `{ omitContentLength: true }` to exercise the fail-closed (no-header) path.
 */
export async function createMultipartRequest(
  url: string,
  formData: FormData,
  options: { headers?: Record<string, string>; omitContentLength?: boolean } = {}
): Promise<NextRequest> {
  const { headers = {}, omitContentLength = false } = options;
  // Serialize the multipart body once to capture its bytes + boundary header.
  const encoded = new Request("http://localhost", { method: "POST", body: formData });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const contentType = encoded.headers.get("content-type") ?? "multipart/form-data";

  const finalHeaders: Record<string, string> = {
    "content-type": contentType,
    ...(omitContentLength ? {} : { "content-length": String(bytes.length) }),
    ...headers,
  };

  return new NextRequest(url, {
    method: "POST",
    body: bytes,
    headers: finalHeaders,
  } as ConstructorParameters<typeof NextRequest>[1]);
}

/** Parse a Response to { status, json } */
export async function parseResponse(response: Response) {
  const json = await response.json();
  return { status: response.status, json };
}

/**
 * Creates a params object matching Next.js 16 route handler signature.
 * Route handlers receive { params: Promise<T> }.
 */
export function createParams<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}
