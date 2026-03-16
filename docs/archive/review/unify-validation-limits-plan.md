# Plan: Unify Validation Limits with Shared Constants

## Objective

UI、App（APIルートハンドラー）、DB（Prisma schema）の3層にまたがるバリデーション制約を、共有定数＋共有Zodスキーマを単一ソースとして統一する。`min()`/`max()` に限らず、`.length()`, `.regex()`, `z.enum()`, `.default()` などすべての単一項目チェックが統一された定数・スキーマを参照する体制を整える。

## Requirements

### Functional
- すべてのバリデーション制約（min/max/length/regex/enum/default）が共有定数またはスキーマを参照する
- APIルートハンドラー内のインラインZodスキーマがハードコード値を使わない
- UIコンポーネントの `maxLength`/`min`/`max` プロパティが同じ定数を参照する
- 既存の動作（バリデーション結果）が変わらない（値の変更はしない）

### Non-functional
- 定数名は意味が明確で、ドメイン別にグループ化される
- 既存テストがすべてパスする
- `npx next build` が成功する

## Technical Approach

### 統一対象のバリデーションパターン

| パターン | 例 | 対処方法 |
|----------|-----|---------|
| `.min(N)` / `.max(N)` | `.min(600_000).max(10_000_000)` | 定数参照 |
| `.length(N)` | `.length(24)`, `.length(32)`, `.length(64)` | 暗号hex長定数 |
| `.regex(/pattern/)` | `/^[0-9a-f]{24}$/`, `/^[0-9a-f]{64}$/` | `hexString()` ヘルパー活用 |
| `z.enum([...])` | `["1h", "1d", "7d", "30d"]` | 共有配列定数 |
| `.default(N)` | `.default(16)`, `.default(4)` | 意味ある定数 |
| `.regex(colorPattern)` | `/^#[0-9a-fA-F]{6}$/` | 共有regex定数 |
| ローカル `const MAX_*` | `MAX_RANGE_DAYS = 90` | 共有定数に昇格 |
| `.take(N)` (Prisma) | `.take(20)` | ページネーション定数 |

### 定数の分類と配置

`src/lib/validations/common.ts` に以下のグループで定数を追加（既存定数はそのまま維持）。

### 設計原則

- **値は変更しない（原則）**: 既存のハードコード値をそのまま定数に昇格するだけ。ただし以下は**意図的な仕様強化**として扱う:
  - `.max(N)` のみ → `hexIv`/`hexAuthTag` への置換（`.length()` + hex regex 追加）: セキュリティ上 IV/AuthTag の正確な長さと形式を保証すべきため
  - 置換前後で `.max()` → `.length()` に変わる箇所は PR に明記する
- **定数名のパターン**: `{DOMAIN}_{FIELD}_{MIN|MAX|LENGTH}` (例: `KDF_PBKDF2_ITERATIONS_MIN`)
- **暗号フィールド**: `HEX_IV_LENGTH = 24`, `HEX_AUTH_TAG_LENGTH = 32` 等 + `hexString()` ヘルパーを活用してインライン regex を排除
- **重複排除**: 3箇所で重複している `MAX_RANGE_DAYS`, `BATCH_SIZE` や、3箇所で重複している `z.enum(["1h","1d","7d","30d"])` など
- **`z.enum()` は string 型フィールドのみに適用**: `EMERGENCY_WAIT_DAYS` (number) は `.refine()` パターンを維持する

## Implementation Steps

### Step 1: 共有定数と共有スキーマの追加

サーバー専用定数は最初から `src/lib/validations/common.server.ts` に配置し、クライアントバンドルへの混入を防ぐ。共有定数（UI・API両方で使用）は従来通り `src/lib/validations/common.ts` に配置する。

