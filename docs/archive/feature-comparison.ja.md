# 主要アプリとの機能比較

このドキュメントは **passwd-sso** を中心に、主要パスワードマネージャー（1Password / Bitwarden）との
**高レベルな機能比較**をまとめたものです。競合情報はプランや提供形態で差が出るため、詳細は各公式ドキュメントで確認してください。

## 凡例

| 記号 | 意味 |
|---|---|
| Done | passwd-sso 実装済み |
| --- | 未実装 |
| Yes | 対応あり |
| No | 非対応 |
| Varies | プラン/構成で差あり |

## 1. 認証 & SSO

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| マスターパスワード / パスフレーズ | Done | Yes | Yes | |
| Google OAuth 2.0 | Done | No | No | Workspace ドメイン制限可 |
| SAML 2.0 SSO | Done | Yes | Yes | BoxyHQ SAML Jackson 経由 |
| パスキー / WebAuthn | --- | Yes | Yes | |
| MFA / 2FA (ログイン時) | --- | Yes | Yes | |

## 2. Vault & 暗号化

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| E2E 暗号化 | Done | Yes | Yes | 個人 Vault は E2E |
| サーバーサイド暗号化 (組織) | Done | Yes | Yes | 共有用途 |
| 自動ロック | Done | Yes | Yes | 15分無操作 / 5分タブ非表示 |
| 鍵ローテーション | --- (準備済) | Yes | No | |
| 複数 Vault | --- | Yes | Yes | |
| Travel Mode | --- | Yes | No | |

## 3. エントリー & 添付

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| パスワード / ノート / カード / ID | Done | Yes | Yes | |
| TOTP 保存 | Done | Yes | Yes | |
| ファイル添付 | Done | Yes | Yes | |
| SSH 鍵 | --- | Yes | No | |
| Boolean カスタムフィールド | --- | No | Yes | |

## 4. 共有 & 組織

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| 期限付きリンク共有 | Done | Yes | No | アクセスログ + rate-limit |
| 組織 / チーム Vault | Done | Yes | Yes | RBAC |
| Emergency Access | Done | Yes | No | |

## 5. 監査 / 監視

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| 監査ログ (Personal + Org) | Done | Yes | Yes | |
| 漏洩/弱い/再利用チェック | Done | Yes | Yes | |

## 6. インポート / エクスポート

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| CSV / JSON エクスポート | Done | Yes | Yes | |
| パスワード保護エクスポート | Done | No | Yes | AES-256-GCM + PBKDF2 |
| 主要 CSV インポート | Done | Yes | Yes | BW/1P/Chrome |

## 7. クライアント対応

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| Web UI | Done | Yes | Yes | |
| ブラウザ拡張 | Done | Yes | Yes | Chrome MV3 |
| デスクトップアプリ | --- | Yes | Yes | |
| モバイルアプリ | --- | Yes | Yes | |

## 8. 運用 / セルフホスト

| 機能 | passwd-sso | 1Password | Bitwarden | 備考 |
|---|---|---|---|---|
| セルフホスト | Done | No | Yes | Docker/Terraform |
| API / 連携 | Done | Varies | Yes | Webhook/SCIM は未実装 |

---

*最終更新: 2026-02-14*
