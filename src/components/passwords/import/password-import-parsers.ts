import { ENTRY_TYPE } from "@/lib/constants";
import type { CsvFormat, ParsedEntry } from "@/components/passwords/import/password-import-types";

function extraDefaults(): Pick<
  ParsedEntry,
  "tags" | "customFields" | "totp" | "generatorSettings" | "passwordHistory" | "requireReprompt" | "travelSafe" | "folderPath" | "isFavorite" | "expiresAt"
> {
  return {
    tags: [],
    customFields: [],
    totp: null,
    generatorSettings: null,
    passwordHistory: [],
    requireReprompt: false,
    travelSafe: true,
    folderPath: "",
    isFavorite: false,
    expiresAt: null,
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
      ...("travelSafe" in parsed ? { travelSafe: parsed.travelSafe !== false } : {}),
      ...("isFavorite" in parsed ? { isFavorite: parsed.isFavorite === true } : {}),
      ...("expiresAt" in parsed && typeof parsed.expiresAt === "string" ? { expiresAt: parsed.expiresAt } : {}),
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
      bankName: typeof parsed.bankName === "string" ? parsed.bankName : "",
      accountType: typeof parsed.accountType === "string" ? parsed.accountType : "",
      accountHolderName: typeof parsed.accountHolderName === "string" ? parsed.accountHolderName : "",
      accountNumber: typeof parsed.accountNumber === "string" ? parsed.accountNumber : "",
      routingNumber: typeof parsed.routingNumber === "string" ? parsed.routingNumber : "",
      swiftBic: typeof parsed.swiftBic === "string" ? parsed.swiftBic : "",
      iban: typeof parsed.iban === "string" ? parsed.iban : "",
      branchName: typeof parsed.branchName === "string" ? parsed.branchName : "",
      softwareName: typeof parsed.softwareName === "string" ? parsed.softwareName : "",
      licenseKey: typeof parsed.licenseKey === "string" ? parsed.licenseKey : "",
      version: typeof parsed.version === "string" ? parsed.version : "",
      licensee: typeof parsed.licensee === "string" ? parsed.licensee : "",
      purchaseDate: typeof parsed.purchaseDate === "string" ? parsed.purchaseDate : "",
      expirationDate: typeof parsed.expirationDate === "string" ? parsed.expirationDate : "",
      privateKey: typeof parsed.privateKey === "string" ? parsed.privateKey : "",
      publicKey: typeof parsed.publicKey === "string" ? parsed.publicKey : "",
      keyType: typeof parsed.keyType === "string" ? parsed.keyType : "",
      keySize: typeof parsed.keySize === "string" ? parsed.keySize : parsed.keySize != null ? String(parsed.keySize) : "",
      fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : "",
      sshPassphrase: typeof parsed.sshPassphrase === "string" ? parsed.sshPassphrase : "",
      sshComment: typeof parsed.sshComment === "string" ? parsed.sshComment : "",
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
  // KeePassXC CSV always exports: Group, Title, Username, Password, URL, Notes
  if (lower.includes("group") && lower.includes("title") && lower.includes("username") && lower.includes("password") && lower.includes("url") && lower.includes("notes")) {
    return "keepassxc";
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

/**
 * Split CSV text into rows respecting RFC 4180 quoted fields
 * (newlines inside double-quoted fields are preserved, not treated as row breaks).
 */
export function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          current += '""';
          i++;
        } else {
          inQuotes = false;
          current += char;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        current += char;
      } else if (char === "\n") {
        if (current.trim()) rows.push(current);
        current = "";
      } else if (char === "\r") {
        // skip \r, the following \n (if any) will trigger row break
      } else {
        current += char;
      }
    }
  }
  if (current.trim()) rows.push(current);
  return rows;
}

