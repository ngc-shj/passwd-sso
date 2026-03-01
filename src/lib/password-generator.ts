import { randomBytes } from "node:crypto";
import { AMBIGUOUS_CHARS } from "./generator-prefs";
import { WORDLIST } from "./wordlist";

export interface GeneratorOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: string;
  excludeAmbiguous?: boolean;
  includeChars?: string;
  excludeChars?: string;
}

const CHARSETS = {
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  numbers: "0123456789",
} as const;

function filterAmbiguous(chars: string): string {
  return chars
    .split("")
    .filter((c) => !AMBIGUOUS_CHARS.includes(c))
    .join("");
}

export function generatePassword(options: GeneratorOptions): string {
  const {
    length,
    uppercase,
    lowercase,
    numbers,
    symbols,
    excludeAmbiguous,
    includeChars = "",
    excludeChars = "",
  } = options;
  const filter = excludeAmbiguous ? filterAmbiguous : (s: string) => s;
  const excludeSet = excludeChars.length > 0 ? new Set(excludeChars) : null;

  const required: string[] = [];

  // Build charset per type and guarantee one from each enabled type
  let charset = "";
  if (uppercase) {
    const chars = filter(CHARSETS.uppercase);
    charset += chars;
    if (chars.length > 0) required.push(randomChar(chars));
  }
  if (lowercase) {
    const chars = filter(CHARSETS.lowercase);
    charset += chars;
    if (chars.length > 0) required.push(randomChar(chars));
  }
  if (numbers) {
    const chars = filter(CHARSETS.numbers);
    charset += chars;
    if (chars.length > 0) required.push(randomChar(chars));
  }
  if (symbols.length > 0) {
    const chars = filter(symbols);
    charset += chars;
    if (chars.length > 0) required.push(randomChar(chars));
  }

  // Add includeChars to charset (unique chars not already present)
  if (includeChars.length > 0) {
    const uniqueInclude = [...new Set(includeChars)].join("");
    for (const ch of uniqueInclude) {
      if (!charset.includes(ch)) charset += ch;
    }
    // Guarantee one character from includeChars in required
    if (uniqueInclude.length > 0) {
      required.push(randomChar(uniqueInclude));
    }
  }

  // Remove excludeChars from charset and required
  if (excludeSet) {
    charset = charset
      .split("")
      .filter((c) => !excludeSet.has(c))
      .join("");
    for (let i = required.length - 1; i >= 0; i--) {
      if (excludeSet.has(required[i])) {
        required.splice(i, 1);
      }
    }
  }

  if (charset.length === 0) {
    throw new Error("At least one character type must be selected");
  }

  // Fill remaining length with random characters from full charset
  const remaining = length - required.length;
  const chars = [...required];
  for (let i = 0; i < remaining; i++) {
    chars.push(randomChar(charset));
  }

  // Shuffle using Fisher-Yates with crypto random
  for (let i = chars.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

// ─── Passphrase Generation ──────────────────────────────────

export interface PassphraseOptions {
  wordCount: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export function generatePassphrase(options: PassphraseOptions): string {
  const { wordCount, separator, capitalize, includeNumber } = options;

  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    let word = WORDLIST[secureRandomInt(WORDLIST.length)];
    if (capitalize) {
      word = word.charAt(0).toUpperCase() + word.slice(1);
    }
    words.push(word);
  }

  if (includeNumber) {
    const pos = secureRandomInt(words.length + 1);
    const num = secureRandomInt(100).toString();
    words.splice(pos, 0, num);
  }

  return words.join(separator);
}

// ─── Helpers ────────────────────────────────────────────────

function randomChar(charset: string): string {
  const index = secureRandomInt(charset.length);
  return charset[index];
}

function secureRandomInt(max: number): number {
  if (max <= 0 || max > 0x100000000) throw new RangeError("max must be in (0, 2^32]");
  // Rejection sampling to eliminate modulo bias.
  const limit = Math.floor(0x100000000 / max) * max;
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return value % max;
}
