import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";

export function escapeCsvValue(val: string | null): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export function formatExportDate(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export function csvExportHeader(includePasswdSso: boolean): string {
  return includePasswdSso
    ? "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp,passwd_sso"
    : "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp";
}

interface CsvTypeOptions {
  includePasskeyType: boolean;
}

export function csvEntryType(
  entryType: EntryTypeValue,
  options: CsvTypeOptions
): "passkey" | "identity" | "card" | "securenote" | "login" {
  if (options.includePasskeyType && entryType === ENTRY_TYPE.PASSKEY) return "passkey";
  if (entryType === ENTRY_TYPE.IDENTITY) return "identity";
  if (entryType === ENTRY_TYPE.CREDIT_CARD) return "card";
  if (entryType === ENTRY_TYPE.SECURE_NOTE) return "securenote";
  return "login";
}

