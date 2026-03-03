# プランレビュー: spicy-sniffing-dawn.md

日時: 2026-02-28T00:00:00+09:00
レビュー回数: 2回目（最終）

## 前回からの変更

### 1回目 → 2回目で反映した修正

- テスト数を正確な値に修正 (39, 20, 9, 14, 8)
- X-5 セキュリティ対策を実装ノートに追記 (sender.tab.url validation, cross-origin push guard, AAD, TTL/max)
- X-3 の UUID validation を追記
- X-5 旧ノート（fetch/XHR interception）の削除・置換を手順に明記
- `_execute_action` が Chrome-native でテスト不要であることを注記
- `trigger-autofill` テスト欠如を Follow-up task として記録
- Verification にチェックリスト追加
- Verification のテスト数を extension 全体 (約346) に修正
- Phase 2 ロードマップに X-3/X-4 を追加する手順を明記

## 機能観点の指摘

### F-1 (重大度: 中) テスト数の記載が不正確

- **問題**: Evidence セクションのテスト数が3ファイルで実際と異なる
  - `context-menu.test.ts`: 10 → 14
  - `background-login-save.test.ts`: 14 → 20
  - `save-banner.test.ts`: 8 → 9
- **影響**: プランの正確性に影響。いずれも実際の方が多いのでカバレッジ不足ではない
- **推奨対応**: 正しい値に修正

### F-2 (重大度: 中) X-5の旧Proposalと実装方式の乖離を明記すべき

- **問題**: 現在の feature-gap-analysis.md では X-5 の Proposal に "intercept submit / fetch / XMLHttpRequest" と記載されているが、実装は form submit capture + click-based detection であり、fetch/XHR interception は不採用
- **影響**: 旧ノートと実装の乖離が記録されないと混乱が生じる
- **推奨対応**: 実装ノートに「fetch/XHR interception は不採用」と明示

## セキュリティ観点の指摘

### S-1 (重大度: 高) X-5実装ノートにセキュリティ対策の記載が欠落

- **問題**: 以下のセキュリティ対策が実装済みだがドキュメントに未記載
  1. sender.tab.url 検証（message.url/title を信頼しない）
  2. クロスオリジン push ガード（host match check）
  3. pull 側の同一ホスト検証
  4. AAD (buildPersonalEntryAAD) による暗号化完全性検証
  5. pending save の TTL 30秒 + 最大5件制限
  6. vault ロック時の pending 全消去
- **影響**: リファクタリング時に防御層が除去されるリスク
- **推奨対応**: 実装ノートにセキュリティ対策を追記

### S-2 (重大度: 中) X-3実装ノートにUUIDバリデーション記載の欠落

- **問題**: handleContextMenuClick() の UUID バリデーションがドキュメントに未記載
- **推奨対応**: 「UUID validation on entryId before autofill」を追記

### S-3 (重大度: 高) Section 2.4 の X-5 旧ノートが実装と乖離 (= F-2と同一)

- セキュリティ観点でも旧ノートの残存は攻撃面の誤解を生む

### S-4 (指摘なし) 情報開示リスク

- 現在の抽象度で適切。追加の攻撃面を開示しない

## テスト観点の指摘

### T-1 (重大度: 高) テスト数の大幅な過少カウント

- **問題**: 5ファイル中4ファイルでテスト数が不正確（合計25件の過少カウント）
  - `login-detector.test.ts`: 25 → 39 (-14)
  - `background-login-save.test.ts`: 14 → 20 (-6)
  - `context-menu.test.ts`: 10 → 14 (-4)
  - `save-banner.test.ts`: 8 → 9 (-1)
  - `background-commands.test.ts`: 8 → 8 (正確)
- **推奨対応**: 全て正しい値に修正

### T-2 (重大度: 低) Verification のテスト件数確認手順が不足

- **問題**: 「all tests should pass」としか記載されていない
- **推奨対応**: 合計テスト件数の確認ステップを追加

### T-3 (重大度: 低) ドキュメント整合性チェックの基準が曖昧

- **推奨対応**: 具体的チェックリストを追加

### T-4 (重大度: 中) trigger-autofill コマンドのユニットテスト欠如

- **問題**: 5コマンドのうち trigger-autofill のリトライロジックがテスト未カバー
- **推奨対応**: プラン範囲外だが、フォローアップタスクとして記録

### T-5 (重大度: 低) _execute_action のテスト不要注記がない

- **推奨対応**: Chrome ビルトイン動作のためテスト不要であることを注記
