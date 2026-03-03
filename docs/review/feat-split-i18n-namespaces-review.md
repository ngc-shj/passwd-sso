# プランレビュー: spicy-riding-walrus.md

日時: 2026-02-22
総ループ回数: 2回（+ T11 軽微修正）

---

## ループ 1: 初回レビュー

### 機能観点の指摘 (5件)

| ID | 深刻度 | 概要 | 対応 |
|----|--------|------|------|
| F1 | 重大 | NS_DASHBOARD_CORE に Watchtower, Import, Export, AuditLog, EmergencyAccess, ShareLinks の 6 名前空間が不足 | 採用: 6 名前空間を追加 |
| F2 | 重大 | Phase 1 で `messages/{locale}.json` 削除後 `src/app/s/layout.tsx` がビルドエラー | 採用: Phase 1 Step 4 に更新手順を追加 |
| F3 | 低 | NS_VAULT 内 Auth の妥当性 | 確認済: signout-button.tsx で useTranslations("Auth") 使用 |
| F4 | 中 | NAMESPACES 定数 37 個の手動列挙 — 新規追加時の忘れリスク | 採用: 双方向チェックテスト追加 |
| F5 | 低 | pickMessages に存在しない名前空間指定時の挙動未定義 | 採用: 開発環境 console.warn 追加 |

### セキュリティ観点の指摘 (3件)

| ID | 深刻度 | 概要 | 対応 |
|----|--------|------|------|
| S1 | 低 | Share パブリックルートに認証済み名前空間が漏れるリスク | 採用: NS_PUBLIC_SHARE ホワイトリスト定数を追加 |
| S2 | 低 | locale 検証ロジックがレイアウト 5 箇所に分散 | 採用: `src/i18n/messages.ts` に loadAllMessages / loadNamespaces を集約 |
| S3 | 低 | 名前空間名の将来的なパス注入リスク | 採用: loadNamespaces 内で validNamespaces.has(ns) ランタイム検証 |

### テスト観点の指摘 (10件)

| ID | 深刻度 | 概要 | 対応 |
|----|--------|------|------|
| T1 | 重大 | NS_DASHBOARD_CORE 不足 6 件（F1 と同一） | 採用 |
| T2 | 中 | Share 公開ページに CopyButton + Common 必要 | 採用: NS_PUBLIC_SHARE = [Common, Share, CopyButton] |
| T3 | 低 | Metadata が NAMESPACES に含まれることの明示 | 採用 |
| T4 | 低 | Auth が NS_VAULT に含まれることの確認 | 確認済 |
| T5 | 中 | 名前空間グループの正確性テスト欠如 | 採用: namespace-groups.test.ts 新規追加 |
| T6 | 中 | ネスト Provider 置換動作のリグレッションテスト | 採用: スーパーセット検証テスト |
| T7 | 中 | pickMessages のユニットテストなし | 採用: pick-messages.test.ts 新規追加 |
| T8 | 低 | マイグレーションスクリプトべき等性 | 不採用: 一度実行して削除するスクリプト |
| T9 | 低 | CI バンドルサイズ検知が手動 | 不採用: スコープ外 |
| T10 | 低 | recovery/vault-reset レイアウトテスト | T5/T6 でカバー |

---

## ループ 2: 再レビュー

### 機能観点: 指摘なし
前回 F1-F5 全て適切に反映。新規指摘なし。

### セキュリティ観点: 指摘なし
前回 S1-S3 全て適切に反映。新規指摘なし。

### テスト観点: 1件

| ID | 深刻度 | 概要 | 対応 |
|----|--------|------|------|
| T11 | 低 | recovery/vault-reset ページの名前空間グループ定数とテスト欠如 | 採用: NS_RECOVERY, NS_VAULT_RESET 定数を追加、スーパーセットテスト追加 |
| T12 | 情報 | NS_PUBLIC_SHARE に将来 ApiErrors が必要になる可能性 | 不採用: 現時点で不要。必要時に追加で十分 |

---

## レビュー完了

最終状態: 機能 0件 / セキュリティ 0件 / テスト 0件（T11 反映済み）
レビューファイル: docs/temp/spicy-riding-walrus-review.md
