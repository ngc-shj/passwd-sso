export function computeBackoffMs(
  attempt: number,
  opts?: { baseMs?: number; capMs?: number },
): number {
  const baseMs = opts?.baseMs ?? 1000;
  const capMs = opts?.capMs ?? 3_600_000;
  return Math.min(baseMs * Math.pow(2, attempt), capMs);
}

export function withFullJitter(ms: number): number {
  return Math.random() * ms;
}
