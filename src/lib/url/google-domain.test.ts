import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("parseAllowedGoogleDomains", () => {
  const original = process.env.GOOGLE_WORKSPACE_DOMAINS;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.GOOGLE_WORKSPACE_DOMAINS;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.GOOGLE_WORKSPACE_DOMAINS;
    } else {
      process.env.GOOGLE_WORKSPACE_DOMAINS = original;
    }
  });

  async function parse() {
    const { parseAllowedGoogleDomains } = await import("./google-domain");
    return parseAllowedGoogleDomains();
  }

  it("returns empty array when env is unset", async () => {
    expect(await parse()).toEqual([]);
  });

  it("returns empty array when env is empty string", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = "";
    expect(await parse()).toEqual([]);
  });

  it("returns empty array when env is whitespace only", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = "   ";
    expect(await parse()).toEqual([]);
  });

  it("parses single domain", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = "example.com";
    expect(await parse()).toEqual(["example.com"]);
  });

  it("parses multiple comma-separated domains", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = "example.com,example.co.jp";
    expect(await parse()).toEqual(["example.com", "example.co.jp"]);
  });

  it("trims whitespace around domains", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = " example.com , example.co.jp ";
    expect(await parse()).toEqual(["example.com", "example.co.jp"]);
  });

  it("filters empty entries from trailing comma", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = "example.com,";
    expect(await parse()).toEqual(["example.com"]);
  });

  it("filters empty entries from leading comma", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = ",example.com";
    expect(await parse()).toEqual(["example.com"]);
  });

  it("filters empty entries from consecutive commas", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = "example.com,,example.co.jp";
    expect(await parse()).toEqual(["example.com", "example.co.jp"]);
  });

  it("lowercases domain values", async () => {
    process.env.GOOGLE_WORKSPACE_DOMAINS = "Example.COM,EXAMPLE.Co.Jp";
    expect(await parse()).toEqual(["example.com", "example.co.jp"]);
  });
});
