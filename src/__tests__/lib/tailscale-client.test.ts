import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  verifyTailscalePeer,
  _extractTailnetFromFqdn,
  _clearWhoIsCache,
} from "@/lib/services/tailscale-client";

describe("_extractTailnetFromFqdn", () => {
  it("extracts tailnet from standard FQDN", () => {
    expect(_extractTailnetFromFqdn("myhost.example-corp.ts.net.")).toBe(
      "example-corp",
    );
  });

  it("handles FQDN without trailing dot", () => {
    expect(_extractTailnetFromFqdn("myhost.example-corp.ts.net")).toBe(
      "example-corp",
    );
  });

  it("normalizes to lowercase", () => {
    expect(_extractTailnetFromFqdn("MyHost.Example-Corp.TS.NET.")).toBe(
      "example-corp",
    );
  });

  it("returns null for too few segments", () => {
    expect(_extractTailnetFromFqdn("ts.net.")).toBeNull();
  });

  it("returns null for non-ts.net domain", () => {
    expect(_extractTailnetFromFqdn("myhost.example.com")).toBeNull();
  });

  it("extracts a dotted, domain-verified tailnet name in full", () => {
    // A domain-verified Tailscale org's tailnet name is its domain, so it
    // must not be truncated to the single label before "ts.net".
    expect(_extractTailnetFromFqdn("laptop.example.com.ts.net.")).toBe(
      "example.com",
    );
  });

  it("folds extra leading hostname labels into the tailnet (fails closed, not a crash)", () => {
    // Tailscale machine names are single-label, so the leading boundary is
    // fixed at exactly one label. A two-label node name folds its second
    // label into the extracted tailnet, which denies (no configured
    // tailnet matches the garbled value) rather than misparsing silently.
    expect(_extractTailnetFromFqdn("a.b.my-tailnet.ts.net.")).toBe(
      "b.my-tailnet",
    );
  });
});

describe("verifyTailscalePeer", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _clearWhoIsCache();
    // Force TCP fallback so fetch mock works (Unix socket path is skipped)
    vi.stubEnv("TAILSCALE_API_BASE", "http://127.0.0.1:41112");
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("returns false for non-Tailscale IP", async () => {
    const result = await verifyTailscalePeer("192.168.1.1", "my-tailnet");
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns false for invalid IP format", async () => {
    const result = await verifyTailscalePeer("not-an-ip", "my-tailnet");
    expect(result).toBe(false);
  });

  it("returns true when tailnet matches", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Node: { Name: "myhost.my-tailnet.ts.net." },
        }),
        { status: 200 },
      ),
    );

    const result = await verifyTailscalePeer("100.64.0.1", "my-tailnet");
    expect(result).toBe(true);
  });

  it("returns false when tailnet does not match", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Node: { Name: "myhost.other-tailnet.ts.net." },
        }),
        { status: 200 },
      ),
    );

    const result = await verifyTailscalePeer("100.64.0.1", "my-tailnet");
    expect(result).toBe(false);
  });

  it("returns false when tailscaled returns error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const result = await verifyTailscalePeer("100.64.0.1", "my-tailnet");
    expect(result).toBe(false);
  });

  it("returns false when fetch throws (tailscaled unreachable)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await verifyTailscalePeer("100.64.0.1", "my-tailnet");
    expect(result).toBe(false);
  });

  it("returns false when Node.Name is missing", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ Node: {} }), { status: 200 }),
    );

    const result = await verifyTailscalePeer("100.64.0.1", "my-tailnet");
    expect(result).toBe(false);
  });

  it("uses cache on second call", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          Node: { Name: "myhost.my-tailnet.ts.net." },
        }),
        { status: 200 },
      ),
    );

    await verifyTailscalePeer("100.64.0.1", "my-tailnet");
    await verifyTailscalePeer("100.64.0.1", "my-tailnet");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("compares tailnet case-insensitively", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Node: { Name: "myhost.My-Tailnet.ts.net." },
        }),
        { status: 200 },
      ),
    );

    const result = await verifyTailscalePeer("100.64.0.1", "My-Tailnet");
    expect(result).toBe(true);
  });

  it("does not let a dotted tailnet's last label satisfy an unrelated policy", async () => {
    // Regression guard for the old parts[length-3] truncation: a policy of
    // "com" must not match a peer whose real tailnet is "example.com".
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Node: { Name: "myhost.example.com.ts.net." },
        }),
        { status: 200 },
      ),
    );

    const result = await verifyTailscalePeer("100.64.0.1", "com");
    expect(result).toBe(false);
  });
});

