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
      candidate.getAttribute("aria-label"),
    ]
      .filter((v): v is string => Boolean(v && v.trim()))
      .join(" ")
      .toLowerCase();

    if (!hints) return false;
    if (/\b(search|query|keyword|coupon|promo|otp|code|verification)\b/.test(hints)) {
      return false;
    }
    return /\b(user(name)?|userid|login|email|e-?mail|identifier|account|member|id)\b/.test(
      hints,
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

  if (usernameInput && payload.username) {
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
