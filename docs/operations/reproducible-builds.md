# Reproducible Builds

## Overview

passwd-sso pins Docker base images to SHA256 digests and embeds build metadata to support reproducible and verifiable builds.

## Docker Image Pinning

All `FROM` directives in the Dockerfile use digest-pinned images:

```dockerfile
FROM node:20-alpine@sha256:<digest> AS deps
```

To update the pinned digest:

```bash
docker pull node:20-alpine
# Copy the Digest: sha256:... from the output
# Update all three FROM lines in Dockerfile
```

## Build Metadata

The following environment variables are embedded at build time via `next.config.ts`:

| Variable | Source | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_BUILD_SHA` | `git rev-parse --short HEAD` | Git commit SHA |
| `NEXT_PUBLIC_BUILD_TIME` | `new Date().toISOString()` | Build timestamp |

These are available client-side via `process.env.NEXT_PUBLIC_BUILD_SHA` and `process.env.NEXT_PUBLIC_BUILD_TIME`.

## Dependency Integrity

- `npm ci` verifies `package-lock.json` integrity hashes automatically
- `--ignore-scripts` prevents post-install scripts from modifying the build
- The lockfile ensures deterministic dependency resolution

## Verification Steps

To verify a build matches a specific commit:

1. Check out the target commit
2. Run `npm ci --ignore-scripts`
3. Run `npx next build`
4. Compare the build output

```bash
git checkout <commit-sha>
npm ci --ignore-scripts
npx next build
```

## Limitations

- npm registry versions are not pinned beyond `package-lock.json` (registry could serve different content for same version, though this is extremely rare)
- Build timestamp will differ between builds (use `NEXT_PUBLIC_BUILD_SHA` for identity)
- Alpine package versions (`apk upgrade`) may differ over time
