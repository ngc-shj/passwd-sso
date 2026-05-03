import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  jcsCanonical,
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
  type ChainInput,
} from "./audit-chain";

describe("jcsCanonical — primitives", () => {
  it("serializes null", () => {
    expect(jcsCanonical(null)).toBe("null");
  });

  it("serializes booleans", () => {
    expect(jcsCanonical(true)).toBe("true");
    expect(jcsCanonical(false)).toBe("false");
  });

  it("serializes strings with JSON.stringify", () => {
    expect(jcsCanonical("hello")).toBe('"hello"');
    expect(jcsCanonical("with \"quotes\"")).toBe('"with \\"quotes\\""');
  });

  it("serializes finite numbers", () => {
    expect(jcsCanonical(42)).toBe("42");
    expect(jcsCanonical(0)).toBe("0");
    expect(jcsCanonical(-1.5)).toBe("-1.5");
  });

  it("throws on Infinity", () => {
    expect(() => jcsCanonical(Infinity)).toThrow(/non-finite/);
  });

  it("throws on -Infinity", () => {
    expect(() => jcsCanonical(-Infinity)).toThrow(/non-finite/);
  });

  it("throws on NaN", () => {
    expect(() => jcsCanonical(NaN)).toThrow(/non-finite/);
  });
});

describe("jcsCanonical — arrays", () => {
  it("serializes empty array", () => {
    expect(jcsCanonical([])).toBe("[]");
  });

  it("serializes flat array preserving order", () => {
    expect(jcsCanonical([3, 1, 2])).toBe("[3,1,2]");
  });

  it("serializes nested array", () => {
    expect(jcsCanonical([[1], [2, 3]])).toBe("[[1],[2,3]]");
  });
});

