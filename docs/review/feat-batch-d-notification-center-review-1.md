# コードレビュー: feat/batch-d-notification-center
日時: 2026-03-02T12:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘 (10件)

### F-1 [重大] 通知APIがプロキシの認証リストに登録されていない
- ファイル: `src/proxy.ts` 100-115行
- 問題: `/api/notifications` がproxy層のセッション検証対象に含まれていない
- 推奨: `pathname.startsWith(API_PATH.NOTIFICATIONS)` を追加

### F-2 [重大] team_policies マイグレーションのRLSポリシーに bypass_rls 句が欠落
- ファイル: `prisma/migrations/20260301210000_add_team_policy/migration.sql` 37-38行
- 問題: `bypass_rls` チェックと `WITH CHECK` 句がない（他テーブルと不整合）
- 推奨: notifications/team_webhooks と同じ形式に統一

### F-3 [中] Webhook作成時の req.json() で JSONパースエラー未処理
- ファイル: `src/app/api/teams/[teamId]/webhooks/route.ts` 87行
- 問題: try-catch なしで `await req.json()` を呼んでいる
- 推奨: 他のPOSTハンドラと同様に try-catch で囲む

### F-4 [中] notification.ts の body フィールドに長さ制限がない
- ファイル: `src/lib/notification.ts` 69行
- 問題: `title` は200文字制限があるが `body` にはない
- 推奨: `body.slice(0, 2000)` 等を追加

### F-5 [中] 監査ログダウンロードの日付バリデーション不足
- ファイル: `src/app/api/audit-logs/download/route.ts` 54-64行
- 問題: 不正な日付文字列で Invalid Date が生成されうる
- 推奨: `isNaN(date.getTime())` で検証し 400 を返す

### F-6 [中] NotificationBell でAPIパスがハードコード
- ファイル: `src/components/notifications/notification-bell.tsx` 42, 54, 84, 98, 114行
- 問題: API_PATH 定数を使っていない
- 推奨: API_PATH.NOTIFICATIONS 等に置き換え

### F-7 [低] タグ削除時の子タグ孤立の警告不足
- ファイル: `src/app/api/tags/[id]/route.ts` 122-148行
- 問題: 削除レスポンスに副作用情報がない

### F-8 [低] Webhook events のバリデーションが甘い
- ファイル: `src/app/api/teams/[teamId]/webhooks/route.ts` 25-28行
- 問題: 任意の文字列を受け入れる

### F-9 [低] createNotification の呼び出しで冗長な void
- ファイル: `src/lib/new-device-detection.ts` 100行
- 問題: createNotification は void を返すため void は不要

### F-10 [情報] テストファイル重複
- notification.test.ts が2箇所に存在

## セキュリティ観点の指摘 (9件)

### S-1 [高] = F-1 と同一

### S-2 [高] Webhook URL に対する SSRF 対策が不足
- ファイル: `src/lib/webhook-dispatcher.ts` 40行、`src/app/api/teams/[teamId]/webhooks/route.ts` 26行
- 問題: プライベートIP/localhost へのリクエストをブロックしていない
- 推奨: URL バリデーションでプライベートIPをブロック、https のみ許可

### S-3 [中] = F-5 と同一

### S-4 [中] = F-8 と同一

### S-5 [中] new-device-detection.ts 行8 に eimport タイプミス (確認済み)
- ファイル: `src/lib/new-device-detection.ts` 8行
- 問題: `eimport` は構文エラー

### S-6 [中] 通知メタデータのサニタイゼーションが浅い
- ファイル: `src/lib/notification.ts` 30-41行
- 問題: ネストされたオブジェクト内の機密キーは検査されない
- 推奨: audit.ts の再帰的 sanitizeMetadata() を使用

### S-7 [低] Webhook作成レスポンスに Cache-Control がない
- ファイル: `src/app/api/teams/[teamId]/webhooks/route.ts` 145-157行

### S-8 [低] CSV インジェクション対策
- ファイル: `src/app/api/audit-logs/download/route.ts` 24-28行
- 問題: `=`, `+`, `-`, `@` 先頭のフィールドが数式として解釈される

### S-9 [低] 通知APIにレート制限がない

## テスト観点の指摘 (12件)

### T-1 [高] = S-5 と同一 (eimport タイプミス)

### T-2 [高] 通知テスト・notification テストの重複 (2箇所に存在)
- src/__tests__/api/notifications/ と src/app/api/notifications/
- src/__tests__/lib/notification.test.ts と src/lib/notification.test.ts

### T-3 [中] PUT /api/user/locale のテストなし

### T-4 [中] resolveUserLocale() のユニットテストなし

### T-5 [中] newDeviceLoginEmail() のテストなし

### T-6 [中] notification.test.ts の setTimeout(r, 10) フレイキーリスク
- ファイル: `src/lib/notification.test.ts` 104, 170行

### T-7 [中] Webhook リトライの fake timer フレイキーリスク
- ファイル: `src/lib/webhook-dispatcher.test.ts` 85-91行

### T-8 [低] team-policy.ts のユニットテストなし

### T-9 [低] notification-bell.tsx のテストがほぼ空

### T-10 [低] notification.test.ts で audit-logger 未モック

### T-11 [低] tags テストの withRequestLog モック漏れの可能性

### T-12 [低] tags GET シグネチャ変更の影響範囲確認

## 対応状況
(修正後に追記)
