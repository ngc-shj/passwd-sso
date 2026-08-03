#!/usr/bin/env bash
# Take-only database backup for the self-hosted / Docker Compose deployment.
#
# Dumps every database in the target set plus cluster globals, validates each
# archive with the reader that will restore it, publishes the run atomically,
# then prunes old generations. Never restores, drops, or writes to a database.
#
# Usage:
#   scripts/backup-db.sh
#
# Environment variables:
#   BACKUP_DIR            (optional) Backup root (default: $HOME/passwd-sso-backups)
#   BACKUP_RETAIN         (optional) Generations to keep, incl. this run (default: 7)
#   BACKUP_DATABASES      (optional) Space-separated targets (default: passwd_sso jackson)
#   BACKUP_DRY_RUN        (optional) "true" previews the prune and exits (default: false)
#   BACKUP_ALLOW_IN_REPO  (optional) "true" permits a destination inside a git worktree
#   BACKUP_TLS_MODE       (optional) TLS floor for URL mode: verify-full|verify-ca (default: verify-full)
#   MIGRATION_DATABASE_URL (optional) When set, selects URL mode instead of Compose mode
#   COMPOSE_DB_SERVICE    (optional) Compose service name (default: db)
#   COMPOSE_DB_SUPERUSER  (optional) Role used for pg_dump in Compose mode (default: passwd_user)
#   BACKUP_FAILED_MAX_AGE_DAYS (optional) Age bound for <stamp>.FAILED corpora, in
#                              whole days; 0 means "older than 24h", not "keep
#                              none" — find -mtime +0 is >= 1 day (default: 7)
#   PGSSLROOTCERT         (optional) CA bundle for the TLS floor, when the URL carries no sslrootcert=
#
# Exit codes:
#   0 — success
#   1 — every failure. The cause is identified by a single BACKUP_ERR:<CODE>
#       line on stderr; the code set is closed and declared in ERR_CODES below.
#
# Restore is deliberately out of scope: see docs/operations/dev-host-migration.md.

set -euo pipefail
IFS=$' \t\n'

# ─── Error identity ──────────────────────────────────────────
#
# One exit code cannot identify a cause, so every failure prints exactly one
# greppable identifier. The set is closed; the self-test asserts on these.
# Mirrors the FORBIDDEN: / EMPTY_SCAN: shape used by scripts/checks/*.
ERR_CODES="BAD_ENV BAD_URL NO_CA NO_DOCKER NO_COMPOSE_FILE UNKNOWN_SERVICE
DB_NOT_RUNNING NO_CLIENT DEST_UNSAFE DEST_IN_REPO LOCKED DUMP_FAILED
VALIDATE_FAILED PRUNE_ABORTED RUN_VANISHED OLD_BASH INTERRUPTED INTERNAL
CONNECT_FAILED STAMP_TAKEN"

# Single exit point for failures. The EXIT trap only ever normalises a status
# it did not produce; it never synthesises a code.
fail() {
  local code="$1"; shift
  FAILED_CODE="$code"
  printf 'BACKUP_ERR:%s %s\n' "$code" "$*" >&2
  exit 1
}

log() { printf '[backup-db] %s\n' "$*"; }
warn() { printf '[backup-db] WARNING: %s\n' "$*" >&2; }

# ─── State the trap reads ────────────────────────────────────
#
# Initialised before the trap is armed: under `set -u` a reference to an unset
# variable inside the trap is itself a fault, stacking a second failure on the
# first.
RUN_PARTIAL=""
RUN_PUBLISHED=""
LOCK_DIR=""
FAILED_CODE=""
KEEP_PARTIAL_AS_FAILED=""
SIGNAL_NAME=""
PGPASS_FILE=""
PGSSLROOTCERT_IN="${PGSSLROOTCERT:-}"
ORIGINAL_CWD="$(pwd -P)"

cleanup() {
  local rc=$?
  trap - EXIT

  if [ -n "$RUN_PARTIAL" ] && [ -d "$RUN_PARTIAL" ]; then
    if [ -n "$KEEP_PARTIAL_AS_FAILED" ]; then
      # A validation failure keeps the archives: the fault may be the reader
      # (a missing or skewed client), and destroying a possibly-good archive
      # to punish the validator is the wrong direction.
      failed_dst="${RUN_PARTIAL%.partial}.FAILED"
      # `mv a b` with b an existing directory moves a INTO b. Suffixing keeps the
      # corpus visible and correctly named instead of nesting it out of reach.
      # <stamp>.<pid>.FAILED, not <stamp>.FAILED.<pid>: the suffix has to stay
      # terminal or list_stamped ".FAILED" cannot see it, and an unmanaged
      # directory is a full plaintext corpus nothing ever bounds.
      [ -e "$failed_dst" ] && failed_dst="${RUN_PARTIAL%.partial}.$$.FAILED"
      if mv -- "$RUN_PARTIAL" "$failed_dst" 2>/dev/null; then
        warn "kept $failed_dst for diagnosis"
      else
        warn "could not keep $RUN_PARTIAL for diagnosis; removing it"
        rm -rf -- "$RUN_PARTIAL"
      fi
    else
      rm -rf -- "$RUN_PARTIAL"
    fi
  fi

  # rm -rf, not rmdir: the lock directory holds a pid file. `|| true` because
  # this is the last command in the trap before the status decision, and under
  # `set -e` its failure would otherwise become the script's exit status —
  # reporting a successful run as a failure.
  [ -n "$PGPASS_FILE" ] && rm -f -- "$PGPASS_FILE" 2>/dev/null

  # Only if it is still OURS: a run that lost a race and exits must not remove
  # the winner's lock.
  if [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] \
     && [ "$(cat -- "$LOCK_DIR/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -rf -- "$LOCK_DIR" 2>/dev/null || true
  fi

  if [ "$rc" -ne 0 ] && [ -z "$FAILED_CODE" ]; then
    # A status no fail() produced: 127 command-not-found, 125/126 from docker,
    # 130 from SIGINT. C1 promises exactly one identifier per failure, so the
    # trap supplies one rather than letting the run exit anonymously.
    if [ "$rc" -ge 128 ]; then
      # The signal NAME, recorded by the handler. Deriving it from the status
      # cannot work when several handlers share one exit code, and reporting a
      # systemctl stop as Ctrl-C points the diagnosis at an absent operator.
      printf 'BACKUP_ERR:INTERRUPTED terminated by SIG%s\n' "${SIGNAL_NAME:-UNKNOWN}" >&2
    else
      printf 'BACKUP_ERR:INTERNAL command exited %d without a named cause\n' "$rc" >&2
    fi
  fi

  [ "$rc" -eq 0 ] && exit 0
  exit 1
}
on_signal() {
  SIGNAL_NAME="$1"
  exit $((128 + $2))
}
trap cleanup EXIT
# Every fatal signal an operator or a supervisor can realistically send. Without
# these the EXIT trap never runs and the credential file survives. SIGKILL stays
# irreducible — the passfile lives inside the audited backup root for that case.
trap 'on_signal INT 2' INT
trap 'on_signal TERM 15' TERM
trap 'on_signal HUP 1' HUP
trap 'on_signal QUIT 3' QUIT
trap 'on_signal PIPE 13' PIPE
trap 'on_signal ALRM 14' ALRM
trap 'on_signal USR1 10' USR1
trap 'on_signal USR2 12' USR2

# ─── Portability helpers ─────────────────────────────────────
#
# The primary operator host is macOS, whose /bin/bash is 3.2 and whose coreutils
# are BSD. No mapfile/readarray, no associative arrays, no `stat -c`, no
# `readlink -f` — see the plan's portability floor.

if [ "${BASH_VERSINFO[0]:-0}" -lt 3 ]; then
  fail OLD_BASH "bash 3.0 or newer is required (found ${BASH_VERSION:-unknown})"
fi

# Resolve a path, following symlinks in every component. `cd … && pwd -P` is
# portable and needs no coreutils.
resolve_path() {
  ( cd -- "$1" >/dev/null 2>&1 && pwd -P )
}

# Nearest existing ancestor of a possibly-absent path.
nearest_existing() {
  local p="$1"
  while [ -n "$p" ] && [ "$p" != "/" ] && [ ! -d "$p" ]; do
    p="$(dirname -- "$p")"
  done
  printf '%s' "$p"
}

# Octal mode of a path, on either coreutils flavour.
stat_mode() {
  case "$(uname -s)" in
    Darwin|*BSD) stat -f '%Lp' -- "$1" ;;
    *)           stat -c '%a' -- "$1" ;;
  esac
}

