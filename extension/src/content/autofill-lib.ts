import type { AutofillPayload } from "../types/messages";
import { AUTOFILL_FILL } from "../lib/constants";
import { extractHost, isHostMatch } from "../lib/url-matching";
import {
  resolveFillRoot,
  runFillSequence,
  supersedeActiveFill,
  type FillRoot,
  type FillStep,
  type FillTarget,
} from "./fill-sequence-lib";
import { FILL_DIAG_CODE, logFillError } from "./select-diag-lib";
import { labelledByText } from "./labelled-by";

/**
 * Whether this frame is allowed to receive the decrypted credential. The SW
 * broadcasts the popup fill to every frame in the tab so an embedded login
 * iframe can fill, so each frame self-verifies against its OWN document: a frame
 * fills when its host matches one of the entry's hosts. The top frame also fills
 * when its origin equals `topFrameOrigin`, the exact origin the popup showed the
 * user (a confirmed mismatched or hostless entry). A document that replaced the
 * requested one checks itself here, so a navigation before delivery cannot turn
 * into a fill on another site.
 */
function isFrameAllowedToFill(
  allowedHosts: string[] | undefined,
  topFrameOrigin: string | undefined,
): boolean {
  if (
    window.top === window.self &&
    typeof topFrameOrigin === "string" &&
    self.origin === topFrameOrigin
  ) {
    return true;
  }
  const frameHost = extractHost(window.location.href);
  if (!frameHost) return false;
  return (allowedHosts ?? []).some((h) => isHostMatch(h, frameHost));
}

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

// Input types a username can be written into.
const USERNAME_TYPES = ["text", "email", "tel"];

function isUsableInput(input: HTMLInputElement) {
  return !input.disabled && !input.readOnly;
}

function escapeSelectorValue(value: string): string {
  const esc = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (esc) return esc(value);
  return value.replace(/["\\]/g, "\\$&");
}

function isVisible(input: HTMLInputElement) {
  return (
    getComputedStyle(input).display !== "none" &&
    getComputedStyle(input).visibility !== "hidden"
  );
}

function findPasswordInput(inputs: HTMLInputElement[]) {
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
    if (!USERNAME_TYPES.includes(candidate.type)) return false;

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
      labelledByText(candidate),
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
  if (!USERNAME_TYPES.includes(active.type)) return null;
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
      // The page's own declaration wins over a substring hint ("hotpepper_id"
      // contains "otp"), as it does for findUsernameInput.
      const ac = (i.autocomplete || "").toLowerCase().trim();
      if (ac === "username" || ac === "email") return false;
      const hints = getHints(i);
      return otpHintRe.test(hints) || otpHintJaRe.test(hints);
    }) ?? null
  );
}

// Custom-field and OTP targets: free-text types only, never a password or hidden field.
const TEXT_LIKE_TYPES = ["text", "email", "tel", "number"];
// Every LOGIN-fillable type, for the bounded-root foreign-control check.
const LOGIN_FILLABLE_TYPES = ["text", "email", "tel", "number", "password"];

function isTextLikeTarget(el: FillTarget): boolean {
  return (
    el instanceof HTMLInputElement &&
    isUsableInput(el) &&
    TEXT_LIKE_TYPES.includes(el.type) &&
    isVisible(el)
  );
}

function isPasswordTarget(el: FillTarget): boolean {
  return el instanceof HTMLInputElement && isUsableInput(el) && el.type === "password" && isVisible(el);
}

function isUsernameTarget(el: FillTarget): boolean {
  return (
    el instanceof HTMLInputElement && isUsableInput(el) && USERNAME_TYPES.includes(el.type)
  );
}

function isLoginForeignCandidate(el: FillTarget): boolean {
  return (
    el instanceof HTMLInputElement &&
    isUsableInput(el) &&
    LOGIN_FILLABLE_TYPES.includes(el.type) &&
    isVisible(el)
  );
}

function inputsIn(root: FillRoot): HTMLInputElement[] {
  return Array.from(root.querySelectorAll("input"));
}

