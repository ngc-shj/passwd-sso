# コードレビュー: feat/unify-form-architecture
日時: 2026-03-04T02:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1: `PersonalEntryDialogShell` に `DialogDescription` が欠落（アクセシビリティ警告）
- **ファイル:** `src/components/passwords/personal-entry-dialog-shell.tsx` 行23-33
- **問題:** Radix UI `DialogContent` は `DialogDescription` が存在しない場合にコンソール警告を出力する。チーム側の `TeamEntryDialogShell` では `<DialogDescription className="sr-only">` を設置しているが、個人側には存在しない。
- **推奨修正:** `DialogDescription` を `sr-only` でインポート・追加する。

### F-2: `TeamSoftwareLicenseForm` にメール検証がない（個人版との機能差異）
- **ファイル:** `src/components/team/team-software-license-form.tsx` 行165-192
- **問題:** 個人版 `personal-software-license-form.tsx` ではメール形式チェック（正規表現）を行いエラー表示するが、チーム版に同等の検証がない。
- **推奨修正:** 個人版と同じメール検証ロジックを `handleFormSubmit` に追加する。

### F-3: ダイアログ再オープン時のstateリセット（情報提供）
- **問題:** 条件レンダリング（`formOpen && ...`）によるアンマウント/リマウントで正しくリセットされるため、現状問題なし。将来的なリスクとして認識のみ。
- **対応:** 不要

### F-4: `CreditCardFields` の有効期限年リストの再計算（低優先）
- **ファイル:** `src/components/entry-fields/credit-card-fields.tsx` 行192-198
- **問題:** `new Date().getFullYear()` がレンダリングごとに評価される。年末年始をまたぐ極端なケースで選択肢が変動する可能性。
- **対応:** 低優先、useMemoでメモ化可能だが必須ではない。

## セキュリティ観点の指摘

**指摘なし。**

暗号化フロー（AAD構築、IV生成、鍵管理）、認証・認可チェック（セッション検証、RBAC、テナント分離）、入力検証（Zodスキーマ）、情報漏洩防止、APIセキュリティのいずれも問題なし。

## テスト観点の指摘

### T-1: team login hooks群のユニットテストが欠落（重要度: 高）
- **対象:** 8ファイル（team-login-fields-callbacks.ts, team-login-fields-props.ts, team-login-fields-text-props.ts, team-login-form-controller.ts, team-login-form-derived.ts, team-login-form-presenter.ts, use-team-login-form-model.ts, use-team-login-form-state.ts）
- **問題:** personal側には対称的なテストがすべて存在するが、team側には欠落。旧テスト15ファイルの削除分が補填されていない。
- **推奨修正:** personal側と同じパターンでteam側テストを追加。

### T-2: `use-personal-base-form-model.ts` のテストが欠落（重要度: 中）
- **問題:** team側（use-team-base-form-model.test.ts）にはテストがあるが、personal側にはない。
- **推奨修正:** variant分岐、encryptionKey null時の早期リターン等をテスト。

### T-3: `WatchtowerPage` のteamスコープテストが欠落（重要度: 中）
- **問題:** personalスコープのみテスト。teamスコープでのTeamEditDialogLoader使用分岐がテストされていない。
- **推奨修正:** teamスコープのシナリオを追加。

### T-4: `useTeamBaseFormModel` のテストが単一シナリオのみ（重要度: 中）
- **問題:** requireRepromptForAllポリシー強制のみ。submitEntryのエラーハンドリング、editData有無による初期値切り替え等がテストされていない。
- **推奨修正:** 複数シナリオのテスト追加。

## 対応状況

### F-1: PersonalEntryDialogShellにDialogDescription追加
- 対応: `DialogDescription` を `sr-only` で追加。TeamEntryDialogShellと同一パターン。
- 修正ファイル: `src/components/passwords/personal-entry-dialog-shell.tsx`

### F-2: TeamSoftwareLicenseFormにメール検証追加
- 対応: 個人版と同じ正規表現チェック + `emailError` state + エラー表示 + 入力時クリアを追加。
- 修正ファイル: `src/components/team/team-software-license-form.tsx`

### F-4: CreditCardFieldsの年リストモジュール定数化
- 対応: `EXPIRY_YEARS` をモジュールレベル定数として抽出。レンダリングごとの再計算を排除。
- 修正ファイル: `src/components/entry-fields/credit-card-fields.tsx`

### T-1: team login hooksテスト追加
- 対応: 8テストファイル / 63テスト追加。personal側と対称的なカバレッジを実現。
- 追加ファイル: `src/hooks/team-login-fields-{callbacks,props,text-props}.test.ts`, `src/hooks/team-login-form-{controller,derived,presenter}.test.ts`, `src/hooks/use-team-login-form-{model,state}.test.ts`

### T-2: use-personal-base-form-modelテスト追加
- 対応: 21テスト追加。variant分岐、defaultTags/defaultFolderIdフォールバック、submitEntry、state settersをカバー。
- 追加ファイル: `src/hooks/use-personal-base-form-model.test.ts`

### T-3: WatchtowerPage teamスコープテスト追加
- 対応: 5テスト追加。teamスコープでのTeamEditDialogLoader使用分岐をカバー。
- 修正ファイル: `src/components/watchtower/watchtower-page.test.tsx`

### T-4: useTeamBaseFormModelテスト拡充
- 対応: 11テスト追加（1→12テスト）。editData初期値、defaultフォールバック、entryCopyメモ化をカバー。
- 修正ファイル: `src/hooks/use-team-base-form-model.test.ts`
