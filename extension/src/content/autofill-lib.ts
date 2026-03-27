import type { AutofillPayload } from "../types/messages";

function setInputValue(input: HTMLInputElement, value: string) {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // Legacy forms often validate on keyup/blur handlers.
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

function isUsableInput(input: HTMLInputElement) {
  return !input.disabled && !input.readOnly;
}

function escapeSelectorValue(value: string): string {
  const esc = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (esc) return esc(value);
  return value.replace(/["\\]/g, "\\$&");
}

function findPasswordInput(inputs: HTMLInputElement[]) {
  const isVisible = (input: HTMLInputElement) =>
    getComputedStyle(input).display !== "none" &&
    getComputedStyle(input).visibility !== "hidden";

  const byAutocomplete = inputs.find(
    (i) =>
      isUsableInput(i) &&
      i.type === "password" &&
      isVisible(i) &&
      i.autocomplete === "current-password"
  );
  if (byAutocomplete) return byAutocomplete;
  const passwordInputs = inputs.filter(
    (i) => isUsableInput(i) && i.type === "password" && isVisible(i)
  );
  return passwordInputs.length > 0
    ? passwordInputs[passwordInputs.length - 1]
    : null;
}

function findUsernameInput(
  inputs: HTMLInputElement[],
  passwordInput: HTMLInputElement | null
) {
  const isUsernameLike = (candidate: HTMLInputElement): boolean => {
    if (!isUsableInput(candidate)) return false;
    if (!["text", "email", "tel"].includes(candidate.type)) return false;

    const ac = (candidate.autocomplete || "").toLowerCase().trim();
    if (ac === "username" || ac === "email") return true;
    if (ac.includes("one-time-code") || ac.includes("password")) return false;

    const hints = [
      candidate.name,
      candidate.id,
      candidate.placeholder,
      candidate.getAttribute("formcontrolname"),
      candidate.getAttribute("ng-reflect-name"),
      candidate.getAttribute("aria-label"),
      candidate.getAttribute("aria-labelledby"),
      candidate.closest("label")?.textContent ?? "",
      (() => {
        const id = candidate.id;
        if (!id) return "";
        return document.querySelector(`label[for="${escapeSelectorValue(id)}"]`)?.textContent ?? "";
      })(),
    ]
      .filter((v): v is string => Boolean(v && v.trim()))
      .join(" ")
      .toLowerCase();

    if (!hints) return false;
    if (
      /\b(search|query|keyword|coupon|promo|otp|code|verification)\b/.test(hints) ||
      /(検索|クーポン|認証コード|確認コード|ワンタイム)/.test(hints)
    ) {
      return false;
    }
    return (
      /\b(user(name)?|userid|login|email|e-?mail|identifier|account|member|id|contract|customer)\b/.test(
        hints,
      ) ||
      /(ログイン|ユーザー|メール|アカウント|会員|契約番号|ご契約番号|お客さま番号|顧客番号|店番|口座番号)/.test(
        hints,
      )
    );
  };

  const byAutocomplete = inputs.find(
    (i) =>
      isUsableInput(i) &&
      (i.type === "text" || i.type === "email" || i.type === "tel") &&
      i.autocomplete === "username"
  );
  if (byAutocomplete) return byAutocomplete;

  if (!passwordInput) return null;
  const index = inputs.indexOf(passwordInput);
  if (index <= 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = inputs[i];
    if (
      isUsernameLike(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function findFocusedTextInput(): HTMLInputElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return null;
  if (!isUsableInput(active)) return null;
  if (!["text", "email", "tel"].includes(active.type)) return null;
  return active;
}

function getHints(input: HTMLInputElement): string {
  const id = input.id;
  const label =
    (id
      ? document.querySelector(`label[for="${escapeSelectorValue(id)}"]`)?.textContent ?? ""
      : "") +
    (input.getAttribute("aria-label") ?? "") +
    (input.placeholder ?? "") +
    (input.name ?? "") +
    (input.id ?? "") +
    (input.getAttribute("formcontrolname") ?? "");
  return label.toLowerCase();
}

// Indexed name pattern for split OTP fields: "otp-code-0", "2fa-3", etc.
// Keywords aligned with otpHintRe in findOtpInput.
const indexedOtpNameRe =
  /^(otp|totp|2fa|two[-_]?factor|mfa|verification[-_]?code|security[-_]?code|auth(?:entication)?[-_]?code|one[-_]?time|otp[-_]?code)[-_]?\d+$/i;

function isSingleDigitOtp(input: HTMLInputElement): boolean {
  if (!isUsableInput(input)) return false;
  if (!["text", "tel"].includes(input.type)) return false;
  if (input.maxLength === 1) return true;
  // Detect by indexed name (e.g. "otp-code-0" … "otp-code-5")
  return indexedOtpNameRe.test(input.name);
}

function findSplitOtpInputs(
  inputs: HTMLInputElement[],
  codeLength: number,
): HTMLInputElement[] | null {
  // Look for a group of consecutive single-digit inputs that match codeLength
  for (let start = 0; start <= inputs.length - codeLength; start++) {
    const candidate = inputs[start];
    if (!isSingleDigitOtp(candidate)) continue;

    const group: HTMLInputElement[] = [candidate];
    // Collect consecutive single-digit inputs sharing the same parent container
    const parent = candidate.parentElement?.closest(
      "form, fieldset, [role='group'], section",
    );
    for (let j = start + 1; j < inputs.length && group.length < codeLength; j++) {
      const next = inputs[j];
      if (!isSingleDigitOtp(next)) break;
      // Must share a common ancestor (not scattered across the page)
      const nextParent = next.parentElement?.closest(
        "form, fieldset, [role='group'], section",
      );
      if (!parent || !nextParent) break;
      if (parent !== nextParent) {
        // Allow if they share any ancestor up to 4 levels
        let shared = false;
        let el: Element | null = next;
        for (let depth = 0; depth < 5 && el; depth++) {
          if (el === parent) { shared = true; break; }
          el = el.parentElement;
        }
        if (!shared) break;
      }
      group.push(next);
    }
    if (group.length === codeLength) return group;
  }
  return null;
}

function findOtpInput(inputs: HTMLInputElement[]): HTMLInputElement | null {
  const byAutocomplete = inputs.find(
    (i) => isUsableInput(i) && i.autocomplete === "one-time-code",
  );
  if (byAutocomplete) return byAutocomplete;

  const otpHintRe =
    /(otp|totp|2fa|two.?factor|mfa|verification.?code|security.?code|auth(?:entication)?.?code|one.?time)/i;
  const otpHintJaRe = /(認証コード|確認コード|ワンタイム|二段階|セキュリティコード)/;

  return (
    inputs.find((i) => {
      if (!isUsableInput(i)) return false;
      if (!["text", "tel", "number"].includes(i.type)) return false;
      const hints = getHints(i);
      return otpHintRe.test(hints) || otpHintJaRe.test(hints);
    }) ?? null
  );
}

export function performAutofill(payload: AutofillPayload) {
  const inputs = Array.from(
    document.querySelectorAll("input")
  ) as HTMLInputElement[];
  const hintedInput =
    (payload.targetHint?.id
      ? inputs.find((i) => i.id === payload.targetHint?.id)
      : undefined) ??
    (payload.targetHint?.name
      ? inputs.find((i) => i.name === payload.targetHint?.name)
      : undefined) ??
    (payload.targetHint?.autocomplete
      ? inputs.find(
          (i) =>
            i.autocomplete === payload.targetHint?.autocomplete &&
            (!payload.targetHint?.type || i.type === payload.targetHint?.type),
        )
      : undefined) ??
    null;
  const hintedUsernameInput =
    hintedInput &&
    isUsableInput(hintedInput) &&
    ["text", "email", "tel"].includes(hintedInput.type)
      ? hintedInput
      : null;

  // Identify inputs reserved for custom fields — exclude from username candidates
  const customFieldTargets = new Set<HTMLInputElement>();
  if (payload.customFields) {
    for (const { label } of payload.customFields) {
      const lower = label.toLowerCase();
      const target = inputs.find(
        (i) =>
          isUsableInput(i) &&
          (i.id.toLowerCase() === lower || i.name.toLowerCase() === lower),
      );
      if (target) customFieldTargets.add(target);
    }
  }

  const focusedUsername = findFocusedTextInput();
  // If focused input is reserved for a custom field, don't use it as username target
  const effectiveFocusedUsername =
    focusedUsername && !customFieldTargets.has(focusedUsername) ? focusedUsername : null;
  const effectiveHintedUsername =
    hintedUsernameInput && !customFieldTargets.has(hintedUsernameInput) ? hintedUsernameInput : null;

  const scopeForm = (focusedUsername ?? hintedUsernameInput)?.form ?? null;
  const passwordInput =
    (scopeForm
      ? findPasswordInput(
          Array.from(scopeForm.querySelectorAll("input")) as HTMLInputElement[],
        )
      : null) ?? findPasswordInput(inputs);
  const usernameInput =
    effectiveFocusedUsername ??
    effectiveHintedUsername ??
    findUsernameInput(
      inputs.filter((i) => !customFieldTargets.has(i)),
      passwordInput,
    );

  if (usernameInput && payload.username) {
    setInputValue(usernameInput, payload.username);
  }
  if (passwordInput && payload.password) {
    setInputValue(passwordInput, payload.password);
  }

  if (payload.totpCode) {
    const otpForm = passwordInput?.form ?? scopeForm;
    const otpScopedInputs = otpForm
      ? (Array.from(otpForm.querySelectorAll("input")) as HTMLInputElement[])
      : null;

    // Try split OTP fields first (e.g. 6 separate single-digit inputs)
    const codeLen = payload.totpCode.length;
    const splitInputs =
      (otpScopedInputs ? findSplitOtpInputs(otpScopedInputs, codeLen) : null) ??
      findSplitOtpInputs(inputs, codeLen);
    if (splitInputs) {
      for (let i = 0; i < codeLen; i++) {
        setInputValue(splitInputs[i], payload.totpCode[i]);
      }
    } else {
      // Fall back to single OTP field
      const otpInput =
        (otpScopedInputs ? findOtpInput(otpScopedInputs) : null) ??
        findOtpInput(inputs);
      if (otpInput) {
        setInputValue(otpInput, payload.totpCode);
      }
    }
  }

  // Generic custom field autofill: match label to input id or name
  if (payload.customFields) {
    for (const { label, value } of payload.customFields) {
      const lower = label.toLowerCase();
      const target = inputs.find(
        (i) =>
          isUsableInput(i) &&
          (i.id.toLowerCase() === lower || i.name.toLowerCase() === lower),
      );
      if (target) {
        setInputValue(target, value);
      }
    }
  }
}

// Guard against double-registration when autofill.js is also injected.
const AUTOFILL_GUARD = "__pssoAutofillHandler";
if (
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage &&
  !(window as unknown as Record<string, boolean>)[AUTOFILL_GUARD]
) {
  (window as unknown as Record<string, boolean>)[AUTOFILL_GUARD] = true;
  chrome.runtime.onMessage.addListener((message: AutofillPayload, sender: chrome.runtime.MessageSender) => {
    // Only accept messages from our own extension — reject external senders
    if (message?.type === "AUTOFILL_FILL" && sender.id === chrome.runtime.id) {
      performAutofill(message);
    }
  });
}
