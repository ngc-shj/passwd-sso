# passwd-sso vs 1Password / Bitwarden 機能比較

## 凡例

| 記号 | 意味 |
|---|---|
| Done | passwd-sso 実装済み |
| --- | 未実装 |
| 1P | 1Password にある |
| BW | Bitwarden にある |
| Both | 両方にある |

---

## 1. 認証 & SSO

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| マスターパスワード (パスフレーズ) | Done | Both | Both | PBKDF2 600k iterations |
| Google OAuth 2.0 | Done | --- | --- | Workspace ドメイン制限対応 |
| SAML 2.0 SSO | Done | Both | Both | BoxyHQ SAML Jackson 経由 |
| データベースセッション | Done | --- | --- | 8時間 + 1時間延長 |
| Secret Key (追加セキュリティ要素) | Done | 1P | --- | account salt + secret key |
| パスキー / WebAuthn | --- | Both | Both | |
| 生体認証 (指紋/顔) | --- | Both | Both | ネイティブアプリ依存 |
| MFA / 2FA (ログイン時) | --- | Both | Both | |

## 2. Vault & 暗号化

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| AES-256-GCM E2E 暗号化 | Done | Both | Both | |
| PBKDF2 + HKDF 鍵導出 | Done | Both | Both | |
| Vault ロック/アンロック | Done | Both | Both | |
| セッションタイムアウト | Done | Both | Both | 8時間 |
| 自動ロック (アイドル時) | Done | Both | Both | 15分無操作 / 5分タブ非表示 |
| 鍵ローテーション | --- (準備済) | 1P | --- | keyVersion フィールド有 |
| 複数 Vault | --- | 1P | BW | |
| Travel Mode | --- | 1P | --- | |

## 3. パスワードエントリー

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| タイトル / ユーザー名 / パスワード | Done | Both | Both | |
| URL | Done | Both | Both | |
| メモ | Done | Both | Both | |
| タグ | Done | Both | Both | 色付き |
| カスタムフィールド (text/hidden/url) | Done | Both | Both | |
| パスワード履歴 (max 10) | Done | Both | Both | 1P: 無制限, BW: 5 |
| お気に入り | Done | Both | Both | |
| アーカイブ | Done | Both | Both | |
| ファビコン (サイトアイコン) | Done | Both | Both | Google Favicon API |
| セキュアノート (独立アイテム) | Done | Both | Both | EntryType enum |
| クレジットカード | Done | Both | Both | Luhn チェック + ブランド検証 |
| ID / 個人情報 | Done | Both | Both | パスポート/免許証等 |
| SSH 鍵 | --- | 1P | --- | |
| TOTP / 2FA コード保存 | Done | Both | Both | otpauth パッケージ |
| ファイル添付 | --- | Both | Both | |
| Boolean カスタムフィールド | --- | --- | BW | |

## 4. パスワード生成

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| ランダムパスワード | Done | Both | Both | 8-128 文字 |
| パスフレーズ (diceware) | Done | Both | Both | 3-10 単語 |
| 文字種選択 (大小英数記号) | Done | Both | Both | 6 記号グループ |
| 曖昧文字除外 (0O, Il1) | Done | Both | Both | |
| カスタム区切り文字 | Done | Both | Both | |
| 生成履歴 | Done | Both | BW | 直近 10 件 |
| 設定保存 (エントリー単位) | Done | 1P | --- | |
| ユーザー名生成 | --- | Both | Both | |

## 5. セキュリティ監査 (Watchtower)

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| 漏洩パスワード検出 (HIBP) | Done | Both | Both | k-Anonymity |
| 弱いパスワード検出 | Done | Both | Both | エントロピー計算 |
| 再利用パスワード検出 | Done | Both | Both | SHA-256 比較 |
| 古いパスワード検出 | Done | 1P | --- | 90/180 日 |
| HTTP URL 検出 | Done | 1P | --- | |
| セキュリティスコア (0-100) | Done | 1P | --- | 重み付き |
| 2FA 未設定の警告 | --- | 1P | --- | |
| フィッシング防止 | --- | 1P | --- | |

## 6. 整理 & ナビゲーション

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| タグ (色付き) | Done | Both | Both | |
| お気に入り | Done | Both | Both | |
| アーカイブ | Done | Both | Both | |
| ゴミ箱 (ソフトデリート) | Done | Both | Both | 30 日自動削除 |
| ゴミ箱復元 | Done | Both | Both | |
| 検索 (タイトル/ユーザー/URL) | Done | Both | Both | クライアントサイド |
| ソート (更新日/作成日/タイトル) | Done | Both | Both | |
| サイドバー (タグ数表示) | Done | Both | Both | |
| カテゴリフィルタ (タイプ別) | Done | Both | Both | LOGIN/NOTE/CARD/ID |
| フォルダ / ネスト構造 | --- | --- | BW | 1P はフォルダなし |
| コレクション (共有グループ) | --- | --- | BW | |

