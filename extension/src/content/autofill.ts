import type { AutofillPayload } from "../types/messages";

function setInputValue(input: HTMLInputElement, value: string) {
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
}

function isUsableInput(input: HTMLInputElement) {
  return !input.disabled && !input.readOnly;
}

function findPasswordInput(inputs: HTMLInputElement[]) {
  const byAutocomplete = inputs.find(
    (i) =>
      isUsableInput(i) &&
      i.type === "password" &&
      i.autocomplete === "current-password"
  );
  if (byAutocomplete) return byAutocomplete;
  const passwordInputs = inputs.filter(
    (i) => isUsableInput(i) && i.type === "password"
  );
  return passwordInputs.length > 0
    ? passwordInputs[passwordInputs.length - 1]
    : null;
}

function findUsernameInput(
  inputs: HTMLInputElement[],
  passwordInput: HTMLInputElement | null
) {
  const byAutocomplete = inputs.find(
    (i) =>
      isUsableInput(i) &&
      (i.type === "text" || i.type === "email") &&
      i.autocomplete === "username"
  );
  if (byAutocomplete) return byAutocomplete;

  if (!passwordInput) return null;
  const index = inputs.indexOf(passwordInput);
  if (index <= 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = inputs[i];
    if (
      isUsableInput(candidate) &&
      (candidate.type === "text" || candidate.type === "email")
    ) {
      return candidate;
    }
  }
  return null;
}

export function performAutofill(payload: AutofillPayload) {
  const inputs = Array.from(
    document.querySelectorAll("input")
  ) as HTMLInputElement[];
  const passwordInput = findPasswordInput(inputs);
  const usernameInput = findUsernameInput(inputs, passwordInput);

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