# The holder's start time, so a reused pid is not mistaken for a live run. Empty
# where the platform does not expose it, in which case the pid check stands alone.
proc_starttime() {
  if [ -r "/proc/$1/stat" ]; then
    awk '{print $22}' "/proc/$1/stat" 2>/dev/null || true
  else
    ps -o lstart= -p "$1" 2>/dev/null | tr -d ' ' || true
  fi
}

# device:inode of a path — the object's identity, which a path string is not.
stat_ident() {
  case "$(uname -s)" in
    Darwin|*BSD) stat -f '%d:%i' -- "$1" 2>/dev/null || printf 'unknown' ;;
    *)           stat -c '%d:%i' -- "$1" 2>/dev/null || printf 'unknown' ;;
  esac
}

stat_uid() {
  case "$(uname -s)" in
    Darwin|*BSD) stat -f '%u' -- "$1" ;;
    *)           stat -c '%u' -- "$1" ;;
  esac
}

# Extended ACLs are invisible to the mode bits, so a directory can read 0700
# and still be readable by another principal.
has_extended_acl() {
  local listing
  case "$(uname -s)" in
    Darwin|*BSD) listing="$(ls -lde -- "$1" 2>/dev/null || true)" ;;
    *)           listing="$(ls -ld -- "$1" 2>/dev/null || true)" ;;
  esac
  # A trailing '+' on the mode field marks an ACL on both flavours; macOS
  # additionally prints the ACEs on continuation lines.
  # Ten '?' — the mode field is 10 characters (type + 3x3 permission bits), and
  # the ACL marker is the 11th. Nine matched nothing, so this branch was dead
  # and a directory carrying a default ACL passed the check with mode 0700
  # while another uid could read every published archive.
  case "$listing" in
    ??????????+*) return 0 ;;
  esac
  case "$listing" in
    *$'\n'*) return 0 ;;
  esac
  return 1
}

# Mount options that make ownership and mode advisory rather than enforced.
# vfat/exfat report a fabricated uid/mode; macOS mounts external media
# `noowners` by default, which is scenario 2's own medium.
mount_is_unsafe() {
  local target="$1" line
  line="$(df -P -- "$target" 2>/dev/null | tail -n1 || true)"
  local dev="${line%% *}"
  local mounts
  mounts="$(mount 2>/dev/null || true)"
  local m
  while IFS= read -r m; do
    case "$m" in
      "$dev on "*)
        # Only the parenthesised option/type field: matching the whole line
        # refuses a safe ext4 destination that merely happens to be mounted at
        # /mnt/exfat-archive.
        local opts="${m##*(}"
        opts="${opts%)*}"
        case ",$opts," in
          *,noowners,*|*noowners*|*msdos*|*exfat*|*vfat*|*smbfs*|*cifs*|*nfs*|*osxfuse*|*macfuse*)
            printf '%s' "$m"; return 0 ;;
        esac
        ;;
    esac
  done <<EOF
$mounts
EOF
  return 1
}

# ─── Environment validation (INV-C1a) ────────────────────────
#
# Member set = this block. Every variable the script reads is validated here
# before any process is spawned; the self-test re-derives the set from the
# usage header and asserts equality.

# Suppress xtrace from the FIRST expansion of the credential, not from the
# parse. `set -x` traces the default-assignment below and the mode test that
# follows it, so a suppression that starts at the parser leaks the URL twice
# before it runs — measured, not assumed.
XTRACE_WAS_ON=""
case "$-" in *x*) XTRACE_WAS_ON=1 ;; esac
{ set +x; } 2>/dev/null

BACKUP_DIR="${BACKUP_DIR:-$HOME/passwd-sso-backups}"
BACKUP_RETAIN="${BACKUP_RETAIN:-7}"
BACKUP_DATABASES="${BACKUP_DATABASES:-passwd_sso jackson}"
BACKUP_DRY_RUN="${BACKUP_DRY_RUN:-false}"
BACKUP_ALLOW_IN_REPO="${BACKUP_ALLOW_IN_REPO:-false}"
BACKUP_TLS_MODE="${BACKUP_TLS_MODE:-verify-full}"
BACKUP_FAILED_MAX_AGE_DAYS="${BACKUP_FAILED_MAX_AGE_DAYS:-7}"
COMPOSE_DB_SERVICE="${COMPOSE_DB_SERVICE:-db}"
COMPOSE_DB_SUPERUSER="${COMPOSE_DB_SUPERUSER:-passwd_user}"
MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-}"

