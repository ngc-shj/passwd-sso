# プランレビュー: typed-dreaming-key.md
日時: 2026-03-04T18:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### 指摘 F1 (Critical): `/api/vault/admin-reset` の TOCTOU — executeVaultReset が updateMany の前に実行される
- **問題**: `admin-reset/route.ts` L99-121 で `executeVaultReset()` を先に実行し、その後に `updateMany` で atomicResult を確認。revoke と execute が競合した場合、Vault データは削除されるが executedAt がセットされない不整合が発生。
- **影響**: 不可逆的なデータ損失。revoke の安全ネットが機能しない。
- **推奨対応**: `updateMany` を先に実行し、`count === 1` の場合のみ `executeVaultReset` を呼ぶ。

### 指摘 F2 (High): `/api/tenant/*` が proxy.ts のセッション保護対象に含まれていない
- **問題**: `src/proxy.ts` L103-116 の保護対象パス一覧に `/api/tenant` がない。
- **影響**: 認証されていないリクエストが route handler まで到達する（handler 側で 401 は返すが多層防御の欠如）。
- **推奨対応**: `pathname.startsWith(\`${API_PATH.API_ROOT}/tenant\`)` を追加。

### 指摘 F3 (Medium): tenant-members-card.tsx でセッション取得に別途 fetch
- **問題**: `currentUserId` 取得に `/api/auth/session` を別途 fetch。`useSession()` で取得可能。
- **影響**: 不要なネットワークリクエスト。
- **推奨対応**: `useSession()` フックから取得。

### 指摘 F4 (Medium): Settings ページで tenant タブが全ユーザーに表示される
- **問題**: テナント未所属/MEMBER ロールでもタブ表示される。
- **影響**: UX の問題。空のタブが表示。
- **推奨対応**: `useTenantRole()` に基づいてタブ自体の表示/非表示を制御。

### 指摘 F5 (Low): リセット履歴 revoke 後にメンバーリストの pendingResets が更新されない
- **問題**: revoke 成功後に親コンポーネントの pendingResets カウントが古いまま。
- **影響**: UI 不整合（リロードまで）。
- **推奨対応**: `onRevoke` コールバック prop 追加。

### 指摘 F6 (Low): fetchHistory が useCallback でなく eslint-disable で抑制
- **問題**: `tenant-reset-history-dialog.tsx` で eslint-disable コメント使用。
- **影響**: userId 変更時のクロージャ不整合リスク（実害薄い）。
- **推奨対応**: `useCallback` でラップし eslint-disable 削除。

### 指摘 F7 (Info): Revoke API にロール階層チェックがない
- **問題**: Initiate は `isTenantRoleAbove` チェックするが Revoke にはない。
- **影響**: ADMIN が OWNER の initiate を revoke 可能。安全側の操作なのでリスク限定的。
- **推奨対応**: 意図的ならコメント明記。

## セキュリティ観点の指摘

### 指摘 S1 (Critical): executeVaultReset が TOCTOU チェック前に実行 (= F1 と同一)
- 機能観点 F1 と同内容。最優先修正。

### 指摘 S2 (High): admin_vault_resets に FORCE ROW LEVEL SECURITY がない
- **問題**: `ENABLE ROW LEVEL SECURITY` のみ。テーブルオーナーには RLS バイパスされる。
- **影響**: defense-in-depth の欠如。アプリ層の tenantId フィルタはあるが DB レイヤーの保護が不完全。
- **推奨対応**: 新マイグレーションで `FORCE ROW LEVEL SECURITY` 追加。

### 指摘 S3 (Medium): Revoke API にロール階層チェックなし (= F7)
- 機能観点 F7 と同内容。

### 指摘 S4 (Medium): Execute API にレート制限がない
- **問題**: トークンは 256-bit エントロピーなのでブルートフォースは不可能だが、defense-in-depth として不足。
- **影響**: 極めて低リスク。
- **推奨対応**: 認証済みユーザーごとに簡易レート制限追加。

### 指摘 S5 (Low): Vault Reset で Folder が削除されない
- **問題**: `executeVaultReset` が PasswordEntry のみ削除、Folder は残る。
- **影響**: 再セットアップ後に古いフォルダ構造が見える。
- **推奨対応**: `prisma.folder.deleteMany` 追加。

### 指摘 S6 (Low): トークンバリデーションが `z.string().min(1)` のみ
- **問題**: 64 文字の hex 文字列であるべきところ検証が緩い。
- **影響**: 不正入力に対して SHA-256 計算が走る（DoS リスク微小）。
- **推奨対応**: `z.string().length(64).regex(/^[0-9a-f]{64}$/)` に厳密化。

## テスト観点の指摘

### 指摘 T1 (High): admin-vault-reset-revoked メールテンプレートのテスト欠如
- **問題**: `admin-vault-reset-revoked.ts` の対応テストファイルが存在しない。
- **影響**: XSS 防止、ロケール分岐、内容正当性が未検証。
- **推奨対応**: `admin-vault-reset-revoked.test.ts` を作成。

### 指摘 T2 (High): APP_URL 未設定時の 500 エラーパスが未テスト
- **問題**: `admin-reset/route.ts` L29-35 のガードが未テスト。
- **影響**: 環境変数の設定漏れ時の動作が未検証。
- **推奨対応**: テストケース追加。

### 指摘 T3 (High): TOCTOU — vault 削除後にトークンマーク失敗 (= F1/S1)
- 設計修正（F1/S1）で解消される。

### 指摘 T4 (Medium): withTenantRls に渡される tenantId の検証欠如
- **問題**: テスト内で `withTenantRls` に渡される tenantId を検証していない。
- **影響**: テナント分離バグの検出漏れ。
- **推奨対応**: named mock にし tenantId アサーション追加。

### 指摘 T5 (Medium): Rate Limiter モックの呼び出し順序依存
- **問題**: admin/target 両リミッターが同じ mock 関数。`mockResolvedValueOnce` の順序依存。
- **影響**: テストの脆弱性。
- **推奨対応**: 独立した mock 関数を作成。

### 指摘 T6 (Medium): executeVaultReset 失敗時の未テスト
- **問題**: `executeVaultReset` がスローした場合の動作未検証。
- **影響**: 例外バブルアップの確認不足。
- **推奨対応**: テストケース追加。

### 指摘 T7 (Low): CSRF 拒否パスの統合テスト欠如
- **問題**: assertOrigin 自体は別テストでカバー済みだが route handler での統合未テスト。
- **影響**: 低リスク。
- **推奨対応**: 各ルートに CSRF テスト 1 件追加。

### 指摘 T8 (Low): resetUrl の XSS テスト欠如
- **問題**: resetUrl にHTML特殊文字を含むケースのテストなし（サーバー生成値なのでリスク低）。
- **推奨対応**: 防御的テスト追加。
