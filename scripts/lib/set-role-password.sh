# shellcheck shell=bash
# Sourced by scripts/set-*-password.sh: set one fixed role's password from
# stdin without the cleartext reaching the server.
#
# The statement carries a SCRAM-SHA-256 verifier (scripts/lib/scram-verifier.mjs),
# never the password: a refused statement is logged under the default
# `log_min_error_statement`, `log_statement = ddl|all` logs every one, and
# pg_stat_statements keeps the text. On a superuser connection the session also
# turns those three off before the ALTER, so not even the verifier is recorded.
# A non-superuser (a managed-database admin) cannot set them; there the verifier
# can still be recorded by all three — never the password.
#
# Not psql's \password: its prompt reads /dev/tty whenever the process has a
# controlling terminal, so run from an operator's shell it would ignore the
# password piped in and ask for one instead.
#
# Requires: psql, node (for the verifier), and psql-safe.sh sourced first.

SET_ROLE_PASSWORD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Fixed by the script that sources this file, never user input.
#   $1 role name   $2 label for log lines   $3.. the caller's own arguments
set_role_password() {
  # Off for the rest of the process and never restored: the password is
  # expanded again below, and `bash -x` would print every expansion.
  { set +x; } 2>/dev/null

  local role="$1" label="$2"
  shift 2

  local print_args_file=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --print-args-file)
        shift
        print_args_file="${1:-}"
        shift
        ;;
      *)
        echo '{"level":"error","msg":"unknown flag","flag":"'"$1"'"}' >&2
        exit 1
        ;;
    esac
  done

  local migration_url="${MIGRATION_DATABASE_URL:-}" dry_run="${DRY_RUN:-}"
  if [[ -z "$migration_url" ]]; then
    echo '{"level":"error","msg":"MIGRATION_DATABASE_URL is required"}' >&2
    exit 1
  fi

  trap psql_safe_cleanup EXIT
  psql_safe_url DB_URL "$migration_url"

  if [[ -t 0 ]]; then
    echo '{"level":"error","msg":"password expected on stdin (use < <(...) or pipe)"}' >&2
    exit 1
  fi

  # $(cat) drops trailing newlines, so `printf '%s\n'`, `openssl rand` output
  # and the like arrive as the password itself.
  local new_password
  new_password="$(cat)"
  if [[ -z "$new_password" ]]; then
    echo '{"level":"error","msg":"password expected on stdin (use < <(...) or pipe)"}' >&2
    exit 1
  fi
  if [[ "$new_password" == *$'\n'* || "$new_password" == *$'\r'* ]]; then
    echo '{"level":"error","msg":"password contains a line break"}' >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo '{"level":"error","msg":"node is required to compute the password verifier"}' >&2
    exit 1
  fi

  # The server's own scram_iterations (empty before PostgreSQL 16), so the
  # verifier is no weaker than one the server would make. DRY_RUN does not
  # connect and uses the default.
  local iterations="4096"
  if [[ "$dry_run" != "1" ]]; then
    iterations="$(psql_safe "$DB_URL" -v ON_ERROR_STOP=1 -Atq \
      -c "SELECT current_setting('scram_iterations', true)")"
  fi

  # Declared apart from the assignment: `local v="$(…)"` would report local's
  # status, not the helper's, and a refusal would carry on.
  local verifier
  verifier="$(printf '%s' "$new_password" \
    | node "$SET_ROLE_PASSWORD_LIB_DIR/scram-verifier.mjs" --iterations "$iterations")"
  # The verifier is interpolated into a quoted literal: accept only its exact
  # shape (base64 has no quote), whatever the helper printed.
  if [[ ! "$verifier" =~ ^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$ ]]; then
    echo '{"level":"error","msg":"password verifier has an unexpected shape"}' >&2
    exit 1
  fi

  local sql
  sql="SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user \\gset
\\if :su
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET pg_stat_statements.track_utility = off;
\\endif
ALTER ROLE ${role} PASSWORD '${verifier}';
"

  if [[ "$dry_run" == "1" ]]; then
    echo "[DRY_RUN] would invoke: psql -X \"${DB_URL}\" -v ON_ERROR_STOP=1 -f - (stdin: ALTER ROLE ${role} PASSWORD '<verifier>';)" >&2
    if [[ -n "$print_args_file" ]]; then
      # Test-only. A path that already exists keeps its own mode (umask applies
      # on creation only) and may be a symlink: refuse it.
      if [[ -e "$print_args_file" || -L "$print_args_file" ]]; then
        echo '{"level":"error","msg":"--print-args-file path already exists"}' >&2
        exit 1
      fi
      (
        umask 077
        set -o noclobber
        printf '%s' "$sql" > "$print_args_file"
      )
    fi
    exit 0
  fi

  printf '%s' "$sql" | psql_safe "$DB_URL" -v ON_ERROR_STOP=1 -f -

  echo "[${label}] OK — password updated for ${role}"
}
