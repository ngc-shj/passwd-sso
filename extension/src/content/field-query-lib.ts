// Pure field-query helpers shared by every detector (LOGIN, CC, identity) and
// the card-field detection. A leaf module: it imports nothing from content/, so
// any detector can depend on it without forming a cycle.

export function isUsableInput(input: HTMLInputElement): boolean {
  return !input.disabled && !input.readOnly;
}

/**
 * Whether a field may receive autofill. An input must resolve to one of the
 * caller's `allowedTypes` (a fail-closed allowlist that keeps radio/checkbox/
 * hidden/submit and unknown future types out — see the identity/CC detectors),
 * and be enabled and writable. Selects have no `type` and are gated on enabled
 * only. `allowedTypes` differs per detector (identity vs CC), so it is passed in.
 */
export function isUsableFieldOfType(
  el: HTMLInputElement | HTMLSelectElement,
  allowedTypes: ReadonlySet<string>,
): boolean {
  if (el instanceof HTMLInputElement) {
    return allowedTypes.has(el.type) && !el.disabled && !el.readOnly;
  }
  return !el.disabled;
}

export function resolveOpacity(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

// isElementVisible is the DETECTION-time visibility check — intentionally
// looser than isElementVisuallySafe (it omits the clipPath/transform anti-
// spoofing checks the display-safety gate applies). Keep the two distinct.

export function isElementVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (resolveOpacity(style.opacity) <= 0.05) return false;
  return true;
}

export function getHintString(el: HTMLElement): string {
  const parts: string[] = [];
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
    if (el.name) parts.push(el.name);
    if (el.id) parts.push(el.id);
    if (el instanceof HTMLInputElement && el.placeholder) parts.push(el.placeholder);
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) parts.push(ariaLabel);
  // Walk up to find associated label
  const id = el.id;
  if (id && typeof CSS !== "undefined" && CSS.escape) {
    const label = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent) parts.push(label.textContent);
  }
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent) parts.push(parentLabel.textContent);
  return parts.join(" ").toLowerCase();
}

// Module-private: only findFieldByAutocomplete consumes it. The detectors
// resolve autocomplete matches through that helper, never directly.
function getAutocomplete(el: HTMLElement): string {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase().trim();
}

/** Find the first usable field whose autocomplete attribute equals acValue.
 * `isUsable` is the caller's per-detector fillable-type predicate (required —
 * a missing predicate is a compile error, keeping the #717 fail-closed gate). */
export function findFieldByAutocomplete(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  acValue: string,
  isUsable: (el: HTMLInputElement | HTMLSelectElement) => boolean,
): HTMLInputElement | HTMLSelectElement | null {
  return fields.find((f) => getAutocomplete(f) === acValue && isUsable(f)) ?? null;
}

/** Find the first usable field whose hint matches the latin or JA regex. */
export function findFieldByRegex(
  fields: (HTMLInputElement | HTMLSelectElement)[],
  regex: RegExp,
  regexJa: RegExp,
  isUsable: (el: HTMLInputElement | HTMLSelectElement) => boolean,
): HTMLInputElement | HTMLSelectElement | null {
  return (
    fields.find((f) => {
      if (!isUsable(f)) return false;
      const hint = getHintString(f);
      return regex.test(hint) || regexJa.test(hint);
    }) ?? null
  );
}
