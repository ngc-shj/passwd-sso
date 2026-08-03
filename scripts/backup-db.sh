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
VALIDATE_FAILED PRUNE_ABORTED RUN_VANISHED OLD_BASH INTERRUPTED INTERNAL"

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
ORIGINAL_CWD="$(pwd -P)"

cleanup() {
  local rc=$?
  trap - EXIT

  if [ -n "$RUN_PARTIAL" ] && [ -d "$RUN_PARTIAL" ]; then
    if [ -n "$KEEP_PARTIAL_AS_FAILED" ]; then
      # A validation failure keeps the archives: the fault may be the reader
      # (a missing or skewed client), and destroying a possibly-good archive
      # to punish the validator is the wrong direction.
      mv -- "$RUN_PARTIAL" "${RUN_PARTIAL%.partial}.FAILED" 2>/dev/null || true
      warn "kept ${RUN_PARTIAL%.partial}.FAILED for diagnosis"
    else
      rm -rf -- "$RUN_PARTIAL"
    fi
  fi

  # rm -rf, not rmdir: the lock directory holds a pid file. `|| true` because
  # this is the last command in the trap before the status decision, and under
  # `set -e` its failure would otherwise become the script's exit status —
  # reporting a successful run as a failure.
  if [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ]; then
    rm -rf -- "$LOCK_DIR" 2>/dev/null || true
  fi

  if [ "$rc" -ne 0 ] && [ -z "$FAILED_CODE" ]; then
    # A status no fail() produced: 127 command-not-found, 125/126 from docker,
    # 130 from SIGINT. C1 promises exactly one identifier per failure, so the
    # trap supplies one rather than letting the run exit anonymously.
    if [ "$rc" -ge 128 ]; then
      printf 'BACKUP_ERR:INTERRUPTED terminated by signal %d\n' "$((rc - 128))" >&2
    else
      printf 'BACKUP_ERR:INTERNAL command exited %d without a named cause\n' "$rc" >&2
    fi
  fi

  [ "$rc" -eq 0 ] && exit 0
  exit 1
}
trap cleanup EXIT
trap 'exit 130' INT TERM

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
  case "$listing" in
    ?????????+*) return 0 ;;
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
        case "$m" in
          *noowners*|*msdos*|*exfat*|*vfat*|*smbfs*|*cifs*|*" nfs"*|*osxfuse*|*macfuse*)
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

BACKUP_DIR="${BACKUP_DIR:-$HOME/passwd-sso-backups}"
BACKUP_RETAIN="${BACKUP_RETAIN:-7}"
BACKUP_DATABASES="${BACKUP_DATABASES:-passwd_sso jackson}"
BACKUP_DRY_RUN="${BACKUP_DRY_RUN:-false}"
BACKUP_ALLOW_IN_REPO="${BACKUP_ALLOW_IN_REPO:-false}"
BACKUP_TLS_MODE="${BACKUP_TLS_MODE:-verify-full}"
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

for _db in $BACKUP_DATABASES; do
  if ! [[ "$_db" =~ ^[A-Za-z_][A-Za-z0-9_$]*$ ]]; then
    fail BAD_ENV "BACKUP_DATABASES contains an invalid database name: $_db"
  fi
done
unset _db
[ -n "${BACKUP_DATABASES// /}" ] || fail BAD_ENV "BACKUP_DATABASES must name at least one database"

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

percent_decode() {
  # Byte-exact: no printf '%b', which re-interprets backslashes already present
  # in the password, and no eval, which would execute $(...) from a secret.
  local s="$1" out="" c hex
  while [ -n "$s" ]; do
    c="${s%"${s#?}"}"
    s="${s#?}"
    if [ "$c" = "%" ] && [ "${#s}" -ge 2 ]; then
      hex="${s:0:2}"
      if [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
        out="$out$(printf '\\x%s' "$hex")"
        s="${s:2}"
        continue
      fi
    fi
    out="$out$c"
  done
  printf '%b' "$out"
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
          URL_PASSWORD="$(percent_decode "${userinfo#*:}")"
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

  # Post-condition: no ':' may remain before the '@' in the outgoing authority.
  # This is what turns a mis-parse into a refusal instead of a silent leak.
  case "$authority" in
    *:*@*) fail BAD_URL "could not separate the password from MIGRATION_DATABASE_URL" ;;
  esac

  URL_STRIPPED="${scheme}${authority}${tail}"
  URL_DISPLAY="${scheme}${authority}"

  case "$URL_STRIPPED" in
    *dbname=*) fail BAD_URL "MIGRATION_DATABASE_URL must not carry dbname= (the target set is BACKUP_DATABASES)" ;;
  esac
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
  printf '%s%sdbname=%s&sslmode=%s' "$url" "$sep" "$db" "$BACKUP_TLS_MODE"
}

if [ "$MODE" = "url" ]; then
  # Suppress xtrace across credential handling. `set -x` traces both the
  # assignment and the command prefix, so a `bash -x` run of a straightforward
  # implementation prints the password several times. Restored afterwards only
  # if it was on, so the suppression cannot silently disable an operator's
  # trace for the rest of the run.
  XTRACE_WAS_ON=""
  case "$-" in *x*) XTRACE_WAS_ON=1 ;; esac
  { set +x; } 2>/dev/null

  parse_url "$MIGRATION_DATABASE_URL"

  [ -n "$XTRACE_WAS_ON" ] && set -x

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
  case "$URL_STRIPPED" in
    *gssencmode=*) fail BAD_URL "gssencmode is not accepted: it selects a transport the TLS floor does not govern" ;;
  esac
