# プランレビュー: typed-dreaming-key (Settings UI 改善)

日時: 2026-03-04T22:30:00+09:00
レビュー回数: 2回

## レビュー対象

Settings UI 改善プラン: スクロール可能なメンバーリスト + メンバー検索 + Webhook 管理 UI

## ラウンド1 (16件)

### 修正済み (10件)

| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| F1 | Medium | webhook グループ自己参照 | group:webhook を除外 |
| F2 | Medium | 削除→再取得パターン未明記 | fetchWebhooks() 再取得を明記 |
| S1 | Low | secret input に autocomplete="off" | 追記 |
| T1 | High | TeamWebhookCard テスト未計画 | team-webhook-card.test.tsx 追加 |
| T2 | High | 検索フィルタ テスト未計画 | filterMembers() 純粋関数分離 + テスト |
| T3 | Medium | スクロールは jsdom 不可 | 手動確認に分類 |
| T4 | Medium | api-path.test.ts 更新漏れ | テスト追加 |
| T6 | Medium | シークレット表示仕様曖昧 | React state ライフサイクルで明確化 |
| T7 | Low | イベント未選択バリデーション | UI disabled + API テスト追加 |

### 既記載 (3件)

| # | 重要度 | 指摘 | 備考 |
|---|--------|------|------|
| F3 | Medium | grid-cols 更新 | Step 3C に grid-cols-4 記載済み |
| S2 | Low | 削除確認ダイアログ | Step 3B に AlertDialog 記載済み |
| S3 | Low | イベント選択整合性 | AUDIT_ACTION_GROUPS_TEAM から動的生成 |

### スキップ (3件)

| # | 重要度 | 指摘 | スキップ理由 |
|---|--------|------|-------------|
| F5 | Low | deactivated メンバー混在 | 将来拡張。初回は名前・メール検索で十分 |
| F6 | Low | i18n キー重複 | 名前空間が異なるため既存パターン通り |
| T5 | Medium | i18n キー整合性確認 | ビルド時に未定義キーはエラー検出される |

## ラウンド2 (4件)

### 修正済み (2件)

| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| F7 | Low | Transfer Ownership 検索共有不明確 | 同一 state 共有を明記 |
| T8 | Low | 不正イベントに group 名も含める | "group:webhook" をテスト入力に追加 |

### スキップ (2件)

| # | 重要度 | 指摘 | スキップ理由 |
|---|--------|------|-------------|
| F8 | Low | Webhook i18n キー一覧未記載 | TeamWebhook.json に全キー定義済み。新規追加なし |
| T9 | Low | api-path ヘルパー未実装 | Step 3A に明記済み |

## セキュリティ観点

ラウンド2で**指摘なし**を確認。既存 API の認証/認可/テナント分離/SSRF 対策/暗号化が有効。
