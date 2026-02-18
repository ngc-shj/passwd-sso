# 評価結果: feat-reprompt

対象: `main...HEAD` (`15aaedb`)
作成日: 2026-02-18
評価者: Claude Opus 4.6

---

## 機能

評価: **要修正あり（1件）**

### F-1 [Medium] TOTP コピーが reprompt ガード未適用

- **ファイル**: `src/components/passwords/totp-field.tsx:123`
- **内容**: `TOTPCodeDisplay` 内の `<CopyButton getValue={() => code} />` にreprompt ガードが適用されていない
- **計画との乖離**: 実装計画 §6 で「TOTP コピー: reprompt チェック後にコピー」と明記
- **影響**: `requireReprompt=true` のエントリでも TOTP コードはパスフレーズ再確認なしにコピー可能
- **修正方針**: `TOTPFieldDisplayProps` に `wrapCopyGetter` prop を追加。`PasswordDetail` から `createGuardedGetter` をバインドして渡す

### F-2 [Low] パスワード履歴の表示・コピーが reprompt ガード未適用

- **ファイル**: `src/components/passwords/password-detail.tsx:418-433`
- **内容**: パスワード履歴の Eye ボタンと CopyButton に reprompt ガードなし
- **計画との乖離**: 計画 §6 で明示的にリストされていないが、旧パスワードも機密データ
- **影響**: 過去パスワードがガードなしで表示・コピー可能
- **修正方針**: 履歴の reveal / copy にも `requireVerification` / `createGuardedGetter` を適用

---

## セキュリティ

評価: **要修正あり（1件）**

### S-1 [Medium] `changePassphrase` 後に `wrappedKeyRef` が未更新 → reprompt 検証が常に失敗

- **ファイル**: `src/lib/vault-context.tsx:547-548`
- **内容**: `changePassphrase` 成功後、`accountSaltRef` は新 salt に更新されるが `wrappedKeyRef` は旧値のまま
- **影響**:
  1. `verifyPassphrase(newPassphrase)` → 新 salt で wrapping key 導出 → 旧 wrapped key で復号 → **常に失敗**
  2. `verifyPassphrase(oldPassphrase)` → 旧 passphrase + 新 salt → 不正な wrapping key → **常に失敗**
  3. パスフレーズ変更後、vault を再ロック→再アンロックするまで reprompt 検証が一切通らない
- **再現手順**: パスフレーズ変更 → reprompt 有効エントリのパスワード表示を試行 → 正しいパスフレーズでも検証失敗
- **修正方針**: `changePassphrase` の step 6 で `wrappedKeyRef.current` を `rewrapped` の値で更新

### S-2 [Info] サーバー側強制は設計上の後続課題

- 現状はクライアント側 UX ガードのみ。API レベルの強制（GET blob, export 時の challenge）は後続 issue で対応予定
- 現在の実装範囲では問題なし

---

## テスト

評価: **テスト追加推奨（1件）**

### T-1 [Low] `changePassphrase` 後の `verifyPassphrase` 動作テストが未存在

- S-1 の修正に伴い、`changePassphrase` 後に `verifyPassphrase(newPassphrase)` が `true` を返すことを検証するテストを追加すべき
- 既存の vault-context テストに追加可能

---

## 総評

| カテゴリ | 判定 | 修正件数 |
|---------|------|---------|
| 機能 | 要修正 | F-1 (Medium), F-2 (Low) |
| セキュリティ | 要修正 | S-1 (Medium) |
| テスト | 追加推奨 | T-1 (Low) |

全体として実装計画に沿った構成だが、3点の修正が必要。特に **S-1** (changePassphrase後のwrappedKeyRef未更新) と **F-1** (TOTPコピーのガード漏れ) は Medium で修正必須。

## 前回評価からの変更

- 判定: **初回評価** (前回比較対象なし)
