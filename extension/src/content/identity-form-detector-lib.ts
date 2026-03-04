// Pure logic module for identity/address form detection (exported, testable).
// Side-effect-free — no global event registration here.

// ── Types ──

export interface IdentityFormFields {
  fullName: HTMLInputElement | null;
  address: HTMLInputElement | null;
  postalCode: HTMLInputElement | null;
  phone: HTMLInputElement | null;
  email: HTMLInputElement | null;
  dateOfBirth: HTMLInputElement | null;
  region: HTMLInputElement | HTMLSelectElement | null;
}

// ── Visibility check ──

function resolveOpacity(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

export function isElementVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (resolveOpacity(style.opacity) <= 0.05) return false;
  return true;
}

// ── Field detection helpers ──

function getHintString(el: HTMLElement): string {
  const parts: string[] = [];
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
    if (el.name) parts.push(el.name);
    if (el.id) parts.push(el.id);
    if (el.placeholder && el instanceof HTMLInputElement) parts.push(el.placeholder);
  }
  if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label")!);
  const id = el.id;
  if (id && typeof CSS !== "undefined" && CSS.escape) {
    const label = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent) parts.push(label.textContent);
  }
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent) parts.push(parentLabel.textContent);
  return parts.join(" ").toLowerCase();
}

function getAutocomplete(el: HTMLElement): string {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase().trim();
}

function isUsableField(el: HTMLInputElement | HTMLSelectElement): boolean {
  if (el instanceof HTMLInputElement) {
    return !el.disabled && !el.readOnly;
  }
  return !el.disabled;
}

// ── Regex patterns ──

const NAME_RE = /\b(full.?name|your.?name|first.?name|last.?name|name)\b/i;
const NAME_JA_RE = /氏名|お名前|名前|姓名/;

const ADDRESS_RE = /\b(address|street|addr|address.?line|shipping.?address|billing.?address)\b/i;
const ADDRESS_JA_RE = /住所|番地|丁目|番号/;

const POSTAL_RE = /\b(zip|postal|post.?code|zip.?code)\b/i;
const POSTAL_JA_RE = /郵便番号/;

const PHONE_RE = /\b(phone|tel|telephone|mobile|cell)\b/i;
const PHONE_JA_RE = /電話|携帯/;

const EMAIL_RE = /\b(email|e.?mail)\b/i;
const EMAIL_JA_RE = /メール/;

const DOB_RE = /\b(birth|dob|date.?of.?birth|birthday)\b/i;
const DOB_JA_RE = /生年月日|誕生日/;

const REGION_RE = /\b(state|province|region|prefecture|county)\b/i;
const REGION_JA_RE = /都道府県|県/;

// ── Autocomplete values ──

const AC_NAME = "name";
const AC_ADDRESS_LINE1 = "address-line1";
const AC_POSTAL_CODE = "postal-code";
const AC_TEL = "tel";
const AC_EMAIL = "email";
const AC_BDAY = "bday";
const AC_ADDRESS_LEVEL1 = "address-level1";

// ── Field finder ──

function findFieldByAutocomplete(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  acValue: string,
): HTMLInputElement | HTMLSelectElement | null {
  return fields.find((f) => getAutocomplete(f) === acValue && isUsableField(f)) ?? null;
}

function findFieldByRegex(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  regex: RegExp,
  regexJa: RegExp,
): HTMLInputElement | HTMLSelectElement | null {
  return (
    fields.find((f) => {
      if (!isUsableField(f)) return false;
      const hint = getHintString(f);
      return regex.test(hint) || regexJa.test(hint);
    }) ?? null
  );
}

// ── Main detection function ──

export function detectIdentityFields(root: ParentNode): IdentityFormFields | null {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input"));
  const selects = Array.from(root.querySelectorAll<HTMLSelectElement>("select"));
  const allFields: (HTMLInputElement | HTMLSelectElement)[] = [...inputs, ...selects];

  const visibleFields = allFields.filter(
    (f) => isElementVisible(f) && isUsableField(f),
  );

  if (visibleFields.length === 0) return null;

  // Priority 1: autocomplete attributes
  let fullName = findFieldByAutocomplete(visibleFields, AC_NAME) as HTMLInputElement | null;
  let address = findFieldByAutocomplete(visibleFields, AC_ADDRESS_LINE1) as HTMLInputElement | null;
  let postalCode = findFieldByAutocomplete(visibleFields, AC_POSTAL_CODE) as HTMLInputElement | null;
  let phone = findFieldByAutocomplete(visibleFields, AC_TEL) as HTMLInputElement | null;
  let email = findFieldByAutocomplete(visibleFields, AC_EMAIL) as HTMLInputElement | null;
  let dateOfBirth = findFieldByAutocomplete(visibleFields, AC_BDAY) as HTMLInputElement | null;
  let region = findFieldByAutocomplete(visibleFields, AC_ADDRESS_LEVEL1);

  // Priority 2: name/id/label regex fallback
  if (!fullName) {
    fullName = findFieldByRegex(visibleFields, NAME_RE, NAME_JA_RE) as HTMLInputElement | null;
  }
  if (!address) {
    address = findFieldByRegex(visibleFields, ADDRESS_RE, ADDRESS_JA_RE) as HTMLInputElement | null;
  }
  if (!postalCode) {
    postalCode = findFieldByRegex(visibleFields, POSTAL_RE, POSTAL_JA_RE) as HTMLInputElement | null;
  }
  if (!phone) {
    phone = findFieldByRegex(visibleFields, PHONE_RE, PHONE_JA_RE) as HTMLInputElement | null;
  }
  if (!email) {
    email = findFieldByRegex(visibleFields, EMAIL_RE, EMAIL_JA_RE) as HTMLInputElement | null;
  }
  if (!dateOfBirth) {
    dateOfBirth = findFieldByRegex(visibleFields, DOB_RE, DOB_JA_RE) as HTMLInputElement | null;
  }
  if (!region) {
    region = findFieldByRegex(visibleFields, REGION_RE, REGION_JA_RE);
  }

  // Must have at least 2 fields to consider this an identity form
  const fieldCount = [fullName, address, postalCode, phone, email, dateOfBirth, region].filter(Boolean).length;
  if (fieldCount < 2) return null;

  return {
    fullName,
    address,
    postalCode,
    phone,
    email,
    dateOfBirth,
    region,
  };
}