function matchesLabel(input: HTMLInputElement, lower: string): boolean {
  return input.id.toLowerCase() === lower || input.name.toLowerCase() === lower;
}

function inDocumentOrder(elements: HTMLInputElement[]): HTMLInputElement[] {
  return [...elements].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

export async function performAutofill(
  payload: AutofillPayload,
  opts: { lateFieldWindowMs?: number } = {},
): Promise<void> {
  // Frame-origin gate: never write the credential into a cross-origin subframe.
  // The newer request still ends this frame's pending fill (FR4).
  if (!isFrameAllowedToFill(payload.allowedHosts, payload.topFrameOrigin)) {
    supersedeActiveFill();
    return;
  }

  // ── T0: every target decision is made here, before the first write ──
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
    USERNAME_TYPES.includes(hintedInput.type)
      ? hintedInput
      : null;

  // Build label→input map for custom fields and identify reserved inputs
  const customFieldMap = new Map<string, HTMLInputElement>();
  if (payload.customFields) {
    for (const { label } of payload.customFields) {
      const lower = label.toLowerCase();
      const target = inputs.find((i) => isTextLikeTarget(i) && matchesLabel(i, lower));
      if (target) customFieldMap.set(lower, target);
    }
  }
  const customFieldTargets = new Set(customFieldMap.values());

  const focusedUsername = findFocusedTextInput();
  // If focused input is reserved for a custom field, don't use it as username target
  const nonCustomFocused =
    focusedUsername && !customFieldTargets.has(focusedUsername) ? focusedUsername : null;
  const nonCustomHinted =
    hintedUsernameInput && !customFieldTargets.has(hintedUsernameInput) ? hintedUsernameInput : null;

  const scopeForm = (nonCustomFocused ?? nonCustomHinted ?? focusedUsername ?? hintedUsernameInput)?.form ?? null;
  const passwordInput =
    (scopeForm
      ? findPasswordInput(
          Array.from(scopeForm.querySelectorAll("input")) as HTMLInputElement[],
        )
      : null) ?? findPasswordInput(inputs);

  // OTP targets are reserved before the username is chosen: the dropdown opens
  // on an OTP field and OTP pages autofocus it, so the focused or hinted field is
  // often the OTP field itself. Writes are write-once, so a username step on it
  // would leave the code unwritten.
  const codeLen = payload.totpCode?.length ?? 0;
  let splitOtpInputs: HTMLInputElement[] | null = null;
  let singleOtpInput: HTMLInputElement | null = null;
  if (payload.totpCode) {
    const otpForm = passwordInput?.form ?? scopeForm;
    const otpScopedInputs = otpForm
      ? (Array.from(otpForm.querySelectorAll("input")) as HTMLInputElement[])
      : null;
    // Try split OTP fields first (e.g. 6 separate single-digit inputs)
    splitOtpInputs =
      (otpScopedInputs ? findSplitOtpInputs(otpScopedInputs, codeLen) : null) ??
      findSplitOtpInputs(inputs, codeLen);
    if (!splitOtpInputs) {
      // Fall back to single OTP field
      singleOtpInput =
        (otpScopedInputs ? findOtpInput(otpScopedInputs) : null) ?? findOtpInput(inputs);
    }
  }
  const otpTargets = new Set<HTMLInputElement>(
    splitOtpInputs ?? (singleOtpInput ? [singleOtpInput] : []),
  );
  const isReserved = (i: HTMLInputElement) => customFieldTargets.has(i) || otpTargets.has(i);

  const effectiveFocusedUsername =
    nonCustomFocused && !otpTargets.has(nonCustomFocused) ? nonCustomFocused : null;
  const effectiveHintedUsername =
    nonCustomHinted && !otpTargets.has(nonCustomHinted) ? nonCustomHinted : null;
  const usernameInput =
    effectiveFocusedUsername ??
    effectiveHintedUsername ??
    findUsernameInput(
      inputs.filter((i) => !isReserved(i)),
      passwordInput,
    );

  const unreservedInputsIn = (root: FillRoot) => inputsIn(root).filter((i) => !isReserved(i));

  // ── Steps, in order: custom fields, username, password, TOTP ──
  // Custom fields go first and the password after the identifiers: a
  // React-controlled password written before the next field's focus() is reset
  // by its own onBlur from stale state (see fill-sequence-lib.ts).
  const steps: FillStep[] = [];

  for (const [index, { label }] of (payload.customFields ?? []).entries()) {
    const lower = label.toLowerCase();
    steps.push({
      key: `custom-${index}`,
      initial: customFieldMap.get(lower) ?? null,
      relocate: (root) =>
        inputsIn(root).find((i) => isTextLikeTarget(i) && matchesLabel(i, lower)) ?? null,
      accepts: isTextLikeTarget,
      write: (el) => setInputValue(el as HTMLInputElement, payload.customFields?.[index]?.value ?? ""),
      release: () => {},
    });
  }

  if (payload.username) {
    steps.push({
      key: "username",
      initial: usernameInput,
      relocate: (root) => {
        const scoped = unreservedInputsIn(root);
        return findUsernameInput(scoped, findPasswordInput(scoped));
      },
      accepts: isUsernameTarget,
      write: (el) => setInputValue(el as HTMLInputElement, payload.username),
      release: () => {},
    });
  }

  if (payload.password) {
    steps.push({
      key: "password",
      initial: passwordInput,
      relocate: (root) => findPasswordInput(inputsIn(root)),
      accepts: isPasswordTarget,
      write: (el) => setInputValue(el as HTMLInputElement, payload.password),
      release: () => {
        payload.password = "";
      },
    });
  }

  if (payload.totpCode) {
    const releaseTotp = () => {
      payload.totpCode = "";
    };

    if (splitOtpInputs) {
      for (let i = 0; i < codeLen; i++) {
        steps.push({
          key: `totp-${i}`,
          initial: splitOtpInputs[i],
          relocate: (root) => findSplitOtpInputs(inputsIn(root), codeLen)?.[i] ?? null,
          accepts: isTextLikeTarget,
          write: (el) => setInputValue(el as HTMLInputElement, payload.totpCode?.[i] ?? ""),
          release: releaseTotp,
        });
      }
    } else {
      steps.push({
        key: "totp",
        initial: singleOtpInput,
        relocate: (root) => findOtpInput(inputsIn(root)),
        accepts: isTextLikeTarget,
        write: (el) => setInputValue(el as HTMLInputElement, payload.totpCode ?? ""),
        release: releaseTotp,
      });
    }
  }

  // ── Root: anchored on the focused/hinted field, else the first identifier,
  // else the password ──
  const identifiers = inDocumentOrder(
    [usernameInput, ...customFieldTargets].filter((i): i is HTMLInputElement => i !== null),
  );
  const anchor =
    effectiveFocusedUsername ??
    effectiveHintedUsername ??
    identifiers[0] ??
    passwordInput ??
    [...otpTargets][0] ??
    null;
  const t0Targets = [usernameInput, passwordInput, ...customFieldTargets, ...otpTargets].filter(
    (i): i is HTMLInputElement => i !== null,
  );
  const { root, reanchor } = anchor
    ? resolveFillRoot(anchor, t0Targets, isLoginForeignCandidate)
    : { root: null, reanchor: () => null };

  return runFillSequence(root, steps, { ...opts, reanchor });
}

// Guard against double-registration when this script is injected more than once
// (manifest content script + programmatic executeScript fallback).
const AUTOFILL_GUARD = "__pssoAutofillHandler";
if (
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage &&
  !(window as unknown as Record<string, boolean>)[AUTOFILL_GUARD]
) {
  (window as unknown as Record<string, boolean>)[AUTOFILL_GUARD] = true;
  chrome.runtime.onMessage.addListener((message: AutofillPayload, sender: chrome.runtime.MessageSender) => {
    // Only accept messages from our own extension — reject external senders
    if (message?.type === AUTOFILL_FILL && sender.id === chrome.runtime.id) {
      performAutofill(message).catch(() => logFillError(FILL_DIAG_CODE.LOGIN_FILL_FAILED));
    }
  });
}