**`common.server.ts` に配置する定数（サーバー専用）:**
- KDF パラメータ群 (`KDF_PBKDF2_*`, `KDF_ARGON2_*`)
- レート制限 (`CSP_REPORT_RATE_MAX`, `HIBP_RATE_MAX`)
- 監査ログ (`AUDIT_LOG_*`)
- ページネーション (`HISTORY_PAGE_SIZE`, `NOTIFICATION_PAGE_*`)
- セッション/Vault ポリシー (`PASSKEY_SESSION_MAX_AGE_SECONDS`, `MAX_CONCURRENT_SESSIONS_*`, `SESSION_IDLE_TIMEOUT_*`, `VAULT_AUTO_LOCK_*`)
- Vault リセット (`MAX_PENDING_RESETS`)
- 管理者 (`MASTER_KEY_VERSION_*`)
- SCIM ページネーション (`SCIM_PAGE_COUNT_*`)

**`common.ts` に配置する定数（共有）:** それ以外のすべて（UI コンポーネントでも参照されるため）

#### 1a. 数値定数 (`common.ts`)

#### 1a. 数値定数

```typescript
// ─── Crypto Hex Field Lengths ────────────────────────────────
export const HEX_IV_LENGTH = 24;        // 12 bytes as hex
export const HEX_AUTH_TAG_LENGTH = 32;   // 16 bytes as hex
export const HEX_SALT_LENGTH = 64;       // 32 bytes as hex
export const HEX_HASH_LENGTH = 64;       // 32 bytes as hex (SHA-256)

// ─── KDF Parameters ─────────────────────────────────────────
export const KDF_PBKDF2_ITERATIONS_MIN = 600_000;
export const KDF_PBKDF2_ITERATIONS_MAX = 10_000_000;
export const KDF_ARGON2_ITERATIONS_MIN = 1;
export const KDF_ARGON2_ITERATIONS_MAX = 100;
export const KDF_ARGON2_MEMORY_MIN = 16_384;      // 16 MiB in KiB
export const KDF_ARGON2_MEMORY_MAX = 4_194_304;    // 4 GiB in KiB
export const KDF_ARGON2_PARALLELISM_MIN = 1;
export const KDF_ARGON2_PARALLELISM_MAX = 16;

// ─── Session & Auth ─────────────────────────────────────────
export const PASSKEY_SESSION_MAX_AGE_SECONDS = 28_800; // 8 hours
export const MAX_CONCURRENT_SESSIONS_MIN = 1;
export const MAX_CONCURRENT_SESSIONS_MAX = 100;
export const SESSION_IDLE_TIMEOUT_MIN = 1;
export const SESSION_IDLE_TIMEOUT_MAX = 1440;      // 24 hours in minutes
export const VAULT_AUTO_LOCK_MIN = 1;
export const VAULT_AUTO_LOCK_MAX = 1440;

// ─── Audit Log ──────────────────────────────────────────────
export const AUDIT_LOG_MAX_RANGE_DAYS = 90;
export const AUDIT_LOG_BATCH_SIZE = 500;
export const AUDIT_LOG_MAX_ROWS = 100_000;

// ─── Webhook ────────────────────────────────────────────────
export const MAX_WEBHOOKS = 5;
export const WEBHOOK_URL_MAX_LENGTH = 2048;

// ─── Directory Sync ─────────────────────────────────────────
export const SYNC_INTERVAL_MIN = 15;
export const SYNC_INTERVAL_MAX = 1440;
export const SYNC_INTERVAL_DEFAULT = 60;

// ─── WebAuthn ───────────────────────────────────────────────
export const WEBAUTHN_NICKNAME_MAX_LENGTH = 100;
export const PRF_ENCRYPTED_KEY_MAX_LENGTH = 10_000;

// ─── SCIM ───────────────────────────────────────────────────
export const SCIM_TOKEN_EXPIRY_MIN_DAYS = 1;
export const SCIM_TOKEN_EXPIRY_MAX_DAYS = 3650;
export const SCIM_TOKEN_EXPIRY_DEFAULT_DAYS = 365;
export const SCIM_PAGE_COUNT_MIN = 1;
export const SCIM_PAGE_COUNT_MAX = 200;
export const SCIM_PAGE_COUNT_DEFAULT = 100;

// ─── Team Key Rotation ──────────────────────────────────────
export const TEAM_KEY_VERSION_MIN = 2;
export const TEAM_KEY_VERSION_MAX = 10_000;
export const TEAM_ROTATE_ENTRIES_MAX = 1000;
export const TEAM_ROTATE_MEMBER_KEYS_MIN = 1;
export const TEAM_ROTATE_MEMBER_KEYS_MAX = 1000;

// ─── General Limits ─────────────────────────────────────────
export const EMAIL_MAX_LENGTH = 254;          // RFC 5321
export const FILENAME_MAX_LENGTH = 255;
export const URL_MAX_LENGTH = 2048;
export const SEARCH_QUERY_MAX_LENGTH = 100;
export const CONTENT_TYPE_MAX_LENGTH = 100;

// ─── Rate Limits ────────────────────────────────────────────
export const CSP_REPORT_RATE_MAX = 60;
export const HIBP_RATE_MAX = 30;

// ─── Watchtower ─────────────────────────────────────────────
export const BREACH_COUNT_MAX = 10_000;

// ─── Admin ──────────────────────────────────────────────────
export const MASTER_KEY_VERSION_MIN = 1;
export const MASTER_KEY_VERSION_MAX = 100;

// ─── Vault Reset ────────────────────────────────────────────
export const MAX_PENDING_RESETS = 3;

// ─── Tenant Policy CIDR ─────────────────────────────────────
export const MAX_CIDRS = 50;

// ─── Breakglass ─────────────────────────────────────────────
export const BREAKGLASS_REASON_MIN = 10;
export const BREAKGLASS_REASON_MAX = 1000;
export const BREAKGLASS_INCIDENT_REF_MAX = 500;

// ─── Pagination ─────────────────────────────────────────────
export const HISTORY_PAGE_SIZE = 20;
export const NOTIFICATION_PAGE_MIN = 1;
export const NOTIFICATION_PAGE_DEFAULT = 20;
export const NOTIFICATION_PAGE_MAX = 50;

// ─── Ciphertext Limits ──────────────────────────────────────
export const CIPHERTEXT_MAX = 500_000;
export const HISTORY_BLOB_MAX = 1_000_000;  // history reencrypt allows larger blobs

// ─── Bulk Operation ─────────────────────────────────────────
export const MAX_BULK_IDS = 100;

// ─── Share Access ───────────────────────────────────────────
export const SHARE_PASSWORD_MAX_ATTEMPTS = 5;
export const SHARE_ACCESS_PASSWORD_MAX = 43;

// ─── Password Generator Defaults ────────────────────────────
export const PASSWORD_LENGTH_DEFAULT = 16;
export const PASSPHRASE_WORD_COUNT_DEFAULT = 4;
export const PASSPHRASE_SEPARATOR_DEFAULT = "-";
export const PASSPHRASE_SEPARATOR_MAX = 5;

// ─── Emergency Access ───────────────────────────────────────
export const EMERGENCY_WAIT_DAYS = [7, 14, 30] as const;

// ─── Team Member Key ────────────────────────────────────────
export const ENCRYPTED_TEAM_KEY_MAX = 1000;
export const EPHEMERAL_PUBLIC_KEY_MAX = 500;

// ─── SCIM Batch Limits ──────────────────────────────────────
export const SCIM_PATCH_OPERATIONS_MAX = 100;
export const SCIM_GROUP_MEMBERS_MAX = 1000;
```

