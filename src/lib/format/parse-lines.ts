/** One value per line; surrounding whitespace (including a CRLF's `\r`) and blank lines are dropped. */
export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
