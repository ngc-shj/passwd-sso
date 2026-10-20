/**
 * Test-support fakes for the retention-gc sweeps' tagged-template reads.
 *
 * Every sweep that takes a tx reads the bypass state first (assertSweepBypass,
 * sweep.ts), and the audit emit reads it again (enqueueAuditInWorkerTx) —
 * both through the single `readBypassState` query (tenant-rls-grants.ts),
 * which selects bypass_rls, purpose, tenant_id and tables in one statement.
 *
 * The fake holds those four GUCs as state, as the transaction does: a
 * `set_config` written through `$executeRaw` updates it, and every read answers
 * all four columns from it. So a test cannot pass because a read moved, and a
 * guard's allow arm (e.g. bypass off with a matching tenant id) is reachable.
 */

import { vi } from "vitest";

export function sqlText(strings: unknown): string {
  return Array.isArray(strings) ? (strings as readonly string[]).join("") : String(strings);
}

/** readBypassState's query: the one statement every bypass-state read issues. */
export function isBypassStateRead(text: string): boolean {
  return text.includes("current_setting('app.bypass_rls'");
}

export function isBypassSetConfig(text: string): boolean {
  return /set_config\(\s*'app\.bypass_rls'/.test(text);
}

/** The four GUCs readBypassState reads, as the transaction holds them. */
export interface GucState {
  bypass_rls: string | null;
  purpose: string | null;
  tenant_id: string | null;
  tables: string | null;
}

const GUC_COLUMN: Record<string, keyof GucState> = {
  "app.bypass_rls": "bypass_rls",
  "app.bypass_purpose": "purpose",
  "app.tenant_id": "tenant_id",
  "app.bypass_tables": "tables",
};

/**
 * Apply every `set_config('<guc>', <value>, true)` in one tagged-template call
 * to `state`: `$` takes the next bound value, a quoted literal its text.
 */
export function applySetConfigs(state: GucState, strings: TemplateStringsArray, values: unknown[]): void {
  const queue = [...values];
  for (const m of strings.join("$").matchAll(/set_config\(\s*'([^']+)'\s*,\s*(\$|'[^']*')\s*,\s*true\s*\)/g)) {
    const column = GUC_COLUMN[m[1]];
    const value = m[2] === "$" ? queue.shift() : m[2].slice(1, -1);
    if (column) state[column] = value === undefined || value === null ? null : String(value);
  }
}

/**
 * A transaction's GUC-touching surface: `$executeRaw` applies set_config
 * writes to the state, and `$queryRaw` answers readBypassState from it (and
 * the tenant-exists check with ok, anything else with `other`).
 */
export function makeGucTx(initial: Partial<GucState> = {}, other: unknown[] = []) {
  const state: GucState = { bypass_rls: null, purpose: null, tenant_id: null, tables: null, ...initial };
  const executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    applySetConfigs(state, strings, values);
    return 0;
  });
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = sqlText(strings);
    if (isBypassStateRead(text)) return [{ ...state }];
    if (text.includes("SELECT EXISTS")) return [{ ok: true }];
    return other;
  });
  return { state, executeRaw, queryRaw };
}

/** The bypass_rls value an entry's declared state reads under the dispatcher. */
export function declaredBypass(entry: { globalDelete?: true }): string | null {
  return entry.globalDelete === true ? "on" : null;
}
