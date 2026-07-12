# Chrome Web Store Listing — passwd-sso Extension

## Store Metadata

| Field | Value |
|-------|-------|
| Name | passwd-sso |
| Category | Productivity |
| Language | English, Japanese |
| Visibility | Unlisted |

## Short Description (132 chars max)

Stop typing passwords. Autofill from your self-hosted vault with one click — end-to-end encrypted.

## Detailed Description

Tired of copying and pasting passwords from your passwd-sso vault? This extension brings your vault directly into the browser — log in to any site with a single click.

**Why install this extension?**

🔑 **One-click login** — The extension detects login forms automatically and fills in your credentials. No more switching tabs to look up passwords.

📋 **Instant copy** — Right-click any page or press a shortcut to copy your password or username to the clipboard. Done in under a second.

🔍 **Search your entire vault** — The popup search box looks across every entry in your vault, not just the current site's matches, so you can find and copy any credential from anywhere.

🔒 **Zero-knowledge security** — Your master passphrase never leaves your device. All data is encrypted with AES-256-GCM before it ever touches the network. Even if someone intercepts the traffic, they see only ciphertext.

⏱️ **Auto-lock** — Walk away from your computer? The vault locks itself after a configurable timeout, so your credentials are never left exposed.

🔐 **Passkey autofill** — The extension intercepts WebAuthn requests and offers vault-stored passkeys automatically. Create new passkeys and save them to your vault — with a prompt to replace duplicates. Falls through to the platform authenticator seamlessly when no vault passkeys match.

🏠 **Your server, your data** — The extension connects only to your self-hosted passwd-sso instance. No third-party cloud, no data collection, no tracking.

**Keyboard Shortcuts:**
- Ctrl+Shift+X (Cmd+Shift+X on Mac) — Open popup
- Ctrl+Shift+F (Cmd+Shift+F on Mac) — Trigger autofill
- Copy password / Copy username / Lock vault — unbound by default; assign your own keys at chrome://extensions/shortcuts (edge://extensions/shortcuts on Edge)

**Getting Started:**
1. Install the extension
2. Open the options page and enter your passwd-sso server URL
3. Log in with your account and unlock the vault
4. Visit any login page — the extension handles the rest

This extension is fully open source: https://github.com/ngc-shj/passwd-sso

## Short Description — Japanese (132 chars max)

パスワードの手入力はもう不要。セルフホストの保管庫からワンクリックで自動入力 — エンドツーエンド暗号化対応。

## Detailed Description — Japanese

passwd-sso の保管庫からパスワードをコピー&ペーストする作業にうんざりしていませんか?この拡張機能は保管庫をブラウザに直接統合し、ワンクリックでどのサイトにもログインできるようにします。

**この拡張機能をインストールする理由**

🔑 **ワンクリックログイン** — ログインフォームを自動検出して認証情報を入力します。パスワードを調べるためにタブを切り替える必要はもうありません。

📋 **すばやくコピー** — 右クリックメニューまたはショートカットキーで、パスワードやユーザー名をクリップボードにコピー。1 秒もかかりません。

🔍 **保管庫全体を検索** — ポップアップの検索ボックスは、現在のサイトに一致する項目だけでなく保管庫内のすべての項目を横断検索。どこからでも目的の認証情報を見つけてコピーできます。

🔒 **ゼロ知識セキュリティ** — マスターパスフレーズがデバイスの外に出ることはありません。すべてのデータはネットワークに送信される前に AES-256-GCM で暗号化されます。通信を傍受されても、見えるのは暗号文だけです。

⏱️ **自動ロック** — 席を離れても大丈夫。設定した時間が経過すると保管庫は自動的にロックされ、認証情報が無防備なまま放置されることはありません。

🔐 **パスキー自動入力** — WebAuthn リクエストを検知し、保管庫に保存されたパスキーを自動的に提案します。新しいパスキーの作成と保管庫への保存にも対応(重複時は置き換えを確認)。一致するパスキーがない場合は、プラットフォーム認証器へシームレスに引き継ぎます。

🏠 **あなたのサーバー、あなたのデータ** — この拡張機能はセルフホストした passwd-sso インスタンスにのみ接続します。サードパーティのクラウドなし、データ収集なし、トラッキングなし。

**キーボード ショートカット:**
- Ctrl+Shift+X(Mac は Cmd+Shift+X)— ポップアップを開く
- Ctrl+Shift+F(Mac は Cmd+Shift+F)— 自動入力を実行
- パスワードをコピー / ユーザー名をコピー / 保管庫をロック — 初期状態では未割り当て。chrome://extensions/shortcuts(Edge は edge://extensions/shortcuts)で任意のキーを割り当てられます

**はじめかた:**
1. 拡張機能をインストール
2. オプションページを開き、passwd-sso サーバーの URL を入力
3. アカウントでログインし、保管庫のロックを解除
4. ログインページを開くだけ — あとは拡張機能にお任せください

この拡張機能は完全なオープンソースです: https://github.com/ngc-shj/passwd-sso

## Permission Justifications

| Permission | Single Purpose | Justification |
|------------|---------------|---------------|
| `storage` | Yes | Stores extension settings and encrypted session state locally. No user data is transmitted to third parties. |
| `alarms` | Yes | Schedules auto-lock of the vault after a user-configurable timeout period. No other use. |
| `activeTab` | Yes | Reads the URL of the current tab to match saved credentials for autofill. Only accessed when the user invokes autofill or opens the popup. |
| `scripting` | Yes | Injects autofill scripts into login forms on web pages when the user triggers autofill. No scripts are injected without user action. |
| `contextMenus` | Yes | Adds right-click menu options ("Copy Password", "Copy Username", "Autofill") for quick access to credentials. |
| `clipboardWrite` | Yes | Copies passwords and usernames to the clipboard when explicitly requested by the user via popup, context menu, or keyboard shortcut. |
| `offscreen` | Yes | Creates an offscreen document to perform clipboard write operations in Manifest V3, where direct clipboard access from the service worker is not available. |

## Optional Host Permissions

| Permission | Justification |
|------------|---------------|
| `https://*/*` | Required for content script injection to detect login forms and perform autofill on web pages. Granted on-demand by the user. |
| `http://localhost/*` | Enables autofill on local development servers. Only used in development environments. |

## Privacy Policy URL

`https://<your-domain>/en/privacy-policy`

## Screenshots

Prepare the following screenshots (1280×800 or 640×400):

1. **Popup — Vault unlocked**: Shows the credential list in the popup
2. **Autofill in action**: Login form with autofill suggestion
3. **Context menu**: Right-click menu with copy/autofill options
4. **Options page**: Extension settings page
