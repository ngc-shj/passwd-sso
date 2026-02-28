# コードレビュー: export/import folder, favorite, expiry 対応
日時: 2026-03-01T01:10:00+09:00
レビュー回数: 2回目

## 対象コミット
- `0c2c4c2` fix: JSON import passwdSso spread overwriting type-specific fields
- `255f35d` feat: add folder, favorite, and expiry support to export/import
- (未コミット) review 対応 + CSV multiline notes 修正

## 前回からの変更

1回目の14件の指摘に対応:
- F-1: team import に requireReprompt/expiresAt/teamFolderId 追加
- F-2/F-3: team export のハードコード修正 + 型別フィールド19件追加
- S-2: MAX_IMPORT_FOLDERS = 200 追加
- T-1〜T-7: テスト追加（リグレッション、roundtrip、folder、cleanup 等）
- CSV multiline notes バグ修正: splitCsvRows 追加（RFC 4180 準拠）

## 機能観点の指摘

### 前回指摘

| ID | 重要度 | 状態 | 概要 |
|----|--------|------|------|
| F-1 | 高 | **解決済み** | Team import POST body の requireReprompt/expiresAt/teamFolderId |
| F-2 | 高 | **解決済み** | Team export の実データ取得 |
| F-3 | 中 | **解決済み** | Team export の型別フィールド19件 |

### 新規指摘

| ID | 重要度 | 状態 | 概要 |
|----|--------|------|------|
| F-4 | 中 | 新規 | `splitCsvRows` が `\r` 単独改行（Classic Mac 形式）に非対応 |
| F-5 | 低 | 新規 | `splitCsvRows` が空白のみの行を除外 |

**F-4**: `splitCsvRows` は `\r` をスキップし `\n` で行区切りとするが、`\r` 単独改行の場合（Classic Mac 形式）は全体が1行になる。現代のアプリケーション（Excel, Bitwarden, 1Password 等）は `\n` または `\r\n` を使用するため実害は極めて低い。

**F-5**: `current.trim()` で空白のみの行を除外する。パスワードマネージャ export で空白のみの行がデータとして出現することは実質的にない。

## セキュリティ観点の指摘

### 前回指摘

| ID | 重要度 | 状態 | 概要 |
|----|--------|------|------|
| S-1 | 低 | **解決済み** | parseCsvLine の無限ループリスク — 問題なし |
| S-2 | 低 | **解決済み** | フォルダ数上限 — MAX_IMPORT_FOLDERS = 200 で対応 |

### 新規指摘

| ID | 重要度 | 状態 | 概要 |
|----|--------|------|------|
| S-3 | 低 | 新規 | インポートエントリ数に上限がない |
| S-4 | 情報 | 新規 | team import で AAD の entryId がクライアント生成（確認事項） |
| S-5 | 情報 | 新規 | team import で isFavorite が送信されない（設計意図通り） |

**S-3**: 巨大 CSV を投入した場合にクライアント側メモリ圧迫の可能性。認証済みユーザーのみアクセス可能なためリスクは低い。

**S-4**: team import で `entryId` をクライアントが `crypto.randomUUID()` で生成し AAD に使用。サーバー側でクライアント送信の ID をそのまま使用する設計のため整合性に問題なし。

**S-5**: team import で `isFavorite` を送信していないが、`createTeamE2EPasswordSchema` に `isFavorite` フィールドがそもそも存在しない。チームのお気に入りはユーザーごとの個人設定として別エンドポイント（`/favorite`）で管理される設計のため、対応不要。

## テスト観点の指摘

### 前回指摘

| ID | 重要度 | 状態 | 概要 |
|----|--------|------|------|
| T-1 | 高 | **解決済み** | passwdSso 空デフォルト上書きリグレッション — 3テスト追加 |
| T-2 | 中 | **解決済み** | CSV roundtrip テスト — 追加 |
| T-3 | 中 | **解決済み** | favorite conflict テスト — 追加 |
| T-4 | 中 | **解決済み** | フォルダ GET 失敗時テスト — 追加 |
| T-5 | 中 | **解決済み** | 3階層フォルダテスト — 追加 |
| T-6 | 低 | **解決済み** | unstubAllGlobals 追加 |
| T-7 | 中 | **解決済み** | folderPath fallback テスト — item.folderPath テスト追加 |

### 新規指摘

**指摘なし** — 前回の全7件が適切に対応され、新規追加の splitCsvRows テスト6件と parseCsv multiline テスト2件も正しく機能している。全2735テストがパス。

## 対応判断

| ID | 判断 | 理由 |
|----|------|------|
| F-4 | 対応不要 | Classic Mac 形式は現代で実質使用されない |
| F-5 | 対応不要 | 空行スキップは意図的な動作 |
| S-3 | 対応不要 | 認証済みユーザーのみ。クライアント側処理のため低リスク |
| S-4 | 対応不要 | サーバー側でクライアント送信 ID を使用する設計 |
| S-5 | 対応不要 | チーム isFavorite は別エンドポイントで管理（設計意図通り） |
