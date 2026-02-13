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

  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof (body as { transformToByteArray: () => Promise<Uint8Array> })
      .transformToByteArray === "function"
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes);
  }

  if (
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body
  ) {
    return readAsyncIterable(body as AsyncIterable<unknown>);
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "getReader" in body &&
    typeof (body as { getReader: () => ReadableStreamDefaultReader<Uint8Array> })
      .getReader === "function"
  ) {
    return readWebStream(body as ReadableStream<Uint8Array>);
  }

  throw new Error("Unsupported object body type");
}
