import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  verifyTailscalePeer,
  _clearWhoIsCache,
  _extractTailnetFromFqdn,
} from "./tailscale-client";

describe("_extractTailnetFromFqdn", () => {
  it("extracts the tailnet from a typical Tailscale FQDN with trailing dot", () => {
    expect(
      _extractTailnetFromFqdn("hostname.example-tailnet.ts.net."),
    ).toBe("example-tailnet");
  });

  it("extracts the tailnet without a trailing dot", () => {
    expect(_extractTailnetFromFqdn("hostname.example-tailnet.ts.net")).toBe(
      "example-tailnet",
    );
  });

  it("lowercases the result", () => {
    expect(_extractTailnetFromFqdn("HOST.MyTailnet.TS.NET")).toBe("mytailnet");
  });

  it("returns null when the FQDN does not end in ts.net", () => {
    expect(_extractTailnetFromFqdn("hostname.tailnet.example.com")).toBeNull();
  });

  it("returns null when there are too few segments", () => {
    expect(_extractTailnetFromFqdn("ts.net")).toBeNull();
  });
});

describe("verifyTailscalePeer (TCP fallback path)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _clearWhoIsCache();
    // Force TCP mode so we never touch a Unix socket in tests.
    vi.stubEnv("TAILSCALE_API_BASE", "http://127.0.0.1:41112");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    _clearWhoIsCache();
  });

  it("returns false for an IP outside the Tailscale CGNAT range without calling fetch", async () => {
    const result = await verifyTailscalePeer("8.8.8.8", "tn.example");
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns false for a malformed IP (validation guard) without calling fetch", async () => {
    const result = await verifyTailscalePeer("not-an-ip", "tn.example");
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns true when the WhoIs FQDN tailnet matches the expected tailnet", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          Node: { Name: "host1.my-tailnet.ts.net." },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await verifyTailscalePeer("100.64.0.5", "my-tailnet");
    expect(result).toBe(true);
  });

  it("returns false when the WhoIs FQDN tailnet does not match", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ Node: { Name: "host1.other-tailnet.ts.net." } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await verifyTailscalePeer("100.64.0.5", "my-tailnet");
    expect(result).toBe(false);
  });

  it("returns false when WhoIs returns 5xx", async () => {
    fetchSpy.mockResolvedValue(new Response("err", { status: 500 }));
    const result = await verifyTailscalePeer("100.64.0.6", "my-tailnet");
    expect(result).toBe(false);
  });

  it("returns false when WhoIs has no Node.Name", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await verifyTailscalePeer("100.64.0.7", "my-tailnet");
    expect(result).toBe(false);
  });

  it("caches the result so a second call does not refetch", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ Node: { Name: "h.my-tailnet.ts.net." } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const ip = "100.64.0.8";
    const a = await verifyTailscalePeer(ip, "my-tailnet");
    const b = await verifyTailscalePeer(ip, "my-tailnet");
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("compares the cached tailnet against the (lowercased) expectedTailnet", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ Node: { Name: "h.cached-net.ts.net." } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const ip = "100.64.0.9";
    expect(await verifyTailscalePeer(ip, "Cached-Net")).toBe(true);
    // Different expected name must yield false even when cached
    expect(await verifyTailscalePeer(ip, "another-net")).toBe(false);
  });

  it("returns false when the network call rejects", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const result = await verifyTailscalePeer("100.64.0.10", "my-tailnet");
    expect(result).toBe(false);
  });
});