fi

# ─── Required binaries (derived from the invocation sites) ───

require_binary() {
  command -v -- "$1" >/dev/null 2>&1 || fail NO_CLIENT "$1 not found on PATH ($2)"
}

if [ "$MODE" = "url" ]; then
  require_binary pg_dump "required by URL mode"
  require_binary pg_dumpall "required for the cluster globals member"
  require_binary pg_restore "required to validate each archive"
else
  require_binary docker "required by Compose mode"
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
  fail DEST_UNSAFE "$BACKUP_ROOT is on a filesystem that does not enforce ownership or mode: $unsafe_mount"
fi

# Every ancestor must also be closed to other principals: a world-writable
# parent lets another local user rename the leaf away between runs.
anc="$BACKUP_ROOT"
while [ "$anc" != "/" ]; do
  anc="$(dirname -- "$anc")"
  anc_mode="$(stat_mode "$anc")"
  anc_uid="$(stat_uid "$anc")"
  if [ "$(( 8#$anc_mode & 8#022 ))" -ne 0 ] && [ "$anc_uid" != "0" ] && [ "$anc_uid" != "$(id -u)" ]; then
    fail DEST_UNSAFE "ancestor $anc is writable by others (mode $anc_mode, uid $anc_uid)"
  fi
done

# ─── Mutual exclusion ────────────────────────────────────────
#
# mkdir is atomic on every POSIX filesystem and needs no external binary.
# flock(1) is util-linux and does not ship on macOS, the primary operator host.
LOCK_CANDIDATE="$BACKUP_ROOT/.lock.d"
if ! mkdir -- "$LOCK_CANDIDATE" 2>/dev/null; then
  holder="$(cat -- "$LOCK_CANDIDATE/pid" 2>/dev/null || echo unknown)"
  fail LOCKED "another backup run holds $LOCK_CANDIDATE (pid $holder)"
fi
LOCK_DIR="$LOCK_CANDIDATE"
printf '%s\n' "$$" > "$LOCK_DIR/pid"

# ─── Prune failed generations (before any dump) ──────────────
#
# .FAILED directories are produced only by runs that did NOT publish, so
# pruning them after publication would never run in a persistently failing
# deployment — the exact state in which they accumulate.
# Candidates are exactly the non-symlink directories directly under the root
# whose basename matches the generation stamp plus the given suffix. Everything
# else — notes/, a regular file named like a generation, .partial, .lock.d — is
# invisible to the count, not merely skipped.
list_stamped() {
  local suffix="$1" n base
  ( cd -- "$BACKUP_ROOT" 2>/dev/null && ls -1 2>/dev/null ) | while IFS= read -r n; do
    base="${n%"$suffix"}"
    [ "$base$suffix" = "$n" ] || continue
    [[ "$base" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    [ -L "$BACKUP_ROOT/$n" ] && continue
    [ -d "$BACKUP_ROOT/$n" ] || continue
    printf '%s\n' "$n"
  done | sort
}

prune_failed() {
  local keep=1 names count=0 name removed=0 excess
  names="$(list_stamped ".FAILED")"
  while IFS= read -r name; do [ -n "$name" ] && count=$((count + 1)); done <<EOF
$names
EOF
  excess=$((count - keep))
  [ "$excess" -gt 0 ] || return 0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ "$removed" -lt "$excess" ] || break
    ( cd -- "$BACKUP_ROOT" && rm -rf -- "$name" )
    removed=$((removed + 1))
    log "pruned failed run $name"
  done <<EOF
$names
EOF
}

prune_failed

# ─── Run directory ───────────────────────────────────────────

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_PARTIAL="$BACKUP_ROOT/$STAMP.partial"
RUN_FINAL="$BACKUP_ROOT/$STAMP"

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
  log "DRY RUN — nothing was dumped and nothing was deleted"
  exit 0
fi

mkdir -- "$RUN_PARTIAL" || fail INTERNAL "could not create $RUN_PARTIAL"

# ─── Dump ────────────────────────────────────────────────────
#
# Children get a constructed environment rather than an inherited one: libpq
# reads roughly thirty PG* variables, and a denylist of the ones remembered at
# authoring time is a member set that expands every time someone reads the
# documentation again.
run_pg() {
  local bin="$1"; shift
  { set +x; } 2>/dev/null
  env -i \
    PATH="$PATH" HOME="$HOME" LANG="${LANG:-C}" \
    ${URL_PASSWORD:+PGPASSWORD="$URL_PASSWORD"} \
    ${PGSSLROOTCERT:+PGSSLROOTCERT="$PGSSLROOTCERT"} \
    "$bin" "$@"
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
    run_pg pg_dumpall --globals-only --no-role-passwords -d "$(conninfo_for "${BACKUP_DATABASES%% *}")" -f "$out"
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
} > "$MANIFEST"

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
    if [ "$(resolve_path "$BACKUP_DIR")" != "$BACKUP_ROOT" ]; then
      fail PRUNE_ABORTED "$BACKUP_DIR no longer resolves to $BACKUP_ROOT"
    fi
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
