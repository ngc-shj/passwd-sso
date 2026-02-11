import type { EntryType } from "@prisma/client";

export const ENTRY_TYPE = {
  LOGIN: "LOGIN",
  SECURE_NOTE: "SECURE_NOTE",
  CREDIT_CARD: "CREDIT_CARD",
  IDENTITY: "IDENTITY",
  PASSKEY: "PASSKEY",
} as const satisfies Record<EntryType, EntryType>;

/** Prisma EntryType に寄せる。独自型は作らない。 */
export type EntryTypeValue = EntryType;

/** Zod 用タプル */
export const ENTRY_TYPE_VALUES = [
  ENTRY_TYPE.LOGIN,
  ENTRY_TYPE.SECURE_NOTE,
  ENTRY_TYPE.CREDIT_CARD,
  ENTRY_TYPE.IDENTITY,
  ENTRY_TYPE.PASSKEY,
] as const;
