import { AsyncLocalStorage } from "node:async_hooks";

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
}

export const sessionMetaStorage = new AsyncLocalStorage<SessionMeta>();
