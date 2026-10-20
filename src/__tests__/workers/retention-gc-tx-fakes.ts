/**
 * Test-support fakes for the retention-gc sweeps' tagged-template reads.
 *
 * Every sweep that takes a tx reads the bypass state first (assertSweepBypass,
 * sweep.ts), and the audit emit reads it again (enqueueAuditInWorkerTx) —
 * both through the single `readBypassState` query (tenant-rls-grants.ts),
 * which selects bypass_rls, purpose, tenant_id and tables in one statement.
 * That statement's text is identical for every caller, so the fakes can no
 * longer tell assert's read from enqueue's by SQL text; they answer in CALL
 * ORDER instead — assert's read is always first within one transaction.
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

export interface QueryRawAnswers {
  /** bypass_rls the FIRST bypass-state read (assertSweepBypass) returns. */
  bypass: string | null;
  /** bypass_rls a SECOND bypass-state read (enqueueAuditInWorkerTx) returns; defaults to `bypass`. */
  enqueueBypass?: string | null;
  /** Rows for any other $queryRaw (e.g. the audit_log_purge call). */
  other?: unknown[];
}

/**
 * A `$queryRaw` that answers each bypass-state read by call order (the first
 * is assertSweepBypass's, any later one is enqueueAuditInWorkerTx's) and
 * anything else by its SQL text.
 */
export function makeQueryRaw(answers: QueryRawAnswers) {
  let bypassReads = 0;
  return vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = sqlText(strings);
    if (isBypassStateRead(text)) {
      bypassReads += 1;
      const bypassRls = bypassReads === 1 ? answers.bypass : answers.enqueueBypass ?? answers.bypass;
      return [{ bypass_rls: bypassRls, purpose: null, tenant_id: null, tables: null }];
    }
    if (text.includes("SELECT EXISTS")) return [{ ok: true }];
    return answers.other ?? [];
  });
}

/** The bypass_rls value an entry's declared state reads under the dispatcher. */
export function declaredBypass(entry: { globalDelete?: true }): string | null {
  return entry.globalDelete === true ? "on" : null;
}
