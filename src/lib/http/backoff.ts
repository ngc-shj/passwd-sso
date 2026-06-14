import { MS_PER_HOUR } from "@/lib/constants/time";

export function computeBackoffMs(
  attempt: number,
  opts?: { baseMs?: number; capMs?: number },
): number {
  const baseMs = opts?.baseMs ?? 1000;
  const capMs = opts?.capMs ?? MS_PER_HOUR;
  return Math.min(baseMs * Math.pow(2, attempt), capMs);
}

export function withFullJitter(ms: number): number {
  return Math.random() * ms;
}
