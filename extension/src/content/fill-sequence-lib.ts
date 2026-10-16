// Sequential writer for every autofill kind (LOGIN, credit card, identity).
//
// Why writes are spread over tasks: a React-controlled field's onBlur runs before
// React commits a value written in the same task, so writing the next field in that
// task resets the previous one (Sony Bank login). And a page that creates fields
// in response to an earlier write (#654) needs the sequence to wait for them.
//
// Why targets are fixed at T0: re-detection after a write would let the page — or
// our own focus movement — steer a later secret into a field it chose. Re-detection
// may only re-validate a T0 element or find a late field inside the T0 root.
//
// See docs/archive/review/autofill-sequential-fill-plan.md (C1, C1a).

import { FILL_DIAG_CODE, logFillError, type FillDiagCode } from "./select-diag-lib";

export type FillTarget = HTMLInputElement | HTMLSelectElement;

export type FillRoot = ParentNode & Node;

export type FillStep = {
  key: string;
  /** Chosen at T0; null means the step is deferred. */
  initial: FillTarget | null;
  /** Structural lookup inside the T0 root. Must not consult focus. */
  relocate?: (root: FillRoot) => FillTarget | null;
  /** Type allowlist + visibility + usable. */
  accepts: (el: FillTarget) => boolean;
  /**
   * Reads the payload lazily at write time. Returns whether the field now holds
   * the value; false (a select with no matching option) counts as not filled.
   */
  write: (el: FillTarget) => boolean;
  /** Drops this step's payload reference. Called exactly once, at exit. */
  release: () => void;
};

export type FillSequenceOptions = {
  lateFieldWindowMs?: number;
  /** Recomputes the root when the T0 root has been detached (see resolveFillRoot). */
  reanchor?: () => FillRoot | null;
};

export const DEFAULT_LATE_FIELD_WINDOW_MS = 1000;

// A waiting step can become acceptable without any mutation under <body> (a
// CSS transition, a stylesheet or <html> class change), so waiting steps are
// also re-checked on this interval until the deadline.
export const WAITING_POLL_MS = 100;

const SUPERSEDING_INPUT_EVENTS = ["keydown", "pointerdown", "paste"] as const;

// Exported: the CC and identity detectors' attribute-rescan observers filter
// on the same set, so a reveal via any of these attributes is caught
// everywhere a field's membership can change.
export const OBSERVED_ATTRIBUTES: readonly string[] = [
  "disabled",
  "readonly",
  "hidden",
  "style",
  "class",
  "type",
  // <dialog> / <details> reveal their content by toggling `open`.
  "open",
];

type StepState = "pending" | "waiting" | "written" | "abandoned";

type ActiveRun = { checkGeneration: () => void; isActive: () => boolean };

// One generation per frame, shared by every fill kind, so a new run of any kind
// supersedes the pending one. The page cannot reach this counter.
let currentGeneration = 0;
let activeRun: ActiveRun | null = null;

export function isFillActive(): boolean {
  return activeRun !== null && activeRun.isActive();
}

function supersedeActiveRun(): void {
  currentGeneration++;
  activeRun?.checkGeneration();
}

/**
 * Supersedes the active run without starting one. A fill request whose T0
 * detection finds nothing to fill still ends the earlier run, so no
 * earlier step can write after a newer request.
 */
export function supersedeActiveFill(): void {
  supersedeActiveRun();
}

/**
 * Runs the steps and resolves, once the run ends, with the number of steps it
 * wrote: the fill's own report of what landed (0 when superseded before any
 * write, or when nothing was found).
 */
