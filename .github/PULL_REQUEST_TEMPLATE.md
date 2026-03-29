## Summary

<!-- Brief description of the changes -->

## Changes

-

## Testing

- [ ] `npm run pre-pr` passed (lint, static checks, migration drift, tests, build)
- [ ] Manually tested in browser

## E2E Safety (if applicable)

- [ ] Destructive tests use a dedicated user (not shared `vaultReady`)
- [ ] No conditional assertion skip (`if (visible) { expect(...) }`)
- [ ] Cleanup scope is limited to `e2e-*` / `E2E` prefixed resources

See [docs/e2e-guidelines.md](../docs/e2e-guidelines.md) for details.

## Related Issues

<!-- e.g., Closes #123 -->
