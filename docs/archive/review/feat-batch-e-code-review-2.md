# コードレビュー: feat/batch-e
日時: 2026-03-04T20:45:00+09:00
レビュー回数: 2回目

## 前回からの変更

### 修正済み (17件)
| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| F1 | High | postalCode 欠落 | IdentityAutofillPayload, autofill-identity-lib.ts, .js, background/index.ts に追加 |
| F2 | High | Zod import 不統一 | vault/reset/route.ts を "zod/v4" に変更 |
| F5 | Low | 「ボールト」→「保管庫」 | VaultReset.json 修正 |
| S1 | High | TLS 警告抑圧 | process.emit 削除、stderr 警告追加 |
| S2 | High | クリップボード exit クリア | execSync で pbcopy/xclip 同期クリア |
| S3 | Medium | TOCTOU in config | O_NOFOLLOW フラグ使用 |
| S4 | Medium | resetUrl スキーム検証 | https?:// チェック追加 |
| S5 | Medium | トークン正規表現 | クライアント側 {64} 制限 |
| S7 | Medium | OWNER/ADMIN コメント | 設計意図コメント追加 |
| S9 | Low | export stdout 警告 | output.warn 追加 |
| T2 | High | watchtower alert モック | resolveUserLocale 等モック追加 |
| T4 | Medium | token ハッシュ検証 | SHA-256 ハッシュで検証 |
| T5 | Medium | notification-messages テスト | 新規テストファイル作成 |
| T6 | Medium | vault-reset フィールド数 | キー数チェック追加 |
| T7 | Medium | email text 出力テスト | 生 adminName テスト追加 |
| T8-T13 | Low | 各種テスト改善 | エッジケース、アサーション強化 |

### 妥当な理由でスキップ (8件)
| # | 重要度 | 指摘 | スキップ理由 |
|---|--------|------|-------------|
| F3 | Medium | useSession | DB session 戦略のため fetchApi がプロジェクト標準 |
| F4 | Medium | tenant タブ表示制御 | 既存 SCIM タブと同構造。スコープ外 |
| S6 | Medium | FavoritedEntry 削除 | FavoritedEntry モデル不在。isFavorite は PasswordEntry の boolean |
| S8 | Low | モジュロバイアス | ~2.8e-7%。実用上リスクなし |
| S10 | Low | CVV メモリクリア | JS はメモリの確実な消去不可能 |
| T1 | High | CLI コマンドテスト | lib 層テスト済み。大スコープ |
| T3 | Medium | withUserTenantRls モック | 標準的 unit test パターン |
| T12 | Low | CC autofill select | jsdom 制約。E2E でカバー |

## 機能観点の指摘

### 指摘 F6 (Low): idNumber がペイロードに含まれるがオートフィルされない
- スキップ: ID書類フィールドは標準 autocomplete 属性がなく、検出ロジックなしは意図的設計。スコープ外

### 指摘 F7 (Low): CLI clipboard クリアの Windows 未対応
- スキップ: Windows 対応は将来の拡張。現状の動作（タイマーのみ）は既存と同等

## セキュリティ観点の指摘
指摘なし

## テスト観点の指摘

### 指摘 T14 (Medium): expiresAt assertion 欠如 → 修正済み
### 指摘 T15 (Low): 呼び出し順序検証 → 修正済み

### 指摘 T16 (Low): notification title の具体値テスト
- スキップ: スナップショット的テストはコピー変更で壊れやすい。非空チェックで十分
