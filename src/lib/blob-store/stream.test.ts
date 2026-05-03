import { describe, it, expect } from "vitest";
import { streamBodyToBuffer } from "./stream";

describe("streamBodyToBuffer", () => {
  it("returns a Buffer untouched when the body is already a Buffer", async () => {
    const input = Buffer.from("hello", "utf8");
    const result = await streamBodyToBuffer(input);
    expect(result).toBe(input);
  });

  it("converts a Uint8Array body to a Buffer with the same bytes", async () => {
    const input = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const result = await streamBodyToBuffer(input);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(true);
  });

  it("uses transformToByteArray when present (AWS SDK shape)", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const body = {
      transformToByteArray: async () => bytes,
    };
    const result = await streamBodyToBuffer(body);
    expect(result.equals(Buffer.from(bytes))).toBe(true);
  });

  it("reads from an AsyncIterable of Buffer chunks", async () => {
    const chunks = [Buffer.from("foo"), Buffer.from("bar")];
    const body = {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c;
      },
    };
    const result = await streamBodyToBuffer(body);
    expect(result.toString("utf8")).toBe("foobar");
  });

  it("reads from an AsyncIterable of Uint8Array chunks", async () => {
    const body = {
      [Symbol.asyncIterator]: async function* () {
        yield new Uint8Array([0x68, 0x69]); // "hi"
        yield new Uint8Array([0x21]); // "!"
      },
    };
    const result = await streamBodyToBuffer(body);
    expect(result.toString("utf8")).toBe("hi!");
  });

  it("reads from a Web ReadableStream<Uint8Array>", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61])); // "a"
        controller.enqueue(new Uint8Array([0x62, 0x63])); // "bc"
        controller.close();
      },
    });
    const result = await streamBodyToBuffer(stream);
    expect(result.toString("utf8")).toBe("abc");
  });

  it("throws when the body is null/undefined", async () => {
    await expect(streamBodyToBuffer(null)).rejects.toThrow(/empty/i);
    await expect(streamBodyToBuffer(undefined)).rejects.toThrow(/empty/i);
  });

  it("throws on non-object primitive body", async () => {
    await expect(streamBodyToBuffer(42)).rejects.toThrow(/Unsupported/i);
  });

  it("throws on a plain object that has no recognized stream interface", async () => {
    await expect(streamBodyToBuffer({ foo: "bar" })).rejects.toThrow(
      /Unsupported/i,
    );
  });
});
