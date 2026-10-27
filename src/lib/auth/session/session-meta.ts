import { AsyncLocalStorage } from "node:async_hooks";

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
  /**
   * Authentication provider for the session being established. Populated by
   * the `signIn` callback via `params.account?.provider`. Read by
   * `auth-adapter.ts createSession` to tag the Session.provider column so
   * downstream code can retain session provenance for policy and audit logic.
   *
   * NOTE: this field is mutated on the shared object held by the surrounding
   * `sessionMetaStorage.run(meta, ...)` call. AsyncLocalStorage returns the
   * same object reference throughout the async chain; that is the contract
   * we rely on.
   */
  provider?: string | null;
  /**
   * Raw tokens of the sessions the browser held under the configured session
   * cookie name when it reached an OAuth/OIDC callback — both CHIPS variants
   * when it holds both. The callback route strips those cookies so Auth.js
   * signs in fresh instead of linking to the signed-in user, and the sign-in
   * response deletes both variants; the sessions they named are deleted
   * inside the transaction that creates the new one
   * (`createSessionUnderConcurrencyCap`), before the concurrent-session cap
   * counts them.
   */
  replacesSessionTokens?: readonly string[];
  /**
   * Raw tokens of every session cookie a sign-out request carried, under any
   * known name. `events.signOut` revokes those that belong to the user Auth.js
   * signed out; Auth.js itself revokes only the first one it reads.
   */
  signOutSessionTokens?: readonly string[];
}

export const sessionMetaStorage = new AsyncLocalStorage<SessionMeta>();