#### 1b. 共有regexパターン

```typescript
// ─── Shared Regex Patterns ──────────────────────────────────
export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
```

#### 1c. 共有enum配列

```typescript
// ─── Shared Enum Values ─────────────────────────────────────
export const EXPIRY_PERIODS = ["1h", "1d", "7d", "30d"] as const;
export const DIRECTORY_SYNC_PROVIDERS = ["AZURE_AD", "GOOGLE_WORKSPACE", "OKTA"] as const;
```

#### 1d. 共有Zodスキーマ（再利用パーツ）

既存の `hexString()` ヘルパーを活用して、インライン `.regex(/^[0-9a-f]{N}$/)` パターンをすべて置換:

```typescript
// 既存（変更なし）
export const hexString = (bytes: number) =>
  z.string().length(bytes * 2).regex(/^[0-9a-f]+$/i);

// 新規: よく使うhexスキーマを事前定義
export const hexIv = hexString(12);        // .length(24)
export const hexAuthTag = hexString(16);   // .length(32)
export const hexSalt = hexString(32);      // .length(64)
export const hexHash = hexString(32);      // .length(64) SHA-256

// 既存スキーマの定数参照化
export const encryptedFieldSchema = z.object({
  ciphertext: z.string().min(1).max(CIPHERTEXT_MAX),
  iv: z.string().length(HEX_IV_LENGTH),
  authTag: z.string().length(HEX_AUTH_TAG_LENGTH),
});

export const bulkIdsSchema = z.object({
  ids: z.array(z.string().min(1))
    .transform(ids => [...new Set(ids)])
    .pipe(z.array(z.string()).min(1).max(MAX_BULK_IDS)),
});
```

