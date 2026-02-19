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
