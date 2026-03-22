# Coding Deviation Log: centralize-version-management
Created: 2026-03-22

## Deviations from Plan

### DEV-1: version.test.ts path fix
- **Plan description**: Test file at `cli/src/__tests__/unit/version.test.ts` with `resolve(import.meta.dirname, "../../dist/index.js")`
- **Actual implementation**: Path corrected to `"../../../dist/index.js"` because `import.meta.dirname` in vitest points to source location (`cli/src/__tests__/unit/`), requiring 3 levels up to reach `cli/dist/`
- **Reason**: Off-by-one in directory traversal count
- **Impact scope**: Test file only

### DEV-2: version.test.ts moved to integration/
- **Plan description**: `cli/src/__tests__/unit/version.test.ts`
- **Actual implementation**: `cli/src/__tests__/integration/version.test.ts`
- **Reason**: Code review finding — test depends on build artifacts (`dist/index.js`) via child process execution, which is characteristic of integration tests, not unit tests
- **Impact scope**: Test file location only; vitest include pattern `src/__tests__/**/*.test.ts` covers both directories