### Step 2: Zodバリデーションスキーマの定数・スキーマ参照化

各 `src/lib/validations/*.ts` ファイル:

| ファイル | 置換対象 |
|----------|----------|
| `validations/entry.ts` | `.default(16)` → `PASSWORD_LENGTH_DEFAULT`, `.default(4)` → `PASSPHRASE_WORD_COUNT_DEFAULT`, `.default("-")` → `PASSPHRASE_SEPARATOR_DEFAULT`, `.max(5)` → `PASSPHRASE_SEPARATOR_MAX`, `historyReencryptSchema` および `teamHistoryReencryptSchema` の `.max(1_000_000)` → `HISTORY_BLOB_MAX` |
| `validations/emergency-access.ts` | `.length(24/32/64)` → `HEX_*_LENGTH` 定数, `.refine(n => [7,14,30].includes(n))` → `EMERGENCY_WAIT_DAYS` |
| `validations/breakglass.ts` | `min=10, max=1000, max=500` → `BREAKGLASS_*` 定数 |
| `validations/tag.ts` | `/^#[0-9a-fA-F]{6}$/` → `HEX_COLOR_REGEX` |
| `validations/team.ts` | `/^#[0-9a-fA-F]{6}$/` → `HEX_COLOR_REGEX`, `.regex(/^[0-9a-f]{24}$/)` → `hexIv`, `.regex(/^[0-9a-f]{32}$/)` → `hexAuthTag`, `.regex(/^[0-9a-f]{64}$/)` → `hexSalt`, `max=1000` → `ENCRYPTED_TEAM_KEY_MAX`, `max=500` → `EPHEMERAL_PUBLIC_KEY_MAX` |
| `validations/send.ts` | `z.enum(["1h","1d","7d","30d"])` → `z.enum(EXPIRY_PERIODS)` |
| `validations/share.ts` | `z.enum(["1h","1d","7d","30d"])` → `z.enum(EXPIRY_PERIODS)`, `.regex(/^[0-9a-f]{64}$/)` → `hexHash`, `.max(43)` → `SHARE_ACCESS_PASSWORD_MAX` |
| `validations/common.ts` | `bulkIdsSchema` と `bulkArchiveSchema` 両方の `.max(100)` → `MAX_BULK_IDS`, `.max(500_000)` → `CIPHERTEXT_MAX`, `.length(24/32)` → `HEX_*`, `encryptedFieldSchema` の iv/authTag を `hexIv`/`hexAuthTag` スキーマに置換（hex 形式検証追加 = 仕様強化） |
| `scim/validations.ts` | `scimPatchOpSchema` の `.max(100)` → `SCIM_PATCH_OPERATIONS_MAX`, `scimGroupSchema` の `.max(1000)` → `SCIM_GROUP_MEMBERS_MAX` |

### Step 3: APIルートハンドラーの定数・スキーマ参照化

#### 3a. Vault系ルート（hex regex → `hexString()` / `hexIv` / `hexAuthTag` / `hexSalt` / `hexHash`）

| ファイル | 置換対象 |
|----------|----------|
| `api/vault/setup/route.ts` | KDF_* 定数群 + すべての `.regex(/^[0-9a-f]{N}$/)` → hexヘルパー |
| `api/vault/unlock/route.ts` | `.regex(/^[0-9a-f]{64}$/)` → `hexHash` |
| `api/vault/change-passphrase/route.ts` | すべてのhex regex → hexヘルパー |
| `api/vault/rotate-key/route.ts` | `.length(24/32/64)` → `HEX_*` 定数 |
| `api/vault/recovery-key/generate/route.ts` | すべてのhex regex → hexヘルパー |
| `api/vault/recovery-key/recover/route.ts` | すべてのhex regex → hexヘルパー |
| `api/vault/admin-reset/route.ts` | `.length(64).regex(...)` → `hexHash` |

