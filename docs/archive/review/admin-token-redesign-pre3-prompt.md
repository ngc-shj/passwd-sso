# pre3 — Admin token redesign (per-operator signed token)

このドキュメントは、Group D の **pre3 (継続リスク)** に着手するための fresh Claude Code session 向け引き継ぎ prompt です。本文をそのまま新 session の最初のメッセージに貼り付けてください。

---

## 着手 prompt（fresh session 向け）

このリポジトリは passwd-sso (Next.js 16 + TypeScript 5.9 + Prisma 7 + Auth.js v5 + PostgreSQL 16)。

過去の review ([docs/archive/review/csrf-admin-token-cache-review.md](csrf-admin-token-cache-review.md)) で **pre3 (継続リスク)** として記録された以下の問題に着手したい。

### 元 review の指摘

> **pre3** | Shared ADMIN_API_TOKEN + operatorId | **Minor (upgrade)** — purge-audit-logs amplifies; major if token leaks
>
> `purge-audit-logs` uses the identical pattern. If `ADMIN_API_TOKEN`
> leaks, an attacker can destroy audit evidence and falsely attribute the act
> to any admin UUID. Severity escalates to Major *conditional on token leakage*.

### 現状の実装

- 共有 secret: `ADMIN_API_TOKEN` (env var, 64 hex chars)
- 検証: [src/lib/auth/tokens/admin-token.ts](../../../src/lib/auth/tokens/admin-token.ts) — `verifyAdminToken(req)` で SHA-256 + `timingSafeEqual`
- 利用 routes (token + operatorId param):
  - `src/app/api/admin/rotate-master-key/route.ts`
  - `src/app/api/maintenance/purge-history/route.ts`
  - `src/app/api/maintenance/purge-audit-logs/route.ts`
  - `src/app/api/maintenance/dcr-cleanup/route.ts`
  - `src/app/api/maintenance/audit-outbox-metrics/route.ts`
  - `src/app/api/maintenance/audit-outbox-purge-failed/route.ts`
  - `src/app/api/maintenance/audit-chain-verify/route.ts`
- operatorId 検証: PR #400 で `requireMaintenanceOperator` (active OWNER/ADMIN + deactivatedAt: null) に統一済
- 運用スクリプト: [scripts/purge-history.sh](../../../scripts/purge-history.sh), [scripts/rotate-master-key.sh](../../../scripts/rotate-master-key.sh) etc — 各 operator が同一 `ADMIN_API_TOKEN` で curl を実行

### 問題

1. **Token 単点障害**: `ADMIN_API_TOKEN` が漏洩すると attacker は任意の admin UUID を `operatorId` body param に詐称可能。`purge-audit-logs` 等で実行された場合、監査証拠そのものが消され、誰の仕業か特定できない。
2. **監査帰属性の弱さ**: token holder = operator が一致しない構造。`operatorId` は単なる body 値で、token とは紐づいていない。
3. **Token rotation の運用負荷**: 全 operator が共有しているため、単独 operator の権限剥奪 = 全員分の token 再配布が必要。

### redesign の方向性（plan で議論する設計判断）

#### 選択肢

| 案 | Pros | Cons |
|---|---|---|
| (a) **per-operator JWT (HS256)** | 短実装、`sub` claim で operator 紐付け、既存 `ADMIN_API_TOKEN` の HMAC key を再利用可 | 共有 secret は依然 single-key、JWT lifetime/rotation 設計必要 |
| (b) **per-operator JWT (RS256/Ed25519)** | server-side public key で検証、private key は token issuer のみ、key rotation が compartmentalized | key 管理基盤が必要、bootstrap 複雑化 |
| (c) **mTLS + cert→operator mapping** | client cert を operator ID と紐付け、token 概念排除 | 運用 (cert 配布・更新)、CI の curl flow 大改修 |
| (d) **OAuth 2.1 per-operator token (既存 SA token 流用)** | 既存 `sa_` token / `mcp_` token と統合、permission scope で操作粒度制御 | service account model を admin operator に流用するのは概念的に重い |

#### 設計判断ポイント

