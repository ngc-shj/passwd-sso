# Manual Test Plan: iOS i18n (en + ja)

Automated coverage (`LocalizationCatalogTests`) proves every catalog key has a ja
translation and that the host bundle compiled `ja`. SwiftUI rendering and on-device
language switching are not unit-testable — verify them here before release.

## Pre-conditions

- A device or simulator running iOS 17+.
- A reachable passwd-sso server. **Use a placeholder host of your own** (e.g.
  `https://vault.example.com`) — do NOT paste a real production hostname or a real
  account email into screenshots or this doc.
- Two passes: device language **日本語** and **English**.

## Steps & Expected result

| # | Screen | Action | Expected (ja device) | Expected (en device) |
|---|--------|--------|----------------------|----------------------|
| 1 | Server setup | Launch fresh | Title `passwd-sso` (unchanged), body「passwd-sso サーバーの URL を入力して開始します。」, button「続ける」, nav「サーバー設定」 | "Enter your passwd-sso server URL…", "Continue", "Server Setup" |
| 2 | Server setup error | Enter `ftp://x`, tap Continue | 「有効な https:// URL を入力してください…」 | "Enter a valid https:// URL…" |
| 3 | Sign in | — |「passwd-sso にサインイン」, signing →「サインインしています…」 | "Sign in to passwd-sso", "Signing in…" |
| 4 | Unlock | — | 「マスターパスフレーズを入力して保管庫のロックを解除します。」, field「マスターパスフレーズ」, button「ロック解除」 | "…unlock the vault.", "Master passphrase", "Unlock" |
| 5 | Unlock (biometric) | Face ID device |「Face ID でロック解除」(Face ID kept as product name) | "Unlock with Face ID" |
| 6 | Unlock error | Wrong passphrase |「パスフレーズが正しくありません。もう一度お試しください。」 | "Incorrect passphrase…" |
| 7 | Vault list | Unlock | nav `passwd-sso` (unchanged); empty →「エントリがありません」; search empty →「一致する項目がありません」; bottom search field, ⋯ menu「設定」「ロック」 | "No entries", "No matches", "Settings", "Lock" |
| 8 | Entry detail | Open entry | sections「ユーザー名」「パスワード」「URL」「メモ」「ワンタイムコード」; empty rows「未設定」; "Edit"→「編集」; TOTP「コピー」/tapped「コピーしました！」 | "Username"/"Password"/…, "Not set", "Edit", "Copy"/"Copied!" |
| 9 | Entry edit | New / Edit | nav「新規エントリ」/「エントリを編集」; footnote in ja; toolbar「キャンセル」「保存」 | "New Entry"/"Edit Entry", "Cancel"/"Save" |
| 10 | Settings | Open | nav「設定」; sections「セキュリティ」「クリップボード」「外観」; pickers「自動ロック」「タイムアウト時」「自動消去」「テーマ」; "Done"→「完了」; theme options「システム」「ライト」「ダーク」 | "Settings", "Security", … |
| 11 | **Plurals** | Auto-Lock picker | options「5 分」「15 分」…; Clipboard「30 秒」… | "5 minutes" / "1 minute", "30 seconds" |
| 12 | Settings footer | — | 保管庫/Face ID footer renders fully in ja (single paragraph, no `+` artifact) | English footer |
| 13 | AutoFill picker | Trigger fill on a site with no match | nav `passwd-sso`; 「このサイトのパスワードはありません」「すべてのエントリを表示するには検索してください。」; search prompt「すべてのエントリを検索」; cancel「キャンセル」 | "No passwords for this site", … |
| 14 | AutoFill app-side | Trigger fill from a native app | 「アプリに入力しますか？」, bold-rendered 「アプリに **<username>** を入力:\n<bundleID>」, 「入力」, nav「入力の確認」 | "Fill for app?", "Fill **<username>** for app:…", "Fill", "Confirm Fill" |
| 15 | One-time-code picker | Trigger TOTP fill, no match |「このサイトのワンタイムコードはありません」 | "No one-time codes for this site" |
| 16 | Locked fallback | Trigger AutoFill with vault locked |「保管庫はロックされています」, body in ja, 「OK」/「キャンセル」 | "Vault is Locked", "OK"/"Cancel" |

## Do-NOT-translate checks (both passes)

- Brand `passwd-sso` stays literal everywhere (titles, body inline).
- Apple product names `Face ID` / `Touch ID` stay literal (Apple localizes the system prompt itself).
- Example URLs (`https://my.passwd-sso.example`, `https://example.com`) stay literal.
- `error.localizedDescription` passthroughs (save error, server-probe error) render in the device language via the system, with only the wrapping text localized.

## Rollback

Revert the branch; no migration, schema, or persisted-state change is involved.
Removing the two `Localizable.xcstrings` files and the `String(localized:)` /
`LocalizedStringKey` edits restores the all-English build.
