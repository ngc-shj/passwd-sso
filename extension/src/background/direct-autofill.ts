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
//
// Its field-visibility rule mirrors content isFieldVisible (field-query-lib.ts)
// the same way, pinned by the same parity tests.

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
  const resolveOpacity = (value: string) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 1;
  };
  // Mirror of content isNotSelfHidden: the element's own style only. For the
  // card-form exclusion, where a stricter "hidden" would un-exclude a CVV.
  const isNotSelfHidden = (el: HTMLElement) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return resolveOpacity(style.opacity) > 0.05;
  };
  // Mirror of content isFieldVisible (field-query-lib.ts) without its options:
  // this fill writes no selects and no OTP. A pure AND; a zero rect denies.
  const MIN_VISIBLE_PX = 4;
  // The flat (rendered) tree: a slotted element's slot first.
  const parentOf = (el: Element): Element | null => {
    if (el.assignedSlot) return el.assignedSlot;
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const isClippedAway = (style: CSSStyleDeclaration) => {
    const clip = style.getPropertyValue("clip").trim();
    if (clip && clip !== "auto" && (style.position === "absolute" || style.position === "fixed")) {
      return true;
    }
    const clipPath = style.getPropertyValue("clip-path").trim().toLowerCase();
    // Mirror of content clipPathPaintsNothing.
    if (/^circle\(0(px|%)?[\s)]/.test(clipPath)) return true;
    const inset = /^inset\(([^)]*)\)/.exec(clipPath);
    if (!inset) return false;
    const parts = inset[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
    const pct = (token: string | undefined) =>
      token?.endsWith("%") ? Number.parseFloat(token) || 0 : 0;
    const [top, right = top, bottom = top, left = right] = parts;
    return pct(top) + pct(bottom) >= 100 || pct(left) + pct(right) >= 100;
  };
  // 0 none, 1 strict clip, 2 scroll window
  const axisClip = (style: CSSStyleDeclaration, axis: "x" | "y") => {
    if (
      /\b(paint|strict|content)\b/.test(style.getPropertyValue("contain")) ||
      style.getPropertyValue("content-visibility").trim() === "auto"
    ) {
      return 1;
    }
    const overflow = style.getPropertyValue(axis === "x" ? "overflow-x" : "overflow-y").trim();
    if (overflow === "hidden" || overflow === "clip") return 1;
    if (overflow === "scroll" || overflow === "auto") return 2;
    return 0;
  };
  // Mirror of content containsFixed: fail-safe, any listed property off its
  // initial value counts as a containing block.
  const containsFixed = (style: CSSStyleDeclaration) => {
    const offInitial = (property: string, ...initial: string[]) => {
      const value = style.getPropertyValue(property).trim();
      return value !== "" && !initial.includes(value);
    };
    return (
      offInitial("transform", "none") ||
      offInitial("translate", "none") ||
      offInitial("rotate", "none") ||
      offInitial("scale", "none") ||
      offInitial("perspective", "none") ||
      offInitial("filter", "none") ||
      offInitial("backdrop-filter", "none") ||
      offInitial("offset-path", "none") ||
      offInitial("transform-style", "flat") ||
      offInitial("contain", "none") ||
      offInitial("content-visibility", "visible") ||
      offInitial("container-type", "normal") ||
      offInitial("will-change", "auto")
    );
  };
  // 0 in flow, 1 absolute, 2 fixed
  const positionMode = (style: CSSStyleDeclaration) =>
    style.position === "fixed" ? 2 : style.position === "absolute" ? 1 : 0;
  const hasVisibleBox = (el: Element) => {
    const rect = el.getBoundingClientRect();
    let left = rect.left;
    let right = rect.right;
    let top = rect.top;
    let bottom = rect.bottom;
    if (right - left < MIN_VISIBLE_PX || bottom - top < MIN_VISIBLE_PX) return false;
    let mode = positionMode(getComputedStyle(el));
    for (let node = parentOf(el); node; node = parentOf(node)) {
      if (node === document.body || node === document.documentElement) break;
      const style = getComputedStyle(node);
      if (style.display === "contents") continue;
      const endsEscape =
        mode === 2
          ? containsFixed(style)
          : mode === 1
            ? style.position !== "static" || containsFixed(style)
            : true;
      if (!endsEscape) continue;
      mode = positionMode(style);
      if (style.display === "inline") continue;
      const box = node.getBoundingClientRect();
      const x = axisClip(style, "x");
      if (x === 1) {
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      } else if (x === 2) {
        const client = node.clientWidth;
        if (client < MIN_VISIBLE_PX) return false;
        const windowLeft = box.left + node.clientLeft;
        const unreachable =
          style.direction === "rtl"
            ? left >= windowLeft + client - node.scrollLeft
            : right <= windowLeft - node.scrollLeft;
        if (!Number.isFinite(windowLeft - node.scrollLeft) || unreachable) return false;
        const span = Math.min(right - left, client);
        left = windowLeft;
        right = left + span;
      }
      const y = axisClip(style, "y");
      if (y === 1) {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      } else if (y === 2) {
        const client = node.clientHeight;
        if (client < MIN_VISIBLE_PX) return false;
        const windowTop = box.top + node.clientTop;
        if (!Number.isFinite(windowTop - node.scrollTop) || bottom <= windowTop - node.scrollTop) {
          return false;
        }
        const span = Math.min(bottom - top, client);
        top = windowTop;
        bottom = top + span;
      }
      if (right - left < MIN_VISIBLE_PX || bottom - top < MIN_VISIBLE_PX) return false;
    }
    if (mode === 2) {
      return right > 0 && bottom > 0 && left < window.innerWidth && top < window.innerHeight;
    }
    return right + window.scrollX > 0 && bottom + window.scrollY > 0;
  };
  const isVisible = (el: HTMLElement) => {
    if (getComputedStyle(el).visibility !== "visible") return false;
    let opacity = 1;
    for (let node: Element | null = el; node; node = parentOf(node)) {
      const style = getComputedStyle(node);
      if (style.display === "none") return false;
      if (style.getPropertyValue("content-visibility").trim() === "hidden") return false;
      opacity *= resolveOpacity(style.opacity);
      if (isClippedAway(style)) return false;
    }
    if (opacity <= 0.05) return false;
    if (!hasVisibleBox(el)) return false;
    const checkVisibility = (el as { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (
      typeof checkVisibility === "function" &&
      checkVisibility.call(el, { opacityProperty: true, visibilityProperty: true }) === false
    ) {
      return false;
    }
    return true;
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
  const isCardUsable = (el: Field) =>
    el instanceof HTMLInputElement
      ? (ccPatternsArg?.fillableTypes ?? []).includes(el.type) && !el.disabled && !el.readOnly
      : !el.disabled;
  // Mirror of content isCreditCardCandidate: the own-style rule.
  const isCardFillable = (el: Field) => isNotSelfHidden(el) && isCardUsable(el);
  const hasCcToken = (el: Field) => autocompleteTokens(el).some((t) => t.startsWith("cc-"));
  const allFields: Field[] = [
    ...inputs,
    ...(Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]),
  ];
  const cardForm = new Set<Field>(ccPatternsArg ? allFields.filter(hasCcToken) : []);
  if (ccPatternsArg) {
    // Mirror of ccCardBlockFields: the union of the blocks around every
    // card-number candidate under the own-style rule.
    const anchors = allFields.filter(
      (el) =>
        el instanceof HTMLInputElement &&
        isCardFillable(el) &&
        ((el.getAttribute("autocomplete") ?? "").toLowerCase().trim() === "cc-number" ||
          numberPatterns.some((re) => re.test(hintOf(el)))),
    );
    for (const cardNumber of anchors) {
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
    isLoginEligible(hintedInput) &&
    isVisible(hintedInput)
      ? hintedInput
      : active instanceof HTMLInputElement &&
          isUsableInput(active) &&
          USERNAME_TYPES.includes(active.type) &&
          isLoginEligible(active) &&
          isVisible(active)
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

  // A hinted field of the card form, or a hidden one, does not scope the search,
  // as on the content side.
  const hintedScope =
    hintedInput instanceof HTMLInputElement && isLoginEligible(hintedInput) && isVisible(hintedInput)
      ? hintedInput
      : null;
  const scopeForm = (usernameInput ?? hintedScope)?.form ?? null;
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
        isLoginEligible(c) &&
        isVisible(c)
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