#### 3b. 数値制限のあるルート

| ファイル | 置換対象 |
|----------|----------|
| `api/tenant/policy/route.ts` | MAX_CIDRS, セッション系定数 |
| `api/tenant/webhooks/route.ts` | MAX_WEBHOOKS, WEBHOOK_URL_MAX_LENGTH |
| `api/teams/[teamId]/webhooks/route.ts` | MAX_WEBHOOKS, WEBHOOK_URL_MAX_LENGTH |
| `api/audit-logs/download/route.ts` | AUDIT_LOG_* |
| `api/teams/[teamId]/audit-logs/download/route.ts` | AUDIT_LOG_* |
| `api/tenant/audit-logs/download/route.ts` | AUDIT_LOG_* |
| `api/directory-sync/route.ts` | SYNC_INTERVAL_*, NAME_MAX_LENGTH, DIRECTORY_SYNC_PROVIDERS |
| `api/directory-sync/[id]/route.ts` | SYNC_INTERVAL_*, NAME_MAX_LENGTH |
| `api/webauthn/register/verify/route.ts` | WEBAUTHN_*, HEX_* |
| `api/webauthn/credentials/[id]/route.ts` | WEBAUTHN_NICKNAME_MAX_LENGTH |
| `api/tenant/scim-tokens/route.ts` | SCIM_TOKEN_EXPIRY_*, SCIM_TOKEN_DESC_MAX_LENGTH |
| `api/scim/v2/Users/route.ts` | SCIM_PAGE_COUNT_* |
| `api/auth/passkey/verify/route.ts` | PASSKEY_SESSION_MAX_AGE_SECONDS |
| `api/auth/passkey/options/email/route.ts` | EMAIL_MAX_LENGTH |
| `api/csp-report/route.ts` | CSP_REPORT_RATE_MAX |
| `api/watchtower/hibp/route.ts` | HIBP_RATE_MAX |
| `api/watchtower/alert/route.ts` | BREACH_COUNT_MAX |
| `api/admin/rotate-master-key/route.ts` | MASTER_KEY_VERSION_* |
| `api/tenant/members/[userId]/reset-vault/route.ts` | MAX_PENDING_RESETS |
| `api/teams/[teamId]/rotate-key/route.ts` | TEAM_KEY_*, CIPHERTEXT_MAX, HEX_* |
| `api/teams/[teamId]/members/search/route.ts` | SEARCH_QUERY_MAX_LENGTH |
| `api/audit-logs/export/route.ts` | FILENAME_MAX_LENGTH |
| `api/audit-logs/import/route.ts` | FILENAME_MAX_LENGTH |
| `api/passwords/[id]/history/route.ts` | HISTORY_PAGE_SIZE |
| `api/teams/[teamId]/passwords/[id]/history/route.ts` | HISTORY_PAGE_SIZE |
| `api/notifications/route.ts` | NOTIFICATION_PAGE_* |

### Step 4: UIコンポーネントの定数参照化

| ファイル | 確認対象 |
|----------|----------|
| `components/share/share-password-gate.tsx` | SHARE_PASSWORD_MAX_ATTEMPTS |
| `components/passwords/password-import-folders.ts` | ローカル定数 → 共有化検討 |
| `components/settings/directory-sync-card.tsx` | SYNC_INTERVAL_*, DIRECTORY_SYNC_PROVIDERS |

### Step 5: 既存テストの定数参照への更新

既存テスト内のハードコード値も新定数を参照するよう更新する。各ファイルで `@/lib/validations/common` (または `common.server`) からの追加 import が必要になる。