export function runFillSequence(
  root: FillRoot | null,
  steps: FillStep[],
  opts: FillSequenceOptions = {},
): Promise<number> {
  supersedeActiveRun();
  const runGeneration = currentGeneration;
  const deadline =
    performance.now() + (opts.lateFieldWindowMs ?? DEFAULT_LATE_FIELD_WINDOW_MS);

  // Two steps that chose the same element at T0: the first one owns it, and the
  // later one ends at once instead of waiting out the window for a field it can
  // never write (write-once).
  const states: StepState[] = steps.map((step, i) =>
    step.initial && steps.slice(0, i).some((earlier) => earlier.initial === step.initial)
      ? "abandoned"
      : "pending",
  );
  // Fields a step has claimed (write-once), whether or not its write took.
  const written = new Set<FillTarget>();
  // Writes that took: the run's answer (C5). A write that throws ends the run
  // before it is counted.
  let filledCount = 0;
  let currentRoot = root;
  let exited = false;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  // setTimeout truncates a fractional delay, so the handler can run just before
  // performance.now() reaches the deadline; once it has run, the deadline holds.
  let deadlineReached = false;
  let observer: MutationObserver | null = null;
  let resolveRun!: (filled: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveRun = resolve;
  });

  const isCurrent = () => runGeneration === currentGeneration && !exited;
  const isPastDeadline = () => deadlineReached || performance.now() >= deadline;

  const onUserInput = (e: Event) => {
    if (!e.isTrusted) return;
    if (e.type === "keydown" && (e as KeyboardEvent).repeat) return;
    if (!isCurrent()) return;
    supersedeActiveRun();
  };

  function exit(errorCode?: FillDiagCode): void {
    if (exited) return;
    exited = true;
    observer?.disconnect();
    observer = null;
    if (tickTimer !== null) clearTimeout(tickTimer);
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    if (pollTimer !== null) clearTimeout(pollTimer);
    tickTimer = null;
    deadlineTimer = null;
    pollTimer = null;
    for (const type of SUPERSEDING_INPUT_EVENTS) {
      window.removeEventListener(type, onUserInput, true);
    }
    if (activeRun === run) activeRun = null;
    let releaseFailed = false;
    for (const step of steps) {
      try {
        step.release();
      } catch {
        releaseFailed = true;
      }
    }
    if (errorCode) logFillError(errorCode);
    else if (releaseFailed) logFillError(FILL_DIAG_CODE.RELEASE_ERROR);
    resolveRun(filledCount);
  }

  function guarded(fn: () => void): () => void {
    return () => {
      try {
        fn();
      } catch {
        exit(FILL_DIAG_CODE.SEQUENCE_ERROR);
      }
    };
  }

  function hasOpenSteps(): boolean {
    return states.some((s) => s === "pending" || s === "waiting");
  }

  function scheduleTick(): void {
    if (exited || tickTimer !== null) return;
    tickTimer = setTimeout(guarded(tick), 0);
  }

  // Like the observer, the poll only schedules the loop.
  function schedulePoll(): void {
    if (exited || pollTimer !== null || isPastDeadline()) return;
    pollTimer = setTimeout(
      guarded(() => {
        pollTimer = null;
        scheduleTick();
      }),
      WAITING_POLL_MS,
    );
  }

  function resolvedRoot(): FillRoot | null {
    if (currentRoot && !currentRoot.isConnected) {
      currentRoot = opts.reanchor ? opts.reanchor() : null;
    }
    return currentRoot;
  }

  // A waiting step (deferred, detached, or failing `accepts` at its turn) is
  // deadline-bound, including a later write to its own initial element.
  function resolveWaiting(index: number): FillTarget | null {
    const step = steps[index];
    if (isPastDeadline()) return null;
    const initial = step.initial;
    if (initial && initial.isConnected && !written.has(initial) && step.accepts(initial)) {
      return initial;
    }
    const scope = resolvedRoot();
    if (!scope || !step.relocate) return null;
    const el = step.relocate(scope);
    if (!el || !el.isConnected || !scope.contains(el)) return null;
    // The field it relocates to is owned by the step that wrote it (first wins).
    if (written.has(el)) {
      states[index] = "abandoned";
      return null;
    }
    if (!step.accepts(el)) return null;
    return el;
  }

  // Same synchronous task as the write: generation, connection, accepts, write-once.
  // The deadline part of the check sits in resolveWaiting for waiting steps.
  function writeStep(index: number, el: FillTarget): void {
    const step = steps[index];
    if (!isCurrent() || !el.isConnected || written.has(el) || !step.accepts(el)) return;
    written.add(el);
    states[index] = "written";
    if (step.write(el)) filledCount++;
  }

  function tick(): void {
    tickTimer = null;
    if (!isCurrent()) {
      exit();
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (states[i] === "pending") {
        const initial = step.initial;
        if (initial && initial.isConnected && !written.has(initial) && step.accepts(initial)) {
          writeStep(i, initial);
          scheduleTick();
          return;
        }
        // A step that would start waiting at or after the deadline could never
        // be woken (the deadline handler has already run), so it ends here.
        states[i] = isPastDeadline() ? "abandoned" : "waiting";
      }
      if (states[i] === "waiting") {
        const el = resolveWaiting(i);
        if (el) {
          writeStep(i, el);
          scheduleTick();
          return;
        }
      }
    }
    if (!hasOpenSteps()) {
      exit();
      return;
    }
    if (states.includes("waiting")) schedulePoll();
  }

  function onDeadline(): void {
    deadlineTimer = null;
    deadlineReached = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    if (!isCurrent()) {
      exit();
      return;
    }
    for (let i = 0; i < states.length; i++) {
      if (states[i] === "waiting") states[i] = "abandoned";
    }
    observer?.disconnect();
    observer = null;
    if (!hasOpenSteps()) exit();
  }

  const run: ActiveRun = {
    checkGeneration: () => {
      if (!isCurrent()) exit();
    },
    isActive: isCurrent,
  };
  activeRun = run;

  try {
    for (const type of SUPERSEDING_INPUT_EVENTS) {
      window.addEventListener(type, onUserInput, true);
    }
    if (document.body) {
      // The callback is a microtask and may land in the same task as a write, so
      // it only schedules the loop; every write runs from the sequencer's own task.
      observer = new MutationObserver(
        guarded(() => {
          if (!isCurrent()) {
            exit();
            return;
          }
          scheduleTick();
        }),
      );
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [...OBSERVED_ATTRIBUTES],
      });
    }
    scheduleTick();
    deadlineTimer = setTimeout(
      guarded(onDeadline),
      Math.max(0, Math.ceil(deadline - performance.now())),
    );
  } catch {
    exit(FILL_DIAG_CODE.SEQUENCE_ERROR);
  }

  return done;
}

