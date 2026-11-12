import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { onRedirectRefused } from "../../lib/redirect-refusal.js";

// A real local server: the matcher keys off undici's own rejection shape, which
// a mocked fetch would only restate.
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(308, { Location: "https://elsewhere.example/" });
    } else if (req.url === "/drop") {
      req.socket.destroy();
      return;
    } else {
      res.writeHead(200);
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("onRedirectRefused", () => {
  it("names the server and the fix when a credential-bearing request is redirected", async () => {
    const url = `${origin}/redirect`;
    const err = await fetch(url, { redirect: "error" }).catch(onRedirectRefused(url)).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`The server at ${origin} redirected the request`);
    expect((err as Error).message).toContain("passwd-sso login --server <url>");
  });

  it("passes any other network error through unchanged", async () => {
    // The same server drops the connection: a network error that is not a redirect.
    const url = `${origin}/drop`;
    const err = await fetch(url, { redirect: "error" }).catch(onRedirectRefused(url)).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe("fetch failed");
  });

  it("leaves a non-redirect response untouched", async () => {
    const url = `${origin}/ok`;
    const res = await fetch(url, { redirect: "error" }).catch(onRedirectRefused(url));

    expect(res.status).toBe(200);
  });
});
