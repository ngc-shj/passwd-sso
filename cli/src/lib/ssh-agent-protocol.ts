/**
 * SSH agent protocol constants and framing helpers.
 *
 * Implements the subset of the SSH agent protocol needed for key listing
 * and signing operations. Reference: draft-miller-ssh-agent.
 */

// ─── Message types ────────────────────────────────────────────

/** Client → Agent */
export const SSH2_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH2_AGENTC_SIGN_REQUEST = 13;

/** Agent → Client */
export const SSH2_AGENT_FAILURE = 5;
export const SSH2_AGENT_IDENTITIES_ANSWER = 12;
export const SSH2_AGENT_SIGN_RESPONSE = 14;

// ─── Signature algorithm flags (SSH2_AGENTC_SIGN_REQUEST flags field) ─

export const SSH_AGENT_RSA_SHA2_256 = 2;
export const SSH_AGENT_RSA_SHA2_512 = 4;

// ─── Framing helpers (pure functions) ─────────────────────────

/**
 * Read a uint32-be from buffer at offset.
 */
export function readUint32(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

/**
 * Write a uint32-be into buffer at offset.
 */
export function writeUint32(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt32BE(value, offset);
}

/**
 * Read an SSH "string" (uint32 length + data) from buffer at offset.
 * Returns the data slice and the new offset after the string.
 */
export function readString(
  buf: Buffer,
  offset: number,
): { data: Buffer; nextOffset: number } {
  const len = readUint32(buf, offset);
  const data = buf.subarray(offset + 4, offset + 4 + len);
  return { data, nextOffset: offset + 4 + len };
}

/**
 * Build an SSH "string" (uint32 length prefix + data).
 */
export function encodeString(data: Buffer | string): Buffer {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  const result = Buffer.alloc(4 + buf.length);
  result.writeUInt32BE(buf.length, 0);
  buf.copy(result, 4);
  return result;
}

/**
 * Wrap a message body with the 4-byte length prefix.
 */
export function frameMessage(body: Buffer): Buffer {
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Build an SSH_AGENT_FAILURE response.
 */
export function buildFailure(): Buffer {
  const body = Buffer.alloc(1);
  body[0] = SSH2_AGENT_FAILURE;
  return frameMessage(body);
}

/**
 * Build an SSH2_AGENT_IDENTITIES_ANSWER response.
 *
 * @param keys Array of { publicKeyBlob, comment } pairs
 */
export function buildIdentitiesAnswer(
  keys: { publicKeyBlob: Buffer; comment: string }[],
): Buffer {
  // Calculate total size: 1 (type) + 4 (nkeys) + per-key data
  let size = 1 + 4;
  for (const key of keys) {
    size += 4 + key.publicKeyBlob.length; // string: public key blob
    size += 4 + Buffer.byteLength(key.comment); // string: comment
  }

  const body = Buffer.alloc(size);
  let offset = 0;

  body[offset++] = SSH2_AGENT_IDENTITIES_ANSWER;
  body.writeUInt32BE(keys.length, offset);
  offset += 4;

  for (const key of keys) {
    body.writeUInt32BE(key.publicKeyBlob.length, offset);
    offset += 4;
    key.publicKeyBlob.copy(body, offset);
    offset += key.publicKeyBlob.length;

    const commentBuf = Buffer.from(key.comment);
    body.writeUInt32BE(commentBuf.length, offset);
    offset += 4;
    commentBuf.copy(body, offset);
    offset += commentBuf.length;
  }

  return frameMessage(body);
}

/**
 * Build an SSH2_AGENT_SIGN_RESPONSE.
 */
export function buildSignResponse(signature: Buffer): Buffer {
  // SSH2_AGENT_SIGN_RESPONSE: byte(14) + string(signature_blob)
  const sigString = encodeString(signature);
  const body = Buffer.alloc(1 + sigString.length);
  body[0] = SSH2_AGENT_SIGN_RESPONSE;
  sigString.copy(body, 1);
  return frameMessage(body);
}
