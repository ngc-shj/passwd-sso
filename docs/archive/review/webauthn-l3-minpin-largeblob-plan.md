# Plan: webauthn-l3-minpin-largeblob

## Context

WebAuthn Level 3 の credProps 拡張を実装済み。続いて minPinLength（テナントポリシー連携）と largeBlob（サポート検出）を同ブランチに追加する。

## Objective

1. **minPinLength**: 登録時に認証器の最小PIN長を取得・保存し、テナントポリシーで最小PIN長を強制できるようにする
2. **largeBlob**: 登録時に largeBlob サポートを検出・保存し、UI で対応状況を表示する（実際の read/write は将来対応）

## Requirements

### Functional — minPinLength
- 登録オプションに `minPinLength: true` を追加
- `clientExtensionResults.minPinLength` を取得（整数 or undefined）
- 範囲バリデーション: 4-63 の整数のみ受け入れ、範囲外は `null` にフォールバック
- テナントポリシーに `requireMinPinLength` フィールドを追加（nullable int, 4-63）
- ポリシーチェック（DB保存前に実行）:
  - minPinLength が返却され、`requireMinPinLength` を満たす → 登録許可
  - minPinLength が未返却で、`requireMinPinLength` が設定済み → 登録拒否（認証器がPIN長を報告しない場合はポリシー準拠を確認できないため）
  - `requireMinPinLength` が未設定（null） → チェックなし
- クレデンシャル一覧 API に `minPinLength` を返す
- UI にバッジ表示（「PIN: N桁」、未報告時は非表示）
- 監査ログに `minPinLength` を含める

### Functional — largeBlob
- 登録オプションに `largeBlob: { support: "preferred" }` を追加
- `clientExtensionResults.largeBlob.supported` を取得（boolean or undefined）
- DB に `largeBlobSupported` (boolean, nullable) を保存
- クレデンシャル一覧 API に `largeBlobSupported` を返す
- UI にバッジ表示（対応/非対応）
- 監査ログに `largeBlobSupported` を含める
- **注意**: `largeBlobSupported` はサポート検出のみ。実際のデータ保存は将来対応

### Non-functional
- 既存クレデンシャルは新フィールド `null`（後方互換）
- credProps の実装パターンに従う（型ガード、フォールバック）
- ポリシーチェックは `prisma.webAuthnCredential.create()` の前に実行

## Technical Approach

### minPinLength データフロー
1. Server: `extensions: { minPinLength: true }` を登録オプションに追加
2. Client: `getClientExtensionResults()` が自動的に返す（透過的、クライアント側変更不要）
3. Server: 型ガード + 範囲チェック (4-63)
4. Server: テナントポリシーチェック（create 前）— `user.findUnique` の select に `tenant.requireMinPinLength` を追加
5. DB: `minPinLength` カラムに保存
6. API → UI: バッジで表示

### largeBlob データフロー
1. Server: `extensions: { largeBlob: { support: "preferred" } }` を登録オプションに追加
2. Client: `getClientExtensionResults()` が `{ largeBlob: { supported: boolean } }` を返す（透過的）
3. Server: `typeof supported === "boolean"` でバリデーション
4. DB: `largeBlobSupported` カラムに保存
5. API → UI: バッジで表示

## Implementation Steps

### Step 1: Prisma schema + migration
- `WebAuthnCredential` に追加:
  - `minPinLength Int? @map("min_pin_length")`
  - `largeBlobSupported Boolean? @map("large_blob_supported")`
- `Tenant` に追加:
  - `requireMinPinLength Int? @map("require_min_pin_length")`
- Prisma Client 再生成 + マイグレーションファイル手動作成

**Files:** `prisma/schema.prisma`

### Step 2: Registration options — request extensions
- `extensions` に `minPinLength: true` と `largeBlob: { support: "preferred" }` を追加

**File:** `src/lib/webauthn-server.ts`

### Step 3: Registration verify — extract, validate, policy check, save
- `clientExtensionResults` から `minPinLength` と `largeBlob.supported` を抽出
- 型ガード:
  ```ts
  const rawMinPin = (response as any).clientExtensionResults?.minPinLength;
  const minPinLength: number | null =
    typeof rawMinPin === "number" && Number.isInteger(rawMinPin) && rawMinPin >= 4 && rawMinPin <= 63
      ? rawMinPin : null;

  const rawLargeBlob = (response as any).clientExtensionResults?.largeBlob?.supported;
  const largeBlobSupported: boolean | null =
    typeof rawLargeBlob === "boolean" ? rawLargeBlob : null;
  ```