| ファイル | 置換対象 |
|----------|----------|
| `src/lib/validations.test.ts` | `"a".repeat(24)` → `"a".repeat(HEX_IV_LENGTH)`, `"b".repeat(32)` → `"b".repeat(HEX_AUTH_TAG_LENGTH)`, `"c".repeat(64)` → `"c".repeat(HEX_SALT_LENGTH)`, `1001` → `BREAKGLASS_REASON_MAX + 1`, `501` → `BREAKGLASS_INCIDENT_REF_MAX + 1` 等。全ハードコード箇所を網羅的に置換する |
| `src/lib/validations/breakglass.test.ts` | `"a".repeat(1001)` → `"a".repeat(BREAKGLASS_REASON_MAX + 1)`, `"b".repeat(501)` → `"b".repeat(BREAKGLASS_INCIDENT_REF_MAX + 1)` 等 |
| `src/app/api/vault/setup/route.test.ts` | `600_000` → `KDF_PBKDF2_ITERATIONS_MIN`, `10_000_000` → `KDF_PBKDF2_ITERATIONS_MAX`, `100_000`/`1_000_000` 等のKDF関連ハードコード値をすべて定数参照に。common.server から import |
| `src/lib/scim/validations.test.ts` | SCIM関連のハードコード値を定数参照に（該当する場合） |
| `src/__tests__/lib/validations-send.test.ts` | Send関連のハードコード値を定数参照に（該当する場合） |

### Step 6: `prisma-sync.test.ts` の追加

**配置場所**: `src/__tests__/lib/prisma-sync.test.ts`

