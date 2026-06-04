"use client";

import { User } from "lucide-react";
import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { DISPLAY_FINGERPRINT_SHORT } from "@/lib/validations/common";

interface EntrySecondaryLineProps {
  entryType: EntryTypeValue;
  username?: string | null;
  urlHost?: string | null;
  snippet?: string | null;
  brand?: string | null;
  lastFour?: string | null;
  cardholderName?: string | null;
  fullName?: string | null;
  idNumberLast4?: string | null;
  relyingPartyId?: string | null;
  bankName?: string | null;
  accountNumberLast4?: string | null;
  softwareName?: string | null;
  licensee?: string | null;
  keyType?: string | null;
  fingerprint?: string | null;
  isTeamMode?: boolean;
  entryTypeLabel?: string;
}

/**
 * Renders the per-entry-type secondary line (the 8-branch switch for login/note/card/etc.).
 * Shared by PasswordCard (accordion) and PasswordRow (compact, C6) — do not duplicate this logic.
 */
export function EntrySecondaryLine({
  entryType,
  username,
  urlHost,
  snippet,
  brand,
  lastFour,
  cardholderName,
  fullName,
  idNumberLast4,
  relyingPartyId,
  bankName,
  accountNumberLast4,
  softwareName,
  licensee,
  keyType,
  fingerprint,
  isTeamMode,
  entryTypeLabel,
}: EntrySecondaryLineProps) {
  const isSshKey = entryType === ENTRY_TYPE.SSH_KEY;
  const isBankAccount = entryType === ENTRY_TYPE.BANK_ACCOUNT;
  const isSoftwareLicense = entryType === ENTRY_TYPE.SOFTWARE_LICENSE;
  const isPasskey = entryType === ENTRY_TYPE.PASSKEY;
  const isIdentity = entryType === ENTRY_TYPE.IDENTITY;
  const isCreditCard = entryType === ENTRY_TYPE.CREDIT_CARD;
  const isNote = entryType === ENTRY_TYPE.SECURE_NOTE;

  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      {isSshKey ? (
        <>
          {keyType && <span className="truncate font-mono">{keyType}</span>}
          {fingerprint && <span className="truncate font-mono text-xs">{fingerprint.slice(0, DISPLAY_FINGERPRINT_SHORT)}…</span>}
        </>
      ) : isBankAccount ? (
        <>
          {bankName && <span className="truncate">{bankName}</span>}
          {accountNumberLast4 && <span className="truncate">•••• {accountNumberLast4}</span>}
        </>
      ) : isSoftwareLicense ? (
        <>
          {softwareName && <span className="truncate">{softwareName}</span>}
          {licensee && <span className="truncate">{licensee}</span>}
        </>
      ) : isPasskey ? (
        <>
          {relyingPartyId && <span className="truncate">{relyingPartyId}</span>}
          {username && (
            <span className="flex items-center gap-1 truncate">
              <User className="h-3 w-3 shrink-0" />
              {username}
            </span>
          )}
        </>
      ) : isIdentity ? (
        <>
          {fullName && <span className="truncate">{fullName}</span>}
          {idNumberLast4 && <span className="truncate">•••• {idNumberLast4}</span>}
        </>
      ) : isCreditCard ? (
        <>
          {brand && <span className="truncate">{brand}</span>}
          {lastFour && <span className="truncate">•••• {lastFour}</span>}
          {cardholderName && <span className="truncate">{cardholderName}</span>}
        </>
      ) : isNote ? (
        snippet && (
          <span className="truncate">{snippet}</span>
        )
      ) : (
        <>
          {username && (
            <span className="flex items-center gap-1 truncate">
              <User className="h-3 w-3 shrink-0" />
              {username}
            </span>
          )}
          {urlHost && (
            <span className="truncate">
              {urlHost}
            </span>
          )}
        </>
      )}
      {isTeamMode && (
        <span className="truncate text-xs font-medium">
          {entryTypeLabel}
        </span>
      )}
    </div>
  );
}
