# Plan: cli-npm-installable

## Context

CLI (`passwd-sso-cli`) is currently `"private": true` and reads its version from the monorepo root `../../package.json` via `createRequire`. This makes it impossible to publish to npm or install globally. The goal is to make it installable via `npm install -g passwd-sso-cli`.

## Objective

Make the CLI package publishable to npm so users can install it with `npm install -g passwd-sso-cli` and run `passwd-sso` commands without cloning the monorepo.

## Requirements

- `npm install -g passwd-sso-cli` installs the CLI globally
- `passwd-sso --version` outputs the correct version
- All commands (login, unlock, agent, decrypt, etc.) work after global install
- release-please continues to sync versions automatically
- CI version-check job continues to work
- No breaking changes to existing monorepo development workflow

## Technical Approach

### 1. Fix version reference (CRITICAL)

**Current:** `cli/src/index.ts:32` — `require("../../package.json")` breaks when installed as npm package.

**Fix:** Read version from CLI's own `package.json` using `createRequire(import.meta.url)("../package.json")`. Since `dist/index.js` is one level below `cli/package.json`, `../package.json` resolves correctly both in monorepo and after npm install.

- release-please already syncs `cli/package.json` version via `release-please-config.json` extra-files
- No additional sync mechanism needed

### 2. Remove `private: true`

Remove `"private": true` from `cli/package.json` to allow `npm publish`.

### 3. Add npm publish metadata

Add to `cli/package.json`:
```json
{
  "description": "CLI for passwd-sso password manager",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/ngc-shj/passwd-sso.git",
    "directory": "cli"
  },
  "homepage": "https://github.com/ngc-shj/passwd-sso/tree/main/cli",
  "keywords": ["password-manager", "cli", "sso", "vault", "ssh-agent"],
  "engines": {
    "node": ">=20"
  },
  "files": ["dist"],
  "scripts": {
    "prepublishOnly": "tsc"
  }
}
```

- `files: ["dist"]` ensures only compiled JS ships (no src/, tests, tsconfig)
- `prepublishOnly` builds before publish as a safety net

### 4. Fix integration test

**Current:** `cli/src/__tests__/integration/version.test.ts:8` — `require("../../../../package.json")` references monorepo root.

**Fix:** Change to reference CLI's own `package.json`:
```ts
const cliPkg = require("../../../package.json") as { version: string };
```

Also update:
- Variable name `rootPkg` → `cliPkg` throughout the test
- Test description `"--version outputs the root package.json version"` → `"--version outputs the CLI package.json version"`

### 5. Add `npm pack --dry-run` step to CI

Add a step to `.github/workflows/ci.yml` `cli-ci` job to verify package contents after build:
```yaml
- name: Verify package contents
  working-directory: cli
  run: |
    FILES=$(npm pack --dry-run 2>&1)
    echo "$FILES"
    echo "$FILES" | grep -q "dist/index.js" || { echo "::error::dist/index.js missing from package"; exit 1; }
```

### 6. Update CLAUDE.md version table

Add note that CLI reads its own `package.json` at runtime (not root).

## Implementation Steps

1. Edit `cli/package.json` — remove `private`, add `description`, `license`, `repository`, `homepage`, `keywords`, `engines`, `files`, `prepublishOnly`
2. Edit `cli/src/index.ts` — change `require("../../package.json")` to `require("../package.json")`
3. Edit `cli/src/__tests__/integration/version.test.ts` — fix path, rename `rootPkg` → `cliPkg`, update test description
4. Edit `.github/workflows/ci.yml` — add `npm pack --dry-run` step to `cli-ci` job
5. Edit `CLAUDE.md` version table — update CLI entry

## Files to Modify

| File | Change |
|------|--------|
| `cli/package.json` | Remove private, add npm metadata |
| `cli/src/index.ts` | Fix version import path |
| `cli/src/__tests__/integration/version.test.ts` | Fix path, rename variable, update description |
| `.github/workflows/ci.yml` | Add npm pack verification step |
| `CLAUDE.md` | Update version table |

## Testing Strategy

1. `cd cli && npm run build` — verify TypeScript compiles
2. `cd cli && npm test` — verify tests pass (including version test)
3. `node cli/dist/index.js --version` — verify correct version output
4. `cd cli && npm pack --dry-run` — verify only `dist/` is included, `dist/index.js` present
5. Simulate global install: `npm install -g ./cli` → `passwd-sso --version` → verify correct output → `npm uninstall -g passwd-sso-cli`
6. `npx next build` from root — verify no regression in main app build

## Considerations

- **No README.md for CLI**: Not creating one unless requested (per CLAUDE.md rules)
- **License file**: The `files` field only includes `dist/`. npm automatically includes `package.json` and `LICENSE` if present at package root. CLI currently has no separate LICENSE — the root LICENSE applies. This is acceptable for now.
- **npm org/scope**: Using unscoped `passwd-sso-cli` name. If the name is taken on npm, will need `@ngc-shj/passwd-sso-cli` or similar.
- **CI publish workflow**: Not adding automated `npm publish` in CI — can be added as a follow-up when ready to publish.
