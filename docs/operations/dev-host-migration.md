# Development Host Migration

Runbook for moving a running development / verification deployment from one
machine to another — for example from a Linux box to a Mac — while keeping the
same tailnet and the same `NEXT_PUBLIC_BASE_PATH`.

This covers the **host dev-server + Docker infrastructure** topology: Next.js
runs on the host (`npm run dev -- -p 3001`) and `db`, `redis`, `jackson`,
`mailpit`, `audit-outbox-worker` run in Compose. For the all-in-Compose
topology see [deployment.md](deployment.md); for AWS see
[../setup/aws](../setup/aws).

Placeholders used below:

| Placeholder | Meaning |
| --- | --- |
| `<OLD_HOST>` | current MagicDNS name, e.g. `oldbox.<tailnet>.ts.net` |
| `<NEW_HOST>` | target MagicDNS name, e.g. `newbox.<tailnet>.ts.net` |
| `<BASE_PATH>` | value of `NEXT_PUBLIC_BASE_PATH`, e.g. `/passwd-sso` |

Read the concrete values from `.env` and `tailscale status` on the source host.

## 0. Confirm target-host facts first

The migration path branches on these; check them before copying anything.

```bash
uname -m                    # arm64 vs x86_64 — decides whether images rebuild
node --version              # must satisfy package.json engines (>=24, .nvmrc)
docker --version            # Docker Desktop / OrbStack / colima all work
docker compose version      # v2.20+ — the override uses depends_on.required
tailscale status            # target must already be on the SAME tailnet
```

Two of these are migration-blocking:

- **Same tailnet.** If any tenant has the Tailscale access restriction enabled
  (`tenants.tailscale_enabled = true`), the stored `tailscale_tailnet` must
  still match after the move, or every post-sign-in request returns
  `access_denied` (API) / `Forbidden` (page routes). Moving within one tailnet
  needs no DB change; moving across tailnets does.
