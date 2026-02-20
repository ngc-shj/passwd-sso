import type { ShareType } from "@prisma/client";

export const SHARE_TYPE = {
  ENTRY_SHARE: "ENTRY_SHARE",
  TEXT: "TEXT",
  FILE: "FILE",
} as const satisfies Record<ShareType, ShareType>;

export type ShareTypeValue = (typeof SHARE_TYPE)[keyof typeof SHARE_TYPE];

export const SHARE_TYPE_VALUES = [
  SHARE_TYPE.ENTRY_SHARE,
  SHARE_TYPE.TEXT,
  SHARE_TYPE.FILE,
] as const;

/** Millisecond durations for Send expiry options. */
export const SEND_EXPIRY_MAP: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