## 7. 共有 & 組織

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| 期限付きリンク共有 | Done | 1P | --- | アクセスログ + rate-limit |
| 組織 / チーム Vault | Done | Both | Both | サーバーサイド暗号化 (AES-256-GCM) |
| ロールベースアクセス制御 | Done | Both | Both | OWNER/ADMIN/MEMBER/VIEWER |
| ゲストアカウント | --- | 1P | --- | |
| Emergency Access | --- | 1P | --- | |
| Bitwarden Send (暗号化共有) | --- | --- | BW | |

## 8. インポート/エクスポート

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| CSV エクスポート | Done | Both | Both | Bitwarden 互換 |
| JSON エクスポート | Done | Both | Both | |
| Bitwarden CSV インポート | Done | --- | Both | |
| 1Password CSV インポート | Done | 1P | --- | |
| Chrome CSV インポート | Done | Both | Both | |
| パスワード保護エクスポート | Done | --- | BW | AES-256-GCM + PBKDF2 600k, 組織含むオプション |

## 9. UI / UX

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| 多言語 (EN/JA) | Done | Both | Both | BW: 50+ 言語 |
| レスポンシブ (モバイル対応) | Done | Both | Both | |
| ダークモード | Done | Both | Both | next-themes |
| アコーディオン詳細展開 | Done | 1P | --- | リスト内インライン |
| ダイアログ編集/新規作成 | Done | Both | Both | |
| ドロップダウンアクション (⋮) | Done | Both | Both | |
| パスワード自動非表示 (30秒) | Done | Both | Both | |
| クリップボード自動クリア (30秒) | Done | Both | Both | |
| トースト通知 | Done | Both | Both | Sonner |
| キーボードショートカット | Done | Both | Both | ⌘K, n, /, ?, Esc |
| ブラウザ拡張 | --- | Both | Both | ネイティブ機能 |
| デスクトップアプリ | --- | Both | Both | ネイティブ機能 |

## 10. インフラ

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| セルフホスト (Docker) | Done | --- | BW | |
| PostgreSQL | Done | --- | --- | |
| Prisma ORM | Done | --- | --- | |
| Next.js (SSR/RSC) | Done | --- | --- | |
| API (REST) | Done | Both | Both | |
| 監査ログ / イベントログ | Done | Both | Both | Personal + Org スコープ, cursor pagination |
| Webhook | --- | --- | BW | |
| SCIM プロビジョニング | --- | Both | Both | |

---

## 優先度別 未実装機能リスト

### Tier 1: 高優先度 (セキュリティ & コア UX)

| # | 機能 | 理由 |
|---|---|---|
| ~~1-1~~ | ~~Vault 自動ロック (アイドルタイムアウト)~~ | ~~実装済み (15分/5分)~~ |
| ~~1-2~~ | ~~MFA / 2FA (ログイン時 TOTP)~~ | ~~IdP 側の MFA に委任。SSO + マスターパスフレーズで十分~~ |
| ~~1-3~~ | ~~TOTP コード保存 & 生成~~ | ~~実装済み (otpauth パッケージ)~~ |
| ~~1-4~~ | ~~ファビコン表示~~ | ~~実装済み (Google Favicon API)~~ |
| ~~1-5~~ | ~~キーボードショートカット~~ | ~~実装済み (⌘K, ⌘N, /, ?, Esc)~~ |

### Tier 2: 中優先度 (機能拡充)

| # | 機能 | 理由 |
|---|---|---|
| ~~2-1~~ | ~~セキュアノート (独立アイテムタイプ)~~ | ~~実装済み (EntryType enum, Personal + Org)~~ |
| ~~2-2~~ | ~~クレジットカード保存~~ | ~~実装済み (Luhn + ブランド検証, Personal + Org)~~ |
| ~~2-3~~ | ~~ID / 個人情報保存~~ | ~~実装済み (パスポート/免許証等, Personal + Org)~~ |
| 2-4 | ファイル添付 | パスワードに関連書類を添付 |
| ~~2-5~~ | ~~フォルダ / ネスト構造~~ | ~~不要と判断。カテゴリフィルタ (タイプ別) で代替~~ |
| ~~2-6~~ | ~~パスワード保護エクスポート~~ | ~~実装済み (AES-256-GCM + PBKDF2 600k, インポート時自動検出・復号)~~ |

### Tier 3: 低優先度 (エンタープライズ & 高度な機能)

| # | 機能 | 理由 |
|---|---|---|
| ~~3-1~~ | ~~組織 / チーム Vault~~ | ~~実装済み (サーバーサイド AES-256-GCM)~~ |
| ~~3-2~~ | ~~ロールベースアクセス制御~~ | ~~実装済み (OWNER/ADMIN/MEMBER/VIEWER)~~ |
| ~~3-3~~ | ~~期限付きリンク共有~~ | ~~実装済み (アクセスログ, rate-limit, 管理ページ)~~ |
| ~~3-4~~ | ~~監査ログ / イベントログ~~ | ~~実装済み (Personal + Org, ADMIN/OWNER 閲覧, cursor pagination)~~ |
| 3-5 | Webhook / API 連携 | 自動化・外部システム連携 |
| 3-6 | SCIM プロビジョニング | エンタープライズ IdP 連携 |
| 3-7 | パスキー / WebAuthn | 次世代認証 |
| 3-8 | Emergency Access | 緊急時のアカウントアクセス |

---

*最終更新: 2026-02-09*
