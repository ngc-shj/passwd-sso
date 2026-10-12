export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A one-shot hold on one call of a mock (issue #885 tests). The matching call
 * waits until `release()` (then runs the mock's previous implementation, so the
 * result is what it would have been) or `fail(err)` (then rejects with err).
 * `reached` resolves once the held call has been made, so a test can act on the
 * operation exactly while it is parked there instead of guessing with a sleep.
 */
export type Hold = {
  reached: Promise<void>;
  release: () => void;
  fail: (err: unknown) => void;
};

/** The part of a vitest mock a hold needs; any vi.fn() / chrome mock fits. */
type HoldableMock = {
  getMockImplementation(): unknown;
  mockImplementation(fn: (...args: never[]) => unknown): unknown;
};

/**
 * Hold the next call of `mock` whose arguments satisfy `match`, skipping the
 * first `skip` matching calls. Every other call — including every call after
 * the held one — goes straight to the implementation the mock had when the hold
 * was armed; `result`, when given, answers the held call instead. Arm a hold
 * only once the background work that could also make a matching call (the
 * unlock's context-menu rebuild, keepalive) has settled, and give the held call
 * an input no other caller uses.
 */
export function holdNextCall<A extends unknown[] = unknown[]>(
  mock: HoldableMock,
  match: (...args: A) => boolean = () => true,
  { skip = 0, result }: { skip?: number; result?: () => unknown } = {},
): Hold {
  const previous = mock.getMockImplementation() as ((...args: unknown[]) => unknown) | undefined;
  const reached = deferred<void>();
  const gate = deferred<void>();
  let remaining = skip;
  let armed = true;
  mock.mockImplementation((...args: unknown[]) => {
    const passThrough = () => previous?.(...args);
    if (!armed || !match(...(args as A))) return passThrough();
    if (remaining > 0) {
      remaining -= 1;
      return passThrough();
    }
    armed = false;
    reached.resolve();
    return gate.promise.then(result ?? passThrough);
  });
  return {
    reached: reached.promise,
    release: () => gate.resolve(),
    fail: (err) => gate.reject(err),
  };
}

/** Hold the next fetch whose URL contains `pathPart` (and, if given, uses `method`). */
export function holdFetch(fetchMock: HoldableMock, pathPart: string, method?: string): Hold {
  return holdNextCall(fetchMock, (url: string, init?: RequestInit) =>
    String(url).includes(pathPart) &&
    (method === undefined || (init?.method ?? "GET") === method));
}

/** Hold the next decryptData call for `ciphertext` (string or `{ ciphertext }` input). */
export function holdDecrypt(decryptMock: HoldableMock, ciphertext: string): Hold {
  return holdNextCall(decryptMock, (encrypted: { ciphertext: string } | string) =>
    (typeof encrypted === "string" ? encrypted : encrypted?.ciphertext) === ciphertext);
}

/**
 * Hold the next chrome.scripting.executeScript location probe: a `func`
 * injection without `args` (the direct-autofill func always passes args, the
 * bundle passes `files`).
 */
export function holdProbe(executeScriptMock: HoldableMock): Hold {
  return holdNextCall(executeScriptMock, (injection: { func?: unknown; args?: unknown }) =>
    !!injection.func && !injection.args);
}

/** Hold the next content-bundle injection (an executeScript call with `files`). */
export function holdBundleInjection(executeScriptMock: HoldableMock): Hold {
  return holdNextCall(executeScriptMock, (injection: { files?: unknown }) => !!injection.files);
}

/** Hold the next direct-autofill injection (an executeScript call with `args`). */
export function holdDirectInjection(executeScriptMock: HoldableMock): Hold {
  return holdNextCall(executeScriptMock, (injection: { args?: unknown }) => !!injection.args);
}

/**
 * Hold the next getSettings() read: chrome.storage.local.get called with the
 * DEFAULTS object (storage.ts), as opposed to a single-key read such as
 * isOwnAppPage's get("serverUrl").
 */
export function holdSettingsRead(storageGetMock: HoldableMock, opts?: { skip?: number }): Hold {
  return holdNextCall(storageGetMock, (keys: unknown) =>
    typeof keys === "object" && keys !== null && "autoLockMinutes" in keys, opts);
}
