#!/usr/bin/env bash
# NFR5 enforcer for docs/archive/review/prod-csp-violation-zero-plan.md.
#
# Every `RUN npm ci` in the Dockerfile must carry `--ignore-scripts`. The flag
# is a deliberate supply-chain control: no dependency install script runs
# inside the image build. It suppresses the ROOT project's own `postinstall`
# too, which is why the builder stage applies `patches/` with an explicit step
# — and that is exactly what makes dropping the flag the tempting wrong fix
# the next time that step misbehaves.
#
# Subject: `RUN` lines in the Dockerfile. The same words inside a comment are
# out of subject (Dockerfile's own comment mentions `npm ci`), which the
# `^\s*RUN\s+` anchor handles.
#
# The pattern this replaces was red-proved DEAD: it embedded the filename in
# the regex body, so it matched nothing — not even the mutated Dockerfile it
# existed to reject. Scope by path, never by smuggling the path into the
# pattern.
set -euo pipefail

DOCKERFILE="${1:-Dockerfile}"

if [ ! -f "$DOCKERFILE" ]; then
  echo "DOCKERFILE_SUBJECT_MISSING: $DOCKERFILE not found — refusing rather than reporting zero findings" >&2
  exit 2
fi

# Every `RUN npm ci …` line, RUN-anchored so comments are excluded.
run_npm_ci=$(grep -nE '^[[:space:]]*RUN[[:space:]]+npm[[:space:]]+ci\b' "$DOCKERFILE" || true)

if [ -z "$run_npm_ci" ]; then
  echo "DOCKERFILE_NO_NPM_CI: no 'RUN npm ci' line in $DOCKERFILE — the subject this gate exists to check is absent, which is a change worth noticing" >&2
  exit 2
fi

offenders=$(printf '%s\n' "$run_npm_ci" | grep -v -- '--ignore-scripts' || true)

if [ -n "$offenders" ]; then
  echo "NFR5 violation: every 'RUN npm ci' in $DOCKERFILE must carry --ignore-scripts." >&2
  echo "  Dependency install scripts would run inside the image build." >&2
  echo "  If the goal was to make the root postinstall apply patches/, use the" >&2
  echo "  explicit 'node_modules/.bin/patch-package --error-on-fail' step instead." >&2
  printf '%s\n' "$offenders" | sed 's/^/    /' >&2
  exit 1
fi

count=$(printf '%s\n' "$run_npm_ci" | wc -l | tr -d ' ')
echo "dockerfile-ignore-scripts: $count 'RUN npm ci' line(s), all carry --ignore-scripts."
