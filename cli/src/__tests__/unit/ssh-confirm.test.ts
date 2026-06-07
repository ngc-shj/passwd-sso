/**
 * Tests for ssh-confirm.ts
 *
 * Injects isTTY and prompt dependencies to avoid needing a real TTY in CI.
 */

import { describe, it, expect } from "vitest";
import { confirmSign } from "../../lib/ssh-confirm.js";

const KEY_LABEL = "deploy@prod";

function makePrompt(answer: string) {
  return (_q: string) => Promise.resolve(answer);
}

describe("confirmSign — TTY present", () => {
  it("returns true when user answers 'y'", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt("y"),
    });
    expect(result).toBe(true);
  });

  it("returns true when user answers 'yes'", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt("yes"),
    });
    expect(result).toBe(true);
  });

  it("returns true when user answers 'Y' (case-insensitive)", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt("Y"),
    });
    expect(result).toBe(true);
  });

  it("returns true when user answers 'YES'", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt("YES"),
    });
    expect(result).toBe(true);
  });

  it("returns false when user answers 'n'", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt("n"),
    });
    expect(result).toBe(false);
  });

  it("returns false when user answers 'no'", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt("no"),
    });
    expect(result).toBe(false);
  });

  it("returns false when user hits Enter without typing (empty answer)", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt(""),
    });
    expect(result).toBe(false);
  });

  it("returns false for a non-yes answer 'ok'", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt("ok"),
    });
    expect(result).toBe(false);
  });

  it("trims whitespace from the answer before comparing", async () => {
    const result = await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: makePrompt("  y  "),
    });
    expect(result).toBe(true);
  });
});

describe("confirmSign — no TTY", () => {
  it("returns false when isTTY is false", async () => {
    const result = await confirmSign(KEY_LABEL, { isTTY: false });
    expect(result).toBe(false);
  });

  it("does not call the prompt function when no TTY", async () => {
    let prompted = false;
    await confirmSign(KEY_LABEL, {
      isTTY: false,
      prompt: (_q) => {
        prompted = true;
        return Promise.resolve("y");
      },
    });
    expect(prompted).toBe(false);
  });
});

describe("confirmSign — prompt question format", () => {
  it("includes the key label in the question", async () => {
    let capturedQuestion = "";
    await confirmSign(KEY_LABEL, {
      isTTY: true,
      prompt: (q) => {
        capturedQuestion = q;
        return Promise.resolve("n");
      },
    });
    expect(capturedQuestion).toContain(KEY_LABEL);
    expect(capturedQuestion).toContain("[y/N]");
  });
});
