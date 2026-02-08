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
  const { length, uppercase, lowercase, numbers, symbols, excludeAmbiguous } = options;
  const filter = excludeAmbiguous ? filterAmbiguous : (s: string) => s;

  let charset = "";
  const required: string[] = [];

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
  const bytes = randomBytes(4);
  const value = bytes.readUInt32BE(0);
  return value % max;
}
