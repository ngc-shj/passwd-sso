/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runFillSequence,
  isFillActive,
  boundedRoot,
  resolveFillRoot,
  __resetFillSequenceForTests,
  type FillStep,
  type FillTarget,
  type FillRoot,
} from "../../content/fill-sequence-lib";

// queueMicrotask stays real: jsdom delivers MutationObserver records as microtasks.
// performance is faked because the deadline reads performance.now().
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => {
  __resetFillSequenceForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (!document.body) document.documentElement.appendChild(document.createElement("body"));
  document.body.innerHTML = "";
});

// A 0 ms timer queued from inside a fake-timer callback is scheduled 1 ms later,
// so "run the sequencer's pending tasks" advances a few ms rather than 0.
async function runTasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

// Only the sequencer's first task: one write, with the next step still pending.
async function firstTask(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function $(selector: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`fixture missing ${selector}`);
  return el;
}

function addInput(parent: Element, attrs: Record<string, string> = {}): HTMLInputElement {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent.appendChild(el);
  return el;
}

const usable = (el: FillTarget) => !el.disabled && !el.hidden;

type Recorder = {
  log: string[];
  releases: Record<string, number>;
  step: (
    key: string,
    initial: FillTarget | null,
    extra?: Partial<Pick<FillStep, "relocate" | "accepts" | "write">>,
  ) => FillStep;
};

function recorder(): Recorder {
  const log: string[] = [];
  const releases: Record<string, number> = {};
  return {
    log,
    releases,
    step: (key, initial, extra = {}) => {
      releases[key] = 0;
      return {
        key,
        initial,
        relocate: extra.relocate,
        accepts: extra.accepts ?? usable,
        write:
          extra.write ??
          ((el) => {
            el.value = key;
            log.push(key);
          }),
        release: () => {
          releases[key]++;
        },
      };
    },
  };
}

function track(p: Promise<void>): { settled: () => boolean } {
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  return { settled: () => settled };
}

// jsdom's Event.isTrusted is a non-configurable own property that is always false
// for scripted events, so the trusted path invokes the captured listener directly
// with a Proxy (precedent: ui/passkey-dropdown.test.ts).
function trusted<E extends Event>(e: E): E {
  return new Proxy(e, {
    get(target, prop) {
      if (prop === "isTrusted") return true;
      const val = Reflect.get(target, prop, target);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as E;
}

function captureWindowListeners(): Map<string, EventListener> {
  const listeners = new Map<string, EventListener>();
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (typeof listener === "function") listeners.set(type, listener);
    original(type, listener, options);
  }) as typeof window.addEventListener);
  return listeners;
}

describe("runFillSequence — order and yield", () => {
  it("writes steps in order with a macrotask between writes", async () => {
    document.body.innerHTML = `<input id="a"><input id="b"><input id="c">`;
    const r = recorder();
    const steps = [
      r.step("a", $("#a"), {
        write: (el) => {
          el.value = "a";
          r.log.push("a");
          // A task queued during the first write must run before the second write.
          setTimeout(() => r.log.push("task"), 0);
        },
      }),
      r.step("b", $("#b")),
      r.step("c", $("#c")),
    ];

    const done = runFillSequence(document.body, steps);
    expect(r.log).toEqual([]); // no write in the caller's task

    await vi.runAllTimersAsync();
    await done;
    expect(r.log).toEqual(["a", "task", "b", "c"]);
  });
});

describe("runFillSequence — late fields", () => {
  it("writes a field created after T0 from a sequencer task, not the observer callback", async () => {
    document.body.innerHTML = `<div id="scope"><input id="a"></div>`;
    const r = recorder();
    const scope = $("#scope") as unknown as HTMLElement;
    const steps = [
      r.step("a", $("#a")),
      r.step("late", null, { relocate: (root) => root.querySelector<HTMLInputElement>("#late") }),
    ];
    const run = track(runFillSequence(scope, steps));

    await runTasks();
    expect(r.log).toEqual(["a"]);

    addInput(scope, { id: "late" });
    await flushMicrotasks();
    expect($("#late").value).toBe(""); // observer callback ran, but did not write

    await runTasks();
    expect($("#late").value).toBe("late");
    expect(run.settled()).toBe(true);
  });
});

