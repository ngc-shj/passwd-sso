/**
 * Symlink-safe file I/O for the E2E auth-state file (holds session tokens).
 * O_NOFOLLOW refuses a symlinked final path component, closing the symlink /
 * TOCTOU window plain writeFileSync/readFileSync leave open.
 */
import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  constants as fsConstants,
} from "node:fs";

export function writeSecretFile(path: string, data: string, mode = 0o600): void {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export function readSecretFile(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}
