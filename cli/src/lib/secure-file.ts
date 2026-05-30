/**
 * Symlink-safe file I/O for secret material (credentials, decrypted exports).
 *
 * O_NOFOLLOW refuses to follow a symlink at the final path component, closing
 * the symlink / check-then-write TOCTOU window that plain writeFileSync/
 * readFileSync leave open. Used wherever the CLI persists or reads secrets.
 */

import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  constants as fsConstants,
} from "node:fs";

/** Write `data` to `path` with O_NOFOLLOW + the given mode (default 0600). */
export function writeSecretFile(
  path: string,
  data: string,
  mode = 0o600,
): void {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    // codeql[js/network-data-written-to-file] secrets are intentionally persisted
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Read `path` with O_NOFOLLOW (refuses a symlinked final component). */
export function readSecretFile(
  path: string,
  encoding: BufferEncoding = "utf-8",
): string {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return readFileSync(fd, encoding);
  } finally {
    closeSync(fd);
  }
}
