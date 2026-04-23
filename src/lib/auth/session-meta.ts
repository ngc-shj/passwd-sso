import { AsyncLocalStorage } from "node:async_hooks";

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
  /**
   * Authentication provider for the session being established. Populated by
   * the `signIn` callback via `params.account?.provider`. Read by
   * `auth-adapter.ts createSession` to tag the Session.provider column so
   * the resolver can apply AAL3 clamping for WebAuthn sessions.
   *
   * NOTE: this field is mutated on the shared object held by the surrounding
   * `sessionMetaStorage.run(meta, ...)` call. AsyncLocalStorage returns the
   * same object reference throughout the async chain; that is the contract
   * we rely on.
   */
  provider?: string | null;
}

export const sessionMetaStorage = new AsyncLocalStorage<SessionMeta>();
