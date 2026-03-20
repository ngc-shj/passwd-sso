# Coding Deviation Log: add-key-rotation-consumers
Created: 2026-03-20T16:50:00+09:00

## Deviations from Plan

### D1: RotateKeyCard wrapper component added (not in plan)

The plan specified placing `RotateKeyDialog` directly as a trigger button in the settings security tab, after `PasskeyCredentialsCard`. The implementation instead introduced a dedicated `src/components/settings/rotate-key-card.tsx` wrapper component that encapsulates the `Card` layout, the vault-unlock guard (`vaultMustBeUnlocked` hint), and the dialog trigger. This is a minor structural deviation that improves code organisation and consistency with other cards on the settings page.

### D2: Rate limiter instantiated separately in data endpoint (not shared instance)

The plan specified exporting `rotateLimiter` from `route.ts` and importing it into the `data/route.ts` sibling, or extracting it to a shared module. The implementation creates a new `rotateLimiter` instance in `data/route.ts` with identical config (`windowMs: 15 * 60_000, max: 3`) and the same key prefix (`rl:vault_rotate:{userId}`). Because the limiter uses Redis as the backing store with an identical key, the two instances share the same rate-limit budget per user in practice. This was explicitly noted in the implementation as a "by design" decision (comment in `data/route.ts`), accepted during review.

### D3: `scripts/rotate-master-key.sh` test not created

The plan called for `scripts/__tests__/rotate-master-key.test.mjs` covering env var validation (missing vars, invalid format, exit codes). No such file was created. No other script test file (`purge-history`) existed as a prior pattern either — the existing `scripts/__tests__/` directory contains only `check-licenses`, `check-crypto-domains`, and `smoke-key-provider` tests. This was accepted during review: the env var validation is exercised manually, consistent with how `purge-history.sh` is tested.

### D4: vault-context `rotateKey` unit tests not implemented

The plan included unit tests for the `rotateKey` function in `vault-context.tsx` (via `renderHook` + Web Crypto stubs). No test file was created for this. The function is covered indirectly via the route-handler tests and the build check, but the client-side state transition and progress callback logic is not unit-tested. This was accepted during review given the complexity of mocking the full Web Crypto API in a jsdom environment.

### D5: Team rotate-key placed in component directory `team/` not `teams/`

The plan referenced `src/components/teams/team-rotate-key-button.tsx` (plural). The actual file is at `src/components/team/team-rotate-key-button.tsx` (singular), consistent with the existing directory structure (`src/components/team/` already existed).

### D6: `ECDH_PRIVATE_KEY_CIPHERTEXT_MAX` named constant extracted (minor addition)

The plan specified `z.string().min(1).max(512)` inline. The implementation extracted this as `ECDH_PRIVATE_KEY_CIPHERTEXT_MAX = 512` in `src/lib/validations/common.ts`, consistent with the pattern used for other max-length constants in that file. This is an improvement beyond what the plan required.
