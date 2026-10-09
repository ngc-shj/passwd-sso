// Direct LOGIN fill injected with chrome.scripting.executeScript({ func }) when
// the content bundle cannot be reached — notably a content script orphaned by an
// extension reload, whose window guard keys block the re-injected bundle from
// registering listeners.
//
// executeScript serializes this function's source, so it must stay
// self-contained: no imports and no module-scope references.
//
// It duplicates the content-side LOGIN fill on purpose (plan C7 / SC5): it writes
// sequentially, password last, but has no supersession, reference drop or
// dropdown suppression.

export async function directAutofill(
  usernameArg: string,
  passwordArg: string,
  targetHintArg?: {
    id?: string;
    name?: string;
    type?: string;
    autocomplete?: string;
  } | null,
  customFieldsArg?: Array<{ label: string; value: string }>,
): Promise<void> {
  const USERNAME_TYPES = ["text", "email", "tel"];
  const CUSTOM_FIELD_TYPES = ["text", "email", "tel", "number"];
  const PASSWORD_TYPES = ["password"];
  const isUsableInput = (input: HTMLInputElement) =>
    !input.disabled && !input.readOnly;
  const isVisible = (input: HTMLInputElement) =>
    getComputedStyle(input).display !== "none" &&
    getComputedStyle(input).visibility !== "hidden";

  const setInputValue = (input: HTMLInputElement, value: string) => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  };

  const inputs = Array.from(
    document.querySelectorAll("input"),
  ) as HTMLInputElement[];

  const findInputByHint = () => {
    if (!targetHintArg) return null;
    return (
      inputs.find((i) => !!targetHintArg.id && i.id === targetHintArg.id) ??
      inputs.find((i) => !!targetHintArg.name && i.name === targetHintArg.name) ??
      inputs.find(
        (i) =>
          !!targetHintArg.autocomplete &&
          i.autocomplete === targetHintArg.autocomplete &&
          (!targetHintArg.type || i.type === targetHintArg.type),
      ) ??
      null
    );
  };

  const active = document.activeElement;
  const hintedInput = findInputByHint();
  const usernameInput: HTMLInputElement | null =
    hintedInput instanceof HTMLInputElement &&
    isUsableInput(hintedInput) &&
    USERNAME_TYPES.includes(hintedInput.type)
      ? hintedInput
      : active instanceof HTMLInputElement &&
          isUsableInput(active) &&
          USERNAME_TYPES.includes(active.type)
        ? active
        : null;

  const findPasswordInScope = (scopeInputs: HTMLInputElement[]) => {
    const byAutocomplete = scopeInputs.find(
      (i) =>
        isUsableInput(i) &&
        i.type === "password" &&
        isVisible(i) &&
        i.autocomplete === "current-password",
    );
    if (byAutocomplete) return byAutocomplete;
    const pwInputs = scopeInputs.filter(
      (i) => isUsableInput(i) && i.type === "password" && isVisible(i),
    );
    return pwInputs.length ? pwInputs[pwInputs.length - 1] : null;
  };

  const scopeForm = (usernameInput ?? hintedInput)?.form ?? null;
  const scopedInputs = scopeForm
    ? (Array.from(scopeForm.querySelectorAll("input")) as HTMLInputElement[])
    : inputs;
  const passwordInput =
    findPasswordInScope(scopedInputs) ?? findPasswordInScope(inputs);

  let fallbackUsername = usernameInput;
  if (!fallbackUsername && passwordInput) {
    const pwIndex = inputs.indexOf(passwordInput);
    for (let i = pwIndex - 1; i >= 0; i -= 1) {
      const c = inputs[i];
      if (
        isUsableInput(c) &&
        USERNAME_TYPES.includes(c.type)
      ) {
        fallbackUsername = c;
        break;
      }
    }
  }

  // Targets are fixed here, before the first write. Order: custom fields,
  // username, password — a React-controlled password written before the
  // next field's focus() loses its value to its own onBlur.
  const writes: Array<{ input: HTMLInputElement; value: string; types: string[] }> = [];

  // Custom fields match label to input id/name
  const cfTargets = new Set<HTMLInputElement>();
  if (customFieldsArg) {
    for (const { label, value } of customFieldsArg) {
      const lower = label.toLowerCase();
      const target = inputs.find(
        (i) =>
          isUsableInput(i) &&
          CUSTOM_FIELD_TYPES.includes(i.type) &&
          isVisible(i) &&
          (i.id.toLowerCase() === lower || i.name.toLowerCase() === lower),
      );
      if (target) {
        cfTargets.add(target);
        writes.push({ input: target, value, types: CUSTOM_FIELD_TYPES });
      }
    }
  }

  // Skip username fill if target is reserved for a custom field
  if (fallbackUsername && usernameArg && !cfTargets.has(fallbackUsername)) {
    writes.push({ input: fallbackUsername, value: usernameArg, types: USERNAME_TYPES });
  }
  if (passwordInput && passwordArg) {
    writes.push({ input: passwordInput, value: passwordArg, types: PASSWORD_TYPES });
  }

  // One field per task. The page runs during each yield, so re-check the
  // target in the same task as its write.
  for (let i = 0; i < writes.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0));
    const { input, value, types } = writes[i];
    if (
      !input.isConnected ||
      !types.includes(input.type) ||
      !isUsableInput(input) ||
      !isVisible(input)
    ) {
      continue;
    }
    setInputValue(input, value);
  }
}