describe("runFillSequence — step states and the deadline", () => {
  it("does not write a deferred field created after the deadline", async () => {
    document.body.innerHTML = `<input id="a">`;
    const r = recorder();
    const steps = [
      r.step("a", $("#a")),
      r.step("late", null, { relocate: (root) => root.querySelector<HTMLInputElement>("#late") }),
    ];
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 100 }));

    await vi.advanceTimersByTimeAsync(100);
    addInput(document.body, { id: "late" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    expect($("#late").value).toBe("");
    expect(r.log).toEqual(["a"]);
    expect(run.settled()).toBe(true);
  });

  it("does not write a deferred field that appears at exactly the deadline", async () => {
    document.body.innerHTML = `<input id="a">`;
    // Registered before the run, so it fires first at T0 + window.
    setTimeout(() => addInput(document.body, { id: "late" }), 100);
    const r = recorder();
    const steps = [
      r.step("a", $("#a")),
      r.step("late", null, { relocate: (root) => root.querySelector<HTMLInputElement>("#late") }),
    ];
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 100 }));

    await vi.advanceTimersByTimeAsync(200);

    expect($("#late").value).toBe("");
    expect(run.settled()).toBe(true);
  });

  // Pins the comparison itself: the first task runs at exactly T0 + 0, so the
  // deferred step meets the deadline with no handler ordering in play.
  it.each([
    { window: 0, written: [] },
    { window: 1, written: ["late"] },
  ])("with window $window, a deferred step resolvable on the first task writes $written", async ({ window, written }) => {
    document.body.innerHTML = `<input id="late">`;
    const r = recorder();
    const steps = [
      r.step("late", null, { relocate: (root) => root.querySelector<HTMLInputElement>("#late") }),
    ];
    const done = runFillSequence(document.body, steps, { lateFieldWindowMs: window });
    await vi.runAllTimersAsync();
    await done;

    expect(r.log).toEqual(written);
  });

  // setTimeout truncates a fractional delay, so the deadline handler can run while
  // performance.now() is still short of the deadline. A step that starts waiting
  // after the handler ran must still end the run.
  it("ends the run when a step starts waiting after the deadline handler, before the clock reaches it", async () => {
    document.body.innerHTML = `<input id="a"><input id="b" disabled>`;
    vi.spyOn(performance, "now").mockReturnValue(0);
    const r = recorder();
    const steps = [
      r.step("a", $("#a"), {
        // The deadline handler runs inside this write (a busy page).
        write: (el) => {
          (el as HTMLInputElement).value = "a";
          vi.advanceTimersByTime(200);
        },
      }),
      r.step("b", $("#b")),
    ];
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 100 }));

    await vi.advanceTimersByTimeAsync(1000);

    expect(isFillActive()).toBe(false);
    expect(run.settled()).toBe(true);
    expect(r.releases).toEqual({ a: 1, b: 1 });
  });

  // A field can become acceptable with no mutation under <body> (a CSS
  // transition, a stylesheet change); waiting steps are polled until the deadline.
  it.each([
    { revealAt: 300, written: ["a", "late"] },
    { revealAt: 1100, written: ["a"] },
  ])("writes a waiting step that becomes acceptable without a mutation at $revealAt ms: $written", async ({ revealAt, written }) => {
    document.body.innerHTML = `<input id="a"><input id="late">`;
    let ready = false;
    setTimeout(() => (ready = true), revealAt);
    const r = recorder();
    const steps = [
      r.step("a", $("#a")),
      r.step("late", $("#late"), { accepts: () => ready }),
    ];
    const done = runFillSequence(document.body, steps);
    await vi.advanceTimersByTimeAsync(1500);
    await done;

    expect(r.log).toEqual(written);
  });

  it("ends a waiting step that relocates to a late field an earlier step already wrote", async () => {
    document.body.innerHTML = ``;
    const r = recorder();
    const late = (root: FillRoot) => root.querySelector<HTMLInputElement>("#late");
    const run = track(
      runFillSequence(document.body, [
        r.step("first", null, { relocate: late }),
        r.step("second", null, { relocate: late }),
      ]),
    );
    await runTasks();
    addInput(document.body, { id: "late" });
    await flushMicrotasks();
    await runTasks();

    expect(r.log).toEqual(["first"]);
    expect(run.settled()).toBe(true);
  });

  it("ends a step whose T0 target an earlier step owns, without waiting out the window", async () => {
    document.body.innerHTML = `<input id="a">`;
    const r = recorder();
    const run = track(
      runFillSequence(document.body, [r.step("first", $("#a")), r.step("second", $("#a"))]),
    );
    await runTasks();

    expect(r.log).toEqual(["first"]);
    expect(run.settled()).toBe(true);
    expect(r.releases).toEqual({ first: 1, second: 1 });
  });

  // A throttled timer can run a sequencer task after the deadline but before the
  // deadline handler; the write check itself must refuse the waiting step.
  it("does not write a waiting step whose task runs past the deadline before the handler", async () => {
    document.body.innerHTML = `<input id="a">`;
    const r = recorder();
    const steps = [
      r.step("a", $("#a")),
      r.step("late", null, { relocate: (root) => root.querySelector<HTMLInputElement>("#late") }),
    ];
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 100 }));
    await runTasks();
    expect(r.log).toEqual(["a"]);

    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    addInput(document.body, { id: "late" });
    await flushMicrotasks();
    await runTasks();
    expect($("#late").value).toBe("");

    now.mockRestore();
    await vi.advanceTimersByTimeAsync(200);
    expect($("#late").value).toBe("");
    expect(run.settled()).toBe(true);
  });

  it("abandons a T0 target disabled at its turn and re-enabled after the deadline", async () => {
    document.body.innerHTML = `<input id="a" disabled><input id="b">`;
    const r = recorder();
    const steps = [r.step("a", $("#a")), r.step("b", $("#b"))];
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 100 }));

    await runTasks();
    expect(r.log).toEqual(["b"]); // the waiting step does not block later steps

    await vi.advanceTimersByTimeAsync(100);
    $("#a").disabled = false;
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    expect($("#a").value).toBe("");
    expect(run.settled()).toBe(true);
    expect(isFillActive()).toBe(false);
    expect(r.releases).toEqual({ a: 1, b: 1 });
  });

  it("writes a T0 target re-enabled before the deadline", async () => {
    document.body.innerHTML = `<input id="a" disabled><input id="b">`;
    const r = recorder();
    const steps = [r.step("a", $("#a")), r.step("b", $("#b"))];
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 100 }));

    await runTasks();
    $("#a").disabled = false;
    await flushMicrotasks();
    await runTasks();

    expect(r.log).toEqual(["b", "a"]);
    expect(run.settled()).toBe(true);
  });

  it("writes every T0 target of a multi-field form with window 0", async () => {
    document.body.innerHTML = `<input id="a"><input id="b"><input id="c"><input id="d">`;
    const r = recorder();
    const steps = ["a", "b", "c", "d"].map((k) => r.step(k, $(`#${k}`)));
    const done = runFillSequence(document.body, steps, { lateFieldWindowMs: 0 });

    await vi.runAllTimersAsync();
    await done;
    expect(r.log).toEqual(["a", "b", "c", "d"]);
  });

  // The disabled target sits at a later step, so its turn comes after the deadline
  // handler has run: only immediate abandonment can end the run.
  it("with window 0, abandons at once a later step that would start waiting", async () => {
    document.body.innerHTML = `<input id="a"><input id="b" disabled><input id="c">`;
    const r = recorder();
    const steps = ["a", "b", "c"].map((k) => r.step(k, $(`#${k}`)));
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 0 }));

    await vi.advanceTimersByTimeAsync(50);

    expect(r.log).toEqual(["a", "c"]);
    expect(run.settled()).toBe(true);
    expect(isFillActive()).toBe(false);
    expect(r.releases).toEqual({ a: 1, b: 1, c: 1 });
  });
});

