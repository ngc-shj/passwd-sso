/**
 * `passwd-sso generate` — Generate a secure password (offline).
 */

import { randomBytes } from "node:crypto";
import { copyToClipboard } from "../lib/clipboard.js";
import * as output from "../lib/output.js";

const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()_+-=[]{}|;:',.<>?/`~";

export async function generateCommand(options: {
  length?: number;
  noUppercase?: boolean;
  noDigits?: boolean;
  noSymbols?: boolean;
  copy?: boolean;
}): Promise<void> {
  const length = options.length ?? 20;
  if (length < 4 || length > 128) {
    output.error("Length must be between 4 and 128.");
    return;
  }

  let charset = LOWERCASE;
  if (!options.noUppercase) charset += UPPERCASE;
  if (!options.noDigits) charset += DIGITS;
  if (!options.noSymbols) charset += SYMBOLS;

  const password = Array.from({ length }, () => {
    const idx = randomBytes(4).readUInt32BE(0) % charset.length;
    return charset[idx];
  }).join("");

  if (options.copy) {
    await copyToClipboard(password);
    output.success("Password generated and copied to clipboard (auto-clears in 30s).");
  } else {
    console.log(password);
  }
}
