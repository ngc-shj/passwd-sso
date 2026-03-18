# Audit Log Forwarding

## Overview

The application performs dual-write audit logging:

1. **PostgreSQL** — every audit event is written to the `AuditLog` table (always on, regardless of configuration).
2. **Structured JSON to stdout** — when `AUDIT_LOG_FORWARD=true`, each audit event is also emitted as a JSON line to stdout via Pino. Log aggregators (Fluent Bit, Datadog Agent, CloudWatch Logs) capture this stream and forward it to a SIEM or log storage system.

The stdout path is additive. Disabling it does not affect the database path.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUDIT_LOG_FORWARD` | No | `false` | Set to `true` to enable JSON emit to stdout. |
| `AUDIT_LOG_APP_NAME` | No | `passwd-sso` | Populates `_app` and `name` fields in every log line. |

## Log Schema

Each forwarded audit event is a single JSON line on stdout. All fields are always present.

```json
{
  "_logType": "audit",
  "_app": "passwd-sso",
  "_version": "1",
  "level": "info",
  "time": "2026-03-18T12:34:56.789Z",
  "name": "passwd-sso",
  "msg": "audit.PASSWORD_CREATE",
  "audit": {
    "scope": "PERSONAL",
    "action": "PASSWORD_CREATE",
    "userId": "cuid_user",
    "teamId": null,
    "targetType": "PasswordEntry",
    "targetId": "cuid_entry",
    "metadata": { "title": "Example" },
    "ip": "203.0.113.42",
    "userAgent": "Mozilla/5.0 ..."
  }
}
```

### Field Reference

| Field | Type | Description |
|---|---|---|
| `_logType` | `"audit"` | Fixed discriminator. Use this to filter audit lines from app logs. |
| `_app` | string | Application name from `AUDIT_LOG_APP_NAME`. |
| `_version` | `"1"` | Schema version. Increment if the schema changes in a breaking way. |
| `level` | `"info"` | Pino log level (always `"info"` for audit events). |
| `time` | ISO 8601 string | Event timestamp (UTC). |
| `name` | string | Same as `_app`. |
| `msg` | string | `"audit.<ACTION>"` — human-readable event label. |
| `audit.scope` | string | Audit scope enum: `PERSONAL`, `TEAM`, `TENANT`, etc. |
| `audit.action` | string | Audit action enum: `PASSWORD_CREATE`, `VAULT_UNLOCK`, etc. |
| `audit.userId` | string | CUID of the user who performed the action. |
| `audit.teamId` | string \| null | Team context, if applicable. |
| `audit.targetType` | string \| null | Resource type (e.g. `"PasswordEntry"`, `"Team"`). |
| `audit.targetId` | string \| null | CUID of the affected resource. |
| `audit.metadata` | object \| null | Action-specific context, with sensitive keys stripped. |
| `audit.ip` | string \| null | Client IP address. |
| `audit.userAgent` | string \| null | Client User-Agent header, truncated if necessary. |

### Metadata Truncation

If the serialized metadata exceeds the size limit, it is replaced with:

```json
{ "_truncated": true, "_originalSize": 12345 }
```

## Integration Patterns

### Fluent Bit — stdin/stdout pipeline

Parse stdout from the container, filter on `_logType`, and forward to your sink.

```ini
[INPUT]
    Name              forward
    Listen            0.0.0.0
    Port              24224

[FILTER]
    Name              grep
    Match             *
    Regex             log  "_logType":"audit"

[FILTER]
    Name              parser
    Match             *
    Key_Name          log
    Parser            json

[OUTPUT]
    Name              es
    Match             *
    Host              opensearch.internal
    Port              9200
    Index             audit-logs
```

For Docker Compose, redirect the app container's stdout to Fluent Bit:

```yaml
services:
  app:
    logging:
      driver: fluentd
      options:
        fluentd-address: localhost:24224
        tag: passwd-sso.app
```

### Datadog Agent — Docker stdout collection

Add labels to the app container so the Datadog Agent picks up and parses the JSON stream:

```yaml
services:
  app:
    labels:
      com.datadoghq.ad.logs: >
        [{"source": "passwd-sso", "service": "passwd-sso",
          "log_processing_rules": [{
            "type": "include_at_match",
            "name": "audit_only",
            "pattern": "\"_logType\":\"audit\""
          }]}]
```

In Datadog, create a log pipeline that parses the JSON body and promotes `audit.action`, `audit.userId`, and `audit.tenantId` to top-level facets for efficient searching.

### AWS CloudWatch — Docker log driver

Configure the app container to use the `awslogs` driver:

```yaml
services:
  app:
    logging:
      driver: awslogs
      options:
        awslogs-region: ap-northeast-1
        awslogs-group: /passwd-sso/audit
        awslogs-stream: app
```

Use a CloudWatch Logs Insights query to extract audit events:

```
fields @timestamp, audit.action, audit.userId, audit.ip
| filter _logType = "audit"
| sort @timestamp desc
```

For separation of concerns, use a Metric Filter or Subscription Filter to route lines matching `"_logType":"audit"` to a dedicated log group before applying retention policies.

## Filtering Audit Logs from Application Logs

All audit lines contain `"_logType":"audit"`. Use this field as the single discriminator:

- **jq**: `docker logs app 2>/dev/null | jq 'select(._logType == "audit")'`
- **grep (quick)**: `docker logs app 2>&1 | grep '"_logType":"audit"'`
- **Fluent Bit / Logstash / Vector**: add a filter on `_logType == "audit"` before the sink stage.

Non-audit application logs (errors, request traces) do not contain `_logType`, so the field is unambiguous.

## Security Notes

### Two-Layer Sanitization

Sensitive data is removed before it ever reaches Pino, using two independent mechanisms:

1. **`sanitizeMetadata()` (pre-Pino)** — recursively walks the metadata object and deletes any key present in `METADATA_BLOCKLIST` at any nesting depth, before the object is passed to the logger.
2. **Pino redaction (in-serializer)** — as a defense-in-depth backstop, Pino's `redact` option replaces known sensitive paths with `[REDACTED]` during serialization.

The blocklist covers: `password`, `passphrase`, `secret`, `secretKey`, `encryptedBlob`, `encryptedOverview`, `encryptedData`, `encryptedSecretKey`, `encryptedTeamKey`, `masterPasswordServerHash`, `token`, `tokenHash`, `accessToken`, `refreshToken`, `idToken`, `accountSalt`, `passphraseVerifierHmac`.

### Non-blocking, Non-failing

Audit forwarding is wrapped in a try/catch. A failure in the forwarding path (e.g. broken pipe, serialization error) is silently swallowed and never surfaces to the caller. The database write is independent and unaffected.

### No PII beyond what the DB already stores

The forwarded payload mirrors the database record: `userId` (opaque CUID), `ip`, and `userAgent`. No plaintext passwords, encrypted blobs, or cryptographic material appear in the stream.