describe("runFillSequence — write-once", () => {
  it("writes an element at most once, even when two steps target it at T0", async () => {
    document.body.innerHTML = `<input id="a">`;
    const r = recorder();
    const steps = [r.step("first", $("#a")), r.step("second", $("#a"))];
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 100 }));

    await vi.advanceTimersByTimeAsync(200);
    expect(r.log).toEqual(["first"]);
    expect($("#a").value).toBe("first");
    expect(run.settled()).toBe(true);
  });

  it("rejects a relocated target the sequence has already written", async () => {
    document.body.innerHTML = `<input id="a">`;
    const r = recorder();
    const steps = [
      r.step("first", $("#a")),
      r.step("second", null, { relocate: (root) => root.querySelector<HTMLInputElement>("#a") }),
    ];
    const run = track(runFillSequence(document.body, steps, { lateFieldWindowMs: 100 }));

    await runTasks();
    document.body.appendChild(document.createElement("span")); // wake the observer
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);

    expect(r.log).toEqual(["first"]);
    expect(run.settled()).toBe(true);
  });
});

describe("runFillSequence — root confinement", () => {
  function fixture(): { scope: HTMLElement; r: Recorder; steps: FillStep[] } {
    document.body.innerHTML = `<div id="scope"><input id="a"></div><div id="elsewhere"></div>`;
    const r = recorder();
    const steps = [
      r.step("a", $("#a")),
      r.step("late", null, {
        relocate: () => document.querySelector<HTMLInputElement>("#late"),
      }),
    ];
    return { scope: document.getElementById("scope")!, r, steps };
  }

  it("rejects a relocated element outside the root", async () => {
    const { scope, r, steps } = fixture();
    const run = track(runFillSequence(scope, steps, { lateFieldWindowMs: 100 }));

    await runTasks();
    addInput(document.getElementById("elsewhere")!, { id: "late" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);

    expect($("#late").value).toBe("");
    expect(r.log).toEqual(["a"]);
    expect(run.settled()).toBe(true);
  });

  it("accepts the same relocated element inside the root", async () => {
    const { scope, r, steps } = fixture();
    const run = track(runFillSequence(scope, steps, { lateFieldWindowMs: 100 }));

    await runTasks();
    addInput(scope, { id: "late" });
    await flushMicrotasks();
    await runTasks();

    expect(r.log).toEqual(["a", "late"]);
    expect(run.settled()).toBe(true);
  });

  it("leaves a step unfilled when the root is null and its initial is gone", async () => {
    document.body.innerHTML = `<input id="a">`;
    const r = recorder();
    const steps = [
      r.step("a", $("#a")),
      r.step("late", null, { relocate: (root) => root.querySelector<HTMLInputElement>("#late") }),
    ];
    const run = track(runFillSequence(null, steps, { lateFieldWindowMs: 100 }));

    await runTasks();
    addInput(document.body, { id: "late" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);

    expect($("#late").value).toBe("");
    expect(run.settled()).toBe(true);
  });
});

describe("runFillSequence — re-anchoring", () => {
  const textField = (el: FillTarget) => el instanceof HTMLInputElement && el.type === "text";

  function fixture() {
    document.body.innerHTML = `
      <div id="other"><input id="foreign" type="text"></div>
      <div id="wrap"><div id="card"><input id="num" type="text"></div></div>`;
    const num = $("#num");
    const { root, reanchor } = resolveFillRoot(num, [num], textField);
    const r = recorder();
    const steps = [
      r.step("num", num),
      r.step("cvv", null, { relocate: (scope) => scope.querySelector<HTMLInputElement>(".cvv") }),
    ];
    return { num, root, reanchor, r, steps };
  }

  it("recomputes the root from the connected anchor when the T0 root is detached", async () => {
    const { num, root, reanchor, r, steps } = fixture();
    expect(root?.id).toBe("wrap");
    const run = track(runFillSequence(root, steps, { lateFieldWindowMs: 100, reanchor }));

    await runTasks();
    expect(r.log).toEqual(["num"]);

    // The page remounts the card: the anchor moves into a new container, the old
    // root goes away, and the late field appears beside the anchor.
    const wrap2 = document.createElement("div");
    wrap2.id = "wrap2";
    document.body.appendChild(wrap2);
    wrap2.appendChild(num);
    document.getElementById("wrap")!.remove();
    addInput(wrap2, { class: "cvv", type: "text" });
    await flushMicrotasks();
    await runTasks();

    expect(r.log).toEqual(["num", "cvv"]);
    expect(run.settled()).toBe(true);
  });

  it("does not reach past the T0 foreign control after re-anchoring", async () => {
    const { num, root, reanchor, r, steps } = fixture();
    const run = track(runFillSequence(root, steps, { lateFieldWindowMs: 100, reanchor }));

    await runTasks();
    const wrap2 = document.createElement("div");
    document.body.appendChild(wrap2);
    wrap2.appendChild(num);
    document.getElementById("wrap")!.remove();
    // Beyond the foreign control's section: outside any re-anchored root.
    addInput(document.getElementById("other")!, { class: "cvv", type: "text" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);

    expect(r.log).toEqual(["num"]);
    expect(run.settled()).toBe(true);
  });

  it("has no root once the anchor itself is detached", async () => {
    const { num, root, reanchor, r, steps } = fixture();
    const run = track(runFillSequence(root, steps, { lateFieldWindowMs: 100, reanchor }));

    await runTasks();
    document.getElementById("wrap")!.remove();
    expect(num.isConnected).toBe(false);
    const wrap2 = document.createElement("div");
    document.body.appendChild(wrap2);
    addInput(wrap2, { class: "cvv", type: "text" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);

    expect(r.log).toEqual(["num"]);
    expect(run.settled()).toBe(true);
  });
});

describe("runFillSequence — supersession", () => {
  // A pending LOGIN password step, then a CC run: the masked CVV that appears
  // afterwards matches both kinds' lookups but must only ever receive the CVV.
  it("a new run of another kind supersedes a pending one before its next write", async () => {
    document.body.innerHTML = `<input id="user" type="text">`;
    const login = recorder();
    const loginRun = track(
      runFillSequence(document.body, [
        login.step("username", $("#user")),
        login.step("password", null, {
          relocate: (root) => root.querySelector<HTMLInputElement>('input[type="password"]'),
        }),
      ]),
    );
    await runTasks();
    expect(login.log).toEqual(["username"]);

    const cc = recorder();
    const ccRun = track(
      runFillSequence(document.body, [
        cc.step("cvv", null, {
          relocate: (root) => root.querySelector<HTMLInputElement>('input[autocomplete="cc-csc"]'),
        }),
      ]),
    );
    expect(login.releases).toEqual({ username: 1, password: 1 }); // dropped at supersession
    await flushMicrotasks();
    expect(loginRun.settled()).toBe(true);

    addInput(document.body, { id: "cvv", type: "password", autocomplete: "cc-csc" });
    await flushMicrotasks();
    await runTasks();

    expect(login.log).toEqual(["username"]);
    expect(cc.log).toEqual(["cvv"]);
    expect($("#cvv").value).toBe("cvv");
    expect(ccRun.settled()).toBe(true);
  });

  it.each(["keydown", "pointerdown", "paste"])(
    "a trusted %s supersedes the run",
    async (type) => {
      document.body.innerHTML = `<input id="a"><input id="b">`;
      const listeners = captureWindowListeners();
      const r = recorder();
      const run = track(runFillSequence(document.body, [r.step("a", $("#a")), r.step("b", $("#b"))]));
      await firstTask();
      expect(r.log).toEqual(["a"]);

      listeners.get(type)!(trusted(new Event(type)));
      expect(isFillActive()).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(r.log).toEqual(["a"]);
      expect(r.releases).toEqual({ a: 1, b: 1 });
      expect(run.settled()).toBe(true);
    },
  );

  it("ignores a repeated keydown", async () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    const listeners = captureWindowListeners();
    const r = recorder();
    const done = runFillSequence(document.body, [r.step("a", $("#a")), r.step("b", $("#b"))]);
    await firstTask();

    listeners.get("keydown")!(trusted(new KeyboardEvent("keydown", { repeat: true })));
    expect(isFillActive()).toBe(true);

    await vi.runAllTimersAsync();
    await done;
    expect(r.log).toEqual(["a", "b"]);
  });

  it("ignores an untrusted keydown dispatched by the page", async () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    const r = recorder();
    const done = runFillSequence(document.body, [r.step("a", $("#a")), r.step("b", $("#b"))]);
    await firstTask();

    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    expect(isFillActive()).toBe(true);

    await vi.runAllTimersAsync();
    await done;
    expect(r.log).toEqual(["a", "b"]);
  });

  it("registers its window listeners in the capture phase and removes the same ones on exit", async () => {
    document.body.innerHTML = `<input id="a">`;
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const done = runFillSequence(document.body, [recorder().step("a", $("#a"))]);
    await vi.runAllTimersAsync();
    await done;

    for (const type of ["keydown", "pointerdown", "paste"]) {
      const added = add.mock.calls.find((c) => c[0] === type);
      expect(added?.[2]).toBe(true);
      expect(remove).toHaveBeenCalledWith(type, added?.[1], true);
    }
  });
});

describe("runFillSequence — release on every exit path", () => {
  it("releases each step exactly once when the run settles", async () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    const r = recorder();
    const done = runFillSequence(document.body, [r.step("a", $("#a")), r.step("b", $("#b"))]);
    await vi.runAllTimersAsync();
    await done;
    expect(r.releases).toEqual({ a: 1, b: 1 });
  });

  it("releases each step exactly once when the deadline ends the run", async () => {
    document.body.innerHTML = `<input id="a">`;
    const r = recorder();
    const done = runFillSequence(
      document.body,
      [r.step("a", $("#a")), r.step("late", null, { relocate: () => null })],
      { lateFieldWindowMs: 100 },
    );
    await runTasks();
    expect(r.releases).toEqual({ a: 0, late: 0 }); // nothing released while waiting
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(r.releases).toEqual({ a: 1, late: 1 });
  });

  it("releases each step exactly once and logs one closed code when a write throws", async () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const r = recorder();
    const done = runFillSequence(document.body, [
      r.step("a", $("#a"), {
        write: () => {
          throw new Error("secret-value-must-not-be-logged");
        },
      }),
      r.step("b", $("#b")),
    ]);
    await vi.runAllTimersAsync();
    await done;

    expect(r.releases).toEqual({ a: 1, b: 1 });
    expect(r.log).toEqual([]);
    expect(isFillActive()).toBe(false);
    expect(debug.mock.calls).toEqual([["[passwd-sso] Fill error: fill-sequence-error"]]);
  });

  it("calls every release even when one release throws", async () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const r = recorder();
    const throwing = r.step("a", $("#a"));
    throwing.release = () => {
      r.releases.a++;
      throw new Error("boom");
    };
    const done = runFillSequence(document.body, [throwing, r.step("b", $("#b"))]);
    await vi.runAllTimersAsync();
    await done;
    expect(r.releases).toEqual({ a: 1, b: 1 });
    expect(debug).toHaveBeenCalledWith("[passwd-sso] Fill error: fill-release-error");
  });
});

