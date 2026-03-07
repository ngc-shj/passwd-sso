# コードレビュー: feat/unify-form-architecture
日時: 2026-03-02T16:45:23Z
レビュー回数: 2回目

## 前回からの変更
- 解決済み: `requireRepromptForAll` を共有フック側で state に同期するよう修正した。
- 解決済み: ログイン用 generator settings を policy 更新時に再拘束する helper を追加した。
- 解決済み: policy 同期と generator policy 適用の回帰テストを追加した。

## 機能観点の指摘
指摘なし

## セキュリティ観点の指摘
指摘なし

## テスト観点の指摘
指摘なし

## 対応状況
### F1 requireReprompt の policy 未同期
- 対応: `useTeamBaseFormModel` で `requireRepromptForAll` を監視し、policy 強制時は保存 state も `true` に同期するよう修正。
- 修正ファイル: src/hooks/use-team-base-form-model.ts:95

### S1 generator settings の policy 未反映
- 対応: 既存 generator settings に policy 下限を再適用する `applyPolicyToGeneratorSettings` を追加し、`TeamPasswordForm` で policy 更新時に反映。
- 修正ファイル: src/hooks/team-password-form-initial-values.ts:87
- 修正ファイル: src/components/team/team-password-form.tsx:74

### T1 policy 同期の回帰テスト不足
- 対応: `useTeamBaseFormModel` の policy 後追い同期テストと generator policy 適用 helper のテストを追加。
- 修正ファイル: src/hooks/use-team-base-form-model.test.ts:1
- 修正ファイル: src/hooks/team-password-form-initial-values.test.ts:1
