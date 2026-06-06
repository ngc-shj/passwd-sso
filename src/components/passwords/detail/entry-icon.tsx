"use client";

import {
  FileText,
  CreditCard,
  IdCard,
  Fingerprint,
  Landmark,
  KeySquare,
} from "lucide-react";
import { Favicon } from "../shared/favicon";
import { ENTRY_TYPE } from "@/lib/constants";

interface EntryIconProps {
  entryType?: string;
  urlHost: string | null;
  /** Icon edge size in px (lucide + favicon both honor it). Default 16 (compact row). */
  size?: number;
  className?: string;
}

/**
 * Per-entry-type icon (or favicon for login/url entries). Shared by the compact row
 * (PasswordRow) and the detail-pane header so the type→icon mapping lives in ONE place
 * (commonization / INV-C6.4 — same rationale as EntrySecondaryLine).
 */
export function EntryIcon({ entryType = ENTRY_TYPE.LOGIN, urlHost, size = 16, className }: EntryIconProps) {
  const px = `${size}px`;
  const style = { width: px, height: px };

  switch (entryType) {
    case ENTRY_TYPE.BANK_ACCOUNT:
      return <Landmark style={style} className={className} />;
    case ENTRY_TYPE.SOFTWARE_LICENSE:
      return <KeySquare style={style} className={className} />;
    case ENTRY_TYPE.PASSKEY:
      return <Fingerprint style={style} className={className} />;
    case ENTRY_TYPE.IDENTITY:
      return <IdCard style={style} className={className} />;
    case ENTRY_TYPE.CREDIT_CARD:
      return <CreditCard style={style} className={className} />;
    case ENTRY_TYPE.SECURE_NOTE:
      return <FileText style={style} className={className} />;
    default:
      return <Favicon host={urlHost} size={size} className={className} />;
  }
}
