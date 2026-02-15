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

  const focusedUsername = findFocusedTextInput();
  const scopeForm = (focusedUsername ?? hintedUsernameInput)?.form ?? null;
  const passwordInput =
    (scopeForm
      ? findPasswordInput(
          Array.from(scopeForm.querySelectorAll("input")) as HTMLInputElement[],
        )
      : null) ?? findPasswordInput(inputs);
  const usernameInput =
    focusedUsername ??
    hintedUsernameInput ??
    findUsernameInput(inputs, passwordInput);

  const host = window.location.hostname.toLowerCase();
  const isAwsSignInPage =
    host === "signin.aws.amazon.com" ||
    host.endsWith(".signin.aws.amazon.com") ||
    host === "sign-in.aws.amazon.com" ||
    host.endsWith(".sign-in.aws.amazon.com");

  const getHints = (input: HTMLInputElement): string => {
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
  };

  const findAwsAccountInput = (): HTMLInputElement | null => {
    return (
      inputs.find((i) => {
        if (!isUsableInput(i) || !["text", "email", "tel"].includes(i.type)) return false;
        return /(account|alias|アカウント|エイリアス)/.test(getHints(i));
      }) ?? null
    );
  };

  const findAwsIamInput = (): HTMLInputElement | null => {
    return (
      inputs.find((i) => {
        if (!isUsableInput(i) || !["text", "email", "tel"].includes(i.type)) return false;
        return /(iam|username|user.?name|ユーザー名|ユーザ名)/.test(getHints(i));
      }) ?? null
    );
  };

  if (isAwsSignInPage) {
    const awsAccountInput = findAwsAccountInput();
    const awsIamInput = findAwsIamInput();
    if (awsAccountInput && payload.awsAccountIdOrAlias) {
      setInputValue(awsAccountInput, payload.awsAccountIdOrAlias);
    }
    if (awsIamInput && (payload.awsIamUsername || payload.username)) {
      setInputValue(awsIamInput, payload.awsIamUsername || payload.username);
    }
  }

  const hasAwsSpecificValues =
    isAwsSignInPage && Boolean(payload.awsAccountIdOrAlias || payload.awsIamUsername);

  if (!hasAwsSpecificValues && usernameInput && payload.username) {
    setInputValue(usernameInput, payload.username);
  }
  if (passwordInput) {
    setInputValue(passwordInput, payload.password);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: AutofillPayload) => {
    if (message?.type === "AUTOFILL_FILL") {
      performAutofill(message);
    }
  });
}
