/**
 * Per-signature confirmation gate for SSH keys with requireReprompt = true.
 *
 * When a key entry requires confirmation, this module prompts the user on the
 * controlling terminal before each signature. If no TTY is available the
 * request is denied (fail-closed) with a logged explanation.
 *
 * Precedent: unlock.ts uses process.stdin.isTTY for the same TTY-detection
 * pattern. Prompt and isTTY are injectable via deps so tests need no real TTY.
 */

import { createInterface } from "node:readline";

/**
 * Optional dependency overrides, primarily for testing.
 */
export interface ConfirmDeps {
  /** Override for process.stdin.isTTY */
  isTTY?: boolean;
  /** Override for the readline prompt function */
  prompt?: (question: string) => Promise<string>;
}

/**
 * Ask the user to confirm an SSH signing operation on the controlling TTY.
 *
 * Returns true only when the user explicitly answers "y" or "yes"
 * (case-insensitive). Any other answer, Ctrl-C, or absence of a TTY → false.
 */
export async function confirmSign(
  keyLabel: string,
  deps?: ConfirmDeps,
): Promise<boolean> {
  const hasTTY = deps?.isTTY ?? process.stdin.isTTY;

  if (!hasTTY) {
    process.stderr.write(
      `SSH signing with "${keyLabel}" requires confirmation but no TTY is available. ` +
      "Run the agent in the foreground (not via eval) to allow per-key confirmation.\n",
    );
    return false;
  }

  const promptFn = deps?.prompt ?? defaultPrompt;
  const answer = await promptFn(`Allow SSH signing with "${keyLabel}"? [y/N] `);
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
}

/**
 * Default readline-based prompt over process.stdin / process.stdout.
 * Mirrors the pattern used in unlock.ts (readPassphrase).
 */
function defaultPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
