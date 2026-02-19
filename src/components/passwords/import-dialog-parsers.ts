import { ENTRY_TYPE } from "@/lib/constants";
import type { CsvFormat, ParsedEntry } from "@/components/passwords/import-dialog-types";

function extraDefaults(): Pick<
  ParsedEntry,
  "tags" | "customFields" | "totp" | "generatorSettings" | "passwordHistory" | "requireReprompt"
> {
  return {
    tags: [],
    customFields: [],
    totp: null,
    generatorSettings: null,
    passwordHistory: [],
    requireReprompt: false,
  };
}

export function parsePasswdSsoPayload(raw: string | undefined): Partial<ParsedEntry> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return {
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      customFields: Array.isArray(parsed.customFields) ? parsed.customFields : [],
      totp:
        parsed.totp && typeof parsed.totp === "object" && typeof parsed.totp.secret === "string"
          ? parsed.totp
          : null,
      generatorSettings:
        parsed.generatorSettings && typeof parsed.generatorSettings === "object"
          ? parsed.generatorSettings
          : null,
      passwordHistory: Array.isArray(parsed.passwordHistory) ? parsed.passwordHistory : [],
      ...("requireReprompt" in parsed ? { requireReprompt: parsed.requireReprompt === true } : {}),
      cardholderName: typeof parsed.cardholderName === "string" ? parsed.cardholderName : "",
      cardNumber: typeof parsed.cardNumber === "string" ? parsed.cardNumber : "",
      brand: typeof parsed.brand === "string" ? parsed.brand : "",
      expiryMonth: typeof parsed.expiryMonth === "string" ? parsed.expiryMonth : "",
      expiryYear: typeof parsed.expiryYear === "string" ? parsed.expiryYear : "",
      cvv: typeof parsed.cvv === "string" ? parsed.cvv : "",
      fullName: typeof parsed.fullName === "string" ? parsed.fullName : "",
      address: typeof parsed.address === "string" ? parsed.address : "",
      phone: typeof parsed.phone === "string" ? parsed.phone : "",
      email: typeof parsed.email === "string" ? parsed.email : "",
      dateOfBirth: typeof parsed.dateOfBirth === "string" ? parsed.dateOfBirth : "",
      nationality: typeof parsed.nationality === "string" ? parsed.nationality : "",
      idNumber: typeof parsed.idNumber === "string" ? parsed.idNumber : "",
      issueDate: typeof parsed.issueDate === "string" ? parsed.issueDate : "",
      expiryDate: typeof parsed.expiryDate === "string" ? parsed.expiryDate : "",
      relyingPartyId: typeof parsed.relyingPartyId === "string" ? parsed.relyingPartyId : "",
      relyingPartyName: typeof parsed.relyingPartyName === "string" ? parsed.relyingPartyName : "",
      credentialId: typeof parsed.credentialId === "string" ? parsed.credentialId : "",
      creationDate: typeof parsed.creationDate === "string" ? parsed.creationDate : "",
      deviceInfo: typeof parsed.deviceInfo === "string" ? parsed.deviceInfo : "",
    };
  } catch {
    return {};
  }
}

export function detectFormat(headers: string[]): CsvFormat {
  const lower = headers.map((h) => h.toLowerCase().trim());
  if (lower.includes("passwd_sso")) {
    return "passwd-sso";
  }
  if (lower.includes("login_password") && lower.includes("login_username")) {
    return "bitwarden";
  }
  if (lower.includes("title") && lower.includes("password") && lower.includes("username")) {
    return "onepassword";
  }
  if (lower.includes("username") && lower.includes("password") && lower.includes("url") && !lower.includes("login_uri")) {
    return "chrome";
  }
  return "unknown";
}

export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}

