# コードレビュー: feat/group-b-email-session-ea
日時: 2026-02-23T12:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### #1 [HIGH] EA routes locale hardcoded "ja"
- **ファイル**: 8 EA route files (`src/app/api/emergency-access/` 配下)
- **問題**: `emergencyInviteEmail("ja", ...)` のように locale が `"ja"` にハードコード
- **影響**: 英語圏ユーザーにも日本語メールが送信される
- **推奨**: owner/grantee の locale preference を使うか、デフォルトロケールを定数化

### #2 [MED] sessions-card.tsx no error toast on revoke failure
- **ファイル**: `src/components/sessions/sessions-card.tsx`
- **問題**: revoke API 失敗時にユーザーへのフィードバックがない
- **推奨**: catch ブロックで toast.error を表示

### #3 [MED] sessions-card.tsx no error handling on fetchSessions
- **ファイル**: `src/components/sessions/sessions-card.tsx`
- **問題**: fetchSessions 失敗時のエラーハンドリングがない
- **推奨**: try-catch + エラー状態の表示

### #4 [MED] layout.ts locale not escaped in lang attribute
- **ファイル**: `src/lib/email/templates/layout.ts`
- **問題**: `<html lang="${locale}">` で locale が未検証
- **推奨**: ホワイトリスト ("ja" | "en") で検証

### #5 [MED] layout.ts appName module-load evaluation
- **ファイル**: `src/lib/email/templates/layout.ts`
- **問題**: `appName` がモジュール読み込み時に評価される
- **推奨**: 関数内で評価するか、テスト時の env 変更に対応

### #8 [MED] DELETE /api/sessions/[id] missing currentToken null guard
- **ファイル**: `src/app/api/sessions/[id]/route.ts`
- **問題**: route.ts 側にはガードがあるが [id]/route.ts にはない可能性
- **推奨**: 確認・修正

### #12 [LOW] AlertDialogAction default close vs async
- **ファイル**: `src/components/sessions/sessions-card.tsx`
- **問題**: AlertDialogAction がクリック後即座にダイアログを閉じるが、async 操作中は表示を維持すべき可能性
- **推奨**: 確認のみ (AlertDialog の動作は標準的)

## セキュリティ観点の指摘

### #1 [HIGH] /api/sessions not in proxy protection
- **ファイル**: `src/proxy.ts`
- **問題**: `/api/sessions` が proxy のルート保護対象に含まれていない
- **影響**: 未認証ユーザーがセッション API にアクセス可能
- **推奨**: matcher にパスを追加

### #2 [MED] sessionToken loaded from DB unnecessarily
- **ファイル**: `src/app/api/sessions/route.ts`
- **問題**: GET で sessionToken を SELECT しており、レスポンスに含めないが不必要にメモリに読み込む
- **推奨**: select で sessionToken を除外

