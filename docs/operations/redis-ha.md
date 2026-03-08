# Redis High Availability with Sentinel

## Overview

passwd-sso supports Redis Sentinel for high availability. This is opt-in and requires explicit configuration via environment variables.

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `REDIS_URL` | Yes | - | Standard Redis URL (used for non-Sentinel mode) |
| `REDIS_SENTINEL` | No | `false` | Set to `true` to enable Sentinel mode |
| `REDIS_SENTINEL_HOSTS` | When Sentinel | - | Comma-separated `host:port` pairs (e.g., `s1:26379,s2:26379,s3:26379`) |
| `REDIS_SENTINEL_MASTER_NAME` | When Sentinel | `mymaster` | Sentinel master name |
| `REDIS_SENTINEL_PASSWORD` | No | - | Password for Sentinel authentication |
| `REDIS_SENTINEL_TLS` | No | `false` | Enable TLS for Sentinel and Redis connections |
| `HEALTH_REDIS_REQUIRED` | No | `false` | Make Redis failure return 503 (instead of degraded 200) |

## Docker Compose HA Setup

Use the `docker-compose.ha.yml` override file alongside the base `docker-compose.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml up
```

The HA overlay provides:

- 1 Redis master
- 2 Redis replicas
- 3 Sentinel instances

## Failover Behavior

1. Sentinels monitor the master node
2. If master becomes unavailable, Sentinels elect a new master from replicas
3. ioredis automatically reconnects to the new master
4. Rate limiting continues uninterrupted

## Fallback

If Redis (including Sentinel) is unavailable, the application falls back to in-memory rate limiting. This is acceptable for development but not recommended for production (rate limits are per-process, not shared).

## Monitoring

The readiness probe (`GET /api/health/ready`) reports Redis status:

- `pass`: Redis is healthy
- `warn`: Redis unavailable but `HEALTH_REDIS_REQUIRED` is not set (degraded mode)
- `fail`: Redis unavailable and `HEALTH_REDIS_REQUIRED=true` (returns 503)