export function parseCsv(text: string): { entries: ParsedEntry[]; format: CsvFormat } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { entries: [], format: "unknown" };

  const headers = parseCsvLine(lines[0]);
  const format = detectFormat(headers);
  const entries: ParsedEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 2) continue;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.toLowerCase().trim()] = fields[idx] ?? "";
    });

    let entry: ParsedEntry;
    const rowType = (row["type"] ?? "").toLowerCase();
    const isNote = rowType === "securenote" || rowType === "note";
    const isCard = rowType === "card";
    const isIdentity = rowType === "identity";
    const passwdSso = parsePasswdSsoPayload(row["passwd_sso"]);

    const cardDefaults = {
      cardholderName: "", cardNumber: "", brand: "",
      expiryMonth: "", expiryYear: "", cvv: "",
    };
    const identityDefaults = {
      fullName: "", address: "", phone: "", email: "",
      dateOfBirth: "", nationality: "", idNumber: "",
      issueDate: "", expiryDate: "",
    };
    const passkeyDefaults = {
      relyingPartyId: "", relyingPartyName: "",
      credentialId: "", creationDate: "", deviceInfo: "",
    };

    switch (format) {
      case "bitwarden":
        entry = {
          entryType: isIdentity ? ENTRY_TYPE.IDENTITY : isCard ? ENTRY_TYPE.CREDIT_CARD : isNote ? ENTRY_TYPE.SECURE_NOTE : ENTRY_TYPE.LOGIN,
          title: row["name"] ?? "",
          username: row["login_username"] ?? "",
          password: row["login_password"] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["login_uri"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
        };
        break;
      case "chrome":
        entry = {
          entryType: ENTRY_TYPE.LOGIN,
          title: row["name"] ?? "",
          username: row["username"] ?? "",
          password: row["password"] ?? "",
          content: "",
          url: row["url"] ?? "",
          notes: row["note"] ?? "",
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
        };
        break;
      case "onepassword":
        entry = {
          entryType: isIdentity ? ENTRY_TYPE.IDENTITY : isCard ? ENTRY_TYPE.CREDIT_CARD : isNote ? ENTRY_TYPE.SECURE_NOTE : ENTRY_TYPE.LOGIN,
          title: row["title"] ?? "",
          username: row["username"] ?? "",
          password: row["password"] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["url"] ?? row["urls"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
        };
        break;
      default:
        entry = {
          entryType: isIdentity ? ENTRY_TYPE.IDENTITY : isCard ? ENTRY_TYPE.CREDIT_CARD : isNote ? ENTRY_TYPE.SECURE_NOTE : ENTRY_TYPE.LOGIN,
          title: row["name"] ?? row["title"] ?? fields[0] ?? "",
          username: row["username"] ?? row["login_username"] ?? fields[1] ?? "",
          password: row["password"] ?? row["login_password"] ?? fields[2] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["url"] ?? row["login_uri"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
        };
    }

    if (!entry.totp && typeof row["login_totp"] === "string" && row["login_totp"]) {
      entry.totp = { secret: row["login_totp"] };
    }
    entry = { ...entry, ...passwdSso };

    if (!("requireReprompt" in passwdSso)) {
      entry.requireReprompt = row["reprompt"] === "1";
    }

    const valid = entry.entryType === ENTRY_TYPE.LOGIN
      ? !!entry.title && !!entry.password
      : !!entry.title;
    if (valid) entries.push(entry);
  }

  return { entries, format };
}

export function parseJson(text: string): { entries: ParsedEntry[]; format: CsvFormat } {
  try {
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : (data.entries ?? data.items ?? []);
    if (!Array.isArray(items)) return { entries: [], format: "unknown" };
    const exportFormat: CsvFormat =
      data && typeof data === "object" && data.format === "passwd-sso"
        ? "passwd-sso"
        : "bitwarden";

    const entries: ParsedEntry[] = [];
    for (const item of items) {
      const type = typeof item.type === "number" ? item.type : (item.type ?? "").toLowerCase();
      const passwdSso =
        item.passwdSso && typeof item.passwdSso === "object"
          ? parsePasswdSsoPayload(JSON.stringify(item.passwdSso))
          : {};

      if (!("requireReprompt" in passwdSso)) {
        passwdSso.requireReprompt =
          "requireReprompt" in item ? item.requireReprompt === true : item.reprompt === 1;
      }

      const cardDefaults = { cardholderName: "", cardNumber: "", brand: "", expiryMonth: "", expiryYear: "", cvv: "" };
      const identityDefaults = { fullName: "", address: "", phone: "", email: "", dateOfBirth: "", nationality: "", idNumber: "", issueDate: "", expiryDate: "" };
      const passkeyDefaults = { relyingPartyId: "", relyingPartyName: "", credentialId: "", creationDate: "", deviceInfo: "" };

      if (type === "passkey") {
        const passkey = item.passkey ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.PASSKEY,
          title: item.name ?? "",
          username: passkey.username ?? "",
          password: "",
          content: "",
          url: "",
          notes: item.notes ?? "",
          ...cardDefaults,
          ...identityDefaults,
          relyingPartyId: passkey.relyingPartyId ?? "",
          relyingPartyName: passkey.relyingPartyName ?? "",
          credentialId: passkey.credentialId ?? "",
          creationDate: passkey.creationDate ?? "",
          deviceInfo: passkey.deviceInfo ?? "",
          ...extraDefaults(),
          ...passwdSso,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      if (type === 4 || type === "identity") {
        const identity = item.identity ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.IDENTITY,
          title: item.name ?? "",
          username: "",
          password: "",
          content: "",
          url: "",
          notes: item.notes ?? "",
          ...cardDefaults,
          ...passkeyDefaults,
          fullName: identity.fullName ?? identity.firstName
            ? `${identity.firstName ?? ""} ${identity.lastName ?? ""}`.trim()
            : "",
          address: identity.address ?? identity.address1 ?? "",
          phone: identity.phone ?? "",
          email: identity.email ?? "",
          dateOfBirth: identity.dateOfBirth ?? "",
          nationality: identity.nationality ?? "",
          idNumber: identity.idNumber ?? identity.ssn ?? identity.passportNumber ?? "",
          issueDate: identity.issueDate ?? "",
          expiryDate: identity.expiryDate ?? "",
          ...extraDefaults(),
          ...passwdSso,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      if (type === 3 || type === "card") {
        const card = item.card ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.CREDIT_CARD,
          title: item.name ?? "",
          username: "",
          password: "",
          content: "",
          url: "",
          notes: item.notes ?? "",
          cardholderName: card.cardholderName ?? "",
          cardNumber: card.number ?? "",
          brand: card.brand ?? "",
          expiryMonth: card.expMonth ?? "",
          expiryYear: card.expYear ?? "",
          cvv: card.code ?? "",
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      if (type === 2 || type === "securenote") {
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.SECURE_NOTE,
          title: item.name ?? "",
          username: "",
          password: "",
          content: item.notes ?? "",
          url: "",
          notes: "",
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      const login = item.login ?? {};
      const uris = login.uris ?? [];
      const entry: ParsedEntry = {
        entryType: ENTRY_TYPE.LOGIN,
        title: item.name ?? "",
        username: login.username ?? "",
        password: login.password ?? "",
        content: "",
        url: uris[0]?.uri ?? "",
        notes: item.notes ?? "",
        ...cardDefaults,
        ...identityDefaults,
        ...passkeyDefaults,
        ...extraDefaults(),
        totp: typeof login.totp === "string" && login.totp ? { secret: login.totp } : null,
        ...passwdSso,
      };
      if (entry.title && entry.password) entries.push(entry);
    }

    return { entries, format: exportFormat };
  } catch {
    return { entries: [], format: "unknown" };
  }
}

export const formatLabels: Record<CsvFormat, string> = {
  bitwarden: "Bitwarden",
  onepassword: "1Password",
  chrome: "Chrome",
  "passwd-sso": "passwd-sso",
  unknown: "CSV",
};
