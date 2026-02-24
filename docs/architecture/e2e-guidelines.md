# E2E Test Guidelines

## 1. Test Isolation

- Each test file should be independent of other test files.
- Shared state between tests within a file (e.g., CRUD chain in `password-crud.spec.ts`) must run with `workers: 1` and be documented.
- Prefer `test.step()` or independent `beforeEach` data setup over cross-test dependencies.
- Never assume data created by another test file exists.

## 2. Destructive Tests

Destructive tests (vault reset, account deletion, data purge, etc.) **must** use a dedicated test user.

| Test type | User requirement |
|-----------|-----------------|
| Read-only (view, list) | Shared user OK (`vaultReady`) |
| Non-destructive write (create, edit) | Shared user OK if cleaned up |
| Destructive (reset, delete account) | **Dedicated user required** |

- Dedicated users are created in `e2e/global-setup.ts`.
- Name dedicated users clearly: `e2e-reset-*`, `e2e-delete-*`, etc.

## 3. Cleanup Scope

- Tests must only clean up resources with the `e2e-*` or `E2E` prefix.
- Never delete or modify resources that could belong to other test suites or manual testing.
- Use `afterEach` / `afterAll` for cleanup when creating persistent data.

## 4. Assertions

- **No conditional assertion skip.** Never wrap `expect()` in `if` blocks:

  ```typescript
  // BAD — silently passes when element is absent
  if (await element.isVisible()) {
    await expect(element).toHaveText("expected");
  }

  // GOOD — fails explicitly when element is absent
  await expect(element).toBeVisible();
  await expect(element).toHaveText("expected");
  ```

- Use Playwright's built-in auto-waiting (`toBeVisible`, `toHaveText`, etc.) instead of manual waits.

## 5. Naming Conventions

- Test data: prefix with `E2E` or `e2e-` (e.g., `E2E Test Entry`, `e2e-user@example.com`).
- Test files: `<feature>.spec.ts` in `e2e/tests/`.
- Page objects: `<feature>.page.ts` in `e2e/page-objects/`.