export function parseCsv(text: string): { entries: ParsedEntry[]; format: CsvFormat } {
  const lines = splitCsvRows(text);
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
    const isPasskey = rowType === "passkey";
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
    const bankAccountDefaults = {
      bankName: "", accountType: "", accountHolderName: "",
      accountNumber: "", routingNumber: "", swiftBic: "",
      iban: "", branchName: "",
    };
    const softwareLicenseDefaults = {
      softwareName: "", licenseKey: "", version: "",
      licensee: "", purchaseDate: "", expirationDate: "",
    };
    const sshKeyDefaults = {
      privateKey: "", publicKey: "", keyType: "",
      keySize: "", fingerprint: "", sshPassphrase: "", sshComment: "",
    };
    const isBankAccount = rowType === "bankaccount";
    const isSoftwareLicense = rowType === "softwarelicense";
    const isSshKey = rowType === "sshkey";

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
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
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
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
        };
        break;
      case "keepassxc":
        entry = {
          entryType: ENTRY_TYPE.LOGIN,
          title: row["title"] ?? "",
          username: row["username"] ?? "",
          password: row["password"] ?? "",
          content: "",
          url: row["url"] ?? "",
          notes: row["notes"] ?? "",
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
          // KeePassXC CSV uses "/" as group separator; group names containing literal "/" are ambiguous.
          // Use the XML importer for unambiguous group hierarchy.
          ...(row["group"] ? { folderPath: row["group"].replace(/\//g, " / ") } : {}),
          ...(row["totp"] ? { totp: { secret: row["totp"] } } : {}),
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
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
        };
        break;
      default:
        entry = {
          entryType: isSshKey ? ENTRY_TYPE.SSH_KEY : isBankAccount ? ENTRY_TYPE.BANK_ACCOUNT : isSoftwareLicense ? ENTRY_TYPE.SOFTWARE_LICENSE : isPasskey ? ENTRY_TYPE.PASSKEY : isIdentity ? ENTRY_TYPE.IDENTITY : isCard ? ENTRY_TYPE.CREDIT_CARD : isNote ? ENTRY_TYPE.SECURE_NOTE : ENTRY_TYPE.LOGIN,
          title: row["name"] ?? row["title"] ?? fields[0] ?? "",
          username: row["username"] ?? row["login_username"] ?? fields[1] ?? "",
          password: row["password"] ?? row["login_password"] ?? fields[2] ?? "",
          content: isNote ? (row["notes"] ?? "") : "",
          url: row["url"] ?? row["login_uri"] ?? "",
          notes: isNote ? "" : (row["notes"] ?? ""),
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
        };
    }

    if (!entry.totp && typeof row["login_totp"] === "string" && row["login_totp"]) {
      entry.totp = { secret: row["login_totp"] };
    }

    // folder / favorite columns (Bitwarden-compatible + passwd-sso)
    if (row["folder"]) {
      entry.folderPath = row["folder"];
    }
    if (row["favorite"] === "1") {
      entry.isFavorite = true;
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

      // folder / favorite / expiresAt from top-level or passwdSso
      const folderPath = typeof item.folder === "string" ? item.folder
        : typeof item.folderPath === "string" ? item.folderPath
        : (passwdSso as Record<string, unknown>).folderPath as string | undefined
        ?? "";
      const isFavorite = item.favorite === true || item.favorite === 1
        || (passwdSso as Record<string, unknown>).isFavorite === true
        || false;
      const expiresAt = typeof item.expiresAt === "string" ? item.expiresAt
        : typeof (passwdSso as Record<string, unknown>).expiresAt === "string"
          ? (passwdSso as Record<string, unknown>).expiresAt as string
        : null;

      const metaOverrides = { folderPath, isFavorite, expiresAt };

      const cardDefaults = { cardholderName: "", cardNumber: "", brand: "", expiryMonth: "", expiryYear: "", cvv: "" };
      const identityDefaults = { fullName: "", address: "", phone: "", email: "", dateOfBirth: "", nationality: "", idNumber: "", issueDate: "", expiryDate: "" };
      const passkeyDefaults = { relyingPartyId: "", relyingPartyName: "", credentialId: "", creationDate: "", deviceInfo: "" };
      const bankAccountDefaults = { bankName: "", accountType: "", accountHolderName: "", accountNumber: "", routingNumber: "", swiftBic: "", iban: "", branchName: "" };
      const softwareLicenseDefaults = { softwareName: "", licenseKey: "", version: "", licensee: "", purchaseDate: "", expirationDate: "" };
      const sshKeyDefaults = { privateKey: "", publicKey: "", keyType: "", keySize: "", fingerprint: "", sshPassphrase: "", sshComment: "" };

      if (type === "sshkey") {
        const sshKey = item.sshKey ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.SSH_KEY,
          title: item.name ?? "",
          username: "",
          password: sshKey.privateKey ?? "",
          content: "",
          url: "",
          notes: item.notes ?? "",
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...extraDefaults(),
          ...passwdSso,
          privateKey: sshKey.privateKey ?? "",
          publicKey: sshKey.publicKey ?? "",
          keyType: sshKey.keyType ?? "",
          keySize: sshKey.keySize != null ? String(sshKey.keySize) : "",
          fingerprint: sshKey.fingerprint ?? "",
          sshPassphrase: sshKey.passphrase ?? "",
          sshComment: sshKey.comment ?? "",
          ...metaOverrides,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

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
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
          relyingPartyId: passkey.relyingPartyId ?? "",
          relyingPartyName: passkey.relyingPartyName ?? "",
          credentialId: passkey.credentialId ?? "",
          creationDate: passkey.creationDate ?? "",
          deviceInfo: passkey.deviceInfo ?? "",
          ...metaOverrides,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      if (type === "bankaccount") {
        const bank = item.bankAccount ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.BANK_ACCOUNT,
          title: item.name ?? "",
          username: "",
          password: "",
          content: "",
          url: "",
          notes: item.notes ?? "",
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
          bankName: bank.bankName ?? "",
          accountType: bank.accountType ?? "",
          accountHolderName: bank.accountHolderName ?? "",
          accountNumber: bank.accountNumber ?? "",
          routingNumber: bank.routingNumber ?? "",
          swiftBic: bank.swiftBic ?? "",
          iban: bank.iban ?? "",
          branchName: bank.branchName ?? "",
          ...metaOverrides,
        };
        if (entry.title) entries.push(entry);
        continue;
      }

      if (type === "softwarelicense") {
        const license = item.softwareLicense ?? {};
        const entry: ParsedEntry = {
          entryType: ENTRY_TYPE.SOFTWARE_LICENSE,
          title: item.name ?? "",
          username: "",
          password: "",
          content: "",
          url: "",
          notes: item.notes ?? "",
          ...cardDefaults,
          ...identityDefaults,
          ...passkeyDefaults,
          ...bankAccountDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
          softwareName: license.softwareName ?? "",
          licenseKey: license.licenseKey ?? "",
          version: license.version ?? "",
          licensee: license.licensee ?? "",
          email: license.email ?? "",
          purchaseDate: license.purchaseDate ?? "",
          expirationDate: license.expirationDate ?? "",
          ...metaOverrides,
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
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
          fullName: identity.fullName
            ?? (identity.firstName
              ? `${identity.firstName} ${identity.lastName ?? ""}`.trim()
              : ""),
          address: identity.address ?? identity.address1 ?? "",
          phone: identity.phone ?? "",
          email: identity.email ?? "",
          dateOfBirth: identity.dateOfBirth ?? "",
          nationality: identity.nationality ?? "",
          idNumber: identity.idNumber ?? identity.ssn ?? identity.passportNumber ?? "",
          issueDate: identity.issueDate ?? "",
          expiryDate: identity.expiryDate ?? "",
          ...metaOverrides,
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
          ...identityDefaults,
          ...passkeyDefaults,
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
          cardholderName: card.cardholderName ?? "",
          cardNumber: card.number ?? "",
          brand: card.brand ?? "",
          expiryMonth: card.expMonth ?? "",
          expiryYear: card.expYear ?? "",
          cvv: card.code ?? "",
          ...metaOverrides,
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
          ...bankAccountDefaults,
          ...softwareLicenseDefaults,
          ...sshKeyDefaults,
          ...extraDefaults(),
          ...passwdSso,
          ...metaOverrides,
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
        ...bankAccountDefaults,
        ...softwareLicenseDefaults,
        ...sshKeyDefaults,
        ...extraDefaults(),
        ...passwdSso,
        // login.totp (bare string) is a fallback; passwdSso.totp (full config) takes priority
        ...(typeof login.totp === "string" && login.totp && !passwdSso.totp
          ? { totp: { secret: login.totp } }
          : {}),
        ...metaOverrides,
      };
      if (entry.title && entry.password) entries.push(entry);
    }

    return { entries, format: exportFormat };
  } catch {
    return { entries: [], format: "unknown" };
  }
}

// ─── KeePassXC XML Parser ──────────────────────────────────

function xmlText(parent: Element, tag: string): string {
  return parent.querySelector(tag)?.textContent ?? "";
}

function parseKeePassXcEntry(entryEl: Element, folderPath: string): ParsedEntry | null {
  const fields: Record<string, string> = {};
  for (const strEl of entryEl.querySelectorAll(":scope > String")) {
    const key = xmlText(strEl, "Key");
    const value = xmlText(strEl, "Value");
    if (key) fields[key] = value;
  }

  const title = fields["Title"] ?? "";
  const password = fields["Password"] ?? "";
  if (!title || !password) return null;

  // KeePassXC stores TOTP under different keys depending on version:
  // "TOTP Seed" (base32 secret), "otp" (otpauth:// URI), or "TOTP" (CSV-style)
  const totpRaw = fields["otp"] || fields["TOTP Seed"] || fields["TOTP"] || "";

  return {
    entryType: ENTRY_TYPE.LOGIN,
    title,
    username: fields["UserName"] ?? "",
    password,
    content: "",
    url: fields["URL"] ?? "",
    notes: fields["Notes"] ?? "",
    cardholderName: "", cardNumber: "", brand: "",
    expiryMonth: "", expiryYear: "", cvv: "",
    fullName: "", address: "", phone: "", email: "",
    dateOfBirth: "", nationality: "", idNumber: "",
    issueDate: "", expiryDate: "",
    relyingPartyId: "", relyingPartyName: "",
    credentialId: "", creationDate: "", deviceInfo: "",
    bankName: "", accountType: "", accountHolderName: "",
    accountNumber: "", routingNumber: "", swiftBic: "",
    iban: "", branchName: "",
    softwareName: "", licenseKey: "", version: "",
    licensee: "", purchaseDate: "", expirationDate: "",
    privateKey: "", publicKey: "", keyType: "",
    keySize: "", fingerprint: "", sshPassphrase: "", sshComment: "",
    tags: [],
    customFields: [],
    totp: totpRaw ? { secret: totpRaw } : null,
    generatorSettings: null,
    passwordHistory: [],
    requireReprompt: false,
    travelSafe: true,
    folderPath,
    isFavorite: false,
    expiresAt: null,
  };
}

function parseKeePassXcGroup(
  groupEl: Element,
  parentPath: string,
  entries: ParsedEntry[],
  recycleBinUuid: string,
) {
  const groupName = xmlText(groupEl, ":scope > Name");
  const currentPath = parentPath ? `${parentPath} / ${groupName}` : groupName;

  // Skip the Recycle Bin: match by UUID (locale-independent) or by known names as fallback
  const groupUuid = xmlText(groupEl, ":scope > UUID");
  if (recycleBinUuid && groupUuid === recycleBinUuid) return;
  if (groupName === "Recycle Bin" || groupName === "ごみ箱") return;

  for (const entryEl of groupEl.querySelectorAll(":scope > Entry")) {
    const entry = parseKeePassXcEntry(entryEl, currentPath);
    if (entry) entries.push(entry);
  }

  for (const childGroup of groupEl.querySelectorAll(":scope > Group")) {
    parseKeePassXcGroup(childGroup, currentPath, entries, recycleBinUuid);
  }
}

export function parseKeePassXcXml(text: string): { entries: ParsedEntry[]; format: CsvFormat } {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/xml");

    // Check for parse errors
    const parseError = doc.querySelector("parsererror");
    if (parseError) return { entries: [], format: "unknown" };

    // KeePassXC XML has <KeePassFile><Root><Group>...
    const rootGroup = doc.querySelector("KeePassFile > Root > Group");
    if (!rootGroup) return { entries: [], format: "unknown" };

    // Read Recycle Bin UUID from Meta section (locale-independent detection)
    const recycleBinUuid = doc.querySelector("KeePassFile > Meta > RecycleBinUUID")?.textContent ?? "";

    const entries: ParsedEntry[] = [];
    // Process entries directly in root group
    for (const entryEl of rootGroup.querySelectorAll(":scope > Entry")) {
      const entry = parseKeePassXcEntry(entryEl, "");
      if (entry) entries.push(entry);
    }
    // Process child groups of Root (skip the root group name itself)
    for (const childGroup of rootGroup.querySelectorAll(":scope > Group")) {
      parseKeePassXcGroup(childGroup, "", entries, recycleBinUuid);
    }

    return { entries, format: "keepassxc" };
  } catch {
    return { entries: [], format: "unknown" };
  }
}

export const formatLabels: Record<CsvFormat, string> = {
  bitwarden: "Bitwarden",
  onepassword: "1Password",
  chrome: "Chrome",
  keepassxc: "KeePassXC",
  "passwd-sso": "passwd-sso",
  unknown: "CSV",
};