describe("isFillActive", () => {
  it("is true only while the current run has not exited", async () => {
    document.body.innerHTML = `<input id="a">`;
    expect(isFillActive()).toBe(false);
    const done = runFillSequence(document.body, [recorder().step("a", $("#a"))]);
    expect(isFillActive()).toBe(true);
    await vi.runAllTimersAsync();
    await done;
    expect(isFillActive()).toBe(false);
  });

  it("stays true for the new run after supersession, and false for the old one", async () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    const first = track(
      runFillSequence(document.body, [recorder().step("a", null, { relocate: () => null })]),
    );
    const second = runFillSequence(document.body, [recorder().step("b", $("#b"))]);
    await flushMicrotasks();
    expect(first.settled()).toBe(true);
    expect(isFillActive()).toBe(true);
    await vi.runAllTimersAsync();
    await second;
    expect(isFillActive()).toBe(false);
  });

  it("runs without an observer when the document has no body", async () => {
    const html = document.documentElement;
    html.removeChild(document.body);
    const a = document.createElement("input");
    html.appendChild(a);
    try {
      const r = recorder();
      const done = runFillSequence(html, [r.step("a", a)]);
      await vi.runAllTimersAsync();
      await done;
      expect(a.value).toBe("a");
    } finally {
      a.remove();
    }
  });
});

