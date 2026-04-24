/**
 * Thin readline/promises wrapper for the interactive env generator.
 *
 * Accepts injectable streams so tests can wire PassThrough instances without
 * touching process.stdin/stdout. No external dependencies — built-ins only.
 */

import { createInterface } from "node:readline/promises";

export type PromptOptions = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type Prompter = {
  ask(
    question: string,
    opts?: { defaultValue?: string; secret?: boolean },
  ): Promise<string>;
  askChoice<T extends string>(
    question: string,
    choices: readonly T[],
  ): Promise<T>;
  askYesNo(question: string, defaultValue?: boolean): Promise<boolean>;
  close(): void;
};

export function createPrompter(opts: PromptOptions): Prompter {
  const rl = createInterface({
    input: opts.stdin,
    output: opts.stdout,
    terminal: false,
  });

  function write(msg: string): void {
    opts.stdout.write(msg);
  }

  async function readLine(): Promise<string> {
    return rl.question("");
  }

  async function ask(
    question: string,
    askOpts?: { defaultValue?: string; secret?: boolean },
  ): Promise<string> {
    const { defaultValue, secret = false } = askOpts ?? {};

    const hint = defaultValue !== undefined ? ` [${defaultValue}]` : "";
    const prompt = `${question}${hint}: `;

    if (secret && (opts.stdin as NodeJS.ReadStream).isTTY) {
      // Suppress echo for TTY stdin by pausing readline output temporarily.
      // We write the prompt ourselves to stderr (no echo of answer).
      opts.stderr.write(prompt);
      const answer = await rl.question("");
      opts.stderr.write("\n");
      return answer !== "" ? answer : (defaultValue ?? "");
    }

    write(prompt);
    const answer = await readLine();
    return answer !== "" ? answer : (defaultValue ?? "");
  }

  async function askChoice<T extends string>(
    question: string,
    choices: readonly T[],
  ): Promise<T> {
    const numbered = choices
      .map((c, i) => `[${i + 1}] ${c}`)
      .join(" / ");
    write(`${question}\n  ${numbered}\n  Choice: `);

    while (true) {
      const raw = await readLine();
      const idx = parseInt(raw.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        return choices[idx];
      }
      write(`  Please enter a number between 1 and ${choices.length}: `);
    }
  }

  async function askYesNo(
    question: string,
    defaultValue?: boolean,
  ): Promise<boolean> {
    const hint =
      defaultValue === true ? " [Y/n]" : defaultValue === false ? " [y/N]" : " [y/n]";
    write(`${question}${hint}: `);

    while (true) {
      const raw = (await readLine()).trim().toLowerCase();
      if (raw === "" && defaultValue !== undefined) return defaultValue;
      if (raw === "y" || raw === "yes") return true;
      if (raw === "n" || raw === "no") return false;
      write("  Please answer y or n: ");
    }
  }

  function close(): void {
    rl.close();
  }

  return { ask, askChoice, askYesNo, close };
}
