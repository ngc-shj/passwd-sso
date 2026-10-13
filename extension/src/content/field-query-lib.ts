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

// ── Visibility ──
//
// Two predicates, chosen by what a denial does at the call site:
// - isFieldVisible: admission, target selection and writes, where "hidden"
//   means "do not fill" — the safe direction.
// - isNotSelfHidden: card-form exclusion and fill-root boundaries, where
//   "hidden" removes a protection — so it stays no stricter than the element's
//   own style.
// A direct-autofill twin of isFieldVisible lives in background/direct-autofill.ts
// (executeScript serializes it with no imports); the parity tests pin the two.

/** Below this opacity (own, or multiplied down the ancestor chain) a field is hidden. */
const MIN_OPACITY = 0.05;
/** A field whose visible box is narrower or shorter than this is hidden. */
const MIN_VISIBLE_PX = 4;

/**
 * Raw computed style and rect per element, for one detection call or finder
 * pass. It never holds a verdict: the options change the verdict for the same
 * element. Never reuse one across fill-sequence ticks — styles change between.
 */
export type VisibilityCache = WeakMap<Element, { style?: CSSStyleDeclaration; rect?: DOMRect }>;

export function createVisibilityCache(): VisibilityCache {
  return new WeakMap();
}

export interface FieldVisibilityOptions {
  /** OTP targets only: single-input OTP widgets overlay an opacity:0 input. */
  transparentOk?: boolean;
  /**
   * Selects only, granted by role: Select2/selectWoo hide the native select
   * with `clip` and a 1px box, and the fill writes it on purpose. Skips the
   * geometry and clip rules; display, visibility, opacity and
   * checkVisibility still apply.
   */
  geometryExempt?: boolean;
  cache?: VisibilityCache;
}

function styleOf(el: Element, cache: VisibilityCache | undefined): CSSStyleDeclaration {
  const entry = cache?.get(el);
  if (entry?.style) return entry.style;
  const style = getComputedStyle(el);
  if (cache) cache.set(el, { ...entry, style });
  return style;
}

function rectOf(el: Element, cache: VisibilityCache | undefined): DOMRect {
  const entry = cache?.get(el);
  if (entry?.rect) return entry.rect;
  const rect = el.getBoundingClientRect();
  if (cache) cache.set(el, { ...entry, rect });
  return rect;
}

/**
 * The next element up the flat (rendered) tree: a slotted element's slot, else
 * its parent, else across a shadow root to its host. A slotted field is
 * clipped by the shadow tree around its slot, not by its light-DOM parent.
 */
function parentOf(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}


const FLOW = 0;
const ABSOLUTE = 1;
const FIXED = 2;

function positionMode(style: CSSStyleDeclaration): number {
  if (style.position === "fixed") return FIXED;
  if (style.position === "absolute") return ABSOLUTE;
  return FLOW;
}

/**
 * Whether an ancestor may be the containing block of its fixed-position (and
 * so also absolute) descendants. Fail-safe: any of these properties off its
 * initial value counts, including values the list does not know, because
 * counting an ancestor as a containing block only keeps its clip applied.
 */
function containsFixed(style: CSSStyleDeclaration): boolean {
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
}

/** Whether an ancestor ends the current escape: it is the escaping box's containing block. */
function endsEscape(mode: number, style: CSSStyleDeclaration): boolean {
  if (mode === FIXED) return containsFixed(style);
  if (mode === ABSOLUTE) return style.position !== "static" || containsFixed(style);
  return true;
}

/**
 * Whether a computed `clip-path` leaves nothing painted: an `inset()` whose
 * opposite percentage insets meet (`inset(50%)`, `inset(100% 0 0)`), or a
 * zero-radius `circle()`. Length insets are not resolved against the box, so
 * an `inset()` in px that covers it is a known gap (plan C1, bypass vi).
 */
function clipPathPaintsNothing(clipPath: string): boolean {
  if (/^circle\(0(px|%)?[\s)]/.test(clipPath)) return true;
  const inset = /^inset\(([^)]*)\)/.exec(clipPath);
  if (!inset) return false;
  const parts = inset[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
  const pct = (token: string | undefined) =>
    token?.endsWith("%") ? Number.parseFloat(token) || 0 : 0;
  // CSS box shorthand: top, right, bottom, left.
  const [top, right = top, bottom = top, left = right] = parts;
  return pct(top) + pct(bottom) >= 100 || pct(left) + pct(right) >= 100;
}