describe("boundedRoot", () => {
  const fillable = (el: FillTarget) =>
    el instanceof HTMLInputElement
      ? ["text", "password", "email", "tel", "number"].includes(el.type) && !el.disabled
      : !el.disabled;

  it("resolves the Sony-shaped portal div, not a block and not null", () => {
    document.body.innerHTML = `
      <div id="__next"><header><input type="text"></header></div>
      <div class="ReactModalPortal">
        <div class="overlay"><div class="content">
          <div class="block"><input id="branch" type="text"></div>
          <div class="block"><input id="account" type="text"></div>
          <div class="block"><input id="pw" type="password"></div>
        </div></div>
      </div>`;
    const targets = [$("#branch"), $("#account"), $("#pw")];
    const root = boundedRoot(targets[0], targets, fillable);
    expect(root).toBe(document.querySelector(".ReactModalPortal"));
  });

  it("is body on a bare page", () => {
    document.body.innerHTML = `<main><div><input id="num" type="text"></div></main>`;
    const num = $("#num");
    expect(boundedRoot(num, [num], fillable)).toBe(document.body);
  });

  it("stops below an SPA wrapper holding a visible foreign control", () => {
    document.body.innerHTML = `
      <div id="app">
        <section id="login"><div><input id="user" type="text"></div><input id="pw" type="password"></section>
        <section id="billing"><input id="cvv" type="text" autocomplete="cc-csc"></section>
      </div>`;
    const targets = [$("#user"), $("#pw")];
    expect(targets).not.toContain($("#cvv")); // the bounding field is not a T0 target
    expect(boundedRoot(targets[0], targets, fillable)?.id).toBe("login");
  });

  it("ignores hidden, submit, button and checkbox inputs even if the predicate admits them", () => {
    document.body.innerHTML = `
      <div><input id="num" type="text"></div>
      <input type="hidden"><input type="submit"><input type="button"><input type="checkbox">`;
    const num = $("#num");
    expect(boundedRoot(num, [num], () => true)).toBe(document.body);
  });

  it("is not bounded by a control the kind's predicate rejects at T0", () => {
    document.body.innerHTML = `<div><input id="num" type="text"></div><input type="text" disabled>`;
    const num = $("#num");
    expect(boundedRoot(num, [num], fillable)).toBe(document.body);
  });

  it("is null when the anchor's own parent holds a foreign control", () => {
    document.body.innerHTML = `<div><input id="num" type="text"><input type="text"></div>`;
    const num = $("#num");
    expect(boundedRoot(num, [num], fillable)).toBeNull();
  });

  it("is never html", () => {
    document.body.innerHTML = `<input id="num" type="text">`;
    const num = $("#num");
    expect(boundedRoot(num, [num], fillable)).toBe(document.body);
  });
});