describe("jcsCanonical — objects (key sorting)", () => {
  it("sorts keys alphabetically", () => {
    expect(jcsCanonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("produces identical output regardless of insertion order", () => {
    const a = jcsCanonical({ z: 1, a: 2, m: 3 });
    const b = jcsCanonical({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
  });

  it("recursively sorts nested object keys", () => {
    expect(jcsCanonical({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("drops keys whose values are undefined", () => {
    expect(jcsCanonical({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it("serializes empty object", () => {
    expect(jcsCanonical({})).toBe("{}");
  });
});

describe("jcsCanonical — unsupported types", () => {
  it("throws on BigInt", () => {
    expect(() => jcsCanonical(1n)).toThrow(/unsupported type bigint/);
  });

  it("throws on symbol", () => {
    expect(() => jcsCanonical(Symbol("x"))).toThrow(/unsupported type symbol/);
  });

  it("throws on function", () => {
    expect(() => jcsCanonical(() => 1)).toThrow(/unsupported type function/);
  });
});

describe("buildChainInput", () => {
  it("normalizes Date to ISO 8601 with Z suffix", () => {
    const input = buildChainInput({
      id: "id-1",
      createdAt: new Date("2026-01-15T12:34:56.789Z"),
      chainSeq: 5n,
      prevHash: Buffer.alloc(32, 0xab),
      payload: { foo: "bar" },
    });
    expect(input.createdAt).toBe("2026-01-15T12:34:56.789Z");
    expect(input.createdAt).toMatch(/Z$/);
  });

  it("serializes chainSeq bigint as base-10 string", () => {
    const input = buildChainInput({
      id: "id-1",
      createdAt: new Date(0),
      chainSeq: 9007199254740993n, // > Number.MAX_SAFE_INTEGER
      prevHash: Buffer.from([0x00]),
      payload: {},
    });
    expect(input.chainSeq).toBe("9007199254740993");
  });

  it("encodes prevHash as lowercase hex", () => {
    const input = buildChainInput({
      id: "id-1",
      createdAt: new Date(0),
      chainSeq: 1n,
      prevHash: Buffer.from([0xab, 0xcd, 0xef]),
      payload: {},
    });
    expect(input.prevHash).toBe("abcdef");
  });

  it("preserves payload reference (no clone)", () => {
    const payload = { a: 1 };
    const input = buildChainInput({
      id: "id-1",
      createdAt: new Date(0),
      chainSeq: 1n,
      prevHash: Buffer.from([0x00]),
      payload,
    });
    expect(input.payload).toBe(payload);
  });

  it("handles 1-byte genesis prevHash", () => {
    const input = buildChainInput({
      id: "id-1",
      createdAt: new Date(0),
      chainSeq: 1n,
      prevHash: Buffer.from([0x00]),
      payload: {},
    });
    expect(input.prevHash).toBe("00");
  });
});

describe("computeCanonicalBytes", () => {
  it("returns a Buffer of UTF-8 JCS bytes", () => {
    const input: ChainInput = {
      id: "id-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      chainSeq: "1",
      prevHash: "00",
      payload: { b: 2, a: 1 },
    };
    const bytes = computeCanonicalBytes(input);
    expect(bytes).toBeInstanceOf(Buffer);
    // Top-level keys must be sorted: chainSeq < createdAt < id < payload < prevHash
    expect(bytes.toString("utf-8")).toBe(
      '{"chainSeq":"1","createdAt":"2026-01-01T00:00:00.000Z","id":"id-1","payload":{"a":1,"b":2},"prevHash":"00"}',
    );
  });

  it("produces identical bytes for identical inputs (determinism)", () => {
    const input: ChainInput = {
      id: "id-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      chainSeq: "1",
      prevHash: "00",
      payload: { x: 1 },
    };
    expect(computeCanonicalBytes(input).equals(computeCanonicalBytes(input))).toBe(true);
  });
});

describe("computeEventHash", () => {
  it("returns SHA-256 over prevHash || canonicalBytes (32 bytes)", () => {
    const prev = Buffer.from([0x00]);
    const canonical = Buffer.from('{"a":1}', "utf-8");
    const hash = computeEventHash(prev, canonical);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash.length).toBe(32);

    const expected = createHash("sha256").update(prev).update(canonical).digest();
    expect(hash.equals(expected)).toBe(true);
  });

  it("differs when prevHash changes (chain continuity)", () => {
    const canonical = Buffer.from('{"a":1}', "utf-8");
    const h1 = computeEventHash(Buffer.from([0x00]), canonical);
    const h2 = computeEventHash(Buffer.from([0x01]), canonical);
    expect(h1.equals(h2)).toBe(false);
  });

  it("differs when canonicalBytes changes (tampering detection)", () => {
    const prev = Buffer.from([0x00]);
    const h1 = computeEventHash(prev, Buffer.from('{"a":1}', "utf-8"));
    const h2 = computeEventHash(prev, Buffer.from('{"a":2}', "utf-8"));
    expect(h1.equals(h2)).toBe(false);
  });
});

describe("chain continuity end-to-end", () => {
  // Build a 3-link chain, then mutate row 2's payload and re-derive row 3's hash
  // from row 2's altered hash — assert it diverges from the recorded next hash.
  it("tamper with one row → next-row recomputed hash diverges", () => {
    const genesis = Buffer.from([0x00]);

    const row1 = buildChainInput({
      id: "id-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      chainSeq: 1n,
      prevHash: genesis,
      payload: { action: "AUTH_LOGIN" },
    });
    const hash1 = computeEventHash(genesis, computeCanonicalBytes(row1));

    const row2 = buildChainInput({
      id: "id-2",
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
      chainSeq: 2n,
      prevHash: hash1,
      payload: { action: "ENTRY_CREATE" },
    });
    const hash2 = computeEventHash(hash1, computeCanonicalBytes(row2));

    const row3 = buildChainInput({
      id: "id-3",
      createdAt: new Date("2026-01-01T00:02:00.000Z"),
      chainSeq: 3n,
      prevHash: hash2,
      payload: { action: "ENTRY_UPDATE" },
    });
    const hash3 = computeEventHash(hash2, computeCanonicalBytes(row3));

    // Tamper with row2's payload while leaving its stored prevHash & seq alone.
    const tamperedRow2 = { ...row2, payload: { action: "EVIL" } };
    const tamperedHash2 = computeEventHash(hash1, computeCanonicalBytes(tamperedRow2));
    expect(tamperedHash2.equals(hash2)).toBe(false);

    // Recompute row3's hash from the tampered hash2 — must diverge from
    // the recorded honest hash3, which is how the verifier detects tampering.
    const recomputedHash3 = computeEventHash(tamperedHash2, computeCanonicalBytes(row3));
    expect(recomputedHash3.equals(hash3)).toBe(false);
  });

  it("clean chain: every row's recomputed hash matches the recorded one", () => {
    const genesis = Buffer.from([0x00]);
    const row1 = buildChainInput({
      id: "id-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      chainSeq: 1n,
      prevHash: genesis,
      payload: { a: 1 },
    });
    const hash1 = computeEventHash(genesis, computeCanonicalBytes(row1));
    const recomputed = computeEventHash(genesis, computeCanonicalBytes(row1));
    expect(recomputed.equals(hash1)).toBe(true);
  });
});