**アプローチ**: Prisma schema の `@db.VarChar(n)` 値と TypeScript 定数の整合性を検証する。

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const schema = readFileSync(
  resolve(__dirname, "../../../prisma/schema.prisma"),
  "utf-8"
);
```

**選定基準**: TypeScript 定数と 1対1 で対応する `@db.VarChar(N)` フィールドのみを対象とする。以下のカテゴリに分類:

1. **暗号 hex フィールド** (パターンマッチ): フィールド名の末尾が `Iv`, `AuthTag`, `Salt`, `Hash` に一致するすべてのフィールド
2. **名前付きフィールド** (明示的マッピング): 個別に定数との対応を定義

各定数ペアを個別の `it()` で検証（失敗箇所を明確化）。

**対象フィールド:**

| Prisma フィールドパターン | VarChar長 | TypeScript定数 |
|---------------------------|-----------|----------------|
| `*Iv` (secretKeyIv, blobIv 等) | 24 | `HEX_IV_LENGTH` |
| `*AuthTag` (secretKeyAuthTag 等) | 32 | `HEX_AUTH_TAG_LENGTH` |
| `*Salt` (hkdfSalt 等) | 64 | `HEX_SALT_LENGTH` |
| `*Hash` / `tokenHash` | 64 | `HEX_HASH_LENGTH` |
| `Send.sendName` | 200 | `SEND_NAME_MAX_LENGTH` |
| `Folder.name` / `TeamFolder.name` | 100 | `NAME_MAX_LENGTH` |
| `Attachment.filename` / `Send.sendFilename` | 255 | `FILENAME_MAX_LENGTH` |
| `*.url` (TeamWebhook, TenantWebhook) | 2048 | `WEBHOOK_URL_MAX_LENGTH` |
| `WebAuthnCredential.nickname` | 100 | `WEBAUTHN_NICKNAME_MAX_LENGTH` |
| `ScimToken.description` | 255 | `SCIM_TOKEN_DESC_MAX_LENGTH` |
| `ApiKey.name` | 100 | `NAME_MAX_LENGTH` |
| `Notification.title` | 200 | `ENTRY_NAME_MAX` |
| `PersonalLogAccessGrant.incidentRef` | 500 | `BREAKGLASS_INCIDENT_REF_MAX` |

**対象外 (意図的な設計差異)**:
- `Tenant.tailscaleTailnet`: VarChar(255) だが `TAILNET_NAME_MAX_LENGTH = 63` — DB は余裕を持たせている（アプリ層で制限）
- `@db.Text` フィールド: VarChar ではないため正規表現抽出の対象外。Zod バリデーションとの整合性は別の仕組みで保証（例: `BREAKGLASS_REASON_MAX` は `@db.Text` に対する Zod 制限であり、DB 制約ではない）

### Step 7: lint、テスト、ビルド検証

```bash
npm run lint
npx vitest run
npx next build
```

## Testing Strategy

- `npm run lint` でimport漏れ、未使用変数がないことを確認
- 既存のVitestテストがすべてパスすることを確認（テスト内のハードコード値も定数参照に更新済み）
- `npx next build` が成功することを確認（`common.server.ts` 分離後にクライアント側 import エラーがないことも検証される）
- `prisma-sync.test.ts` で Prisma schema と TypeScript 定数の整合性を自動検証
- **ハードコード残存チェック**: 実装完了後に `grep -rn` でバリデーション関連のハードコードリテラルが残っていないことを確認
- **注**: PRF IV/AuthTag の `.max()` → `hexIv`/`hexAuthTag` 置換、および `encryptedFieldSchema` の iv/authTag への hex regex 追加は仕様強化（セマンティクス変更）であり、PR に明記する

## Considerations & Constraints

- **値の変更はしない**: 本タスクは定数化のみ。制限値の見直しは別タスク
- **Prisma schemaの `@db.VarChar(n)` は対象外**: Prisma schemaではリテラル値のみ許容されるため、定数参照はできない。Prisma schemaの各VarCharフィールドにコメントで対応する定数名を記載し、対応関係を明示する。さらに、Prisma schemaの値とTypeScript定数の値が一致していることを検証するユニットテスト (`prisma-sync.test.ts`) を追加する
- **hex regex の大文字小文字**: 既存の `hexString()` は `/^[0-9a-f]+$/i` (case-insensitive)。APIルートの既存パターンは `/^[0-9a-f]{N}$/` (case-sensitive, lowercase only)。`hexString()` に統一する場合、セマンティクスが変わる（大文字も許容される）。現在のDB格納値がすべて小文字であることを確認し、問題がなければ `hexString()` に統一する。問題がある場合は `hexStringLower()` ヘルパーを別途作成する
- **ハードコード置換漏れ検出**: 実装完了後に `grep -rn "\.min(\d" --include="*.ts"` 等のパターンで残存ハードコードを検索し、置換漏れがないことを確認する
- **バンドルサイズへの影響**: `common.ts` はUI・API両方からimportされる。以下のサーバー専用定数がクライアントバンドルに含まれないよう、`common.server.ts` に分離する:
  - KDF パラメータ群 (`KDF_PBKDF2_*`, `KDF_ARGON2_*`)
  - レート制限 (`CSP_REPORT_RATE_MAX`, `HIBP_RATE_MAX`)
  - 監査ログ (`AUDIT_LOG_*`)
  - ページネーション (`HISTORY_PAGE_SIZE`, `NOTIFICATION_PAGE_*`)
  - セッション/Vault ポリシー (`PASSKEY_SESSION_MAX_AGE_SECONDS`, `MAX_CONCURRENT_SESSIONS_*`, `SESSION_IDLE_TIMEOUT_*`, `VAULT_AUTO_LOCK_*`)
- **`SHARE_PASSWORD_MAX_ATTEMPTS`**: クライアントUX用の定数であり、サーバーサイドのレートリミット値とは独立。コメントで明記する
- **`src/lib/constants/` 配下の既存定数ファイル** (`api-key.ts`, `extension-token.ts`) はドメイン固有のため、そのまま維持。将来的に `common.ts` への統合を検討
- **`hexString()` ヘルパーの活用**: 既存の `hexString(bytes)` ヘルパーが `.length(bytes*2).regex(/^[0-9a-f]+$/i)` を生成するため、APIルートの `.regex(/^[0-9a-f]{N}$/)` パターンをこれに統一する
- **`z.enum()` の型安全性**: `as const` 配列から `z.enum()` を生成することで、TypeScriptの型推論も統一される
- **`.default()` 値**: `PASSWORD_LENGTH_DEFAULT = 16` 等、UIの初期値とZodスキーマのデフォルトを同一定数にすることで、UI⇔APIの不整合を防ぐ
- **レート制限値**: APIルート固有だが、定数化して可視性を高める
- **ページネーション**: `.take(20)` のようなPrismaクエリのリテラルも定数化対象に含める
