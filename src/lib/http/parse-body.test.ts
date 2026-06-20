import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  parseBody,
  readJsonWithCap,
  readBytesWithCap,
  readFormWithCap,
  rejectOversizedMultipart,
  exceedsDeclaredContentLength,
} from "./parse-body";

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
      expect(json.details.properties).toBeDefined();
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

  it("rejects request with content-length over default cap → 413 PAYLOAD_TOO_LARGE", async () => {
    const defaultCap = 1_048_576; // MAX_JSON_BODY_BYTES
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(defaultCap + 1),
      },
      body: JSON.stringify({ name: "Alice", age: 30 }),
    });
    const result = await parseBody(req, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      const json = await result.response.json();
      expect(json.error).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("accepts request when content-length header is absent (stream still capped)", async () => {
    // No Content-Length — stream cap still applies but small payload passes
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice", age: 30 }),
    });
    const result = await parseBody(req, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    }
  });

  it("accepts request with content-length under cap", async () => {
    const body = JSON.stringify({ name: "Alice", age: 30 });
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
    });
    const result = await parseBody(req, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    }
  });

  it("accepts large body when maxBytes override is set", async () => {
    // Build a body larger than 1 MB (default cap) but under the override
    const bigString = "x".repeat(2_000_000); // 2 MB string value
    const largeSchema = z.object({ data: z.string() });
    const bodyStr = JSON.stringify({ data: bigString });

    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    });
    const result = await parseBody(req, largeSchema, { maxBytes: 4 * 1024 * 1024 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.data.length).toBe(2_000_000);
    }
  });

  it("rejects large body without content-length via stream cap (chunked-TE bypass guard)", async () => {
    // 2 MB body with no Content-Length header — stream cap must still fire
    const bigString = "x".repeat(2_000_000);
    const largeSchema = z.object({ data: z.string() });
    const bodyStr = JSON.stringify({ data: bigString });

    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    });
    // Use default 1 MB cap — 2 MB body should be rejected
    const result = await parseBody(req, largeSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      const json = await result.response.json();
      expect(json.error).toBe("PAYLOAD_TOO_LARGE");
    }
  });
});

describe("readJsonWithCap", () => {
  it("returns tooLarge when content-length exceeds cap", async () => {
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "1000",
      },
      body: JSON.stringify({ foo: "bar" }),
    });
    const result = await readJsonWithCap(req, 500);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tooLarge).toBe(true);
    }
  });

  it("returns parsed body when within cap", async () => {
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });
    const result = await readJsonWithCap(req, 1024);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toEqual({ foo: "bar" });
    }
  });
});

describe("readBytesWithCap", () => {
  it("returns the raw bytes when within the cap", async () => {
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      body: "hello",
    });
    const result = await readBytesWithCap(req, 1024);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.bytes)).toBe("hello");
    }
  });

  it("rejects via streaming cap when no content-length is present (chunked-TE bypass guard)", async () => {
    const big = "x".repeat(2_000_000);
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: big,
    });
    const result = await readBytesWithCap(req, 1_048_576);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tooLarge).toBe(true);
    }
  });

  it("rejects early when content-length declares over the cap", async () => {
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "Content-Length": "2000" },
      body: "small",
    });
    const result = await readBytesWithCap(req, 1000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tooLarge).toBe(true);
    }
  });

  it("reports noStream (not tooLarge) when the body stream is absent", async () => {
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
    });
    const result = await readBytesWithCap(req, 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tooLarge).toBeUndefined();
      expect(result.noStream).toBe(true);
    }
  });
});

describe("readFormWithCap", () => {
  it("decodes a urlencoded body within the cap", async () => {
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "a=1&b=two",
    });
    const result = await readFormWithCap(req, 1024);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const params = new URLSearchParams(result.text);
      expect(params.get("a")).toBe("1");
      expect(params.get("b")).toBe("two");
    }
  });

  it("rejects an oversized form body via the streaming cap", async () => {
    const big = "k=" + "v".repeat(2_000_000);
    const req = new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: big,
    });
    const result = await readFormWithCap(req, 1_048_576);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tooLarge).toBe(true);
    }
  });
});

describe("rejectOversizedMultipart", () => {
  function multipartReq(contentLength: string | null): NextRequest {
    const headers: Record<string, string> = {
      "Content-Type": "multipart/form-data; boundary=x",
    };
    if (contentLength !== null) headers["Content-Length"] = contentLength;
    return new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers,
      body: "--x--",
    });
  }

  it("returns a 413 when content-length is absent (fail-closed)", () => {
    const res = rejectOversizedMultipart(multipartReq(null), 1000);
    expect(res?.status).toBe(413);
  });

  it("returns a 413 when content-length exceeds the cap", () => {
    const res = rejectOversizedMultipart(multipartReq("2000"), 1000);
    expect(res?.status).toBe(413);
  });

  it("returns a 413 for a non-numeric content-length", () => {
    const res = rejectOversizedMultipart(multipartReq("not-a-number"), 1000);
    expect(res?.status).toBe(413);
  });

  it("returns null (proceed) when content-length is within the cap", () => {
    expect(rejectOversizedMultipart(multipartReq("500"), 1000)).toBeNull();
  });

  it("returns null when content-length equals the cap", () => {
    expect(rejectOversizedMultipart(multipartReq("1000"), 1000)).toBeNull();
  });
});

describe("exceedsDeclaredContentLength", () => {
  function reqWithContentLength(value: string | null): NextRequest {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (value !== null) headers["Content-Length"] = value;
    return new NextRequest("http://localhost:3000/api/test", {
      method: "POST",
      headers,
      body: "{}",
    });
  }

  it("returns false when the content-length header is absent", () => {
    expect(exceedsDeclaredContentLength(reqWithContentLength(null), 100)).toBe(false);
  });

  it("returns false when the declared length is under the cap", () => {
    expect(exceedsDeclaredContentLength(reqWithContentLength("50"), 100)).toBe(false);
  });

  it("returns false when the declared length equals the cap", () => {
    expect(exceedsDeclaredContentLength(reqWithContentLength("100"), 100)).toBe(false);
  });

  it("returns true when the declared length exceeds the cap", () => {
    expect(exceedsDeclaredContentLength(reqWithContentLength("101"), 100)).toBe(true);
  });

  it("returns false for a non-numeric (garbage) header", () => {
    expect(exceedsDeclaredContentLength(reqWithContentLength("not-a-number"), 100)).toBe(false);
  });
});