describe("runFillSequence with resolveFillRoot — paired root rows", () => {
  const fillable = (el: FillTarget) => el instanceof HTMLInputElement && el.type === "text";

  function fixture() {
    document.body.innerHTML = `
      <div id="app">
        <section id="card"><div id="numbox"><input id="num" type="text"></div><div id="later"></div></section>
        <section id="other"><input id="foreign" type="text"></section>
      </div>`;
    const num = $("#num");
    const { root, reanchor } = resolveFillRoot(num, [num], fillable);
    const r = recorder();
    const steps = [
      r.step("num", num),
      r.step("cvv", null, {
        relocate: (scope: FillRoot) => scope.querySelector<HTMLInputElement>(".cvv"),
      }),
    ];
    return { root, reanchor, r, steps };
  }

  it("writes a late field inside the section root but outside the anchor's parent", async () => {
    const { root, reanchor, r, steps } = fixture();
    expect(root?.id).toBe("card");
    const run = track(runFillSequence(root, steps, { lateFieldWindowMs: 100, reanchor }));
    await runTasks();
    addInput(document.getElementById("later")!, { class: "cvv", type: "text" });
    await flushMicrotasks();
    await runTasks();
    expect(r.log).toEqual(["num", "cvv"]);
    expect(run.settled()).toBe(true);
  });

  it("does not write a late field beyond the foreign control", async () => {
    const { root, reanchor, r, steps } = fixture();
    const run = track(runFillSequence(root, steps, { lateFieldWindowMs: 100, reanchor }));
    await runTasks();
    addInput(document.getElementById("other")!, { class: "cvv", type: "text" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.log).toEqual(["num"]);
    expect(run.settled()).toBe(true);
  });
});
