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
  /** Reads the payload lazily at write time. */
  write: (el: FillTarget) => void;
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

const OBSERVED_ATTRIBUTES = ["disabled", "readonly", "hidden", "style", "class"];

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
 * detection finds nothing to fill still ends the earlier run (FR4), so no
 * earlier step can write after a newer request.
 */
export function supersedeActiveFill(): void {
  supersedeActiveRun();
}

export function runFillSequence(
  root: FillRoot | null,
  steps: FillStep[],
  opts: FillSequenceOptions = {},
): Promise<void> {
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
  const written = new Set<FillTarget>();
  let currentRoot = root;
  let exited = false;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  // setTimeout truncates a fractional delay, so the handler can run just before
  // performance.now() reaches the deadline; once it has run, the deadline holds.
  let deadlineReached = false;
  let observer: MutationObserver | null = null;
  let resolveRun!: () => void;
  const done = new Promise<void>((resolve) => {
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
    resolveRun();
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
  function resolveWaiting(step: FillStep): FillTarget | null {
    if (isPastDeadline()) return null;
    const initial = step.initial;
    if (initial && initial.isConnected && !written.has(initial) && step.accepts(initial)) {
      return initial;
    }
    const scope = resolvedRoot();
    if (!scope || !step.relocate) return null;
    const el = step.relocate(scope);
    if (!el || !el.isConnected || !scope.contains(el)) return null;
    if (written.has(el) || !step.accepts(el)) return null;
    return el;
  }

  // Same synchronous task as the write: generation, connection, accepts, write-once.
  // The deadline part of the check sits in resolveWaiting for waiting steps.
  function writeStep(index: number, el: FillTarget): void {
    const step = steps[index];
    if (!isCurrent() || !el.isConnected || written.has(el) || !step.accepts(el)) return;
    written.add(el);
    states[index] = "written";
    step.write(el);
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
        const el = resolveWaiting(step);
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
        attributeFilter: OBSERVED_ATTRIBUTES,
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
