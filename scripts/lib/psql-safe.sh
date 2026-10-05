# shellcheck shell=bash
# Sourced by the scripts that run psql against an operator-supplied URL. Two
# properties every such caller needs:
#
#  - `psql -X`. Without it ~/.psqlrc runs inside the caller's connection —
#    often a superuser one — and its output lands ahead of the rows the caller
#    parses, so an `\echo` there can forge a result the database never gave.
#
#  - No password in argv. A URL on psql's command line is readable by every
#    local user through /proc/<pid>/cmdline for the life of the process. The
#    password moves into a mode-0600 passfile and argv carries the URL without
#    it. Not PGPASSWORD: libpq documents it as visible to other users on some
#    platforms, and backup-db.sh already settled on a passfile.
#
# Usage:
#   source "$SCRIPT_DIR/lib/psql-safe.sh"
#   trap psql_safe_cleanup EXIT        # or call it from the caller's own trap
#   psql_safe_url DB_URL "$MIGRATION_DATABASE_URL"
#   psql_safe "$DB_URL" -c 'select 1'
#
# The passfile entry is scoped by user only. The host/port/database fields are
# wildcards, which offers the password to the same peers the URL-embedded
# password reached before: whatever the URL names. Scoping by user is what lets
# two URLs with different roles share one passfile.

PSQL_SAFE_PASSFILE=""

psql_safe_fail() {
  printf '{"level":"error","msg":"%s"}\n' "$*" >&2
  exit 1
}

# Byte-exact percent-decoding: no printf '%b' over the whole string, which
# re-interprets backslashes already present in the password.
psql_safe_percent_decode() {
  local s="$1" c hex
  while [ -n "$s" ]; do
    c="${s%"${s#?}"}"
    s="${s#?}"
    if [ "$c" = "%" ] && [ "${#s}" -ge 2 ]; then
      hex="${s:0:2}"
      if [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
        printf "\\x$hex"
        s="${s:2}"
        continue
      fi
    fi
    printf '%s' "$c"
  done
}

# .pgpass fields escape ':' and '\' with a backslash.
psql_safe_pgpass_escape() {
  local v="${1//\\/\\\\}"
  printf '%s' "${v//:/\\:}"
}

# psql_safe_url <out-var> <url>
#   Sets <out-var> to <url> with the password removed and records the password
#   in the passfile. Refuses any URL whose password it cannot separate rather
#   than passing it through to argv.
psql_safe_url() {
  # Tracing goes off before the arguments are copied: `local url="$2"` is itself
  # traced with the password expanded.
  local xt=""
  case "$-" in *x*) xt=1 ;; esac
  { set +x; } 2>/dev/null
  local out_var="$1" url="$2"
  local scheme rest authority tail userinfo hostpart user enc_pw pw query kv key IFS

  case "$url" in
    postgresql://*) scheme="postgresql://" ;;
    postgres://*)   scheme="postgres://" ;;
    *) psql_safe_fail "connection URL must start with postgres:// or postgresql://" ;;
  esac
  rest="${url#"$scheme"}"
  authority="${rest%%/*}"
  authority="${authority%%\?*}"
  authority="${authority%%#*}"
  tail="${rest#"$authority"}"

  # An '@' after the authority means a raw '/', '?' or '#' cut the userinfo
  # short, so the password is still in the remainder. A second '@' inside the
  # authority is the same ambiguity. Either way the strip cannot be trusted.
  case "$tail" in
    *@*) psql_safe_fail "connection URL has an unencoded '/', '?' or '#' in the userinfo; percent-encode them (%2F, %3F, %23)" ;;
  esac
  case "$authority" in
    *@*@*) psql_safe_fail "connection URL has an unencoded '@' in the userinfo; percent-encode it (%40)" ;;
  esac

  user=""
  pw=""
  case "$authority" in
    *@*)
      userinfo="${authority%@*}"
      hostpart="${authority#*@}"
      case "$userinfo" in
        *:*)
          enc_pw="${userinfo#*:}"
          userinfo="${userinfo%%:*}"
          # .pgpass is line-oriented, and a command substitution strips
          # trailing newlines, so these could only reach libpq altered.
          case "$enc_pw" in
            *%0[Aa]*|*%0[Dd]*|*%00*|*$'\n'*|*$'\r'*)
              psql_safe_fail "connection URL password contains a newline or NUL, which a passfile cannot represent" ;;
          esac
          pw="$(psql_safe_percent_decode "$enc_pw")"
          ;;
      esac
      user="$(psql_safe_percent_decode "$userinfo")"
      authority="${userinfo}@${hostpart}"
      ;;
  esac

  # libpq also accepts credentials as query parameters and percent-decodes the
  # keyword first, so each key is decoded after splitting the raw query on '&'.
  query="${tail#*\?}"
  [ "$query" = "$tail" ] && query=""
  if [ -n "$query" ]; then
    IFS='&'
    for kv in $query; do
      key="$(psql_safe_percent_decode "${kv%%=*}")"
      case "$key" in
        password|passfile|sslpassword|oauth_client_secret|scram_client_key|scram_server_key)
          psql_safe_fail "connection URL must not carry $key= as a query parameter; put the password in the userinfo" ;;
      esac
    done
    IFS=$' \t\n'
  fi

  if [ -n "$pw" ]; then
    if [ -z "$PSQL_SAFE_PASSFILE" ]; then
      PSQL_SAFE_PASSFILE="$(umask 077 && mktemp "${TMPDIR:-/tmp}/psql-safe.XXXXXX")" \
        || psql_safe_fail "could not create a passfile"
      export PGPASSFILE="$PSQL_SAFE_PASSFILE"
      # libpq prefers PGPASSWORD to the passfile, so an ambient one would
      # silently replace the password the URL named.
      unset PGPASSWORD
    fi
    printf '*:*:*:%s:%s\n' \
      "$(if [ -n "$user" ]; then psql_safe_pgpass_escape "$user"; else printf '*'; fi)" \
      "$(psql_safe_pgpass_escape "$pw")" >> "$PSQL_SAFE_PASSFILE"
  fi

  printf -v "$out_var" '%s' "${scheme}${authority}${tail}"
  [ -n "$xt" ] && set -x
  return 0
}

psql_safe() {
  psql -X "$@"
}

psql_safe_cleanup() {
  if [ -n "$PSQL_SAFE_PASSFILE" ]; then
    rm -f -- "$PSQL_SAFE_PASSFILE"
    PSQL_SAFE_PASSFILE=""
  fi
}
