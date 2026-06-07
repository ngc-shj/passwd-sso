# Manual Test: dev-ops-tooling (systemd + dev.sh)

Covers the deployment artifacts in this PR that automated tests / CI cannot
exercise (R35 Tier-1): `infra/systemd/passwd-sso.service` and
`scripts/dev.sh`. Both require a real Docker host, so they are operator-run.

## Pre-conditions

- A Linux host with Docker Engine + Compose v2 (`docker compose version`).
- Repo checked out (e.g. `/opt/passwd-sso`), `.env` populated and `chmod 0600`.
- DB migrated once: `docker compose -f docker-compose.yml --profile migrate run --rm migrate`.

## Part A — systemd unit

### A1 — Boot
- **Steps**:
  1. `sudo cp infra/systemd/passwd-sso.service /etc/systemd/system/ && sudo systemctl daemon-reload`
  2. `sudo systemctl enable --now passwd-sso`
  3. `systemctl is-active passwd-sso` and `journalctl -u passwd-sso -n 50`
- **Expected**: unit active; logs show `app`, `db`, `jackson`, `redis` starting; the app answers on its port. No `docker-compose.override.yml` is loaded (datastore ports NOT published — verify `ss -ltnp | grep -E ':5432|:6379|:5225'` shows nothing bound on the host).

### A2 — Crash recovery (verifies F6 `--abort-on-container-exit`)
- **Steps**:
  1. `docker kill $(docker compose -f docker-compose.yml ps -q app)`
  2. Watch `journalctl -u passwd-sso -f`
- **Expected**: compose exits non-zero, systemd reports failure, and after `RestartSec=10` the whole stack restarts. The app becomes reachable again. (If the unit lacked `--abort-on-container-exit`, compose would keep running and no restart would fire — this step is the reason that flag exists.)

### A3 — Stop
- **Steps**: `sudo systemctl stop passwd-sso`
- **Expected**: `ExecStop` runs `docker compose down`; all containers removed within `TimeoutStopSec=90`; no orphaned containers (`docker compose -f docker-compose.yml ps` empty).

### A4 — Secret hygiene
- **Steps**: `stat -c '%a %U:%G' /opt/passwd-sso/.env`
- **Expected**: `600 root:root` (or the dedicated service user). The unit has no inline secrets and no `EnvironmentFile=`, so this file mode is the sole protection (S3).

### Rollback
- `sudo systemctl disable --now passwd-sso && sudo rm /etc/systemd/system/passwd-sso.service && sudo systemctl daemon-reload`. Stack can still be run manually via `scripts/dev.sh` / `npm run docker:up`.

## Part B — dev.sh (local dev)

### B1 — init
- **Steps**: from a fresh clone, `scripts/dev.sh init`
- **Expected**: generates `.env` if absent (interactive), builds images, starts `db`/`redis`/`jackson`, applies migrations via the `migrate` profile, prints the "Start the full stack" hint. Idempotent on re-run (skips `.env`/`npm install`).

### B2 — lifecycle
- **Steps**: `scripts/dev.sh start` → `scripts/dev.sh status` → `scripts/dev.sh logs app` → `scripts/dev.sh restart` → `scripts/dev.sh stop`
- **Expected**: stack comes up detached on the dev override (app :3000, mailpit :8025); `logs app` follows; `restart` recreates; `stop` removes containers. Named volumes (`postgres_data`, `redis_data`) survive `stop` (no `down -v`).

### Rollback
- `scripts/dev.sh stop`. No persistent changes beyond the dev DB volume, which is untouched by this tooling.
