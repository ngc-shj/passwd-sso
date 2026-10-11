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
//
// It also re-implements, inline, the content side's card-form exclusion
// (ccFormFields + isLoginEligible in content/): a masked CVV of the card form is
// never the password target and a card field never the username target, unless
// the page declares a LOGIN autocomplete. The patterns and tokens arrive as args
// from lib/cc-patterns.ts, so only the matching code is duplicated; a parity test
// pins the two implementations to the same targets. Without the pattern args
// (older callers) no exclusion runs.

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
  ccPatternsArg?: {
    number: Array<{ source: string; flags: string }>;
    neighbour: Array<{ source: string; flags: string }>;
    fillableTypes: string[];
  } | null,
  loginTokensArg?: string[] | null,
): Promise<void> {
  const USERNAME_TYPES = ["text", "email", "tel"];
  const CUSTOM_FIELD_TYPES = ["text", "email", "tel", "number"];
  const PASSWORD_TYPES = ["password"];
  const isUsableInput = (input: HTMLInputElement) =>
    !input.disabled && !input.readOnly;
  // Same rule as the content side's isElementVisible: hidden, or near-transparent.
  const isVisible = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = Number.parseFloat(style.opacity);
    return !(Number.isFinite(opacity) && opacity <= 0.05);
  };

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

  // ── The card form (mirror of ccFormFields; see the header) ──
  type Field = HTMLInputElement | HTMLSelectElement;
  const toRegExps = (list: Array<{ source: string; flags: string }> | undefined) =>
    (list ?? []).map(({ source, flags }) => new RegExp(source, flags));
  const numberPatterns = toRegExps(ccPatternsArg?.number);
  const neighbourPatterns = toRegExps(ccPatternsArg?.neighbour);
  const loginTokens = loginTokensArg ?? [];
  const autocompleteTokens = (el: Element) =>
    (el.getAttribute("autocomplete") ?? "").toLowerCase().trim().split(/\s+/);
  const hintOf = (el: Field) => {
    const parts: string[] = [];
    if (el.name) parts.push(el.name);
    if (el.id) parts.push(el.id);
    if (el instanceof HTMLInputElement && el.placeholder) parts.push(el.placeholder);
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) parts.push(ariaLabel);
    const id = el.id;
    if (id && typeof CSS !== "undefined" && CSS.escape) {
      const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label?.textContent) parts.push(label.textContent);
    }
    const parentLabel = el.closest("label");
    if (parentLabel?.textContent) parts.push(parentLabel.textContent);
    return parts.join(" ").toLowerCase();
  };
  const isCardFillable = (el: Field) =>
    isVisible(el) &&
    (el instanceof HTMLInputElement
      ? (ccPatternsArg?.fillableTypes ?? []).includes(el.type) && !el.disabled && !el.readOnly
      : !el.disabled);
  const hasCcToken = (el: Field) => autocompleteTokens(el).some((t) => t.startsWith("cc-"));
  const allFields: Field[] = [
    ...inputs,
    ...(Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]),
  ];
  const cardForm = new Set<Field>(ccPatternsArg ? allFields.filter(hasCcToken) : []);
  if (ccPatternsArg) {
    const candidates = allFields.filter(isCardFillable);
    const cardNumber =
      candidates.find(
        (el) => (el.getAttribute("autocomplete") ?? "").toLowerCase().trim() === "cc-number",
      ) ??
      candidates.find((el) => numberPatterns.some((re) => re.test(hintOf(el)))) ??
      null;
    if (cardNumber) {
      const neighbours = allFields.filter(
        (el) =>
          el !== cardNumber &&
          isCardFillable(el) &&
          (hasCcToken(el) || neighbourPatterns.some((re) => re.test(hintOf(el)))),
      );
      let inBlock: ((el: Field) => boolean) | null = null;
      const form = cardNumber.form;
      if (form) {
        const inForm = (el: Field) => el.form === form || form.contains(el);
        if (neighbours.some(inForm)) inBlock = inForm;
      }
      if (!inBlock) {
        const sameFormOrNone = neighbours.filter((el) => el.form === null || el.form === form);
        for (
          let ancestor = cardNumber.parentElement;
          ancestor && ancestor !== document.body && ancestor !== document.documentElement;
          ancestor = ancestor.parentElement
        ) {
          const block = ancestor;
          if (sameFormOrNone.some((el) => block.contains(el))) {
            inBlock = (el) => sameFormOrNone.includes(el) && block.contains(el);
            break;
          }
        }
      }
      if (inBlock) {
        cardForm.add(cardNumber);
        for (const el of neighbours) if (inBlock(el)) cardForm.add(el);
      }
    }
  }
  const isLoginEligible = (el: HTMLInputElement) =>
    !cardForm.has(el) || autocompleteTokens(el).some((t) => loginTokens.includes(t));

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
    USERNAME_TYPES.includes(hintedInput.type) &&
    isLoginEligible(hintedInput)
      ? hintedInput
      : active instanceof HTMLInputElement &&
          isUsableInput(active) &&
          USERNAME_TYPES.includes(active.type) &&
          isLoginEligible(active)
        ? active
        : null;

  const findPasswordInScope = (allScopeInputs: HTMLInputElement[]) => {
    const scopeInputs = allScopeInputs.filter(isLoginEligible);
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
        USERNAME_TYPES.includes(c.type) &&
        isLoginEligible(c)
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
