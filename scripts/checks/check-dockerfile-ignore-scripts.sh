#!/usr/bin/env bash
# NFR5 enforcer for docs/archive/review/prod-csp-violation-zero-plan.md.
#
# Every npm install in the Dockerfile must carry `--ignore-scripts`. The flag is
# a deliberate supply-chain control: no dependency install script runs inside
# the image build. It suppresses the ROOT project's own `postinstall` too, which
# is why the builder stage applies `patches/` with an explicit step — and that
# is exactly what makes dropping the flag the tempting wrong fix the next time
# that step misbehaves.
#
# Subject: every `&&`-separated command segment of every `RUN` instruction that
# invokes an npm install verb. Three things this has to get right, each learned
# from a miss:
#
#  - **Verbs, not one spelling.** An earlier version matched `npm ci` only. This
#    Dockerfile already contains `npm install "prisma@…"` and `npm install -g
#    "npm@…"`, neither of which it could see.
#  - **Continuations.** Those two live on `\`-continued lines inside a compound
#    RUN, so a line-anchored `^RUN npm` never reaches them. Continuations are
#    flattened before matching.
#  - **Per command, on the WHOLE separator set.** A RUN with two installs where
#    only one carries the flag must fail. This has now been the same miss three
#    times — line-anchored, then verb-incomplete, then separator-incomplete
#    (`RUN npm ci --ignore-scripts; npm install evil` passed) — so the subject
#    is derived from POSIX sh's complete command-separator set `; & |` rather
#    than from whichever separator the last example happened to use.
#
# `npm init` is not an install verb and is deliberately excluded — it creates a
# manifest and runs nothing from the registry.
#
# The pattern this replaces was red-proved DEAD: it embedded the filename in the
# regex body, so it matched nothing — not even the mutated Dockerfile it existed
# to reject. Scope by path, never by smuggling the path into the pattern.
set -euo pipefail

DOCKERFILE="${1:-Dockerfile}"

if [ ! -f "$DOCKERFILE" ]; then
  echo "DOCKERFILE_SUBJECT_MISSING: $DOCKERFILE not found — refusing rather than reporting zero findings" >&2
  exit 2
fi

# Join `\`-continued lines, then keep RUN instructions only (so the word
# `npm ci` inside a comment stays out of subject), then split on every POSIX
# sh command separator so each command is judged on its own.
segments=$(
  sed -e ':a' -e '/\\$/N; s/\\\n//; ta' "$DOCKERFILE" \
    | grep -E '^[[:space:]]*RUN[[:space:]]' \
    | tr ';&|' '\n' \
    | grep -E '(^|[[:space:];])npm[[:space:]]+(ci|install|i|add)([[:space:]]|$)' \
    || true
)

if [ -z "$segments" ]; then
  echo "DOCKERFILE_NO_NPM_INSTALL: no npm install verb (ci|install|i|add) in a RUN instruction of $DOCKERFILE — the subject this gate exists to check is absent, which is a change worth noticing" >&2
  exit 2
fi

offenders=$(printf '%s\n' "$segments" | grep -v -- '--ignore-scripts' || true)

if [ -n "$offenders" ]; then
  echo "NFR5 violation: every npm install in $DOCKERFILE must carry --ignore-scripts." >&2
  echo "  Dependency install scripts would run inside the image build." >&2
  echo "  If the goal was to make the root postinstall apply patches/, use the" >&2
  echo "  explicit 'node_modules/.bin/patch-package --error-on-fail' step instead." >&2
  printf '%s\n' "$offenders" | sed 's/^[[:space:]]*/    /' >&2
  exit 1
fi

count=$(printf '%s\n' "$segments" | wc -l | tr -d ' ')
echo "dockerfile-ignore-scripts: $count npm install invocation(s), all carry --ignore-scripts."
