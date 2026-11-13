import { describe, it, expect, vi } from "vitest";
import { parseJsonBodyOnce, readApiErrorBody } from "../../lib/api-error-body.js";

describe("api-error-body read-once", () => {
  it("returns the same body when readApiErrorBody is called twice on one Response", async () => {
    const res = new Response(JSON.stringify({ error: "TEAM_BUSY" }), { status: 409 });
    expect(await readApiErrorBody(res)).toEqual({ error: "TEAM_BUSY" });
    expect(await readApiErrorBody(res)).toEqual({ error: "TEAM_BUSY" });
  });

  it("calls json() once for the same object and parses distinct objects separately", async () => {
    const jsonA = vi.fn().mockResolvedValue({ error: "A" });
    const jsonB = vi.fn().mockResolvedValue({ error: "B" });
    const a = { json: jsonA } as unknown as Response;
    const b = { json: jsonB } as unknown as Response;
    await parseJsonBodyOnce(a);
    await parseJsonBodyOnce(a);
    expect(await parseJsonBodyOnce(b)).toEqual({ error: "B" });
    expect(jsonA).toHaveBeenCalledTimes(1);
    expect(jsonB).toHaveBeenCalledTimes(1);
  });

  it("resolves null for an unparseable body instead of rejecting", async () => {
    await expect(
      parseJsonBodyOnce(new Response("not-json", { status: 500 })),
    ).resolves.toBeNull();
  });
});
