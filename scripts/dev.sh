#!/usr/bin/env bash
set -euo pipefail

# Dev environment helper for the local Docker Compose stack.
#
# Wraps `docker compose` with the base + dev override files (same pair as
# `npm run docker:up`) and adds first-run bootstrap. Run from anywhere.
#
# Usage: scripts/dev.sh <command> [args]
#
#   init                First-run setup: create .env, build images, run migrations
#   start [svc...]      Start the stack detached (docker compose up -d)
#   stop                Stop and remove containers (docker compose down)
#   restart [svc...]    Recreate and restart (down → up -d)
#   logs [svc...]       Follow logs (all services, or only the named ones)
#   status              Show container status (docker compose ps)
#   build [svc...]      (Re)build images
#   migrate             Apply DB migrations via the one-shot migrate service
#   seed                Run prisma seed against the dev DB (host-side)
#   shell <svc>         Open an interactive shell inside a running service
#
# Examples:
#   scripts/dev.sh init
#   scripts/dev.sh start
#   scripts/dev.sh logs app
#   scripts/dev.sh restart audit-outbox-worker

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.override.yml)

die() { echo "ERROR: $*" >&2; exit 1; }

require_docker() {
  command -v docker &>/dev/null || die "docker is required but not installed."
  docker compose version &>/dev/null || die "docker compose v2 is required."
}

require_env() {
  [[ -f .env ]] || die ".env not found. Run 'scripts/dev.sh init' first."
}

cmd_init() {
  require_docker

  if [[ ! -f .env ]]; then
    echo "==> .env not found — launching interactive generator (npm run init:env)"
    npm run init:env
  else
    echo "==> .env already present — skipping generation"
  fi

  if [[ ! -d node_modules ]]; then
    echo "==> Installing host dependencies (npm install)"
    npm install
  fi

  echo "==> Building images"
  "${COMPOSE[@]}" build

  echo "==> Starting datastores (db, redis, jackson)"
  "${COMPOSE[@]}" up -d db redis jackson

  echo "==> Applying database migrations"
  cmd_migrate

  echo ""
  echo "Init complete. Start the full stack with:  scripts/dev.sh start"
}

cmd_start() {
  require_docker
  require_env
  "${COMPOSE[@]}" up -d "$@"
  "${COMPOSE[@]}" ps
}

cmd_stop() {
  require_docker
  "${COMPOSE[@]}" down
}

cmd_restart() {
  require_docker
  require_env
  "${COMPOSE[@]}" down
  "${COMPOSE[@]}" up -d "$@"
  "${COMPOSE[@]}" ps
}

cmd_logs() {
  require_docker
  "${COMPOSE[@]}" logs -f --tail=100 "$@"
}

cmd_status() {
  require_docker
  "${COMPOSE[@]}" ps
}

cmd_build() {
  require_docker
  "${COMPOSE[@]}" build "$@"
}

cmd_migrate() {
  require_docker
  require_env
  # migrate is profile-gated in docker-compose.yml; run it as a one-shot.
  "${COMPOSE[@]}" --profile migrate run --rm migrate
}

cmd_seed() {
  require_env
  echo "==> Seeding dev DB (npm run db:seed)"
  npm run db:seed
}

cmd_shell() {
  require_docker
  local svc="${1:-}"
  [[ -n "$svc" ]] || die "Usage: scripts/dev.sh shell <service>"
  "${COMPOSE[@]}" exec "$svc" sh
}

main() {
  local cmd="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$cmd" in
    init)    cmd_init "$@" ;;
    start|up)   cmd_start "$@" ;;
    stop|down)  cmd_stop "$@" ;;
    restart) cmd_restart "$@" ;;
    logs)    cmd_logs "$@" ;;
    status|ps)  cmd_status "$@" ;;
    build)   cmd_build "$@" ;;
    migrate) cmd_migrate "$@" ;;
    seed)    cmd_seed "$@" ;;
    shell)   cmd_shell "$@" ;;
    ""|-h|--help|help)
      sed -n '4,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      ;;
    *)
      die "Unknown command: $cmd (run 'scripts/dev.sh help')"
      ;;
  esac
}

main "$@"