- **`tailscale serve` availability.** On macOS the CLI ships inside the app
  bundle (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`); confirm
  `tailscale serve status` runs before relying on it.

### macOS: the tenant Tailscale restriction cannot verify peers

`verifyTailscalePeer` reaches tailscaled's LocalAPI over the Unix socket at
`/run/tailscale/tailscaled.sock` (override: `TAILSCALE_SOCKET`), or over
unauthenticated TCP (`TAILSCALE_API_BASE`). The **Mac App Store** build of
Tailscale (`~/Library/Group Containers/*.group.io.tailscale.ipn.macos`)
provides neither: it exposes LocalAPI only over token-authenticated TCP, and
macOS TCC blocks reading the token file — `Operation not permitted` even under
`sudo` — unless the calling process has Full Disk Access.

The symptom is a plain-text `Forbidden` on `/dashboard/*` after a successful
sign-in: `checkAccessRestriction` denies with `Tailscale tailnet mismatch`
because the WhoIs call threw and `verifyTailscalePeer` returned false. The
tenant's `tailscale_tailnet` value is not at fault — verify with
`/Applications/Tailscale.app/Contents/MacOS/Tailscale whois <peer-ip>`, which
reaches LocalAPI from inside the sandbox and prints the FQDN the app wanted.

For a verification host, turn the restriction off on that host's database:

```bash
docker compose exec -T db psql -U passwd_user -d passwd_sso \
  -c "update tenants set tailscale_enabled = false where tailscale_enabled"
```

The policy is cached for one minute (`POLICY_CACHE_TTL_MS`), so wait or restart
the dev server. To keep the restriction testable on macOS instead, either teach
`tailscale-client.ts` to send `Authorization: Basic base64(":" + token)` and
grant the dev server's terminal Full Disk Access, or replace the App Store build
with the open-source `tailscaled`, which does create the Unix socket.

Architecture only matters for locally built images (`app`, the worker services
built from `Dockerfile`). `postgres:16-alpine`, `redis:7-alpine`,
`boxyhq/jackson`, and `axllent/mailpit` are all multi-arch. Do **not** copy the
raw `postgres_data` volume between hosts of different architectures — use the
dump/restore path in step 3 regardless.

## 1. Classify the configuration

`.env` is untracked and holds every host-specific and secret value. No tracked
file contains the hostname, so the repository itself needs no edit.

### Copy verbatim — data becomes unreadable if these change

| Variable | What breaks if it differs |
| --- | --- |
| `VERIFIER_PEPPER_KEY` (+ `_V2`…) | Vault unlock fails for every user — HMAC verifier mismatch |
| `SHARE_MASTER_KEY_V1`, `_V2`, `SHARE_MASTER_KEY_CURRENT_VERSION` | Existing share links and Sends cannot be decrypted |
| `WEBAUTHN_PRF_SECRET` | PRF-based vault auto-unlock stops working |
| `AUTH_SECRET` | Existing sessions invalidated; also Jackson's `NEXTAUTH_SECRET` |
| `PASSWD_SUPERUSER_PASSWORD`, `PASSWD_APP_PASSWORD`, `PASSWD_OUTBOX_WORKER_PASSWORD`, `PASSWD_RETENTION_GC_WORKER_PASSWORD`, `PASSWD_JACKSON_PASSWORD` | The initdb scripts create the DB roles from these; a mismatch means the restored dump's ACLs point at roles nothing can log in as |
| `JACKSON_API_KEY`, `ADMIN_API_TOKEN` | Jackson admin API and the maintenance scripts stop authenticating |

Vault entry contents themselves are end-to-end encrypted under the user's master
passphrase, so they survive the move independently of server-side keys.

### Rewrite for the new host

| Variable | Change |
| --- | --- |
| `AUTH_URL` | `https://<NEW_HOST>` |
| `WEBAUTHN_RP_ID` | `<NEW_HOST>` — see the warning below |
| `NEXT_DEV_ALLOWED_ORIGINS` | `<NEW_HOST>` |

### Leave as-is

`NEXT_PUBLIC_BASE_PATH`, `TRUST_TAILSCALE_SERVE_HEADERS=true`,
`TRUST_PROXY_HEADERS`, `EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS` (Chrome
extension IDs, not host-bound), `IOS_APP_TEAM_ID`, `BLOB_BACKEND`, the SMTP
block (mailpit is local to whichever host runs it), and the
`localhost`-pointing `DATABASE_URL` / `MIGRATION_DATABASE_URL` /
`OUTBOX_WORKER_DATABASE_URL` (the Compose override publishes 5432 on
`127.0.0.1`).

### Changing `WEBAUTHN_RP_ID` invalidates every passkey

WebAuthn credentials are scoped to the RP ID. After the hostname changes,
authenticators will not offer the old credentials, and the rows left in the
database can never match again. Consequences:

- Passkey sign-in and passkey step-up reauth stop working for all users.
- PRF vault auto-unlock stops working; users fall back to the master
  passphrase, which still works.
- iOS passkeys and the Associated Domains / `apple-app-site-association`
  binding follow the hostname too.

**Before cutting over, confirm at least one non-passkey sign-in path works on
the new host.** If `AUTH_GOOGLE_ID` / SAML client credentials are not
configured, the only remaining path is the email magic link — verify mailpit
(`http://127.0.0.1:8025`) receives it. Users re-register passkeys after their
first sign-in on `<NEW_HOST>`.

If Google OIDC or a SAML IdP *is* configured, mirror every redirect URI
currently registered for `<OLD_HOST>` with `<NEW_HOST>` substituted — for Google
that is `https://<NEW_HOST><BASE_PATH>/api/auth/callback/google`.

## 2. Prepare the target host

```bash
# 1. Clone and install
git clone <repo-url> && cd passwd-sso
node --version                       # matches .nvmrc
npm ci

# 2. Create .env
#    Either copy the source .env over a secure channel and edit the three
#    host-bound variables from step 1, or run the generator and paste the
#    "copy verbatim" values in afterwards:
npm run init:env

# 3. Verify the env file is internally consistent
npm run check:env-docs
```

Copy `.env` over an encrypted channel (`tailscale file cp`, `scp` over the
tailnet). Never commit it, and never route it through a shared clipboard
service.

## 3. Dump the data (skip for a clean verification environment)

If the target is meant to start empty, skip to step 4 and run `npm run db:seed`
after migrating.

On the **source** host, with the app stopped so no writes race the dump:

```bash
# Stop writers, keep the database up. The two dumps are separate snapshots
# taken at different instants either way, so a live writer between them can
# leave the pair mutually inconsistent.
docker compose stop audit-outbox-worker retention-gc-worker
# also stop the host dev server (Ctrl-C)

BACKUP_DIR="$HOME/passwd-sso-migration" BACKUP_RETAIN=1 scripts/backup-db.sh
```

The script prints the run directory it published — call it `$RUN` below. It
dumps `passwd_sso`, `jackson` and the cluster globals, and reads each archive
back with `pg_restore` before reporting success, so a truncated dump fails here
rather than at restore time on the new host.

The equivalent by hand, if the script is unavailable:

```bash
docker compose exec -T db pg_dump -U passwd_user -Fc --create -d passwd_sso > passwd_sso.dump
docker compose exec -T db pg_dump -U passwd_user -Fc --create -d jackson    > jackson.dump
docker compose exec -T db pg_dumpall -U passwd_user --globals-only --no-role-passwords > globals.sql
```

Both databases matter: `passwd_sso` holds application data, `jackson` holds SSO
connection records. With `BLOB_BACKEND=db`, attachments and Send files live in
`passwd_sso` and are included — there is no separate blob directory to copy.

Redis holds only rate-limit and cache state; do not migrate it.

Transfer both dumps over the tailnet. They contain ciphertext, audit logs, and
role ACLs — treat them as secrets and delete them from both hosts afterwards.

## 4. Start the target stack

Bring up **only the database first**, so the initdb scripts create the
`jackson` database and the least-privilege roles from the `.env` passwords
before anything else touches them:

```bash
docker compose up -d db
docker compose ps    # wait for db to report healthy
```

Name the service explicitly. A bare `docker compose up -d` also starts
`jackson`, which creates its own tables on first boot and makes the `jackson`
restore in step 5 fail. Likewise, do not run any `prisma migrate` before the
restore.

The initdb scripts run exactly once, against an empty data directory. If the
volume already exists from an earlier attempt, the roles are *not* recreated —
remove the volume and retry (this destroys the target's data only; confirm you
are on the target host first).

## 5. Restore, then migrate

Confirm both target databases are still empty. Restoring into a database that
already carries the Prisma schema, or one whose Jackson tables were created by a
booted `jackson` container, fails on the first conflicting object:

```bash
docker compose exec -T db psql -U passwd_user -d passwd_sso -c '\dt'
docker compose exec -T db psql -U passwd_user -d jackson    -c '\dt'
# both must print "Did not find any relations."
```

```bash
# $RUN is the run directory scripts/backup-db.sh published in step 3. The paths
# matter: the archives live under it, not in the current directory.
RUN=~/passwd-sso-migration/20260803T164500Z   # substitute the real stamp

# Restore before Jackson boots — it creates its own tables on first start
docker compose exec -T db pg_restore -U passwd_user --exit-on-error -d passwd_sso < "$RUN/passwd_sso.dump"
docker compose exec -T db pg_restore -U passwd_user --exit-on-error -d jackson    < "$RUN/jackson.dump"
```

**Do not restore `globals.sql` here.** The initdb scripts already created the
roles with the passwords from `.env`, and `--no-role-passwords` means replaying
the file would add nothing while erroring on every existing role. `globals.sql`
is for a cluster rebuilt *without* initdb — the RDS or bare-cluster path. On
this route it is a cross-check: compare its `CREATE ROLE` lines against the
target's `\du` output to confirm the two clusters carry the same principals.

If the check above shows tables, do **not** reach for `--clean` or
`DROP DATABASE`. The initdb scripts apply privileges that a `pg_dump -Fc`
without `--create` does not carry — `GRANT CONNECT ON DATABASE`,
`REVOKE CREATE ON SCHEMA public FROM PUBLIC`, the default ACLs, and
`CREATE DATABASE jackson OWNER jackson_user`. Re-running those scripts after a
restore is worse still: `02-create-app-role.sql` grants DML on **all** tables,
re-granting exactly what migration `20260522000200` revokes. The only order that
lands the correct ACLs is empty volume → initdb → restore, so start over:

```bash
docker compose down                        # no -v; remove the volume explicitly
docker volume rm <project>_postgres_data   # TARGET host only — this is the
                                           # source's only copy if you slip
docker compose up -d db
```

`--exit-on-error` is deliberate: a partially restored schema that reports
success is worse than a loud failure. Restore without `--no-owner` — the roles
already exist with identical names, so ownership and the column-level grants
carried in the dump land on the correct principals.

Then bring up the rest and reconcile the schema:

```bash
docker compose up -d redis jackson mailpit audit-outbox-worker
npx prisma migrate deploy   # no-op when the dump already carries _prisma_migrations
```

Use `migrate deploy`, not `npm run db:migrate`. The latter is `prisma migrate
dev`, which offers to **reset the database** when it detects drift — exactly the
wrong prompt to be one keystroke away from on a freshly restored dump.

For a clean environment instead of a restore:

```bash
docker compose up -d redis jackson mailpit audit-outbox-worker
npm run db:migrate
npm run db:seed
```

## 6. Recreate the tailscale serve configuration

`serve` config is per-node and does not transfer. Recreate every handler the
source host published — read them off `tailscale serve status` on the source
before shutting it down. For the standard layout:

```bash
sudo tailscale serve --bg --https=443 --set-path=<BASE_PATH> \
  https+insecure://localhost:3001<BASE_PATH>
sudo tailscale serve --bg --https=443 --set-path=/.well-known/apple-app-site-association \
  https+insecure://localhost:3001<BASE_PATH>/api/mobile/.well-known/apple-app-site-association
sudo tailscale serve --bg --https=443 --set-path=/.well-known/oauth-authorization-server \
  https+insecure://localhost:3001<BASE_PATH>/api/mcp/.well-known/oauth-authorization-server
```

Keep the result **tailnet-only**. `tailscale serve status` must not print
`# Funnel on`. Funnel publishes a public DNS record, and clients that resolve
through it reach the app from Tailscale's ingress rather than a tailnet
address — which the per-tenant Tailscale access restriction then denies. Funnel
is per-port, so enabling it for one path exposes every path on that port.

## 7. Fix host references stored in the data

After a restore, rows still point at `<OLD_HOST>`:

- **Jackson SSO connections** carry `defaultRedirectUrl` and a `redirectUrl`
  allowlist. Update them in the Jackson admin API (`JACKSON_API_KEY`) or
  re-register the connection, or SAML sign-in redirects back to the dead host.
- **Outstanding share links, Sends, and invitation emails** embed the old
  origin and will not resolve. Reissue them if they matter for the
  verification scenario.
- **Browser extension and CLI** configurations point at the old server URL;
  update the extension's configured endpoint and re-run `passwd-sso login`.

## 8. Verify before decommissioning the source

Run the dev server and walk the checklist:

```bash
npm run dev -- -p 3001      # the serve target is 3001, not the default 3000
```

- [ ] `curl -sf https://<NEW_HOST><BASE_PATH>/api/health/live` returns 200
- [ ] `.../api/health/ready` returns 200 (proves DB **and** Redis reachable)
- [ ] Magic-link sign-in completes end to end (check mailpit at `:8025`)
- [ ] Dashboard loads after sign-in — a `Forbidden` here means the tenant
      Tailscale restriction is rejecting the new node
- [ ] Vault unlocks with the master passphrase (proves `VERIFIER_PEPPER_KEY`
      and the encrypted blobs travelled together)
- [ ] An existing entry decrypts and a new entry saves
- [ ] Passkey **re-registration** succeeds against the new RP ID
- [ ] An existing share link created after the move opens (proves
      `SHARE_MASTER_KEY_*`)
- [ ] `docker compose logs audit-outbox-worker` shows drains, and
      `audit_outbox` is not accumulating `PENDING` rows
- [ ] `npx vitest run` and `npx next build` pass on the new host

Integration tests additionally require the Compose workers to be stopped —
they claim rows `FOR UPDATE SKIP LOCKED` across the whole table:

```bash
docker compose stop audit-outbox-worker retention-gc-worker
npm run test:integration
docker compose start audit-outbox-worker retention-gc-worker
```

## 9. Cutover and rollback

Keep the source host's stack intact — stopped, not deleted — until the
checklist above is fully green. Rolling back is then just reverting the three
host-bound variables in the source `.env`, restarting its services, and
restoring its `tailscale serve` configuration.

Never run `docker compose down -v` on the source as part of cutover; the `-v`
destroys `postgres_data`, which is the only remaining copy once the dumps are
deleted. Decommission by stopping services, and remove the volume only after
the new host has been serving successfully for long enough to trust it.

Finally, delete the transferred `.dump` files and any temporary copy of `.env`
from both hosts.
