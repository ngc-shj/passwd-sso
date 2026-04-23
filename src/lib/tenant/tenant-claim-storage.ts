import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries the extracted tenant claim (e.g. Google Workspace `hd`)
 * from the signIn callback to the createUser adapter method
 * within the same request context.
 *
 * Usage scope: This store is used exclusively on the one-way path
 * `signIn` callback → `createUser` adapter for new OAuth users.
 * The signIn callback writes the claim; createUser reads it.
 * Do not use this store for any other purpose.
 */
interface TenantClaimStore {
  tenantClaim: string | null;
}

export const tenantClaimStorage = new AsyncLocalStorage<TenantClaimStore>();
