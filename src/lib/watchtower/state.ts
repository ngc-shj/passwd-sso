export interface CooldownState {
  nextAllowedAt: number | null;
  cooldownRemainingMs: number;
  canAnalyze: boolean;
}

export function getCooldownState(
  lastAnalyzedAt: number | null,
  now: number,
  loading: boolean,
  cooldownMs: number
): CooldownState {
  const nextAllowedAt = lastAnalyzedAt ? lastAnalyzedAt + cooldownMs : null;
  const cooldownRemainingMs = nextAllowedAt
    ? Math.max(0, nextAllowedAt - now)
    : 0;
  return {
    nextAllowedAt,
    cooldownRemainingMs,
    canAnalyze: !loading && cooldownRemainingMs === 0,
  };
}

export function calculateTotalIssues(report: {
  breached: { length: number };
  weak: { length: number };
  reused: { entries: unknown[] }[];
  old: { length: number };
  unsecured: { length: number };
  duplicate: { entries: unknown[] }[];
  expiring: { length: number };
}): number {
  return (
    report.breached.length +
    report.weak.length +
    report.reused.reduce((sum, group) => sum + group.entries.length, 0) +
    report.old.length +
    report.unsecured.length +
    report.duplicate.reduce((sum, group) => sum + group.entries.length, 0) +
    report.expiring.length
  );
}

export function getWatchtowerVisibility(
  report: { totalPasswords: number } | null,
  loading: boolean,
  totalIssues: number
) {
  return {
    showRunHint: !report && !loading,
    showIssueSections: !!report && !loading && report.totalPasswords > 0,
    showNoIssuesCard:
      !!report &&
      !loading &&
      totalIssues === 0 &&
      report.totalPasswords > 0,
    showEmptyVault: !!report && !loading && report.totalPasswords === 0,
  };
}
