/**
 * The integration suite's sink for RLS bypass reports. setup.ts registers it
 * before any pool exists; every report a test causes lands here, never thrown
 * into the production code that issued the statement (a `.catch` there could
 * swallow it), and setup.ts's afterEach fails the test unless the cell took
 * the reports with expectBypassNotices.
 */
import type { BypassNotice } from "@/lib/db/pool-factory";

const buffer: BypassNotice[] = [];

export function bypassNoticeBuffer(): BypassNotice[] {
  return buffer;
}

export function recordBypassNotice(notice: BypassNotice): void {
  buffer.push(notice);
}
