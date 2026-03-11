# Chrome Web Store Listing — passwd-sso Extension

## Store Metadata

| Field | Value |
|-------|-------|
| Name | passwd-sso |
| Category | Productivity |
| Language | English, Japanese |
| Visibility | Unlisted |

## Short Description (132 chars max)

Autofill passwords from your self-hosted passwd-sso vault. End-to-end encrypted, open source.

## Detailed Description

passwd-sso is a companion browser extension for the passwd-sso password manager.

**Features:**
- Auto-detect login forms and autofill credentials
- Quick copy passwords and usernames via context menu or keyboard shortcuts
- Auto-lock vault after configurable timeout
- End-to-end encryption — your master passphrase never leaves your device
- Works exclusively with your self-hosted passwd-sso server

**Keyboard Shortcuts:**
- Ctrl+Shift+A (Cmd+Shift+A on Mac) — Open popup
- Ctrl+Shift+P (Cmd+Shift+P on Mac) — Copy password
- Ctrl+Shift+U (Cmd+Shift+U on Mac) — Copy username
- Ctrl+Shift+F (Cmd+Shift+F on Mac) — Trigger autofill

**Security:**
All vault data is encrypted client-side using AES-256-GCM. Key derivation uses PBKDF2 with 600,000 iterations. The extension communicates only with your self-hosted server instance over HTTPS.

**Open Source:**
This extension is fully open source. See the project repository for source code and contribution guidelines.

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
