import { describe, it, expect } from "vitest";
import { scimResponse, scimError, scimListResponse } from "./response";

describe("scimResponse", () => {
  it("sets Content-Type to application/scim+json", async () => {
    const res = scimResponse({ ok: true });
    expect(res.headers.get("content-type")).toBe("application/scim+json");
  });

  it("defaults to 200 status", () => {
    const res = scimResponse({ ok: true });
    expect(res.status).toBe(200);
  });

  it("supports custom status", () => {
    const res = scimResponse({ created: true }, 201);
    expect(res.status).toBe(201);
  });
});

describe("scimError", () => {
  it("returns SCIM error format with schemas array", async () => {
    const res = scimError(409, "User exists", "uniqueness");
    const body = await res.json();
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.status).toBe("409");
    expect(body.detail).toBe("User exists");
    expect(body.scimType).toBe("uniqueness");
  });

  it("omits scimType when not provided", async () => {
    const res = scimError(404, "Not found");
    const body = await res.json();
    expect(body.scimType).toBeUndefined();
  });

  it("returns 429 in SCIM error format", async () => {
    const res = scimError(429, "Too many requests");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    expect(body.status).toBe("429");
  });

  it("sets Content-Type to application/scim+json", () => {
    const res = scimError(400, "Bad request");
    expect(res.headers.get("content-type")).toBe("application/scim+json");
  });
});

describe("scimListResponse", () => {
  it("returns ListResponse schema", async () => {
    const res = scimListResponse([{ id: "1" }], 1);
    const body = await res.json();
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
    expect(body.totalResults).toBe(1);
    expect(body.startIndex).toBe(1);
    expect(body.itemsPerPage).toBe(1);
    expect(body.Resources).toHaveLength(1);
  });

  it("respects custom startIndex", async () => {
    const res = scimListResponse([], 0, 5);
    const body = await res.json();
    expect(body.startIndex).toBe(5);
  });
});
