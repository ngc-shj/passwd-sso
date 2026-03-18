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

## Failover Test Procedure

Verify Sentinel failover works correctly before relying on HA in production.

### Prerequisites

- Running HA setup: `docker compose -f docker-compose.yml -f docker-compose.ha.yml up -d`
- Application connected to Sentinel (verify `REDIS_SENTINEL=true` in env)

### Steps

1. Identify the current master:
   ```bash
   docker compose exec sentinel-1 redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
   ```

2. Stop the master node:
   ```bash
   docker compose stop redis
   ```

3. Wait for failover (typically 5-30 seconds):
   ```bash
   docker compose exec sentinel-1 redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
   ```

4. Verify the application reconnected:
   ```bash
   curl -s http://localhost:3000/api/health/ready | jq '.checks.redis'
   # Expected: {"status":"pass","responseTimeMs":N}
   ```

5. Restart the old master (joins as replica):
   ```bash
   docker compose start redis
   ```

### Expected Results

- New master elected within 30 seconds
- Application health check returns `{"status":"healthy",...}` with `redis.status: "pass"` after reconnection
- No request errors during failover (rate limiting falls back to in-memory)

## Verification Checklist

| Check | Command | Expected |
|-------|---------|----------|
| Sentinel quorum | `SENTINEL ckquorum mymaster` | `OK 3 usable Sentinels` |
| Master reachable | `SENTINEL get-master-addr-by-name mymaster` | Returns IP:port |
| Replica count | `SENTINEL replicas mymaster` | 2 replicas listed |
| App health | `GET /api/health/ready` | `{"status":"healthy","checks":{"redis":{"status":"pass","responseTimeMs":N}}}` |
| Rate limiting | `POST /api/vault/unlock` (6x) | 429 after 5th attempt |
