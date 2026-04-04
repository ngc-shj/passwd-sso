/**
 * Output formatting for CLI display.
 */

import chalk from "chalk";
import Table from "cli-table3";

export function success(message: string): void {
  console.log(chalk.green(`✓ ${message}`));
}

export function error(message: string): void {
  console.error(chalk.red(`✗ ${message}`));
}

export function warn(message: string): void {
  console.error(chalk.yellow(`! ${message}`));
}

export function info(message: string): void {
  console.log(chalk.blue(`ℹ ${message}`));
}

export function table(
  headers: string[],
  rows: string[][],
): void {
  const t = new Table({
    head: headers.map((h) => chalk.cyan(h)),
    style: { head: [], border: [] },
  });
  for (const row of rows) {
    t.push(row);
  }
  console.log(t.toString());
}

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function masked(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}
