async function readWebStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function readAsyncIterable(
  source: AsyncIterable<unknown>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const part of source) {
    chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export async function streamBodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new Error("Object body is empty");

  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);

  if (typeof body !== "object") throw new Error("Unsupported object body type");
  const obj = body as Record<string | symbol, unknown>;

  // The AWS SDK v3 body exposes transformToByteArray. Called on its own object
  // rather than through a cast, so no own type is asserted onto a library value.
  const transformToByteArray = obj.transformToByteArray;
  if (typeof transformToByteArray === "function") {
    const bytes = (await transformToByteArray.call(obj)) as Uint8Array;
    return Buffer.from(bytes);
  }

  if (Symbol.asyncIterator in obj) {
    return readAsyncIterable(obj as unknown as AsyncIterable<unknown>);
  }

  if ("getReader" in obj && typeof obj.getReader === "function") {
    return readWebStream(obj as unknown as ReadableStream<Uint8Array>);
  }

  throw new Error("Unsupported object body type");
}
