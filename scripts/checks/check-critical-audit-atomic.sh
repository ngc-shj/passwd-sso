#!/usr/bin/env bash
# M1: assert that the audit records for security-critical, single-mutation
# operations are written INSIDE the mutation's transaction (logAuditInTx), not
# post-commit best-effort (logAuditAsync).
#
# The CLAUDE.md audit-outbox contract: use logAuditInTx when "an audit record
# must not survive/precede a rolled-back mutation (or be lost when the mutation
# commits)". For these actions the business write is a single atomic mutation
# (a create or a CAS updateMany) whose audit must commit or roll back with it —
# a rotation/approval/revoke/recovery that lands with no audit trail is a
# forensic hole on exactly the operations most likely to be attacked or
# disputed.
#
# NOTE ON SCOPE: this gate covers only actions whose success audit pairs 1:1 with
# a single atomic mutation. It deliberately does NOT cover multi-step outcome
# audits (MASTER_KEY_ROTATION_EXECUTE, ADMIN_VAULT_RESET_EXECUTE) whose audit
# must run AFTER a post-CAS irreversible step to record its outcome (share
# revocation / data deletion counts) — forcing those into the CAS tx would drop
# the outcome data, so logAuditAsync is correct there. Rejection audits (no
# mutation) also correctly stay async.
#
# The gate is intentionally action-based, not file-based: a file may legitimately
# contain BOTH a logAuditInTx success path and a logAuditAsync rejection path for
# the same action. What must hold is that each critical action appears in at
# least one logAuditInTx call — i.e. the atomic path exists and was not reverted.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"
# SCAN_ROOT override is a single test seam so the self-test can point the gate at
# a fixture tree; production CI uses the repo root.
SCAN_ROOT="${CRITICAL_AUDIT_ATOMIC_ROOT:-$REPO_ROOT}"
cd "$SCAN_ROOT"

echo "check-critical-audit-atomic: SCAN_ROOT=$SCAN_ROOT"

SEARCH_DIR="src/app/api"
[ -d "$SEARCH_DIR" ] || { echo "OK ($SEARCH_DIR not present)"; exit 0; }

# Actions that MUST have their success audit written via logAuditInTx.
CRITICAL_ACTIONS=(
  "MASTER_KEY_ROTATION_INITIATE"
  "MASTER_KEY_ROTATION_APPROVE"
  "MASTER_KEY_ROTATION_REVOKE"
  "RECOVERY_PASSPHRASE_RESET"
)

# Collect the text of every logAuditInTx(...) call across the API tree. A call
# can span multiple lines, so pull a window after each match. Using a generous
# window (40 lines) so the action constant inside the call body is captured.
intx_blocks="$(grep -rn --include="*.ts" -A40 "logAuditInTx(" "$SEARCH_DIR" 2>/dev/null || true)"

fail=0
for action in "${CRITICAL_ACTIONS[@]}"; do
  # The action must appear within a logAuditInTx window.
  if ! printf '%s\n' "$intx_blocks" | grep -q "AUDIT_ACTION\.${action}\b"; then
    echo "ERROR: AUDIT_ACTION.${action} is not written via logAuditInTx (must be atomic with its mutation — M1)."
    echo "       Its success audit must live INSIDE the mutation transaction, not in a post-commit logAuditAsync."
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAIL: one or more security-critical actions lost their atomic audit path (M1)."
  exit 1
fi

echo "OK (all ${#CRITICAL_ACTIONS[@]} security-critical actions write their audit via logAuditInTx)"
