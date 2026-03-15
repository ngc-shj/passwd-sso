import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseResponse } from "@/__tests__/helpers/request-builder";

const mockAuthOrToken = vi.hoisted(() => vi.fn());
const mockBuildOpenApiSpec = vi.hoisted(() =>
  vi.fn(() => ({ openapi: "3.1.0", info: { title: "test", version: "1.0" } }))
);

vi.mock("@/lib/auth-or-token", () => ({
  authOrToken: mockAuthOrToken,
}));

vi.mock("@/lib/openapi-spec", () => ({
  buildOpenApiSpec: mockBuildOpenApiSpec,
}));

const URL = "http://localhost:3000/api/v1/openapi.json";

describe("GET /api/v1/openapi.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe("when OPENAPI_PUBLIC is not set (default: public)", () => {
    it("returns 200 without auth", async () => {
      const { GET } = await import("@/app/api/v1/openapi.json/route");

      const req = createRequest("GET", URL);
      const res = await GET(req);
      const { status, json } = await parseResponse(res);

      expect(status).toBe(200);
      expect(json.openapi).toBe("3.1.0");
      expect(mockAuthOrToken).not.toHaveBeenCalled();
    });

    it("returns Cache-Control: public with Vary: Authorization", async () => {
      const { GET } = await import("@/app/api/v1/openapi.json/route");

      const req = createRequest("GET", URL);
      const res = await GET(req);

      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
      expect(res.headers.get("Vary")).toBe("Authorization");
    });
  });

  describe("when OPENAPI_PUBLIC=false (auth required)", () => {
    beforeEach(() => {
      vi.stubEnv("OPENAPI_PUBLIC", "false");
    });

    it("returns 401 when not authenticated", async () => {
      mockAuthOrToken.mockResolvedValue(null);
      const { GET } = await import("@/app/api/v1/openapi.json/route");

      const req = createRequest("GET", URL);
      const res = await GET(req);
      const { status, json } = await parseResponse(res);

      expect(status).toBe(401);
      expect(json.error).toBe("UNAUTHORIZED");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns 200 with private, no-store when authenticated", async () => {
      mockAuthOrToken.mockResolvedValue({
        type: "session",
        userId: "user-1",
      });
      const { GET } = await import("@/app/api/v1/openapi.json/route");

      const req = createRequest("GET", URL);
      const res = await GET(req);
      const { status, json } = await parseResponse(res);

      expect(status).toBe(200);
      expect(json.openapi).toBe("3.1.0");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Vary")).toBeNull();
    });
  });
});
