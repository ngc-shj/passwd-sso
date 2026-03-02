# コードレビュー: feat/batch-d-notification-center
日時: 2026-03-02T16:30:00+09:00
レビュー回数: 5回目

## 前回からの変更
- dispatchWebhook を CRUD ルートに接続
- チームフォームライフサイクル整理完了
- セキュアノートテンプレート表示順序修正

## 機能観点の指摘

| # | 深刻度 | ファイル | 問題 |
|---|--------|---------|------|
| F-3 | Medium | notification.ts:75 | `as never` キャストが型安全性をバイパス |
| F-4 | High | team-tag-input.tsx:117 | IME コンポジション中の Enter キーガード欠落 |
| F-5 | Medium | audit-logs/download/route.ts:37 | CSV に metadata カラムがない |
| F-9 | Medium | user/locale/route.ts:7 | `zod/v4` インポートが他ファイルと不一致の可能性 |
| F-10 | Medium | notification-bell.tsx:70-74 | バックグラウンドタブでもポーリング継続 |
| F-14 | Medium | audit-logs/download/route.ts:192-194 | ストリームエラー時に controller.close() のみ |

## セキュリティ観点の指摘

| # | 深刻度 | ファイル | 問題 |
|---|--------|---------|------|
| S-2 | High | webhook-dispatcher.ts:40-48 | SSRF: リダイレクト経由のバイパス |
| S-5 | Medium | secure-note-markdown.tsx | img タグで外部URLへのリクエスト（IP漏洩） |
| S-9 | Low | webhook-dispatcher.ts:132-134 | エラーの完全握り潰し（ログなし） |

## テスト観点の指摘

| # | 深刻度 | ファイル | 問題 |
|---|--------|---------|------|
| T-1 | Medium | webhook-dispatcher.test.ts | failCount >= 10 の自動無効化テスト欠落 |
| T-3 | Medium | audit-logs/download/route.test.ts | CSV injection 防止テスト欠落 |
| T-6 | Medium | notifications/[id]/route.test.ts | withRequestLog モック欠落 |
| T-8 | Medium | tags/[id]/route.test.ts | PUT parentId 変更時の循環参照テスト欠落 |
| T-11 | Low | new-device-detection.test.ts | ユーザー未検出時のテスト欠落 |
| T-13 | Low | secure-note-markdown.test.tsx | data: URI テスト欠落 |
| T-14 | Low | share-permission.test.ts | 複数パーミッション組み合わせテスト欠落 |
| T-15 | Low | webhooks/route.test.ts | HTTP/localhost URL 拒否テスト欠落 |

## 対応状況
[修正後に追記]