- **既存 SA token (sa_) との統合可否**: 既に Service Account model + scope 概念がある (`src/lib/auth/access/service-account-auth.ts`)。admin operator を SA の特殊形として扱えるか？それとも separate concern？
- **token lifetime**: 短期 (1h, 都度発行) vs 長期 (90d, 定期更新)
- **token issuance flow**: CLI / web UI / one-shot script のどれで発行するか
- **revocation**: blacklist DB? token family rotation (既存 MCP refresh token 方式)?
- **scope 設計**: 全 maintenance routes で同 scope か、route ごと scope 細分化か（例: `admin:rotate-key`, `admin:purge-history`）
- **migration 戦略**: 既存 `ADMIN_API_TOKEN` との並行運用期間、scripts/*.sh の段階移行
- **operationsへの影響**:
  - `scripts/purge-history.sh` 等は cron / one-shot 実行が主用途。全 operator で同 token を使い回している現運用を、per-operator token に変えるとどう運用するか
  - CI で master key rotation を automation する場合の token 取得 flow
  - 開発者 (admin) と CI/automation で別 token クラスにすべきか

### 進め方

triangulate skill を使って Phase 1 (Plan creation) から起こす:

```
/triangulate
```

最初に Phase 1 plan を `docs/archive/review/admin-token-redesign-plan.md` に起こす。Phase 1 review で 3 expert が設計判断を triangulate。security expert は OAuth 2.1 / RFC 7519 / NIST SP 800-63B-4 等の citation accuracy も確認する。

### 制約 / 非機能要件

- **下方互換性 (移行期間)**: 既存 `ADMIN_API_TOKEN` 検証は移行期間中残し、新方式と並列で動作。feature flag で切替
- **timing-safe**: 全 token 比較は `timingSafeEqual` を使用 (RS1 obligation)
- **rate limit**: 既存の per-route limiter (`createRateLimiter({ max: 1, windowMs: 60_000 })`) は維持
- **audit log**: 既存の `MASTER_KEY_ROTATION` / `HISTORY_PURGE` / `AUDIT_LOG_PURGE` audit emission を維持しつつ、`actorType: SYSTEM` → `actorType: HUMAN` (operator 直接帰属) への切替検討
- **CLAUDE.md 規約**: Coding Style / Git Workflow / Safety / Mandatory Checks 遵守

### Out of scope

- Auth.js v5 セッション機構自体の改修
- service account / MCP token 機構の根本変更
- `/api/admin/rotate-master-key` 以外の admin endpoint (現状 7 routes 以外)

### 関連既存実装

- 共有 token 検証: `src/lib/auth/tokens/admin-token.ts`
- maintenance operator 検証 helper: `src/lib/auth/access/maintenance-auth.ts`（PR #400 で導入）
- service account token: `src/lib/auth/access/service-account-auth.ts`
- MCP refresh token rotation: `src/app/api/mcp/token/route.ts`（参考実装、family-based revocation pattern）
- 運用 scripts: `scripts/purge-history.sh`, `scripts/rotate-master-key.sh`, `scripts/set-outbox-worker-password.sh`, `scripts/purge-audit-logs.sh`

### 推定工数

5-8 時間。設計判断 (Phase 1 plan + 2-3 round review) で 2-3 時間、実装 (Phase 2、新 token 検証 module + 7 routes 移行 + scripts 更新) で 2-3 時間、code review (Phase 3) で 1-2 時間。

## 最初の指示

「triangulate Phase 1 から開始してください。まず現実装 (`src/lib/auth/tokens/admin-token.ts` + 7 maintenance routes + 関連 scripts) と既存 SA token 機構 (`src/lib/auth/access/service-account-auth.ts`) を読んで、4 選択肢の trade-off を pros/cons 表にまとめた上で plan ドラフトを作成してください。」 とお願いするのが妥当な起点。

## 関連 PR 履歴 (この issue 周辺で触れた箇所)

- **PR #400** (`fix(admin): align operator validation`): operatorId 検証の統一 (`requireMaintenanceOperator`)、関連 7 routes すべてが同 helper を経由するようになった
- **PR #401** (`feat(audit): AUDIT_LOG_PURGE`): purge-audit-logs と purge-history の audit action label 分離
- **PR #402** (`feat(audit-emit): bound metadata`): audit-emit metadata size cap (DoS 対策)、admin token とは直接無関係だが同レビュー出自
- **PR #404** (`fix(proxy): staleness eviction`): admin token 検証とは無関係だが、同 review で並走
- **PR #406** (`refactor(proxy)`): proxy.ts decomposition
