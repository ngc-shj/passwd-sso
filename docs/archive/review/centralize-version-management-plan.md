# Plan: Centralize Version Management

## Objective

Eliminate version number drift by establishing root `package.json` as the single source of truth and ensuring all other version references derive from it automatically.

## Requirements

### Functional
- All user-facing version strings (CLI `--version`, extension manifest, npm metadata) must reflect the same value
- A single command bumps all version numbers atomically
- CI detects version drift on every PR

### Non-functional
- No heavy tooling (no lerna, changesets, semantic-release)
- OpenAPI spec version (`1.0.0`) remains independent (API versioning lifecycle)
- Chrome manifest version must stay `X.Y.Z` numeric format (no prerelease tags)

## Technical Approach

### Single Source of Truth: root `package.json`

```
passwd-sso/
├── package.json              ← version: "0.2.1" (SSOT)
├── cli/
│   ├── package.json          ← version: "0.2.1" (synced via bump script)
│   └── src/index.ts          ← reads root package.json at runtime
└── extension/
    ├── package.json          ← version: "0.2.1" (synced via bump script)
    └── manifest.config.ts    ← imports root package.json at build time
```

### CLI: `createRequire` for runtime version reading

CLI uses `"module": "NodeNext"` with `rootDir: "src"`. Direct `import` of `../../package.json` would break `outDir` structure. Use `createRequire(import.meta.url)` instead:

- From compiled `cli/dist/index.js`, `../../package.json` resolves to root package.json
- `resolveJsonModule: true` is already enabled
- CLI is `private: true`, so path stability is guaranteed

### Extension: static import at build time

`manifest.config.ts` runs in Vite pipeline with `moduleResolution: "bundler"` and `noEmit: true`. No `rootDir` constraint applies:

- `import rootPkg from "../package.json"` works directly
- Vite resolves and bundles the JSON at build time

### Version bump: shell script

Simple `scripts/bump-version.sh` updates all three `package.json` files. Validates strict `X.Y.Z` format (no prerelease tags — Chrome manifest compatibility). Uses `process.argv` to avoid shell interpolation issues.

### CI guard: version-check job

Lightweight job (no `node_modules` install needed) that compares versions across all three `package.json` files. Runs on every PR regardless of path filters.

## Implementation Steps

### Step 1: Fix CLI version reading

**File:** `cli/src/index.ts`

1. Add `createRequire` import from `node:module`
2. Create require function and load `../../package.json`
3. Replace hardcoded `.version("0.1.0")` with `.version(rootPkg.version)`

This also fixes the existing bug where CLI reports `0.1.0` instead of `0.2.1`.

### Step 1b: Add CLI version test

**New file:** `cli/src/__tests__/unit/version.test.ts`

Test via child process execution (NOT module import — `index.ts` calls `program.parse()` at module top-level, which would execute with vitest's `process.argv` and crash). Spawn `node dist/index.js --version`, capture stdout, assert it matches root `package.json` version. Requires CLI to be built first (`npm run build` in cli/).

### Step 1c: Update cli-ci job step order

**File:** `.github/workflows/ci.yml` (cli-ci job)

Reorder steps so that `npm run build` precedes `npm test`. The version test (Step 1b) spawns `dist/index.js` which only exists after compilation. Current order: `npm ci` → `npm test` → `npm run build`. Required order: `npm ci` → `npm run build` → `npm test`.

### Step 2: Fix extension manifest version

**File:** `extension/manifest.config.ts`

1. Add `import rootPkg from "../package.json"`
2. Replace hardcoded `version: "0.2.1"` with `version: rootPkg.version`

**File:** `extension/tsconfig.json`

3. Add `"manifest.config.ts"` to the `include` array so `tsc` type-checks it

### Step 3: Create version bump script

**New file:** `scripts/bump-version.sh`

1. Accept new version as argument
2. Validate strict semver format: `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$` (no prerelease tags, no leading zeros — ensures Chrome manifest compatibility)
3. Update `version` field in all three `package.json` files using `process.argv` (not shell interpolation)
4. Run `npm install --package-lock-only` in root, cli, and extension to sync lock files
5. Print summary and next steps

Implementation pattern for safe JSON update:
```bash
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  pkg.version = process.argv[2];
  fs.writeFileSync(process.argv[1], JSON.stringify(pkg, null, 2) + '\n');
" "$PKG" "$VERSION"
```

**File:** `package.json` — add npm script:
```json
"version:bump": "bash scripts/bump-version.sh"
```

### Step 4: Add CI version-check job

**File:** `.github/workflows/ci.yml`

Add a `version-check` job that:
1. Reads version from root, cli, and extension `package.json`
2. Compares all three
3. Fails with `::error::` annotation if any mismatch
4. Uses `working-directory: ${{ github.workspace }}` explicitly

No `needs: changes` dependency — always runs.

### Step 4b: Add extension manifest version CI verification

**File:** `.github/workflows/ci.yml` (extension-ci job)

Add a post-build step in the extension CI job to verify `dist/manifest.json` contains the expected version after `vite build`. The extension-ci job uses `working-directory: extension`, so the comparison reads `../package.json` for root version:

```bash
EXPECTED=$(node -p "require('../package.json').version")
ACTUAL=$(node -p "require('./dist/manifest.json').version")
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "::error::Manifest version ($ACTUAL) does not match root ($EXPECTED)"
  exit 1
fi
```

### Step 5: Verification

1. `cd cli && npm run build` — verify `dist/index.js` resolves version correctly
2. `cd extension && npm run build` — verify manifest includes correct version
3. `npx vitest run` — all existing tests pass (including new CLI version test)
4. `npx next build` — production build succeeds
5. **Dynamic propagation check:** Temporarily change root version, rebuild CLI and extension, verify both reflect the new version, then restore

## Testing Strategy

- **CLI version (automated):** Unit test in `cli/src/__tests__/unit/version.test.ts` asserts `program.version()` matches root `package.json`
- **Extension manifest (CI):** Post-build CI step reads `dist/manifest.json` and compares version to root `package.json`
- **Bump script:** Run with test version, verify all three `package.json` files updated
- **CI check:** Test locally by temporarily changing one version, run the check script
- **Existing tests:** `npx vitest run` must pass (no regressions)

## Considerations & Constraints

- **CLI path resolution:** `createRequire` resolves relative to the compiled file (`cli/dist/index.js`). Path `../../package.json` correctly reaches root. If CLI is ever published as a standalone package, this path would break — but CLI is `private: true`.
- **Chrome version format:** Chrome manifest `version` only accepts `X.Y.Z.W` (numeric). Bump script enforces strict `X.Y.Z` to prevent incompatibility.
- **OpenAPI spec version** (`src/lib/openapi-spec.ts:14`): Intentionally excluded. API version `1.0.0` follows its own lifecycle independent of app version.
- **Test assertions:** `src/lib/openapi-spec.test.ts:29` and `src/__tests__/api/v1/openapi-json.test.ts:6` assert `version: "1.0.0"` — these are for the API spec, not the app version, so no changes needed.
