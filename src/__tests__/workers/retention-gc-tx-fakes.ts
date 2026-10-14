/**
 * Test-support fakes for the retention-gc sweeps' tagged-template reads.
 *
 * Every sweep that takes a tx reads `current_setting('app.bypass_rls', true)`
 * first (assertSweepBypass, sweep.ts), and the audit emit reads it again
 * together with `app.tenant_id` (enqueueAuditInWorkerTx). The fakes answer by
 * the SQL text, not by call order, so a test cannot pass because a read moved.
 */

import { vi } from "vitest";

export function sqlText(strings: unknown): string {
  return Array.isArray(strings) ? (strings as readonly string[]).join("") : String(strings);
}

/** enqueueAuditInWorkerTx's read: selects bypass_rls AND tenant_id. */
export function isEnqueueContextRead(text: string): boolean {
  return text.includes("current_setting('app.bypass_rls'") && text.includes("app.tenant_id");
}

/** assertSweepBypass's read: selects bypass_rls only. */
export function isAssertRead(text: string): boolean {
  return text.includes("current_setting('app.bypass_rls'") && !text.includes("app.tenant_id");
}

export function isBypassSetConfig(text: string): boolean {
  return /set_config\(\s*'app\.bypass_rls'/.test(text);
}

export interface QueryRawAnswers {
  /** bypass_rls the assert's read returns. */
  bypass: string | null;
  /** bypass_rls enqueue's read returns; defaults to `bypass`. */
  enqueueBypass?: string | null;
  /** Rows for any other $queryRaw (e.g. the audit_log_purge call). */
  other?: unknown[];
}

/** A `$queryRaw` that answers each read by its SQL text. */
export function makeQueryRaw(answers: QueryRawAnswers) {
  return vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = sqlText(strings);
    if (isEnqueueContextRead(text)) {
      return [{ bypass_rls: answers.enqueueBypass === undefined ? answers.bypass : answers.enqueueBypass, tenant_id: "" }];
    }
    if (isAssertRead(text)) return [{ bypass_rls: answers.bypass }];
    if (text.includes("SELECT EXISTS")) return [{ ok: true }];
    return answers.other ?? [];
  });
}

/** The bypass_rls value an entry's declared state reads under the dispatcher. */
export function declaredBypass(entry: { globalDelete?: true }): string | null {
  return entry.globalDelete === true ? "on" : null;
}
