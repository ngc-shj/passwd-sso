# コードレビュー: feat/batch-d-notification-center
日時: 2026-03-02T14:15:00+09:00
レビュー回数: 3回目

## 前回からの変更
ループ2の全指摘が修正済み (commit aa94a33)

## 機能観点の指摘
- N-1: API_ERROR コード数 92→94 (POLICY_SHARING_DISABLED, POLICY_EXPORT_DISABLED 追加分)
- N-2: Emergency Access locale テスト不足 (テストカバレッジ)
- N-3: Team Password Form テスト失敗 (useTeamPolicy mock 未追加)
- N-4: Share Link E2E テスト失敗 (withTeamTenantRls mock 未追加)
- N-5: Webhook IPv6 hostname ブラケット除去問題
- N-6: Team Policy enforcement 未呼出 (要確認)
- N-7: User locale client-side 反映 (設計確認)

## セキュリティ観点の指摘
- N-5: Webhook IPv6 ブロック不完全 (hostname からブラケット除去済み)
- N-6: メタデータ blocklist vs whitelist (設計選択)
- N-7: OVERVIEW_ONLY 空オブジェクト (エッジケース)

## テスト観点の指摘
- T-14: share-links test に withTeamTenantRls mock 不足
- T-15: use-team-password-form-model test に useTeamPolicy mock 不足
- T-16: API_ERROR count 92→94 更新必要

## 対応状況
(修正後に追記)