- コメント: `// minPinLength is a client-supplied value (not authenticator-signed). Policy enforcement is best-effort.`
- テナントポリシーチェック（create 前）:
  - `user.findUnique` の select を拡張: `{ tenantId: true, locale: true, tenant: { select: { requireMinPinLength: true } } }`
  - 条件式:
    ```ts
    const requireMinPin = user.tenant?.requireMinPinLength ?? null;
    if (requireMinPin !== null && (minPinLength === null || minPinLength < requireMinPin)) {
      return 400 "PIN length policy not satisfied"
    }
    ```
  - エラー details は定性的メッセージのみ（ポリシー値の具体的な数値を含めない）
- `prisma.webAuthnCredential.create()` に `minPinLength`, `largeBlobSupported` を追加
- レスポンス JSON に追加
- 監査ログ metadata に追加

**File:** `src/app/api/webauthn/register/verify/route.ts`

### Step 4: Tenant policy — add requireMinPinLength
- GET: `select` に `requireMinPinLength: true` を追加
- PATCH: Zod スキーマに `requireMinPinLength: z.number().int().min(4).max(63).nullable().optional()` を追加
- テナント管理 UI にポリシー設定フィールド追加

**Files:** `src/app/api/tenant/policy/route.ts`, テナント設定コンポーネント

### Step 5: Credentials list API — return new fields
- `select` に `minPinLength: true`, `largeBlobSupported: true` を追加

**File:** `src/app/api/webauthn/credentials/route.ts`

### Step 6: UI — badges and Credential interface
- `Credential` interface に `minPinLength: number | null`, `largeBlobSupported: boolean | null` を追加
- バッジ表示:
  - minPinLength: `PIN: N桁` (null時は非表示)
  - largeBlob: 対応/非対応 (null時は非表示)
- i18n メッセージ追加

**Files:** `src/components/settings/passkey-credentials-card.tsx`, `messages/ja/WebAuthn.json`, `messages/en/WebAuthn.json`

### Step 7: Tests
- register/verify:
  - minPinLength: 有効値(6) / 範囲外(2) / 非整数("4") / 未対応(undefined) → DB保存値の検証
  - largeBlob: supported=true / false / 未対応(undefined) → DB保存値の検証（false と null の区別を明確に）
  - ポリシー違反: requireMinPinLength=6 で minPinLength=4 → 400
  - ポリシー違反: requireMinPinLength=6 で minPinLength 未返却 → 400
  - ポリシー境界値: requireMinPinLength=6 で minPinLength=6 → 201（ちょうど一致）
  - ポリシーなし: requireMinPinLength=null で minPinLength 任意 → 201
  - `makeCreatedCredential` を拡張して `minPinLength`, `largeBlobSupported` を含める
- tenant/policy: `src/app/api/tenant/policy/route.test.ts` を新規作成
  - GET: requireMinPinLength を返す
  - PATCH: requireMinPinLength の有効値(6) / 範囲外下限(3) / 範囲外上限(64) / null(無効化)
- credentials: 新フィールドの select 確認

**Files:** 既存テストファイルに追加 + `src/app/api/tenant/policy/route.test.ts` 新規作成

## Testing Strategy

- 新テストケース合計: ~12件
- `npx vitest run` — 全テストパス
- `npx next build` — ビルド成功

## Considerations & Constraints

- `minPinLength` は Chrome 100+ / Safari 16.4+ でサポート。未対応ブラウザは拡張を無視する（エラーにならない）
- `largeBlob: { support: "preferred" }` は登録時のサポート検出のみ。`{ read: true }` / `{ write: Uint8Array }` は認証時オプション（将来対応）
- テナントポリシー違反時のエラーコードは `VALIDATION_ERROR` で、details にポリシー不足の内容を明示
- `requireMinPinLength` のデフォルトは `null`（チェックなし）— 既存テナントに影響なし
- **セキュリティ上の制約**: `minPinLength` はクライアント供給値であり、認証器の署名対象外。ポリシー強制はベストエフォート型で、改ざんされたブラウザには有効でない。コード内に警告コメントを必須とする
