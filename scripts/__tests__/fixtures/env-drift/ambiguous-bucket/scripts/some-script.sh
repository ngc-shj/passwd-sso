#!/usr/bin/env bash
# Fixture consumer for DATABASE_URL — referenced by env-allowlist.ts.
# Its presence proves the "stale allowlist" check passes, isolating the
# ambiguous-bucket case (CT5).
echo "$DATABASE_URL"