case "$BACKUP_DIR" in
  /*) ;;
  *) fail BAD_ENV "BACKUP_DIR must be an absolute path (got: $BACKUP_DIR)" ;;
esac
case "$BACKUP_DIR" in
  *$'\n'*) fail BAD_ENV "BACKUP_DIR must not contain a newline" ;;
esac

if ! [[ "$BACKUP_RETAIN" =~ ^[1-9][0-9]*$ ]]; then
  # Zero is rejected rather than treated as "unlimited": a naive pruner with
  # BACKUP_RETAIN=0 deletes every generation including the one just written.
  fail BAD_ENV "BACKUP_RETAIN must be a positive integer (got: $BACKUP_RETAIN)"
fi

# Counted by iterating the SAME loop that does the work: a guard that strips
# only spaces while the loop splits on IFS disagrees with it about what "empty"
# means, and a tab-only value published a run containing no database at all.
_db_count=0
FIRST_DB=""
for _db in $BACKUP_DATABASES; do
  [ -n "$FIRST_DB" ] || FIRST_DB="$_db"
  if ! [[ "$_db" =~ ^[A-Za-z_][A-Za-z0-9_$]*$ ]]; then
    fail BAD_ENV "BACKUP_DATABASES contains an invalid database name: $_db"
  fi
  _db_count=$((_db_count + 1))
done
[ "$_db_count" -gt 0 ] || fail BAD_ENV "BACKUP_DATABASES must name at least one database"
unset _db _db_count

for _pair in "BACKUP_DRY_RUN:$BACKUP_DRY_RUN" "BACKUP_ALLOW_IN_REPO:$BACKUP_ALLOW_IN_REPO"; do
  case "${_pair#*:}" in
    true|false) ;;
    *) fail BAD_ENV "${_pair%%:*} must be exactly 'true' or 'false' (got: ${_pair#*:})" ;;
  esac
done
unset _pair

case "$BACKUP_TLS_MODE" in
  # `require` is deliberately absent: it encrypts without verifying the
  # certificate or the hostname, which is not a floor against an on-path
  # attacker holding any certificate.
  verify-full|verify-ca) ;;
  *) fail BAD_ENV "BACKUP_TLS_MODE must be verify-full or verify-ca (got: $BACKUP_TLS_MODE)" ;;
esac

if ! [[ "$BACKUP_FAILED_MAX_AGE_DAYS" =~ ^[0-9]+$ ]]; then
  # A negative value would become `find -mtime "+-1"`, which matches every
  # candidate and deletes the whole retained-failure set; a non-numeric one
  # makes find error into a discarded stream and the bound stops existing.
  fail BAD_ENV "BACKUP_FAILED_MAX_AGE_DAYS must be a non-negative integer (got: $BACKUP_FAILED_MAX_AGE_DAYS)"
fi

if ! [[ "$COMPOSE_DB_SERVICE" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  fail BAD_ENV "COMPOSE_DB_SERVICE has an invalid form: $COMPOSE_DB_SERVICE"
fi
if ! [[ "$COMPOSE_DB_SUPERUSER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  fail BAD_ENV "COMPOSE_DB_SUPERUSER has an invalid form: $COMPOSE_DB_SUPERUSER"
fi

# ─── Connection mode (C2) ────────────────────────────────────

if [ -n "$MIGRATION_DATABASE_URL" ]; then
  MODE="url"
else
  MODE="compose"
fi

# ─── URL parsing (C7) ────────────────────────────────────────
#
# libpq's URI grammar is the interpreter that defines what this variable
# means, so the script extracts ONLY the password — the one component that
# must not reach argv — and hands the password-stripped URL to pg_dump -d.
# Hosts, IPv6 literals, multi-host lists and query parameters are then parsed
# by the implementation that will do the connecting.

URL_STRIPPED=""
URL_PASSWORD=""
URL_DISPLAY=""
URL_PGPASS_HOST=""
URL_PGPASS_PORT=""
URL_PASSWORD_ENCODED=""

percent_decode() {
  # Byte-exact: no printf '%b', which re-interprets backslashes already present
  # in the password, and no eval, which would execute $(...) from a secret.
  local s="$1" c hex
  while [ -n "$s" ]; do
    c="${s%"${s#?}"}"
    s="${s#?}"
    if [ "$c" = "%" ] && [ "${#s}" -ge 2 ]; then
      hex="${s:0:2}"
      if [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
        # Decode this pair and emit it immediately. Accumulating into a buffer
        # and running `printf %b` at the end would re-interpret backslashes the
        # password legitimately contains — `p\nass` would become p-newline-ass.
        printf "\\x$hex"
        s="${s:2}"
        continue
      fi
    fi
    printf '%s' "$c"
  done
}

parse_url() {
  local url="$1" rest scheme authority tail userinfo hostpart

  case "$url" in
    postgresql://*) scheme="postgresql://" ;;
    postgres://*)   scheme="postgres://" ;;
    *) fail BAD_URL "MIGRATION_DATABASE_URL must start with postgres:// or postgresql://" ;;
  esac

  rest="${url#"$scheme"}"

  # The authority ends at the first '/', '?' or '#'. Everything after it is
  # handed through untouched.
  authority="${rest%%/*}"
  authority="${authority%%\?*}"
  authority="${authority%%#*}"
  tail="${rest#"$authority"}"

  case "$authority" in
    *@*)
      # A password strip is now MANDATORY. Failing to fire here must not fall
      # through to passing the whole URL — including the password — to
      # pg_dump in argv.
      userinfo="${authority%@*}"
      hostpart="${authority##*@}"
      case "$userinfo" in
        *:*)
          URL_PASSWORD_ENCODED="${userinfo#*:}"
          URL_PASSWORD="$(percent_decode "$URL_PASSWORD_ENCODED")"
          # Decided on the ENCODED form: percent_decode's output passes
          # through a command substitution, which strips trailing newlines, so
          # a password ending in %0A arrives here already altered and would
          # authenticate as a different secret. NUL cannot survive a shell
          # variable at all.
          case "$URL_PASSWORD_ENCODED" in
            *%0[Aa]*|*%0[Dd]*|*%00*) fail BAD_URL "the password contains an encoded newline or NUL, which .pgpass cannot represent" ;;
            *$'\n'*|*$'\r'*) fail BAD_URL "the password contains a literal newline, which .pgpass cannot represent" ;;
          esac
          case "$URL_PASSWORD" in
            *$'\n'*|*$'\r'*) fail BAD_URL "the password contains a newline, which .pgpass cannot represent" ;;
          esac
          userinfo="${userinfo%%:*}"
          ;;
        *)
          URL_PASSWORD=""
          ;;
      esac
      authority="${userinfo}@${hostpart}"
      ;;
    *)
      URL_PASSWORD=""
      ;;
  esac

  # An '@' surviving in the remainder means the authority was cut before the
  # userinfo ended — i.e. the password contained a raw '/', '?' or '#'. The
  # strip could not have run, so refusing is the only option that does not put
  # the credential in argv.
  case "$tail" in
    *@*) fail BAD_URL "MIGRATION_DATABASE_URL has an unencoded '/', '?' or '#' in the userinfo — percent-encode them (%2F, %3F, %23)" ;;
  esac

  # Belt and braces. The refusal that actually closes the leak class is the
  # mandatory strip above: an authority containing '@' must yield a password or
  # the URL is rejected. This post-condition cannot fire once that branch has
  # run — after the userinfo/hostpart split no ':' can precede an '@' — and is
  # kept only so a future edit to the split is caught here rather than in argv.
  case "$authority" in
    *:*@*) fail BAD_URL "could not separate the password from MIGRATION_DATABASE_URL" ;;
  esac

  URL_STRIPPED="${scheme}${authority}${tail}"
  URL_DISPLAY="${scheme}${authority}"

  # Narrow the passfile to this host/port when the authority is a single plain
  # host — a wildcard entry offers the superuser password to whatever peer the
  # connection reaches. Multi-host and bracketed IPv6 forms keep the wildcard;
  # host=/hostaddr= are refused above, so the authority is the peer either way.
  local hp="${authority##*@}"
  # Validated before it reaches a credential file or the MANIFEST: both are
  # line-oriented, and neither escapes what it is given.
  case "$hp" in
    *$'\n'*|*$'\r'*) fail BAD_URL "the connection authority contains a newline" ;;
    *\\*) fail BAD_URL "the connection authority contains a backslash, which .pgpass reads as an escape" ;;
  esac
  case "$hp" in
    "")      fail BAD_URL "MIGRATION_DATABASE_URL names no host — the Unix-socket form gives the passfile nothing to scope to, so the entry would be a wildcard offering the password to any peer" ;;
    *,*|\[*) URL_PGPASS_HOST="*"; URL_PGPASS_PORT="*" ;;
    *:*:*)   fail BAD_URL "the connection authority has more than one colon: $hp" ;;
    *:*)     URL_PGPASS_HOST="${hp%:*}"; URL_PGPASS_PORT="${hp##*:}" ;;
    *)       URL_PGPASS_HOST="$hp";      URL_PGPASS_PORT="*" ;;
  esac
  case "${URL_PGPASS_PORT}" in
    \*|[0-9]*) ;;
    *) fail BAD_URL "the connection port is not numeric: $URL_PGPASS_PORT" ;;
  esac

  # libpq accepts the password as a URI QUERY parameter too, and percent-decodes
  # the keyword before lookup — `?password=`, `?%70assword=` and every other
  # encoding of those bytes are the same parameter to it. A strip that covers
  # only the userinfo therefore leaves that spelling in the URL that reaches
  # pg_dump's argv, where every local user can read it. Decoding the query here
  # would be a second adjudicator of libpq's grammar (the mistake this design
  # exists to avoid), so the spelling is refused outright.
  local decoded_query="${URL_STRIPPED#*\?}"
  [ "$decoded_query" = "$URL_STRIPPED" ] && decoded_query=""
  if [ -n "$decoded_query" ]; then
    decoded_query="$(percent_decode "$decoded_query")"
    # Member set derived from every parameter that can carry a credential,
    # redirect the peer, or select a transport the TLS floor does not govern.
    case "$decoded_query" in
      *password=*|*passfile=*|*service=*|*oauth_client_secret=*|*sslpassword=*|*sslkeylogfile=*|*scram_client_key=*|*scram_server_key=*)
        fail BAD_URL "MIGRATION_DATABASE_URL must not carry a credential or credential-file parameter (password, passfile, service, oauth_client_secret, sslpassword, sslkeylogfile, scram_client_key, scram_server_key) — the password goes in the userinfo, and the rest select material this script cannot audit" ;;
      *host=*|*hostaddr=*)
        fail BAD_URL "MIGRATION_DATABASE_URL must not carry host= or hostaddr= — they move the connection away from the authority that MANIFEST records and that the TLS floor verifies" ;;
      *gssencmode=*)
        fail BAD_URL "gssencmode is not accepted: it selects a transport the TLS floor does not govern" ;;
      *dbname=*)
        fail BAD_URL "MIGRATION_DATABASE_URL must not carry dbname= (the target set is BACKUP_DATABASES)" ;;
    esac
  fi
}

# Build the per-target conninfo. The database is appended as a query parameter
# because libpq lets a later parameter win, and because PGDATABASE loses to the
# URL's own path component.
conninfo_for() {
  local db="$1" sep url
  url="$URL_STRIPPED"
  case "$url" in
    *\?*) sep="&" ;;
    *)    sep="?" ;;
  esac
  # sslmode is appended LAST so libpq's own last-occurrence-wins settles the
  # floor regardless of what the operator wrote or how they encoded it. A
  # string-level rejection cannot: libpq percent-decodes both the keyword and
  # the value, so ?%73slmode=disable is sslmode=disable to it and matches no
  # regex over the raw text.
  printf '%s%sdbname=%s&sslmode=%s&gssencmode=disable' "$url" "$sep" "$db" "$BACKUP_TLS_MODE"
}

if [ "$MODE" = "url" ]; then
  parse_url "$MIGRATION_DATABASE_URL"

  # verify-* is unusable without a root certificate, and libpq's own error text
  # steers the operator toward disabling verification. Refuse before any dump
  # with a cause the operator can act on.
  case "$URL_STRIPPED" in
    *sslrootcert=*) ;;
    *)
      [ -n "${PGSSLROOTCERT:-}" ] || fail NO_CA \
        "$BACKUP_TLS_MODE needs a CA: pass sslrootcert= in MIGRATION_DATABASE_URL or set PGSSLROOTCERT"
      ;;
  esac
fi

# Past this point nothing expands the raw URL or the password outside run_pg,
# which suppresses tracing around its own credential-bearing prefix. Restore the
# operator's trace so the rest of the run stays debuggable.
[ -n "$XTRACE_WAS_ON" ] && set -x
true


# ─── Required binaries (derived from the invocation sites) ───

require_binary() {
  command -v -- "$1" >/dev/null 2>&1 || fail NO_CLIENT "$1 not found on PATH ($2)"
}

if [ "$MODE" = "url" ]; then
  # The whole set is preflighted, not just the one the first failure would
  # reveal: a host with pg_restore but no pg_dumpall would otherwise dump both
  # databases and then die mid-run, after the partial directory exists.
  require_binary pg_dump "required by URL mode"
  require_binary pg_dumpall "required for the cluster globals member"
  require_binary pg_restore "required to validate each archive"
  require_binary psql "required to verify the achieved transport"
else
  # A distinct code from NO_CLIENT: "install Docker" and "install the Postgres
  # client" are different remedies, and one exit status cannot say which.
  command -v -- docker >/dev/null 2>&1 || fail NO_DOCKER "docker not found on PATH (required by Compose mode)"
fi

# ─── Compose preflight (C2) ──────────────────────────────────

compose() { docker compose "$@"; }

if [ "$MODE" = "compose" ]; then
  compose_config_err=""
  if ! compose_config_err="$(compose config --quiet 2>&1)"; then
    case "$compose_config_err" in
      *"no configuration file provided"*)
        fail NO_COMPOSE_FILE "no compose configuration under $ORIGINAL_CWD — run from the repository root"
        ;;
      *)
        fail NO_COMPOSE_FILE "docker compose could not read its configuration under $ORIGINAL_CWD: $compose_config_err"
        ;;
    esac
  fi

  # `docker compose ps --status running` exits 0 for a STOPPED service, so the
  # exit status cannot decide this predicate. The content can. Capturing into a
  # variable also keeps the shape away from `| grep -q`, which the repo's own
  # gate forbids for the SIGPIPE inversion it hides.
  running_ids=""
  ps_status=0
  running_ids="$(compose ps --status running --quiet -- "$COMPOSE_DB_SERVICE" 2>/dev/null)" || ps_status=$?
  if [ "$ps_status" -ne 0 ]; then
    fail UNKNOWN_SERVICE "compose project has no service named '$COMPOSE_DB_SERVICE'"
  fi
  if [ -z "$running_ids" ]; then
    fail DB_NOT_RUNNING "compose service '$COMPOSE_DB_SERVICE' is not running — start it first"
  fi
fi

ACHIEVED_TLS=""

verify_transport() {
  local row
  local diag
  # stderr is kept: the password lives in PGPASSFILE, so libpq's message carries
  # no credential, and it is the only text that separates a missing CA from a
  # wrong host, a rejected password, or a server with TLS switched off.
  diag="$(run_pg psql -Atq -d "$(conninfo_for "$FIRST_DB")" \
    -c "select ssl, coalesce(version,''), coalesce(cipher,'') from pg_stat_ssl where pid = pg_backend_pid()" 2>&1)" \
    || fail CONNECT_FAILED "could not connect to verify the transport: $diag"
  row="$diag"
  case "$row" in
    t\|*) ACHIEVED_TLS="${row#t|}" ;;
    *) fail CONNECT_FAILED "the connection is not encrypted with TLS despite a $BACKUP_TLS_MODE floor (pg_stat_ssl reports ssl=false) — a GSSAPI-encrypted or cleartext session would report this" ;;
  esac
}

# ─── Destination safety (C4) ─────────────────────────────────

dest_parent="$(nearest_existing "$BACKUP_DIR")"
[ -n "$dest_parent" ] || fail DEST_UNSAFE "cannot resolve any existing ancestor of $BACKUP_DIR"

# The git check runs on the nearest existing ancestor because BACKUP_DIR may not
# exist yet. Ambient GIT_* variables are stripped: they redirect discovery and
# would let the environment decide the verdict.
repo_top=""
dest_top=""
if command -v git >/dev/null 2>&1; then
  repo_top="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_CEILING_DIRECTORIES \
    git -C "$(dirname -- "$0")" rev-parse --show-toplevel 2>/dev/null || true)"
  dest_top="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_CEILING_DIRECTORIES \
    git -C "$dest_parent" rev-parse --show-toplevel 2>/dev/null || true)"
fi

if [ -z "$dest_top" ] && [ "$BACKUP_ALLOW_IN_REPO" != "true" ]; then
  # An unanswered check is not a passed check. git may be absent, or may refuse
  # the directory under safe.directory; either way the operator should know the
  # guard did not run rather than assume it did.
  command -v git >/dev/null 2>&1 \
    || warn "git is not on PATH — the in-repository destination check did NOT run"
fi
if [ -n "$dest_top" ] && [ "$BACKUP_ALLOW_IN_REPO" != "true" ]; then
  if [ -n "$repo_top" ] && [ "$dest_top" = "$repo_top" ]; then
    fail DEST_IN_REPO "BACKUP_DIR is inside this repository ($dest_top) — choose a path outside it"
  fi
  fail DEST_IN_REPO "BACKUP_DIR is inside a git worktree ($dest_top) — choose a path outside it, or set BACKUP_ALLOW_IN_REPO=true"
fi
[ "$BACKUP_ALLOW_IN_REPO" = "true" ] && warn "BACKUP_ALLOW_IN_REPO=true — dumps may be committed or enter a Docker build context"

umask 077

if [ ! -e "$BACKUP_DIR" ]; then
  mkdir -m 0700 -- "$BACKUP_DIR" || fail DEST_UNSAFE "could not create $BACKUP_DIR"
fi

[ -L "$BACKUP_DIR" ] && fail DEST_UNSAFE "$BACKUP_DIR is a symlink"
[ -d "$BACKUP_DIR" ] || fail DEST_UNSAFE "$BACKUP_DIR is not a directory"

BACKUP_ROOT="$(resolve_path "$BACKUP_DIR")"
[ -n "$BACKUP_ROOT" ] || fail DEST_UNSAFE "could not resolve $BACKUP_DIR"
ROOT_IDENT="$(stat_ident "$BACKUP_ROOT")"

# umask governs only NEWLY created inodes, so from the second run onward — when
# the root already exists — it verifies nothing. Read the achieved state back.
dest_mode="$(stat_mode "$BACKUP_ROOT")"
dest_uid="$(stat_uid "$BACKUP_ROOT")"
[ "$dest_uid" = "$(id -u)" ] || fail DEST_UNSAFE "$BACKUP_ROOT is owned by uid $dest_uid, not by $(id -u)"
if [ "$(( 8#$dest_mode & 8#077 ))" -ne 0 ]; then
  fail DEST_UNSAFE "$BACKUP_ROOT has mode $dest_mode — group/other access must be absent"
fi
if has_extended_acl "$BACKUP_ROOT"; then
  fail DEST_UNSAFE "$BACKUP_ROOT carries an extended ACL, which grants access the mode bits do not show"
fi
if unsafe_mount="$(mount_is_unsafe "$BACKUP_ROOT")"; then
  case "$(uname -s)" in
    Darwin) fail DEST_UNSAFE "$BACKUP_ROOT is on a filesystem that does not enforce ownership or mode: $unsafe_mount — macOS ignores ownership on external volumes by default; enable it with: sudo diskutil enableOwnership '$BACKUP_ROOT'" ;;
    *)      fail DEST_UNSAFE "$BACKUP_ROOT is on a filesystem that does not enforce ownership or mode: $unsafe_mount" ;;
  esac
fi

# Every ancestor must also be closed to other principals: a world-writable
# parent lets another local user rename the leaf away between runs.
anc="$BACKUP_ROOT"
while [ "$anc" != "/" ]; do
  anc="$(dirname -- "$anc")"
  anc_mode="$(stat_mode "$anc")"
  anc_uid="$(stat_uid "$anc")"
  # Group/other-writable is only safe when the sticky bit stops another
  # principal renaming our entry out from under us (/tmp is the archetype).
  # Ownership is NOT a substitute: a directory we own at 0777 is renameable by
  # anyone, which is precisely the sequence this check exists to prevent.
  if [ "$(( 8#$anc_mode & 8#022 ))" -ne 0 ] && [ "$(( 8#$anc_mode & 8#1000 ))" -eq 0 ]; then
    fail DEST_UNSAFE "ancestor $anc is writable by others without the sticky bit (mode $anc_mode)"
  fi
  # A directory's OWNER can rename any entry in it whenever the owner-write bit
  # is set — sticky or not. So a third-party-owned ancestor is unsafe in the
  # ordinary 0755 case too, which is what an admin creating the root and
  # chown-ing it to the operator produces.
  if [ "$anc_uid" != "0" ] && [ "$anc_uid" != "$(id -u)" ] \
     && [ "$(( 8#$anc_mode & 8#200 ))" -ne 0 ]; then
    fail DEST_UNSAFE "ancestor $anc is owned by uid $anc_uid, who can rename our entry out of it (mode $anc_mode)"
  fi
  # Mode bits do not show an ACL grant. An ancestor at 0700 with a named-user
  # ACL is writable by that user, who can then substitute the backup root.
  if has_extended_acl "$anc"; then
    fail DEST_UNSAFE "ancestor $anc carries an extended ACL, which grants access the mode bits do not show"
  fi
done

# Candidates are exactly the non-symlink directories directly under the root
# whose basename matches the generation stamp plus the given suffix. Everything
# else — notes/, a regular file named like a generation, .partial, .lock.d — is
# invisible to the count, not merely skipped.
list_stamped() {
  local suffix="$1" n base
  ( cd -- "$BACKUP_ROOT" 2>/dev/null && ls -1 2>/dev/null ) | while IFS= read -r n; do
    base="${n%"$suffix"}"
    [ "$base$suffix" = "$n" ] || continue
    # The optional .<pid> is the collision form the cleanup trap writes, and it
    # exists ONLY for .FAILED. Admitting it for the empty suffix would let a
    # stray <stamp>.<digits> directory count as a published generation and push
    # a real one out of the retention window.
    if [ "$suffix" = ".FAILED" ]; then
      [[ "$base" =~ ^[0-9]{8}T[0-9]{6}Z(\.[0-9]+)?$ ]] || continue
    else
      [[ "$base" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    fi
    [ -L "$BACKUP_ROOT/$n" ] && continue
    [ -d "$BACKUP_ROOT/$n" ] || continue
    printf '%s\n' "$n"
  done | sort
}

# Under the lock there can be no live writer, so any surviving .partial is an
# orphan from a killed run. It matched neither list_stamped "" nor
# list_stamped ".FAILED", so it accumulated without bound.
prune_orphaned_partials() {
  local name
  # Under the lock there is no live writer, so a surviving passfile is residue
  # from a run that died before its trap could fire.
  for name in "$BACKUP_ROOT"/.pgpass.*; do
    [ -e "$name" ] || continue
    assert_root_unchanged
    rm -f -- "$name"
    warn "removed a credential file left by an interrupted run"
  done
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    assert_root_unchanged
    ( cd -- "$BACKUP_ROOT" && rm -rf -- "$name" )
    warn "removed orphaned $name from an interrupted run"
  done <<EOF
$(list_stamped ".partial")
EOF
}

# One place, so a future removal loop cannot be added without it. The check the
# generation pruner performs was not being performed by the other two.
assert_root_unchanged() {
  # $BACKUP_ROOT is what the removals traverse; $BACKUP_DIR resolves through any
  # symlink and is not the object being protected.
  [ "$(stat_ident "$BACKUP_ROOT")" = "$ROOT_IDENT" ] \
    || fail PRUNE_ABORTED "$BACKUP_DIR is no longer the directory that was audited"
}

prune_failed() {
  local keep="$BACKUP_RETAIN" names count=0 name removed=0 excess
  names="$(list_stamped ".FAILED")"
  while IFS= read -r name; do [ -n "$name" ] && count=$((count + 1)); done <<EOF
$names
EOF
  # Age first: a corpus kept "for diagnosis" past the window in which anyone
  # would diagnose it is just an extra copy of the database.
  local cutoff_days="$BACKUP_FAILED_MAX_AGE_DAYS"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [ -n "$(find "$BACKUP_ROOT/$name" -maxdepth 0 -type d -mtime "+$cutoff_days" -print 2>/dev/null)" ]; then
      assert_root_unchanged
      ( cd -- "$BACKUP_ROOT" && rm -rf -- "$name" )
      log "pruned failed run $name (older than ${cutoff_days}d)"
    fi
  done <<EOF
$names
EOF
  names="$(list_stamped ".FAILED")"
  count=0
  while IFS= read -r name; do [ -n "$name" ] && count=$((count + 1)); done <<EOF
$names
EOF

  excess=$((count - keep))
  [ "$excess" -gt 0 ] || return 0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ "$removed" -lt "$excess" ] || break
    assert_root_unchanged
    ( cd -- "$BACKUP_ROOT" && rm -rf -- "$name" )
    removed=$((removed + 1))
    log "pruned failed run $name"
  done <<EOF
$names
EOF
}

# ─── Mutual exclusion ────────────────────────────────────────
#
# mkdir is atomic on every POSIX filesystem and needs no external binary.
# flock(1) is util-linux and does not ship on macOS, the primary operator host.
LOCK_CANDIDATE="$BACKUP_ROOT/.lock.d"

# mkdir is the atomic exclusion primitive: it fails when the directory exists.
# (mv cannot serve here — moving onto an existing directory nests inside it and
# reports success.) The window between taking the lock and recording the holder
# is closed on the READER side: a lock with no pid is treated as held.
if ! mkdir -- "$LOCK_CANDIDATE" 2>/dev/null; then
  holder="$(cat -- "$LOCK_CANDIDATE/pid" 2>/dev/null || true)"
  # Reclaim a lock whose holder is gone. The pid was previously written and
  # never read, so one SIGKILL, OOM or power loss disabled backups permanently —
  # a fail-closed wedge on the deployment's only backup path, discovered only
  # when someone noticed the corpus had stopped advancing.
  holder_host="$(cat -- "$LOCK_CANDIDATE/host" 2>/dev/null || true)"
  holder_start="$(cat -- "$LOCK_CANDIDATE/starttime" 2>/dev/null || true)"

  # Every uncertainty resolves toward "held". A lock with no pid, or one written
  # by a different host whose liveness we cannot test, is not evidence that the
  # holder is gone — and treating it as such lets two runs dump into one root.
  if [ -z "$holder" ]; then
    fail LOCKED "$LOCK_CANDIDATE exists but records no holder — remove it by hand if you are sure no run is active"
  fi
  if [ "$holder_host" != "$(uname -n)" ]; then
    fail LOCKED "$LOCK_CANDIDATE is held by ${holder_host:-an unknown host} (pid $holder) — liveness cannot be tested from here"
  fi
  if kill -0 "$holder" 2>/dev/null \
     && { [ -z "$holder_start" ] || [ "$holder_start" = "$(proc_starttime "$holder")" ]; }; then
    fail LOCKED "another backup run holds $LOCK_CANDIDATE (pid $holder, alive)"
  fi

  # Not reclaimed by this script, at all. Not because reclaiming cannot be made
  # atomic — a rename-to-claim is — but because no automatic rule can tell a
  # dead holder from one whose process table entry is gone while its work is
  # not: a container restarted mid-dump, a run whose pid was reused, a lock
  # written by a host this one cannot interrogate. Taking the lock on a guess
  # puts two writers in one directory. A human confirming nothing is running is
  # the only check that actually decides it.
  fail LOCKED "$LOCK_CANDIDATE is held by a process that is gone (pid $holder). Confirm no backup is running, then: rm -rf '$LOCK_CANDIDATE'"
fi
LOCK_DIR="$LOCK_CANDIDATE"
# Recorded immediately, and guarded: a lock we hold but cannot describe would
# make the NEXT run unable to distinguish us from a dead holder.
printf '%s\n' "$$" > "$LOCK_DIR/pid" || fail INTERNAL "could not record the lock holder"
printf '%s\n' "$(uname -n)" > "$LOCK_DIR/host" || fail INTERNAL "could not record the lock host"
printf '%s\n' "$(proc_starttime "$$")" > "$LOCK_DIR/starttime" || true

# ─── Dry run (C6g) ───────────────────────────────────────────

list_generations() { list_stamped ""; }

if [ "$BACKUP_DRY_RUN" = "true" ]; then
  existing="$(list_generations)"
  n=0
  while IFS= read -r g; do [ -n "$g" ] && n=$((n + 1)); done <<EOF
$existing
EOF
  # The real run adds a generation BEFORE pruning, so previewing over the
  # current count reports one deletion too few — and says "nothing will be
  # deleted" at exactly the boundary where the real run deletes one.
  total=$((n + 1))
  would_delete=$((total - BACKUP_RETAIN))
  [ "$would_delete" -lt 0 ] && would_delete=0
  log "DRY RUN — $n existing generation(s); a real run would hold $total and delete $would_delete of them"
  i=0
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    [ "$i" -lt "$would_delete" ] || break
    log "DRY RUN — would delete $g"
    i=$((i + 1))
  done <<EOF
$existing
EOF
  # The same predicate the sweep uses, so the preview cannot name something the
  # run would leave alone (a regular file called notes.partial, say).
  while IFS= read -r _res; do
    [ -n "$_res" ] || continue
    log "DRY RUN — would remove residue $_res"
  done <<EOF
$(list_stamped ".partial")
EOF
  for _res in "$BACKUP_ROOT"/.pgpass.*; do
    [ -e "$_res" ] || continue
    log "DRY RUN — would remove residue $(basename -- "$_res")"
  done
  # .FAILED is pruned by age and by count before every dump, so the preview has
  # to cover it or it understates what the run destroys.
  _failed_n=0
  while IFS= read -r _res; do [ -n "$_res" ] && _failed_n=$((_failed_n + 1)); done <<EOF
$(list_stamped ".FAILED")
EOF
  _failed_excess=$((_failed_n - BACKUP_RETAIN))
  [ "$_failed_excess" -lt 0 ] && _failed_excess=0
  log "DRY RUN — $_failed_n failed run(s) retained; would prune $_failed_excess by count, plus any older than ${BACKUP_FAILED_MAX_AGE_DAYS}d"
  _i=0
  while IFS= read -r _res; do
    [ -n "$_res" ] || continue
    if [ -n "$(find "$BACKUP_ROOT/$_res" -maxdepth 0 -type d -mtime "+$BACKUP_FAILED_MAX_AGE_DAYS" -print 2>/dev/null)" ]; then
      log "DRY RUN — would prune failed run $_res (older than ${BACKUP_FAILED_MAX_AGE_DAYS}d)"
    elif [ "$_i" -lt "$_failed_excess" ]; then
      log "DRY RUN — would prune failed run $_res"
      _i=$((_i + 1))
    fi
  done <<EOF
$(list_stamped ".FAILED")
EOF
  unset _res _failed_n _failed_excess _i
  log "DRY RUN — nothing was dumped and nothing was deleted"
  exit 0
fi

# Only past the dry-run exit: a preview must delete nothing. Still before this
# run creates its own passfile, which a later sweep would delete.
prune_orphaned_partials


# After the destination is verified and the lock is held: the passfile lives
# inside BACKUP_ROOT, so it cannot be created before BACKUP_ROOT exists.
{ set +x; } 2>/dev/null
if [ "$MODE" = "url" ] && [ -n "$URL_PASSWORD" ]; then
  # Inside BACKUP_ROOT, not $TMPDIR: the destination is the only directory whose
  # owner, mode, extended ACLs, mount options and ancestors this script has
  # verified, and $TMPDIR is neither declared nor audited.
  PGPASS_FILE="$(umask 077 && mktemp "$BACKUP_ROOT/.pgpass.XXXXXX")" \
    || fail INTERNAL "could not create a password file"
  # Wildcards for host/port/database: the script decides those per target, and a
  # mismatch would silently fall back to no password.
  # Escape the two bytes .pgpass treats as syntax. Backslash first: escaping the
  # colon first would then have its own backslash escaped again.
  _pgpass_pw="${URL_PASSWORD//\\/\\\\}"
  _pgpass_pw="${_pgpass_pw//:/\\:}"
  printf '%s:%s:*:*:%s\n' "${URL_PGPASS_HOST:-*}" "${URL_PGPASS_PORT:-*}" "$_pgpass_pw" > "$PGPASS_FILE"
  unset _pgpass_pw
  URL_PASSWORD=""
fi
[ -n "$XTRACE_WAS_ON" ] && set -x
true


# ─── Prune failed generations (before any dump) ──────────────
#
# .FAILED directories are produced only by runs that did NOT publish, so
# pruning them after publication would never run in a persistently failing
# deployment — the exact state in which they accumulate.

# ─── Run directory ───────────────────────────────────────────

# The stamp has one-second resolution and is the generation key, so a second
# run inside the same second would collide. Waiting for the clock to advance
# keeps the name in the ^[0-9]{8}T[0-9]{6}Z$ shape the pruner matches — a suffix
# would not — and the no-clobber check before the publish stays as the backstop
# for the case this loop cannot see (another host writing the same directory).
STAMP=""
_tries=0
while [ "$_tries" -lt 5 ]; do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  if [ ! -e "$BACKUP_ROOT/$STAMP" ] && [ ! -e "$BACKUP_ROOT/$STAMP.partial" ] \
     && [ ! -e "$BACKUP_ROOT/$STAMP.FAILED" ]; then
    break
  fi
  sleep 1
  _tries=$((_tries + 1))
  STAMP=""
done
[ -n "$STAMP" ] || fail STAMP_TAKEN "every generation stamp in the last few seconds is taken under $BACKUP_ROOT — retry"
unset _tries

RUN_PARTIAL="$BACKUP_ROOT/$STAMP.partial"
RUN_FINAL="$BACKUP_ROOT/$STAMP"


# Only now, past the dry-run exit: previewing must delete nothing. Still before
# any dump, because .FAILED directories are produced only by runs that did NOT
# publish — pruning them after publication would never run in a persistently
# failing deployment, which is exactly when they accumulate.
prune_failed

mkdir -- "$RUN_PARTIAL" || fail INTERNAL "could not create $RUN_PARTIAL"

# ─── Dump ────────────────────────────────────────────────────
#
# Children get a constructed environment rather than an inherited one: libpq
# reads roughly thirty PG* variables, and a denylist of the ones remembered at
# authoring time is a member set that expands every time someone reads the
# documentation again.
run_pg() {
  local bin="$1"; shift
  local xt=""
  case "$-" in *x*) xt=1 ;; esac
  { set +x; } 2>/dev/null
  # env -i gives an allowlisted child environment, so no ambient PG* variable
  # can influence the connection — but a `PGPASSWORD=<secret>` element would
  # then be part of env(1)'s OWN argv, readable through /proc/<pid>/cmdline for
  # the life of that process. A PGPASSFILE path is not a secret, so the
  # credential travels in a mode-0600 file instead and never reaches any argv.
  env -i \
    PATH="$PATH" HOME="$HOME" LANG="${LANG:-C}" \
    ${PGPASS_FILE:+PGPASSFILE="$PGPASS_FILE"} \
    ${PGSSLROOTCERT_IN:+PGSSLROOTCERT="$PGSSLROOTCERT_IN"} \
    "$bin" "$@"
  local rc=$?
  [ -n "$xt" ] && set -x
  return $rc
}

dump_database() {
  local db="$1" out="$2"
  if [ "$MODE" = "url" ]; then
    # --create so the DATABASE TOC entry carries the database-level ACLs
    # (GRANT/REVOKE CONNECT, ALTER DATABASE SET). pg_dumpall --globals-only
    # does not emit them and a plain -Fc without --create does not either.
    run_pg pg_dump -Fc --create -d "$(conninfo_for "$db")" -f "$out"
  else
    compose exec -T -- "$COMPOSE_DB_SERVICE" \
      pg_dump -Fc --create -U "$COMPOSE_DB_SUPERUSER" -d "$db" > "$out"
  fi
}

dump_globals() {
  local out="$1"
  if [ "$MODE" = "url" ]; then
    run_pg pg_dumpall --globals-only --no-role-passwords -d "$(conninfo_for "$FIRST_DB")" -f "$out"
  else
    compose exec -T -- "$COMPOSE_DB_SERVICE" \
      pg_dumpall --globals-only --no-role-passwords -U "$COMPOSE_DB_SUPERUSER" > "$out"
  fi
}

# Count non-comment TOC entries. `pg_restore --list` always emits a block of
# ';'-prefixed header lines, so a raw line count can never reach zero and the
# check would collapse into "did the command exit 0".
toc_entries() {
  local archive="$1" listing=""
  if [ "$MODE" = "url" ]; then
    listing="$(run_pg pg_restore --list "$archive")" || return 1
  else
    # No filename argument: naming /dev/stdin makes pg_restore re-open and seek
    # a non-seekable descriptor, which fails on every valid archive. stdin is
    # its default input.
    listing="$(compose exec -T -- "$COMPOSE_DB_SERVICE" pg_restore --list < "$archive")" || return 1
  fi
  printf '%s\n' "$listing" | grep -cv '^;' || true
}

# Recorded because a restore reads these archives with whatever client the
# target host has, and pg_restore refuses a format version newer than its own.
tool_version() {
  if [ "$MODE" = "url" ]; then
    run_pg "$1" --version 2>/dev/null || printf 'unknown'
  else
    compose exec -T -- "$COMPOSE_DB_SERVICE" "$1" --version 2>/dev/null || printf 'unknown'
  fi
}

if [ "$MODE" = "url" ]; then
  # Before the MANIFEST is written, not after: the manifest records what the
  # connection actually negotiated, and a group written first can only record
  # the unset default.
  verify_transport
  log "transport verified: $ACHIEVED_TLS"
fi

MANIFEST="$RUN_PARTIAL/MANIFEST"
{
  printf 'script: scripts/backup-db.sh\n'
  printf 'taken_at: %s\n' "$STAMP"
  printf 'hostname: %s\n' "$(uname -n)"
  printf 'mode: %s\n' "$MODE"
  if [ "$MODE" = "url" ]; then
    printf 'target: %s\n' "$URL_DISPLAY"
    printf 'tls_floor: %s\n' "$BACKUP_TLS_MODE"
  else
    printf 'target: compose service %s\n' "$COMPOSE_DB_SERVICE"
  fi
  printf 'pg_dump_version: %s\n' "$(tool_version pg_dump)"
  printf 'pg_restore_version: %s\n' "$(tool_version pg_restore)"
  printf 'validated_at: %s\n' "$([ "$MODE" = "url" ] && printf host || printf 'compose service %s' "$COMPOSE_DB_SERVICE")"
  [ "$MODE" = "url" ] && printf 'achieved_tls: %s\n' "${ACHIEVED_TLS:-unknown}"
} > "$MANIFEST"

if [ "$MODE" = "url" ]; then
  log "mode=url target=$URL_DISPLAY tls_floor=$BACKUP_TLS_MODE"
else
  log "mode=compose target=service:$COMPOSE_DB_SERVICE user=$COMPOSE_DB_SUPERUSER"
fi

for db in $BACKUP_DATABASES; do
  archive="$RUN_PARTIAL/$db.dump"
  log "dumping $db"
  dump_database "$db" "$archive" || fail DUMP_FAILED "pg_dump failed for database $db"
  [ -s "$archive" ] || fail DUMP_FAILED "pg_dump produced an empty archive for $db"

  KEEP_PARTIAL_AS_FAILED=1
  entries="$(toc_entries "$archive")" || fail VALIDATE_FAILED "pg_restore could not read $db.dump"
  KEEP_PARTIAL_AS_FAILED=""

  # Zero entries is a legitimate state — jackson before its first boot — not a
  # corruption signal. Record it and say so loudly rather than failing a run
  # whose other members are good.
  [ "$entries" -eq 0 ] && warn "$db.dump contains no restorable entries (empty database?)"
  printf 'member: %s size=%s entries=%s\n' "$db.dump" "$(wc -c < "$archive" | tr -d ' ')" "$entries" >> "$MANIFEST"
done

log "dumping cluster globals"
GLOBALS="$RUN_PARTIAL/globals.sql"
dump_globals "$GLOBALS" || fail DUMP_FAILED "pg_dumpall failed for cluster globals"
[ -s "$GLOBALS" ] || fail DUMP_FAILED "pg_dumpall produced an empty globals.sql"

# globals.sql is plain SQL, so pg_restore is not its reader. This is structural
# assurance only — the trailing marker detects truncation, the role count
# detects an empty result — and the docs say so rather than letting INV-C5a's
# universal claim stand over a member it does not reach.
globals_tail="$(tail -n 5 -- "$GLOBALS")"
case "$globals_tail" in
  *"PostgreSQL database cluster dump complete"*) ;;
  *) KEEP_PARTIAL_AS_FAILED=1; fail VALIDATE_FAILED "globals.sql is missing its completion marker (truncated?)" ;;
esac
role_count="$(grep -c '^CREATE ROLE' -- "$GLOBALS" || true)"
[ "$role_count" -ge 1 ] || { KEEP_PARTIAL_AS_FAILED=1; fail VALIDATE_FAILED "globals.sql declares no roles"; }
printf 'member: globals.sql size=%s roles=%s structural_check_only=true\n' \
  "$(wc -c < "$GLOBALS" | tr -d ' ')" "$role_count" >> "$MANIFEST"

# ─── Publish ─────────────────────────────────────────────────

# `mv a b` where b is a directory moves a INTO b. INV-C4e's protection was the
# bare mkdir of the .partial, which a collision at the PUBLISH step walks past:
# the run nested itself inside the existing generation and reported success.
[ -e "$RUN_FINAL" ] && fail INTERNAL "$RUN_FINAL already exists — refusing to publish over it"
mv -- "$RUN_PARTIAL" "$RUN_FINAL" || fail INTERNAL "could not publish $RUN_FINAL"
RUN_PUBLISHED="$RUN_FINAL"
RUN_PARTIAL=""
log "published $RUN_FINAL"

# ─── Prune generations (C6) ──────────────────────────────────
#
# The run just published is excluded by resolved path, not by assuming it sorts
# newest: a clock step or two hosts sharing one BACKUP_DIR can make it the
# oldest name, and with BACKUP_RETAIN=1 a name-ordered pruner deletes the
# backup it has just validated and exits 0.
published_real="$(resolve_path "$RUN_PUBLISHED")"

candidates=""
cand_count=0
while IFS= read -r g; do
  [ -n "$g" ] || continue
  [ "$(resolve_path "$BACKUP_ROOT/$g")" = "$published_real" ] && continue
  candidates="$candidates$g"$'\n'
  cand_count=$((cand_count + 1))
done <<EOF
$(list_generations)
EOF

# +1 for the published run, which is kept and is not a candidate.
to_delete=$((cand_count + 1 - BACKUP_RETAIN))
[ "$to_delete" -lt 0 ] && to_delete=0

if [ "$to_delete" -gt 0 ]; then
  deleted=0
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    [ "$deleted" -lt "$to_delete" ] || break
    # Re-verify that the root the name will resolve through is still the root
    # that was audited. `rm` re-walks every component by name, so a swap
    # between the scan and the removal lands the deletion elsewhere.
    # Identity, not path text: a rename-and-recreate leaves `cd … && pwd -P`
    # byte-identical while the directory `rm` will walk into is a different
    # object. Comparing the strings could never detect the swap the surrounding
    # comment describes.
    assert_root_unchanged
    ( cd -- "$BACKUP_ROOT" && rm -rf -- "$g" ) || fail PRUNE_ABORTED "could not remove generation $g"
    deleted=$((deleted + 1))
    log "pruned generation $g"
  done <<EOF
$candidates
EOF
fi

# Success is conditional on the artifact still existing, not on the dump having
# once succeeded.
[ -d "$RUN_PUBLISHED" ] || fail RUN_VANISHED "$RUN_PUBLISHED disappeared during pruning"
for db in $BACKUP_DATABASES; do
  [ -s "$RUN_PUBLISHED/$db.dump" ] || fail RUN_VANISHED "$RUN_PUBLISHED/$db.dump is missing"
done
[ -s "$RUN_PUBLISHED/globals.sql" ] || fail RUN_VANISHED "$RUN_PUBLISHED/globals.sql is missing"

log "OK — $RUN_PUBLISHED"
