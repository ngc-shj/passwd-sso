import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { scimParseBody } from "./parse-body";

const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

function jsonRequest(body: unknown, contentLength?: number): NextRequest {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (contentLength !== undefined) headers["Content-Length"] = String(contentLength);
  return new NextRequest("http://localhost:3000/api/scim/v2/Users", {
    method: "POST",
    headers,
    body: text,
  });
}

function textRequest(text: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/scim/v2/Users", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: text,
  });
}

const schema = z.object({
  userName: z.string().min(1),
  emails: z.array(z.object({ value: z.string().email() })).optional(),
});

describe("scimParseBody", () => {
  it("returns parsed data for valid JSON matching the SCIM schema", async () => {
    const req = jsonRequest({ userName: "alice@example.com" });
    const result = await scimParseBody(req, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ userName: "alice@example.com" });
    }
  });

  it("returns 400 with SCIM Error envelope for invalid JSON body", async () => {
    const req = textRequest("not json");
    const result = await scimParseBody(req, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.schemas).toEqual([SCIM_ERROR_SCHEMA]);
      expect(json.status).toBe("400");
      expect(json.detail).toBe("Invalid JSON");
    }
  });

  it("returns 400 with SCIM Error envelope for Zod validation failure", async () => {
    const req = jsonRequest({ userName: "" }); // min(1) violation
    const result = await scimParseBody(req, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.schemas).toEqual([SCIM_ERROR_SCHEMA]);
      expect(json.status).toBe("400");
      // detail is a `path: message` joined string from Zod issues
      expect(typeof json.detail).toBe("string");
      expect(json.detail).toContain("userName");
    }
  });

  it("returns 413 with SCIM Error envelope when content-length exceeds default cap", async () => {
    // Content-Length pre-check rejects before reading the stream
    const req = jsonRequest({ userName: "alice" }, /* contentLength */ 2_000_000);
    const result = await scimParseBody(req, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      const json = await result.response.json();
      expect(json.schemas).toEqual([SCIM_ERROR_SCHEMA]);
      expect(json.status).toBe("413");
      expect(json.detail).toBe("Request body too large");
    }
  });

  it("respects custom maxBytes override (accepts larger body when permitted)", async () => {
    // 100-byte body with explicit 1_000_000 cap → accepted
    const req = new NextRequest("http://localhost:3000/api/scim/v2/Users", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "100" },
      body: JSON.stringify({ userName: "alice@example.com" }),
    });
    const result = await scimParseBody(req, schema, { maxBytes: 1_000_000 });
    expect(result.ok).toBe(true);
  });
});