/** A `clip` or `clip-path` that leaves nothing of the element painted. */
function isClippedAway(style: CSSStyleDeclaration): boolean {
  const clip = style.getPropertyValue("clip").trim();
  if (clip && clip !== "auto" && (style.position === "absolute" || style.position === "fixed")) {
    return true;
  }
  const clipPath = style.getPropertyValue("clip-path").trim().toLowerCase();
  return clipPathPaintsNothing(clipPath);
}

const CLIP_NONE = 0;
const CLIP_STRICT = 1;
const CLIP_SCROLL = 2;

function hasPaintContainment(style: CSSStyleDeclaration): boolean {
  const contain = style.getPropertyValue("contain");
  return (
    /\b(paint|strict|content)\b/.test(contain) ||
    style.getPropertyValue("content-visibility").trim() === "auto"
  );
}

/**
 * Whether [start, end) meets the band a scroll container can bring into its
 * window, read from the engine's own scroll offset and extent rather than from
 * a hand-derived scroll direction. Overflow runs one way, and content the
 * engine cannot scroll to is not part of scrollWidth / scrollHeight. The band
 * follows the sign of the engine's offset, which a forward axis keeps in
 * [0, extent − client] and a reversed one in [−(extent − client), 0]: a
 * positive offset takes the forward band, a negative one the reversed band, and
 * an offset at rest (0, where either is possible) their union. So it holds
 * whichever way the axis runs, with no direction derived from CSS.
 */
function meetsScrollBand(
  start: number,
  end: number,
  windowStart: number,
  client: number,
  offset: number,
  extent: number,
): boolean {
  if (!Number.isFinite(offset) || !Number.isFinite(extent)) return false;
  const origin = windowStart - offset;
  const slack = Math.max(0, extent - client);
  const bandStart = offset > 0 ? origin : origin - slack;
  const bandEnd = offset < 0 ? origin + client : origin + Math.max(extent, client);
  return end > bandStart && start < bandEnd;
}

/** How an ancestor clips one axis. Reads the longhands only. */
function axisClip(style: CSSStyleDeclaration, axis: "x" | "y"): number {
  if (hasPaintContainment(style)) return CLIP_STRICT;
  const overflow = style.getPropertyValue(axis === "x" ? "overflow-x" : "overflow-y").trim();
  if (overflow === "hidden" || overflow === "clip") return CLIP_STRICT;
  if (overflow === "scroll" || overflow === "auto") return CLIP_SCROLL;
  return CLIP_NONE;
}

/**
 * Whether some 4×4 part of the element can be on screen: its rect, clipped per
 * axis by every clipping ancestor below <body>. A scroll axis counts the field
 * as scrolled into the container's window, unless that window is itself under
 * 4px. A zero or absent rect denies — there is no layout-less escape.
 */
function hasVisibleBox(el: Element, cache: VisibilityCache | undefined): boolean {
  const rect = rectOf(el, cache);
  let left = rect.left;
  let right = rect.right;
  let top = rect.top;
  let bottom = rect.bottom;
  if (right - left < MIN_VISIBLE_PX || bottom - top < MIN_VISIBLE_PX) return false;

  const doc = el.ownerDocument;
  // Which ancestors clip the box follows the containing-block chain: an in-flow
  // box is clipped by every clipping ancestor; an absolutely positioned one
  // skips static ancestors up to its containing block; a fixed one skips every
  // ancestor up to one that a transform, filter or containment makes its
  // containing block. A box still fixed at the top never scrolls.
  let mode = positionMode(styleOf(el, cache));
  for (let node = parentOf(el); node; node = parentOf(node)) {
    if (node === doc.body || node === doc.documentElement) break;
    const style = styleOf(node, cache);
    // display:contents has no box: it neither clips nor contains.
    if (style.display === "contents") continue;
    // Not the escaping box's containing block: its clip does not apply.
    if (!endsEscape(mode, style)) continue;
    mode = positionMode(style);
    // An inline box can still be a containing block (above), but overflow does
    // not apply to it, and its client size is 0: it clips nothing.
    if (style.display === "inline") continue;
    const box = rectOf(node, cache);

    const x = axisClip(style, "x");
    if (x === CLIP_STRICT) {
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    } else if (x === CLIP_SCROLL) {
      const client = node.clientWidth;
      if (client < MIN_VISIBLE_PX) return false;
      const windowLeft = box.left + node.clientLeft;
      if (!meetsScrollBand(left, right, windowLeft, client, node.scrollLeft, node.scrollWidth)) {
        return false;
      }
      const span = Math.min(right - left, client);
      left = windowLeft;
      right = left + span;
    }
    const y = axisClip(style, "y");
    if (y === CLIP_STRICT) {
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    } else if (y === CLIP_SCROLL) {
      const client = node.clientHeight;
      if (client < MIN_VISIBLE_PX) return false;
      const windowTop = box.top + node.clientTop;
      if (!meetsScrollBand(top, bottom, windowTop, client, node.scrollTop, node.scrollHeight)) {
        return false;
      }
      const span = Math.min(bottom - top, client);
      top = windowTop;
      bottom = top + span;
    }
    if (right - left < MIN_VISIBLE_PX || bottom - top < MIN_VISIBLE_PX) return false;
  }

  const view = doc.defaultView;
  if (mode === FIXED) {
    // Never scrolls into view: the viewport is the bound.
    return (
      right > 0 &&
      bottom > 0 &&
      (!view || (left < view.innerWidth && top < view.innerHeight))
    );
  }
  // Wholly before the document origin cannot be scrolled to.
  return right + (view?.scrollX ?? 0) > 0 && bottom + (view?.scrollY ?? 0) > 0;
}

