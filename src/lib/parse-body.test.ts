import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "./parse-body";

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function textRequest(text: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/test", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: text,
  });
}

const schema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

describe("parseBody", () => {
  it("returns parsed data for valid JSON", async () => {
    const req = jsonRequest({ name: "Alice", age: 30 });
    const result = await parseBody(req, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    }
  });

  it("returns 400 INVALID_JSON for non-JSON body", async () => {
    const req = textRequest("not json");
    const result = await parseBody(req, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.error).toBe("INVALID_JSON");
    }
  });

  it("returns 400 VALIDATION_ERROR for invalid schema", async () => {
    const req = jsonRequest({ name: "", age: -1 });
    const result = await parseBody(req, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.error).toBe("VALIDATION_ERROR");
      expect(json.details).toBeDefined();
      expect(json.details.fieldErrors).toBeDefined();
    }
  });

  it("returns 400 VALIDATION_ERROR for extra fields (passthrough not applied)", async () => {
    const strictSchema = z.object({ name: z.string() }).strict();
    const req = jsonRequest({ name: "Bob", extra: true });
    const result = await parseBody(req, strictSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it("returns 400 VALIDATION_ERROR for missing required fields", async () => {
    const req = jsonRequest({ name: "Alice" }); // age missing
    const result = await parseBody(req, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const json = await result.response.json();
      expect(json.error).toBe("VALIDATION_ERROR");
    }
  });

  it("works with union schemas", async () => {
    const unionSchema = z.union([
      z.object({ type: z.literal("a"), value: z.string() }),
      z.object({ type: z.literal("b"), count: z.number() }),
    ]);

    const req = jsonRequest({ type: "a", value: "hello" });
    const result = await parseBody(req, unionSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ type: "a", value: "hello" });
    }
  });

  it("returns 400 INVALID_JSON for empty body", async () => {
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
    });
    const result = await parseBody(req, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.error).toBe("INVALID_JSON");
    }
  });
});
