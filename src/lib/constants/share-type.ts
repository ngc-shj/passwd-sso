import type { ShareType } from "@prisma/client";

import { MS_PER_DAY, MS_PER_HOUR } from "./time";

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
  "1h": MS_PER_HOUR,
  "1d": MS_PER_DAY,
  "7d": 7 * MS_PER_DAY,
  "30d": 30 * MS_PER_DAY,
};