const IGNORED_INPUT_TYPES = new Set(["hidden", "submit", "button", "checkbox"]);

function collectForeignControls(
  doc: Document,
  t0Targets: readonly Element[],
  isForeignCandidate: (el: FillTarget) => boolean,
): Element[] {
  const own = new Set<Element>(t0Targets);
  const foreign: Element[] = [];
  for (const el of doc.querySelectorAll<FillTarget>("input, select")) {
    if (own.has(el)) continue;
    if (el instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(el.type)) continue;
    if (isForeignCandidate(el)) foreign.push(el);
  }
  return foreign;
}

function climb(anchor: Element, foreign: readonly Element[]): HTMLElement | null {
  const doc = anchor.ownerDocument;
  let best: HTMLElement | null = null;
  for (
    let cur = anchor.parentElement;
    cur && cur !== doc.documentElement;
    cur = cur.parentElement
  ) {
    if (foreign.some((f) => cur!.contains(f))) break;
    best = cur;
    if (cur === doc.body) break;
  }
  return best;
}

/**
 * The highest ancestor of `anchor` that contains no foreign control at T0, at most
 * `body` and never `html`. A foreign control is an input/select that is not one of
 * the sequence's T0 targets and that `isForeignCandidate` (the kind's own visible +
 * usable + allowlisted-type predicate) admits; hidden, submit, button and checkbox
 * inputs never count. Returns null when even the anchor's parent holds one.
 */
export function boundedRoot(
  anchor: Element,
  t0Targets: readonly Element[],
  isForeignCandidate: (el: FillTarget) => boolean,
): HTMLElement | null {
  if (!anchor.isConnected) return null;
  return climb(anchor, collectForeignControls(anchor.ownerDocument, t0Targets, isForeignCandidate));
}

/**
 * The T0 root plus the re-anchoring rule: when the root is detached, the root is
 * recomputed from the anchor if it is still connected, against the foreign-control
 * set captured at T0 (controls re-rendered since then drop out of it); otherwise null.
 */
export function resolveFillRoot(
  anchor: Element,
  t0Targets: readonly Element[],
  isForeignCandidate: (el: FillTarget) => boolean,
): { root: HTMLElement | null; reanchor: () => HTMLElement | null } {
  if (!anchor.isConnected) return { root: null, reanchor: () => null };
  const foreign = collectForeignControls(anchor.ownerDocument, t0Targets, isForeignCandidate);
  return {
    root: climb(anchor, foreign),
    reanchor: () => (anchor.isConnected ? climb(anchor, foreign) : null),
  };
}

/** Test-only: ends any active run and resets the frame generation. */
export function __resetFillSequenceForTests(): void {
  supersedeActiveRun();
  activeRun = null;
  currentGeneration = 0;
}

// ── Focus scope (card and identity fill) ──

export interface FocusScope<T> {
  detect: (root: ParentNode) => T | null;
  /** Role elements in a fixed role order, so two detections compare by index. */
  roles: (fields: T) => readonly (Element | null)[];
  /** Whether a detection is enough to start from (the CC fill needs a card number). */
  anchors: (fields: T) => boolean;
  /** Whether a detection beside the held one is a second block, not a duplicate field. */
  competes: (other: T, held: T) => boolean;
}

function holdsSameRoles(held: readonly (Element | null)[], next: readonly (Element | null)[]): boolean {
  return held.every((el, i) => el === null || next[i] === el);
}

/**
 * The detection for the block the user is in: the focused field's lowest
 * ancestor whose detection anchors, widened while no role it holds moves to
 * another element and no sibling branch holds a competing block. Capped at the
 * focused field's form and kept below <body>. Without a focused field, or with
 * none that anchors, the whole document — the fill's behaviour before focus
 * scoping. The popup and the inline dropdown leave the page's focus in place,
 * and a right-click focuses the field, so activeElement is the requester.
 */
export function focusScopedFields<T>(scope: FocusScope<T>): T | null {
  const doc = document;
  const active = doc.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement)) {
    return scope.detect(doc);
  }
  const cap = active.form;
  const isTop = (el: Element) => el === doc.body || el === doc.documentElement;

  let root: Element | null = null;
  let held: T | null = null;
  for (let node = active.parentElement; node && !isTop(node); node = node.parentElement) {
    const fields = scope.detect(node);
    if (fields && scope.anchors(fields)) {
      root = node;
      held = fields;
      break;
    }
    if (node === cap) break;
  }
  if (!root || !held) return scope.detect(doc);

  while (root !== cap) {
    const parent: Element | null = root.parentElement;
    if (!parent || isTop(parent)) break;
    const next = scope.detect(parent);
    if (!next || !holdsSameRoles(scope.roles(held), scope.roles(next))) break;
    const current: T = held;
    const path: Element = root;
    const competitor = Array.from(parent.children).some((child) => {
      if (child === path) return false;
      const other = scope.detect(child);
      return other !== null && scope.competes(other, current);
    });
    if (competitor) break;
    root = parent;
    held = next;
  }
  return held;
}
