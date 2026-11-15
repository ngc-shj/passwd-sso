/**
 * The integration suite's sink for RLS bypass reports. setup.ts registers it
 * before any pool exists; every report a test causes lands here, never thrown
 * into the production code that issued the statement (a `.catch` there could
 * swallow it), and setup.ts's afterEach fails the test unless the cell took
 * the reports: WARNINGs with expectBypassNotices, refusals with
 * expectBypassRefusal or expectSwallowedBypassRefusal.
 *
 * Warnings and refusals are kept apart, as `{ table, purpose }`: a refusal
 * cell asserts on each signal separately, and the refusal is the one that
 * still arrives when the WARNING is suppressed.
 */
import { BYPASS_REPORT_KIND, type BypassNotice } from "@/lib/db/pool-factory";

export type BypassReport = Omit<BypassNotice, "kind">;

const warnings: BypassReport[] = [];
const refusals: BypassReport[] = [];

export function bypassNoticeBuffer(): BypassReport[] {
  return warnings;
}

export function bypassRefusalBuffer(): BypassReport[] {
  return refusals;
}

export function recordBypassNotice({ kind, table, purpose }: BypassNotice): void {
  (kind === BYPASS_REPORT_KIND.REFUSAL ? refusals : warnings).push({ table, purpose });
}

const describeReports = (reports: BypassReport[]): string =>
  reports.map((r) => `${r.table} (purpose ${r.purpose})`).join(", ");

/** Empty both buffers, and fail if either held a report no cell took. */
export function failOnReports(when: string): void {
  const reports = warnings.splice(0);
  const refused = refusals.splice(0);
  const problems: string[] = [];
  if (reports.length > 0) {
    problems.push(
      `RLS bypass reached tables outside its grant ${when}: ${describeReports(reports)}. ` +
        "Add the table to the grant the code passes, or take the report with expectBypassNotices.",
    );
  }
  if (refused.length > 0) {
    problems.push(
      `RLS bypass refusals were counted ${when} and not taken: ${describeReports(refused)}. ` +
        "Take a refusal the code under test throws with expectBypassRefusal, or one it catches itself with expectSwallowedBypassRefusal.",
    );
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}
