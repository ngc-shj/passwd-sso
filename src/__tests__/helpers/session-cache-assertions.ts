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
 *
 * Optional `dbSpy` (a spy on the DB-write call) enforces the sequencing
 * invariant from §S-6: the cache invalidation MUST run AFTER the DB
 * write, never speculatively before. Pass it whenever both spies are
 * accessible so a future reorder regression is caught at the helper.
 */
export function expectInvalidatedAfterCommit(
  invalidateSpy: Mock,
  expectedTokens: ReadonlyArray<string>,
  dbSpy?: Mock,
): void {
  expect(invalidateSpy).toHaveBeenCalledTimes(1);
  expect(invalidateSpy).toHaveBeenCalledWith(
    expect.arrayContaining([...expectedTokens]),
  );
  if (dbSpy !== undefined) {
    expect(dbSpy).toHaveBeenCalled();
    const dbOrder = dbSpy.mock.invocationCallOrder[0];
    const invalidateOrder = invalidateSpy.mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeGreaterThan(dbOrder);
  }
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
