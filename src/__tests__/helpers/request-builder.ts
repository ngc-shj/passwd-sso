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