/**
 * Whether a field may be detected, chosen as a target, or written. A pure AND:
 * every rule can only deny, and none returns true early.
 */
export function isFieldVisible(el: HTMLElement, opts: FieldVisibilityOptions = {}): boolean {
  const { transparentOk = false, geometryExempt = false, cache } = opts;
  // Visibility inherits, so the element's own computed value decides.
  if (styleOf(el, cache).visibility !== "visible") return false;

  let opacity = 1;
  for (let node: Element | null = el; node; node = parentOf(node)) {
    const style = styleOf(node, cache);
    if (style.display === "none") return false;
    if (style.getPropertyValue("content-visibility").trim() === "hidden") return false;
    opacity *= resolveOpacity(style.opacity);
    if (!geometryExempt && isClippedAway(style)) return false;
  }
  if (!transparentOk && opacity <= MIN_OPACITY) return false;

  if (!geometryExempt && !hasVisibleBox(el, cache)) return false;

  // The platform's own answer, where it exists. It can only deny.
  const checkVisibility = (el as { checkVisibility?: (o: object) => boolean }).checkVisibility;
  if (
    typeof checkVisibility === "function" &&
    checkVisibility.call(el, { opacityProperty: !transparentOk, visibilityProperty: true }) === false
  ) {
    return false;
  }
  return true;
}

export type FieldAdmit = (el: HTMLInputElement | HTMLSelectElement) => boolean;

/**
 * Detection's admission rule, with one cache for the scan. Roles are not known
 * at admission, so every select is geometry-exempt; the fill's per-role
 * `accepts` narrow that. Fields it rejects are added to `hidden`, so a detector
 * can tell a later focus on a field it saw hidden (and that may since have been
 * revealed by a rule no mutation shows) from a focus on an unrelated field.
 */
export function fillAdmission(hidden?: WeakSet<Element>): FieldAdmit {
  const cache = createVisibilityCache();
  return (el) => {
    const admitted = isFieldVisible(el, { geometryExempt: el instanceof HTMLSelectElement, cache });
    if (!admitted) hidden?.add(el);
    return admitted;
  };
}

/**
 * The inline dropdown's rule for the focused field and for dropdown
 * membership: the field's own opacity, as before, but not its ancestors'. A
 * fade-in modal focuses its first field while the content is still near
 * opacity 0, and the end of a transition fires no mutation to rescan on. The
 * fill re-checks the full rule (ancestor opacity included) at write time.
 */
export function isDropdownFieldVisible(el: HTMLElement, cache?: VisibilityCache): boolean {
  return isNotSelfHidden(el) && isFieldVisible(el, { transparentOk: true, cache });
}

/** fillAdmission's counterpart for dropdown membership (isDropdownFieldVisible). */
export function memberAdmission(hidden?: WeakSet<Element>): FieldAdmit {
  const cache = createVisibilityCache();
  return (el) => {
    const admitted =
      isNotSelfHidden(el) &&
      isFieldVisible(el, {
        transparentOk: true,
        geometryExempt: el instanceof HTMLSelectElement,
        cache,
      });
    if (!admitted) hidden?.add(el);
    return admitted;
  };
}

/**
 * The element's own display/visibility/opacity only. For exclusion and
 * boundary callers, where a stricter "hidden" would widen what gets filled.
 */
export function isNotSelfHidden(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (resolveOpacity(style.opacity) <= MIN_OPACITY) return false;
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
