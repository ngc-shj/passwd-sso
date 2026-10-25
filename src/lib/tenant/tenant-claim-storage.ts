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
 *
 * `provider` is the Auth.js provider id that presented the claim, set together
 * with it (plan sso-claim-connection-binding, C5): createUser decides the
 * claim's binding against it and refuses a claim that arrives without one.
 * Required in the type, so every literal store states it.
 */
interface TenantClaimStore {
  tenantClaim: string | null;
  provider: string | null;
}

export const tenantClaimStorage = new AsyncLocalStorage<TenantClaimStore>();
