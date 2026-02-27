import { ENTRY_TYPE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import type {
  EntryCustomFieldPortable,
  EntryPasswordHistory,
  EntryTagNameColor,
  EntryTotpPortable,
} from "@/lib/entry-form-types";

export interface ExportEntry {
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  password: string;
  content: string | null;
  url: string | null;
  notes: string | null;
  totp: string | null;
  cardholderName: string | null;
  cardNumber: string | null;
  brand: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
  cvv: string | null;
  fullName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  idNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  relyingPartyId?: string | null;
  relyingPartyName?: string | null;
  credentialId?: string | null;
  creationDate?: string | null;
  deviceInfo?: string | null;
  tags: EntryTagNameColor[];
  customFields: EntryCustomFieldPortable[];
  totpConfig: EntryTotpPortable | null;
  generatorSettings: Record<string, unknown> | null;
  passwordHistory: EntryPasswordHistory[];
  requireReprompt?: boolean;
}

export type ExportProfile = "compatible" | "passwd-sso";
export type ExportFormat = "csv" | "json";

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

interface FormatExportJsonOptions {
  includePasskey: boolean;
  includeReprompt: boolean;
  includeRequireRepromptInPasswdSso: boolean;
}

export interface FormatExportCsvOptions {
  includePasskeyType: boolean;
  includeReprompt: boolean;
  includeRequireRepromptInPasswdSso: boolean;
  includePasskeyFieldsInPasswdSso: boolean;
}

export interface FormatExportOptions {
  csv: FormatExportCsvOptions;
  json: FormatExportJsonOptions;
}

export const PERSONAL_EXPORT_OPTIONS: FormatExportOptions = {
  csv: {
    includePasskeyType: true,
    includeReprompt: true,
    includeRequireRepromptInPasswdSso: true,
    includePasskeyFieldsInPasswdSso: true,
  },
  json: {
    includePasskey: true,
    includeReprompt: true,
    includeRequireRepromptInPasswdSso: true,
  },
};

export const TEAM_EXPORT_OPTIONS: FormatExportOptions = {
  csv: {
    includePasskeyType: true,
    includeReprompt: false,
    includeRequireRepromptInPasswdSso: false,
    includePasskeyFieldsInPasswdSso: false,
  },
  json: {
    includePasskey: true,
    includeReprompt: false,
    includeRequireRepromptInPasswdSso: false,
  },
};

function withReprompt(
  entry: ExportEntry,
  includeReprompt: boolean
): { reprompt?: number } {
  if (!includeReprompt) return {};
  return { reprompt: entry.requireReprompt ? 1 : 0 };
}

function basePasswdSsoMeta(
  entry: ExportEntry,
  includeRequireRepromptInPasswdSso: boolean
): Record<string, unknown> {
  return {
    entryType: entry.entryType,
    tags: entry.tags,
    ...(includeRequireRepromptInPasswdSso
      ? { requireReprompt: entry.requireReprompt }
      : {}),
  };
}

function withPasswdSsoMeta(
  profile: ExportProfile,
  meta: Record<string, unknown>
): { passwdSso?: Record<string, unknown> } {
  if (profile !== "passwd-sso") return {};
  return { passwdSso: meta };
}

export function formatExportJson(
  entries: ExportEntry[],
  profile: ExportProfile,
  options: FormatExportJsonOptions
): string {
  return JSON.stringify(
    {
      ...(profile === "passwd-sso" ? { format: "passwd-sso", version: 1 } : {}),
      exportedAt: new Date().toISOString(),
      entries: entries.map((e) => {
        if (options.includePasskey && e.entryType === ENTRY_TYPE.PASSKEY) {
          return {
            type: "passkey",
            name: e.title,
            passkey: {
              relyingPartyId: e.relyingPartyId,
              relyingPartyName: e.relyingPartyName,
              username: e.username,
              credentialId: e.credentialId,
              creationDate: e.creationDate,
              deviceInfo: e.deviceInfo,
            },
            notes: e.notes,
            ...withReprompt(e, options.includeReprompt),
            ...withPasswdSsoMeta(
              profile,
              basePasswdSsoMeta(e, options.includeRequireRepromptInPasswdSso)
            ),
          };
        }

        if (e.entryType === ENTRY_TYPE.IDENTITY) {
          return {
            type: "identity",
            name: e.title,
            identity: {
              fullName: e.fullName,
              address: e.address,
              phone: e.phone,
              email: e.email,
              dateOfBirth: e.dateOfBirth,
              nationality: e.nationality,
              idNumber: e.idNumber,
              issueDate: e.issueDate,
              expiryDate: e.expiryDate,
            },
            notes: e.notes,
            ...withReprompt(e, options.includeReprompt),
            ...withPasswdSsoMeta(
              profile,
              basePasswdSsoMeta(e, options.includeRequireRepromptInPasswdSso)
            ),
          };
        }

        if (e.entryType === ENTRY_TYPE.CREDIT_CARD) {
          return {
            type: "card",
            name: e.title,
            card: {
              cardholderName: e.cardholderName,
              brand: e.brand,
              number: e.cardNumber,
              expMonth: e.expiryMonth,
              expYear: e.expiryYear,
              code: e.cvv,
            },
            notes: e.notes,
            ...withReprompt(e, options.includeReprompt),
            ...withPasswdSsoMeta(
              profile,
              basePasswdSsoMeta(e, options.includeRequireRepromptInPasswdSso)
            ),
          };
        }

        if (e.entryType === ENTRY_TYPE.SECURE_NOTE) {
          return {
            type: "securenote",
            name: e.title,
            notes: e.content,
            ...withReprompt(e, options.includeReprompt),
            ...withPasswdSsoMeta(
              profile,
              basePasswdSsoMeta(e, options.includeRequireRepromptInPasswdSso)
            ),
          };
        }

        return {
          type: "login",
          name: e.title,
          login: {
            username: e.username,
            password: e.password,
            uris: e.url ? [{ uri: e.url }] : [],
            totp: e.totp,
          },
          notes: e.notes,
          ...withReprompt(e, options.includeReprompt),
          ...withPasswdSsoMeta(profile, {
            ...basePasswdSsoMeta(e, options.includeRequireRepromptInPasswdSso),
            customFields: e.customFields,
            totp: e.totpConfig,
            generatorSettings: e.generatorSettings,
            passwordHistory: e.passwordHistory,
          }),
        };
      }),
    },
    null,
    2
  );
}

function passwdSsoCsvPayload(
  entry: ExportEntry,
  options: Pick<
    FormatExportCsvOptions,
    "includeRequireRepromptInPasswdSso" | "includePasskeyFieldsInPasswdSso"
  >
): string {
  return JSON.stringify({
    entryType: entry.entryType,
    tags: entry.tags,
    customFields: entry.customFields,
    totp: entry.totpConfig,
    generatorSettings: entry.generatorSettings,
    passwordHistory: entry.passwordHistory,
    ...(options.includeRequireRepromptInPasswdSso
      ? { requireReprompt: entry.requireReprompt }
      : {}),
    cardholderName: entry.cardholderName,
    cardNumber: entry.cardNumber,
    brand: entry.brand,
    expiryMonth: entry.expiryMonth,
    expiryYear: entry.expiryYear,
    cvv: entry.cvv,
    fullName: entry.fullName,
    address: entry.address,
    phone: entry.phone,
    email: entry.email,
    dateOfBirth: entry.dateOfBirth,
    nationality: entry.nationality,
    idNumber: entry.idNumber,
    issueDate: entry.issueDate,
    expiryDate: entry.expiryDate,
    ...(options.includePasskeyFieldsInPasswdSso
      ? {
          relyingPartyId: entry.relyingPartyId,
          relyingPartyName: entry.relyingPartyName,
          credentialId: entry.credentialId,
          creationDate: entry.creationDate,
          deviceInfo: entry.deviceInfo,
        }
      : {}),
  });
}

export function formatExportCsv(
  entries: ExportEntry[],
  profile: ExportProfile,
  options: FormatExportCsvOptions
): string {
  const header = csvExportHeader(profile === "passwd-sso");
  const rows = entries.map((entry) => {
    const isNote = entry.entryType === ENTRY_TYPE.SECURE_NOTE;
    const isCard = entry.entryType === ENTRY_TYPE.CREDIT_CARD;
    const isIdentity = entry.entryType === ENTRY_TYPE.IDENTITY;
    const isPasskey = entry.entryType === ENTRY_TYPE.PASSKEY;
    const type = csvEntryType(entry.entryType, {
      includePasskeyType: options.includePasskeyType,
    });
    const isLogin = !isNote && !isCard && !isIdentity && !isPasskey;
    const passwdSso = passwdSsoCsvPayload(entry, {
      includeRequireRepromptInPasswdSso:
        options.includeRequireRepromptInPasswdSso,
      includePasskeyFieldsInPasswdSso: options.includePasskeyFieldsInPasswdSso,
    });

    return [
      "",
      "",
      type,
      escapeCsvValue(entry.title),
      escapeCsvValue(isNote ? entry.content : entry.notes),
      "",
      options.includeReprompt && entry.requireReprompt ? "1" : "",
      isLogin ? escapeCsvValue(entry.url) : "",
      isLogin ? escapeCsvValue(entry.username) : "",
      isLogin ? escapeCsvValue(entry.password) : "",
      isLogin ? escapeCsvValue(entry.totp) : "",
      ...(profile === "passwd-sso" ? [escapeCsvValue(passwdSso)] : []),
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

export function formatExportContent(
  entries: ExportEntry[],
  format: ExportFormat,
  profile: ExportProfile,
  options: FormatExportOptions
): string {
  if (format === "csv") {
    return formatExportCsv(entries, profile, options.csv);
  }
  return formatExportJson(entries, profile, options.json);
}
