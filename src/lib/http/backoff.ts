import { MS_PER_SECOND, MS_PER_HOUR } from "@/lib/constants/time";

export function computeBackoffMs(
  attempt: number,
  opts?: { baseMs?: number; capMs?: number },
): number {
  const baseMs = opts?.baseMs ?? MS_PER_SECOND;
  const capMs = opts?.capMs ?? MS_PER_HOUR;
  return Math.min(baseMs * Math.pow(2, attempt), capMs);
}

export function withFullJitter(ms: number): number {
  return Math.random() * ms;
}
