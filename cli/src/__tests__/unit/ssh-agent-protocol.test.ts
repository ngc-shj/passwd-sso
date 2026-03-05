import { describe, it, expect } from "vitest";
import {
  readUint32,
  writeUint32,
  readString,
  encodeString,
  frameMessage,
  buildFailure,
  buildIdentitiesAnswer,
  buildSignResponse,
  SSH2_AGENT_FAILURE,
  SSH2_AGENT_IDENTITIES_ANSWER,
  SSH2_AGENT_SIGN_RESPONSE,
} from "../../lib/ssh-agent-protocol";

describe("readUint32 / writeUint32", () => {
  it("round-trips uint32 values", () => {
    const buf = Buffer.alloc(4);
    writeUint32(buf, 0, 0x01020304);
    expect(readUint32(buf, 0)).toBe(0x01020304);
  });

  it("handles zero", () => {
    const buf = Buffer.alloc(4);
    writeUint32(buf, 0, 0);
    expect(readUint32(buf, 0)).toBe(0);
  });

  it("handles max uint32", () => {
    const buf = Buffer.alloc(4);
    writeUint32(buf, 0, 0xffffffff);
    expect(readUint32(buf, 0)).toBe(0xffffffff);
  });

  it("reads at offset", () => {
    const buf = Buffer.alloc(8);
    writeUint32(buf, 4, 42);
    expect(readUint32(buf, 4)).toBe(42);
  });
});

describe("encodeString / readString", () => {
  it("round-trips string data", () => {
    const encoded = encodeString("hello");
    const { data, nextOffset } = readString(encoded, 0);
    expect(data.toString()).toBe("hello");
    expect(nextOffset).toBe(9); // 4 + 5
  });

  it("round-trips Buffer data", () => {
    const input = Buffer.from([0x01, 0x02, 0x03]);
    const encoded = encodeString(input);
    const { data, nextOffset } = readString(encoded, 0);
    expect(Buffer.compare(data, input)).toBe(0);
    expect(nextOffset).toBe(7); // 4 + 3
  });

  it("handles empty string", () => {
    const encoded = encodeString("");
    const { data, nextOffset } = readString(encoded, 0);
    expect(data.length).toBe(0);
    expect(nextOffset).toBe(4);
  });
});

describe("frameMessage", () => {
  it("prepends 4-byte length", () => {
    const body = Buffer.from([0x01, 0x02]);
    const framed = frameMessage(body);
    expect(framed.length).toBe(6);
    expect(readUint32(framed, 0)).toBe(2);
    expect(framed[4]).toBe(0x01);
    expect(framed[5]).toBe(0x02);
  });
});

describe("buildFailure", () => {
  it("returns framed failure message", () => {
    const msg = buildFailure();
    expect(readUint32(msg, 0)).toBe(1); // body length
    expect(msg[4]).toBe(SSH2_AGENT_FAILURE);
  });
});

describe("buildIdentitiesAnswer", () => {
  it("encodes empty key list", () => {
    const msg = buildIdentitiesAnswer([]);
    expect(msg[4]).toBe(SSH2_AGENT_IDENTITIES_ANSWER);
    expect(readUint32(msg, 5)).toBe(0); // nkeys = 0
  });

  it("encodes single key", () => {
    const blob = Buffer.from("ssh-ed25519-key");
    const msg = buildIdentitiesAnswer([
      { publicKeyBlob: blob, comment: "test" },
    ]);
    expect(msg[4]).toBe(SSH2_AGENT_IDENTITIES_ANSWER);
    expect(readUint32(msg, 5)).toBe(1); // nkeys = 1
  });

  it("encodes multiple keys", () => {
    const keys = [
      { publicKeyBlob: Buffer.from("key1"), comment: "first" },
      { publicKeyBlob: Buffer.from("key2"), comment: "second" },
    ];
    const msg = buildIdentitiesAnswer(keys);
    expect(readUint32(msg, 5)).toBe(2); // nkeys = 2
  });
});

describe("buildSignResponse", () => {
  it("returns framed sign response", () => {
    const sig = Buffer.from("signature-data");
    const msg = buildSignResponse(sig);
    expect(msg[4]).toBe(SSH2_AGENT_SIGN_RESPONSE);
    // After type byte, there should be an encoded string (the signature)
    const sigLen = readUint32(msg, 5);
    expect(sigLen).toBe(sig.length);
  });
});
