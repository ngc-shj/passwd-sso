# Coding Deviation Log: retention-gc-bypass-assert

## D1: the shared unit-test fakes live under `src/__tests__/workers/`

- **Plan:** the unit tests live beside the worker, in `src/workers/retention-gc-worker/__tests__/`.
- **Change:** the shared tx fakes are in `src/__tests__/workers/retention-gc-tx-fakes.ts`. The tests themselves stay beside the worker.
- **Why:** the worker-policy manifest test treats every non-test `.ts` under `src/workers/` as a candidate worker module, and a helper file there fails it. A helper module, unlike a `*.test.ts` file, is not excluded.

## D2: the `is_local` mutation is caught by the set_config text only

- **Change:** the red-proof "wrapper `is_local` set to `false`" goes red through the dispatcher unit test, which pins the `set_config` text `'on', true)`.
- **Not added:** a real-DB test that a session-level setting leaks to the next transaction on a pooled connection.
- **Why:** the wrapper is one line, and both the text pin and the source check fix it. The integration tests still run every sweep through it.
