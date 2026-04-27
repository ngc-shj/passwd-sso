import type { Mock } from "vitest";
import { expect } from "vitest";

/**
 * Shared assertions for the 9 session-mutation sites that must invalidate
 * the Redis-backed session cache after a successful DB delete (R3 sweep).
 *
 * Plan: docs/archive/review/sessioncache-redesign-plan.md §C3 + step 8.
 */

/**
 * Asserts that `invalidateCachedSessions` was called exactly once with a
 * token list that contains every expected token. Use after a positive
 * (DB-delete-succeeded) path.
 */
export function expectInvalidatedAfterCommit(
  invalidateSpy: Mock,
  expectedTokens: ReadonlyArray<string>,
): void {
  expect(invalidateSpy).toHaveBeenCalledTimes(1);
  expect(invalidateSpy).toHaveBeenCalledWith(
    expect.arrayContaining([...expectedTokens]),
  );
}

/**
 * Asserts that `invalidateCachedSessions` was NOT called. Use after a
 * negative path where the DB delete threw / rolled back — the sequencing
 * invariant requires invalidation to run AFTER a successful commit, never
 * speculatively before.
 */
export function expectNotInvalidatedOnDbThrow(invalidateSpy: Mock): void {
  expect(invalidateSpy).not.toHaveBeenCalled();
}
