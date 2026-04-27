# pre2 — sessionCache redesign (multi-worker safe revocation)

このドキュメントは、Group D の **pre2 (継続リスク)** に着手するための fresh Claude Code session 向け引き継ぎ prompt です。本文をそのまま新 session の最初のメッセージに貼り付けてください。

---

## 着手 prompt（fresh session 向け）

このリポジトリは passwd-sso (Next.js 16 + TypeScript 5.9 + Prisma 7 + Auth.js v5 + Redis 7)。

過去の review ([docs/archive/review/csrf-admin-token-cache-review.md](csrf-admin-token-cache-review.md)) で **pre2 (継続リスク)** として記録された以下の問題に着手したい。

### 元 review の指摘

> **pre2** | Raw session token as cache key | **Minor (upgrade)** — 30s session-revocation bypass window
>
> not just a heap-dump exposure — the 30s in-process cache means a session
> revoked via `DELETE /api/sessions/[id]` remains accepted for up to 30s per
> worker. This is a functional auth-bypass window for revocation, not just info.

### 現状の実装

- ファイル: [src/lib/proxy/auth-gate.ts](../../../src/lib/proxy/auth-gate.ts)
- in-process `Map<string, SessionInfo>` cache（PR #398 で proxy.ts から抽出）
- Cache key: 平文の session token（cookie value）
- TTL: 30 秒（`SESSION_CACHE_TTL_MS`）
- Cap: 1000 entries（`SESSION_CACHE_MAX`）
- Eviction: TTL sweep → FIFO fallback (`auth-gate.ts:128-145`、PR #405 で同パターン他 2 sites も統一済)
- 関連テスト: [src/__tests__/proxy.test.ts](../../../src/__tests__/proxy.test.ts) の `proxy — session cache` describe 群

### 問題

1. **Revocation バイパス窓**: ユーザーが `DELETE /api/sessions/[id]` で自分のセッションを取り消しても、各 worker のキャッシュが切れるまで（最大 30 秒）失効が反映されない。
2. **平文 token をキーに使用**: heap dump / debug log で session token が露出しうる。
3. **Multi-worker 不整合**: Next.js standalone build でも node プロセスが複数あれば、各 worker が独立した Map を持つ。1 worker でキャッシュ失効しても他 worker は引きずる。

### redesign の方向性（plan で議論する設計判断）

#### 選択肢

| 案 | Pros | Cons |
|---|---|---|
| (a) **TTL 短縮** (30s → ~5s) | 最小変更、コード影響少 | 30s → 5s でも問題は本質的に解消せず、DB 負荷が 6x |
| (b) **Redis-backed cache + hashed key + 能動 invalidation** | revocation 即時反映、worker 間で一貫、平文 token 漏洩リスク低減 | Redis 障害時の挙動設計、TTL/invalidation 整合性、テスト戦略 |
| (c) **In-process cache 維持 + Redis Pub/Sub で invalidation broadcast** | 既存 path への影響最小、Redis 部分障害時 fail-open しやすい | 実装複雑、Pub/Sub miss 時の整合性、メモリ局所性失われない |
| (d) **完全削除 (毎リクエスト DB)** | Simplest correctness | DB 負荷 (auth check が全 protected request の hot path) |

#### 設計判断ポイント

- Redis は既に Docker Compose で起動済み（`redis` service、`/api/health/ready` で接続確認）。新規依存追加は不要。
- session token の hash 関数選定: SHA-256? HMAC で Redis-poisoning 防止？
- Revocation flow: `DELETE /api/sessions/[id]` から `INVALIDATE` イベントをどう発火するか
- Multi-worker coordination: Pub/Sub vs Streams vs Lua atomic
- Failure semantics: Redis down 時に fail-open（cache miss → DB lookup）か fail-closed（401）か
- 移行戦略: feature flag / segment rollout / 既存 in-process cache との互換期間
- Test 戦略: integration test (real Redis container)、unit test (mock Redis client)、end-to-end (multi-worker docker compose で revocation 即時反映を verify)

### 進め方

triangulate skill を使って Phase 1 (Plan creation) から起こす:

```
/triangulate
```

最初に Phase 1 plan を `docs/archive/review/sessioncache-redesign-plan.md` に起こす。Phase 1 review で 3 expert が設計判断を triangulate するので、上記選択肢の trade-off を expert review に委ねるのがよい。

### 制約 / 非機能要件

- **下方互換**: `getSessionInfo()` の現呼び出し点（`src/lib/proxy/page-route.ts`, `api-route.ts`）の signature は維持する
- **ホットパス影響**: 全 protected request の hot path なので、レイテンシ追加は ~10ms 以内に抑える
- **Redis 障害時の挙動**: 設計判断で確定（fail-open vs fail-closed）、ログで観測可能にする
- **Test infrastructure**: 既存の vitest + integration test (real DB / Redis) を活用、新規 framework は導入しない
- **CLAUDE.md 規約**: Coding Style / Git Workflow / Safety / Mandatory Checks (`npx vitest run` + `npx next build`) を遵守

### Out of scope

- Auth.js の database session strategy 自体の変更（adapter は `@auth/prisma-adapter` のまま）
- session token 形式自体の変更（依然として `authjs.session-token` cookie）
- session DB schema 変更（既存 `Session` テーブルそのまま）

### 関連既存実装

- session 取得本体: `src/lib/auth/session/check-auth.ts`（cache を経由しない直接 DB lookup）
- session revocation route: `src/app/api/sessions/[id]/route.ts`
- session lifecycle: `src/lib/auth/session/user-session-invalidation.ts`
- Redis client: `src/lib/redis.ts`（既存、SCIM token / rate limit 等で利用中）

### 推定工数

5+ 時間。設計判断 (Phase 1 plan + 2 round review) で 1-2 時間、実装 (Phase 2) で 2-3 時間、code review (Phase 3) で 1-2 時間。

## 最初の指示

「triangulate Phase 1 から開始してください。まず現実装 (`src/lib/proxy/auth-gate.ts` 全体 + 呼び出し元 + Redis 利用例) を読んで、4 選択肢の trade-off を pros/cons 表にまとめた上で plan ドラフトを作成してください。」 とお願いするのが妥当な起点。
