/**
 * scripts/lib/scram-verifier.mjs against RFC 7677 §3 — both halves of the
 * verifier, each checked the way the server uses it — plus the iteration
 * resolution, the refusals and the CLI.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_SCRAM_ITERATIONS,
  resolveIterations,
  scramSha256Verifier,
} from "../lib/scram-verifier.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "lib", "scram-verifier.mjs");

// RFC 7677 §3: user "user", password "pencil". The AuthMessage is written out
// rather than rebuilt, so a reconstruction slip cannot pass for a helper bug.
const RFC = {
  password: "pencil",
  salt: Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"),
  iterations: 4096,
  authMessage:
    "n=user,r=rOprNGfwEbeRWgbNEkqO," +
    "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096," +
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0",
  clientProof: Buffer.from("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=", "base64"),
  serverSignature: "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
};

const parse = (verifier) => {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (!m) throw new Error(`not a verifier: ${verifier}`);
  return {
    iterations: Number(m[1]),
    salt: Buffer.from(m[2], "base64"),
    storedKey: Buffer.from(m[3], "base64"),
    serverKey: Buffer.from(m[4], "base64"),
  };
};

const rfcVerifier = () =>
  parse(scramSha256Verifier(RFC.password, { iterations: RFC.iterations, salt: RFC.salt }));

describe("scramSha256Verifier against RFC 7677", () => {
  it("ServerKey signs the RFC's AuthMessage into its ServerSignature", () => {
    const { serverKey } = rfcVerifier();
    expect(createHmac("sha256", serverKey).update(RFC.authMessage).digest("base64"))
      .toBe(RFC.serverSignature);
  });

  it("StoredKey verifies the RFC's ClientProof the way the server does", () => {
    const { storedKey } = rfcVerifier();
    const signature = createHmac("sha256", storedKey).update(RFC.authMessage).digest();
    const clientKey = Buffer.from(RFC.clientProof.map((b, i) => b ^ signature[i]));
    expect(createHash("sha256").update(clientKey).digest().equals(storedKey)).toBe(true);
  });

  it("writes the pg_authid format: iterations, 16-byte salt, two 32-byte keys", () => {
    const v = scramSha256Verifier("a", { iterations: 4096 });
    const p = parse(v);
    expect(p.iterations).toBe(4096);
    expect(p.salt).toHaveLength(16);
    expect(p.storedKey).toHaveLength(32);
    expect(p.serverKey).toHaveLength(32);
  });

  it("draws a fresh salt per call", () => {
    expect(scramSha256Verifier("a", { iterations: 4096 }))
      .not.toBe(scramSha256Verifier("a", { iterations: 4096 }));
  });

  it.each([
    ["quotes", `it's"q`],
    ["a dollar and a backslash", "pa$$\\word"],
    ["a TAB", "tab\there"],
  ])("accepts an ASCII password with %s", (_name, password) => {
    expect(scramSha256Verifier(password, { iterations: 4096 })).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it.each([
    ["an empty password", "", 4096, "empty"],
    ["a non-ASCII password", "pé", 4096, "non-ASCII"],
    ["iterations below the floor", "a", 4095, "iterations"],
    ["non-integer iterations", "a", 4096.5, "iterations"],
  ])("refuses %s", (_name, password, iterations, reason) => {
    expect(() => scramSha256Verifier(password, { iterations })).toThrow(reason);
  });
});

describe("resolveIterations", () => {
  it.each([
    [null, 4096],
    ["", 4096],
    ["1000", 4096],
    ["4096", 4096],
    ["10000", 10000],
    [String(MAX_SCRAM_ITERATIONS), MAX_SCRAM_ITERATIONS],
  ])("maps the server value %j to %d", (server, expected) => {
    expect(resolveIterations(server)).toBe(expected);
  });

  it.each([
    String(MAX_SCRAM_ITERATIONS + 1),
    "abc",
    " 4096",
    "-1",
    "4096.0",
  ])("refuses %j", (server) => {
    expect(() => resolveIterations(server)).toThrow();
  });
});

describe("CLI", () => {
  const cli = (input, ...args) =>
    spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", timeout: 10_000 });

  it("reads stdin verbatim: a trailing LF is part of the password", () => {
    const r = cli("pencil\n", "--iterations", "4096");
    expect(r.status, r.stderr).toBe(0);
    const v = r.stdout.trim();
    const { salt } = parse(v);
    expect(v).toBe(scramSha256Verifier("pencil\n", { iterations: 4096, salt }));
    expect(v).not.toBe(scramSha256Verifier("pencil", { iterations: 4096, salt }));
  });

  it("resolves the server value it is given", () => {
    const r = cli("pencil", "--iterations", "");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it.each([
    ["a non-ASCII password", "s3ntinel-é", ["--iterations", "4096"]],
    ["an empty password", "", ["--iterations", "4096"]],
    ["a malformed server value", "s3ntinel", ["--iterations", "s3ntinel-iter"]],
    ["no --iterations", "s3ntinel", []],
  ])("refuses %s, printing only the reason", (_name, input, args) => {
    const r = cli(input, ...args);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^scram-verifier: /);
    expect(r.stderr).not.toContain("s3ntinel");
  });
});
