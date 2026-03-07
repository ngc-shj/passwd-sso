# コードレビュー: feat/batch-d-notification-center
日時: 2026-03-02T12:45:00+09:00
レビュー回数: 2回目

## 前回からの変更
前回 (ループ1) の指摘 25+ 件すべてに対応してコミット済み (441f142)。

## 機能観点の指摘
| ID | 重要度 | ファイル | 概要 |
|----|--------|----------|------|
| F-10 | Medium | `webhooks/route.ts:50` | `events.max(50)` が実際の 62 アクションと不一致 |
| F-11 | Medium | `audit-logs/download/route.ts` (2箇所) | `from > to` の逆順日付が無バリデーション |
| F-12 | Medium | `webhook-dispatcher.ts` | `dispatchWebhook` が未接続でイベントが実際に配信されない |
| F-13 | Low | `notifications/[id]/route.ts:23-24` | `findUnique` に `userId` フィルタなし（情報漏洩の余地） |
| F-14 | Low | `notification.ts:75` | `as never` 型アサーション |

## セキュリティ観点の指摘
| ID | 重要度 | ファイル | 概要 |
|----|--------|----------|------|
| N-1 | High | `webhooks/route.ts:27-51` | IPv6-mapped IPv4 による SSRF フィルタ回避 |
| N-2 | Medium | `audit-logs/download` (2箇所) | 片側日付指定で 90 日上限が無効化される |
| N-3 | Low | `webhooks/[webhookId]/route.ts:45-47` | DELETE クエリに `teamId` 制約欠落 |
| N-4 | Low | 初回マイグレーション | RLS ポリシー履歴の整合性（修正マイグレーションで対処済み） |

## テスト観点の指摘
| ID | 重要度 | ファイル | 概要 |
|----|--------|----------|------|
| T-7 | High | `notification.test.ts:173` | `never throws` テストのアサーションが無意味 |
| T-8 | Medium | `notification.test.ts` | `body` 2000文字 truncation テスト欠落 |
| T-9 | Medium | `notification.test.ts` | ネスト metadata サニタイズテスト欠落 |
| T-10 | Medium | `new-device-detection.test.ts` | `currentSessionToken` 除外テスト欠落 |
| T-11 | Medium | `new-device-detection.test.ts` | 英語ロケール sendEmail subject 未検証 |
| T-12 | Low | `notifications/route.test.ts` | `withRequestLog` モックアプローチ不一致 |
| T-13 | Low | `notification-bell.test.ts:41` | テスト名と内容の乖離 |