### #3 [LOW] locale not escaped in layout.ts
- **ファイル**: `src/lib/email/templates/layout.ts` (機能 #4 と重複)

### #4 [MED] EA decline/approve/revoke/reject missing rate limits
- **ファイル**: 4 EA route files
- **問題**: accept には rate limit があるが、decline/approve/revoke/reject にはない
- **推奨**: 重要な変更操作にレートリミットを追加

### #5 [LOW] GET /api/sessions no rate limit
- **ファイル**: `src/app/api/sessions/route.ts`
- **問題**: 読み取り API にレートリミットなし
- **推奨**: 低優先度、必要に応じて追加

### #6 [LOW] sendEmail fire-and-forget without void prefix
- **ファイル**: 8 EA route files
- **問題**: `sendEmail(...)` の戻り値が void で、ESLint の @typescript-eslint/no-floating-promises に引っかかる可能性
- **推奨**: `void sendEmail(...)` に変更

### #8 [INFO] SMTP requireTLS
- **ファイル**: `src/lib/email/smtp-provider.ts`
- **推奨**: 情報のみ、現状で問題なし

## テスト観点の指摘

### #1 [MED] locale XSS test missing for layout
- **ファイル**: `src/lib/email/templates/layout.ts` のテスト
- **問題**: 不正な locale 値によるインジェクションテストがない
- **推奨**: ホワイトリスト検証のテストを追加

### #2 [MED] [id]/route.test.ts Cookie-less test missing
- **ファイル**: `src/app/api/sessions/[id]/route.test.ts`
- **問題**: Cookie なし時の 401 テストがない
- **推奨**: テスト追加

### #5 [MED] vi.useRealTimers() placement
- **ファイル**: email テスト
- **問題**: `vi.useRealTimers()` の位置が不適切な可能性
- **推奨**: 確認

### #6 [MED] lastActiveAt null case untested
- **ファイル**: `src/lib/auth-adapter.test.ts`
- **問題**: sessionMetaStorage が undefined 時の lastActiveAt 更新テストがない
- **推奨**: テスト追加

### #7 [MED] helpers.ts has no test file
- **ファイル**: `src/app/api/sessions/helpers.ts`
- **問題**: テストファイルが存在しない
- **推奨**: `helpers.test.ts` 作成

### #9 [MED] EA tests don't verify sendEmail subject
- **ファイル**: 8 EA test files
- **問題**: sendEmail の to は検証しているが subject を検証していない
- **推奨**: subject 検証を追加

### #10 [LOW] email/index.test.ts init failure caching
- **ファイル**: `src/lib/email/index.test.ts`
- **問題**: プロバイダ初期化失敗時のキャッシュ動作テストなし
- **推奨**: 低優先度

### #11 [LOW] auth-adapter { ip: null } untested
- **ファイル**: `src/lib/auth-adapter.test.ts`
- **問題**: createSession で ip が null の場合のテストがない
- **推奨**: 低優先度

## 対応状況

### 機能 #1 [HIGH] EA routes locale hardcoded "ja" → 修正済み
- 対応: 8 EA route files で `"ja"` → `routing.defaultLocale` に変更
- `import { routing } from "@/i18n/routing"` を追加

### 機能 #2 [MED] sessions-card.tsx no error toast → 修正済み
- 対応: `handleRevoke`, `handleRevokeAll`, `fetchSessions` に catch + `toast.error` 追加
- i18n キー `fetchError`, `revokeError` を en/ja に追加

### 機能 #3 [MED] sessions-card.tsx no error on fetch → 修正済み (上記と同時)

### 機能 #4 [MED] layout.ts locale not escaped → 修正済み
- 対応: `sanitizeLocale()` ホワイトリスト関数を追加、不正 locale は `"ja"` に fallback

### 機能 #5 [MED] layout.ts appName module-load → スキップ
- 理由: 標準的なパターン。APP_NAME は起動時に固定される値で、テスト時の変更は不要

### 機能 #8 [MED] [id] currentToken null guard → 修正済み
- 対応: `if (currentToken)` → `if (!currentToken) return 401` ガードに変更

### 機能 #12 [LOW] AlertDialogAction async → スキップ
- 理由: AlertDialog の標準動作。disabled 属性でクリック抑止済み

### セキュリティ #1 [HIGH] /api/sessions not in proxy → 修正済み
- 対応: `src/proxy.ts` の保護対象に `API_PATH.SESSIONS` を追加

### セキュリティ #2 [MED] sessionToken in SELECT → 修正済み
- 対応: findUnique で現在の session ID を取得し、findMany では sessionToken を除外。ID ベースで isCurrent 判定

### セキュリティ #3 [LOW] locale not escaped → 修正済み (機能 #4 と同一)

### セキュリティ #4 [MED] EA rate limits → スキップ
- 理由: approve/decline/revoke は既に auth + proxy で保護。低頻度操作でレートリミットは過剰

### セキュリティ #5 [LOW] GET rate limit → スキップ
- 理由: 読み取り API かつ proxy で認証済み。低リスク

### セキュリティ #6 [LOW] void sendEmail → 修正済み
- 対応: 8 EA route files で `sendEmail(...)` → `void sendEmail(...)` に変更

### セキュリティ #8 [INFO] SMTP requireTLS → スキップ (情報のみ)

### テスト #1 [MED] locale XSS test → 修正済み
- 対応: `layout.test.ts` を新規作成。XSS locale テスト + 正常系テスト含む

### テスト #2 [MED] [id] Cookie-less test → 修正済み
- 対応: `[id]/route.test.ts` に Cookie なし時の 401 テスト追加

### テスト #5 [MED] vi.useRealTimers → スキップ
- 理由: 現在のテストで問題なし、具体的な不具合指摘なし

### テスト #6 [MED] lastActiveAt null → スキップ
- 理由: auth-adapter のテストで既に Store undefined 時のフォールバック確認済み

### テスト #7 [MED] helpers.ts no test → 修正済み
- 対応: `helpers.test.ts` を新規作成 (5 テスト: http/https/absent/invalid/NEXTAUTH_URL)

### テスト #9 [MED] EA subject verification → 修正済み
- 対応: 8 EA test files で sendEmail の subject 検証を追加

### テスト #10 [LOW] init failure caching → スキップ (低優先度)
### テスト #11 [LOW] ip null untested → スキップ (低優先度)
