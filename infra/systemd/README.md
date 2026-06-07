# systemd unit for self-hosted passwd-sso

`passwd-sso.service` runs the **production** Docker Compose stack
(`docker-compose.yml` — the base file only, no dev override) as a
systemd-managed service on a single Linux host.

It is intended for self-hosted VM deployments. The AWS ECS / Kubernetes paths
(`infra/terraform/`, `infra/k8s/`) are the managed-platform alternatives and do
not use this unit.

## Why the base compose file only

The unit deliberately omits `docker-compose.override.yml`. The override is a
**development** file: it publishes `db` (5432), `redis` (6379), and `jackson`
(5225) to the host and adds `mailpit` / `minio`. Loading it in production would
expose internal datastores. The base `docker-compose.yml` keeps those services
on the internal Docker network only.

## Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose`, not
  `docker-compose`). The unit calls `/usr/bin/docker` — adjust the path if your
  install differs (`command -v docker`).
- The repository checked out at the host (e.g. `/opt/passwd-sso`).
- A populated `.env` in that directory (see below).

## Install

```bash
# 1. Place the repo where the unit expects it (or edit WorkingDirectory).
sudo git clone <repo-url> /opt/passwd-sso
cd /opt/passwd-sso

# 2. Create .env (interactive generator writes the canonical .env).
sudo npm run init:env -- --profile=production

# 3. Lock down .env — it holds every secret (DB passwords, AUTH_SECRET,
#    JACKSON_API_KEY, SHARE_MASTER_KEY, ...). Compose auto-loads it from the
#    WorkingDirectory; there is no EnvironmentFile= in the unit, so the file
#    mode is the only thing protecting these secrets on a multi-user host.
sudo install -m 0600 -o root -g root .env .env   # ensure 0600 root:root

# 4. Apply database migrations once (the one-shot 'migrate' profile).
sudo docker compose -f docker-compose.yml --profile migrate run --rm migrate

# 5. Install and enable the unit.
sudo cp infra/systemd/passwd-sso.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now passwd-sso
```

If you cloned somewhere other than `/opt/passwd-sso`, edit `WorkingDirectory=`
in the unit before `daemon-reload`.

## Operate

```bash
systemctl status passwd-sso
journalctl -u passwd-sso -f          # follow logs
sudo systemctl restart passwd-sso
sudo systemctl stop passwd-sso
```

Database migrations on upgrade are an explicit operator step (the unit never
runs them automatically — matching the profile-gated `migrate` service):

```bash
cd /opt/passwd-sso && git pull
sudo docker compose -f docker-compose.yml --profile migrate run --rm migrate
sudo systemctl restart passwd-sso
```

## Restart semantics

`ExecStart` runs `docker compose up --abort-on-container-exit` in the
foreground. When any container exits unexpectedly, compose exits non-zero and
`Restart=on-failure` brings the whole stack back after `RestartSec=10`. On
`systemctl stop`, `ExecStop` runs `docker compose down` for an orderly teardown.

## Verification

This unit cannot be boot-tested in CI (no systemd-managed Docker host). See
[`docs/archive/review/dev-ops-tooling-manual-test.md`](../../docs/archive/review/dev-ops-tooling-manual-test.md)
for the operator boot + crash-recovery test plan.
