# Batch D グループ A: ブラウザ拡張強化 (X-3, X-4, X-5)

## Context

passwd-sso の Chrome 拡張機能にはフォーム検出・自動入力・TOTP 自動入力が実装済みだが、競合と比べて以下が不足:

- **X-5**: ログインフォーム送信後に「このログインを保存しますか？」を表示しない
- **X-3**: 右クリックメニューからの自動入力がない
- **X-4**: キーボードショートカットが `Ctrl+Shift+F`（自動入力トリガー）のみ

## 実装順序

**X-4 → X-3 → X-5** (難易度の低い順、X-5 が最大)

---

## Feature 1: X-4 キーボードショートカット拡張

### X-4 変更ファイル

1. **`extension/src/lib/constants.ts`** — 新コマンド定数追加

   ```text
   CMD_COPY_PASSWORD = "copy-password"
   CMD_COPY_USERNAME = "copy-username"
   CMD_LOCK_VAULT = "lock-vault"
   ```

2. **`extension/manifest.config.ts`** — commands セクションに追加
   - `copy-password`: Ctrl+Shift+C / Cmd+Shift+C
   - `copy-username`: Ctrl+Shift+U / Cmd+Shift+U (**注意**: Linux では Chrome の「ページのソースを表示」と競合する可能性あり。ユーザーは chrome://extensions/shortcuts でカスタマイズ可能)
   - `lock-vault`: suggested_key なし、description のみ (ユーザーが chrome://extensions/shortcuts で設定)
   - **注意**: Chrome は `_execute_action` を除き最大 4 つの suggested_key コマンドまで。既存 `trigger-autofill` (1) + 新規 `copy-password` (2) + `copy-username` (3) = 3/4 使用。`lock-vault` は suggested_key なしで定義

3. **`extension/src/background/index.ts`** — `chrome.commands.onCommand` リスナー拡張
   - `copy-password`: (1) アクティブタブの URL → `getCachedEntries()` → ホスト一致の最初のエントリの `id` を特定、(2) `swFetch(extApiPath.passwordById(id))` で fullBlob を取得 → 復号して password を取得、(3) `chrome.scripting.executeScript` でクリップボードにコピー → 通知「コピーしました」。既存の `COPY_PASSWORD` メッセージハンドラ (background/index.ts L930-993) と同パターン
   - `copy-username`: 同様に fullBlob から username を取得してコピー
   - `lock-vault`: `clearVault()` 呼び出し
   - **複数マッチ時**: 最初のマッチを使用 (ショートカットは即座に動作すべき)
   - **クリップボード方式**: Service Worker は `navigator.clipboard` にアクセスできないため、`chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: (text) => navigator.clipboard.writeText(text), args: [value] })` で委譲する。`world: "ISOLATED"` を明示してページ側の monkey-patch の影響を防ぐ
   - **クリップボード自動クリア**: 二重構成で確実にクリアする。(1) `setTimeout(() => { /* executeScript で空文字をコピー */ }, 30_000)` — 30秒後にクリア (SW 停止時は消失)。(2) `chrome.alarms.create("clear-clipboard", { delayInMinutes: 1 })` — 1分後のフォールバック (alarms の最小遅延は1分)。アラームハンドラではコピー時刻を確認し、30秒以上経過していればクリアする

4. **`extension/src/messages/en.json`** + **`ja.json`** — i18n キー追加

   ```json
   "commands.copyPassword": "Copy password",
   "commands.copyUsername": "Copy username",
   "commands.lockVault": "Lock vault",
   "commands.copied": "Copied to clipboard",
   "commands.noMatch": "No matching entry for this site",
   "commands.clipboardCleared": "Clipboard cleared"
   ```

### X-4 テスト

- `extension/src/__tests__/background-commands.test.ts` (新規)
- コマンドハンドラのユニットテスト (モック chrome.commands, chrome.tabs, chrome.scripting)
- クリップボードコピー: `chrome.scripting.executeScript` の呼び出し引数 (`world: "ISOLATED"` 含む) を検証

---

## Feature 2: X-3 コンテキストメニュー

### X-3 変更ファイル

1. **`extension/manifest.config.ts`** — permissions に `"contextMenus"` 追加

2. **`extension/src/background/context-menu.ts`** (新規) — コンテキストメニュー管理
   - `setupContextMenu()`: `chrome.runtime.onInstalled` **および `chrome.runtime.onStartup`** で親メニュー作成 (SW 再起動時にもメニューを再構築)

     ```text
     "psso-parent" → "passwd-sso" (contexts: ["editable"])
       ├── "psso-login-{id}" → "{title} ({username})" (動的)
       ├── separator
       └── "psso-open-popup" → "Open passwd-sso"
     ```

   - `updateContextMenuForTab(tabId, url)`: タブ変更時にメニュー項目を更新
     - URL からホスト抽出 → getCachedEntries() → マッチするエントリでメニュー再構築
     - 最大 5 件表示 (Chrome メニュー項目の実用的な上限)
     - Vault ロック時: "Vault is locked" (disabled)
     - 未ログイン時: メニュー非表示
   - `chrome.contextMenus.onClicked` → entryId 抽出 → `performAutofillForEntry()`

3. **`extension/src/background/index.ts`** — 統合
   - `import { setupContextMenu, updateContextMenuForTab } from "./context-menu"`
   - `chrome.tabs.onActivated` + `chrome.tabs.onUpdated` でメニュー更新
     - **`onUpdated` フィルタリング**: `changeInfo.status === "complete"` の場合のみ更新 (過度な呼び出しを防止)
   - Vault unlock/lock 時にもメニュー更新

4. **`extension/src/messages/en.json`** + **`ja.json`** — i18n キー追加

   ```json
   "contextMenu.title": "passwd-sso",
   "contextMenu.vaultLocked": "Vault is locked",
   "contextMenu.noMatches": "No matches",
   "contextMenu.openPopup": "Open passwd-sso"
   ```

### X-3 テスト

- `extension/src/__tests__/context-menu.test.ts` (新規)
- モック chrome.contextMenus API

---

## Feature 3: X-5 新規ログイン自動検出・保存

### 概要

フォーム送信を検出 → 認証情報キャプチャ → 既存エントリと比較 → 保存/更新プロンプト表示

### X-5 変更ファイル

1. **`extension/src/types/messages.ts`** — メッセージ型追加

   ```typescript
   // Content → Background
   | { type: "LOGIN_DETECTED"; url: string; username: string; password: string }
   | { type: "SAVE_LOGIN"; url: string; title: string; username: string; password: string }
   | { type: "UPDATE_LOGIN"; entryId: string; password: string }
   | { type: "DISMISS_SAVE_PROMPT" }

   // Background → Content (response)
   | { type: "LOGIN_DETECTED"; action: "save" | "update" | "none"; existingEntryId?: string; existingTitle?: string }
   | { type: "SAVE_LOGIN"; ok: boolean; error?: string }
   | { type: "UPDATE_LOGIN"; ok: boolean; error?: string }
   | { type: "DISMISS_SAVE_PROMPT"; ok: true }
   ```

2. **`extension/src/lib/crypto.ts`** — `encryptData()` 関数追加 (保存時に必要)

   ```typescript
   export async function encryptData(
     plaintext: string,
     key: CryptoKey,
     aad?: Uint8Array
   ): Promise<EncryptedData>
   ```

3. **`extension/src/content/login-detector-lib.ts`** (新規) — ログイン検出ロジック
   - `form-detector-lib.ts` (既に 586 行) の肥大化を避けるため、独立モジュールとして分離
   - `form-detector.ts` (エントリポイント) から `initFormDetector()` と `initLoginDetector()` を両方呼ぶ構成
   - `initLoginDetector()` をエクスポート (テスト可能)

4. **`extension/src/content/form-detector.ts`** — エントリポイント更新

   ```typescript
   import { initFormDetector } from "./form-detector-lib";
   import { initLoginDetector } from "./login-detector-lib";

   initFormDetector();
   initLoginDetector();
   ```

5. **`extension/src/content/login-detector-lib.ts`** — ログイン検出の詳細
   - **フォーム送信検出**: submit イベントの capture phase でキャプチャ

     ```typescript
     // form submit イベント (capture phase) — ナビゲーション前に発火
     document.addEventListener("submit", submitHandler, true);
     ```

   - **extractCredentials(form)**: フォーム内の password + username input を探す
     - 既存の `findPasswordInputs()` + `findUsernameInput()` を再利用 (form-detector-lib.ts からエクスポート)
     - パスワードが空なら null を返す
   - **偽陽性の除外ヒューリスティック**:
     - パスワードフィールドが 2 つ以上 → パスワード変更フォーム → スキップ
     - `autocomplete="new-password"` → 登録フォーム → スキップ
     - フォーム内に `name`, `email`, `phone` 等の追加フィールドが 3 つ以上 → 登録フォームの可能性 → スキップ
     - `action` URL がリセット系 (`/reset`, `/forgot`, `/register`, `/signup`) → スキップ
   - **SPA 対応 (fetch/XHR インターセプト)** — Phase 2 で検討。初回は form submit のみで MVP
   - **既知の制限 (MVP)**: JavaScript による `form.submit()` 直接呼び出しは submit イベントが発火しないため検出不可

6. **`extension/src/content/ui/save-banner.ts`** (新規) — 保存プロンプト UI
   - 既存の `shadow-host.ts` を使用して Shadow DOM 内にバナー表示
   - UI: ページ上部に固定バナー

     ```text
     ┌─────────────────────────────────────────┐
     │ Save login for example.com?             │
     │    user@example.com                      │
     │    [Save]  [Update "Example"]  [Dismiss] │
     └─────────────────────────────────────────┘
     ```

   - "Save" → `SAVE_LOGIN` メッセージ送信
   - "Update" → `UPDATE_LOGIN` メッセージ送信 (既存エントリの password 更新)
   - "Dismiss" → バナー非表示 + `DISMISS_SAVE_PROMPT` 送信
   - 自動非表示: 15 秒後
   - スタイル: 既存の `styles.ts` パターンに準拠 (ダーク背景、白文字)

7. **`extension/src/background/login-save.ts`** (新規) — ログイン保存ハンドラ (background.ts の肥大化防止のため分離)
   - `handleLoginDetected(msg, state)`:
     1. Vault ロック中なら `action: "none"` を返す (将来的にキュー対応)
     2. `getCachedEntries()` → ホスト + ユーザー名が一致するエントリを検索 (複数マッチ時は最初のマッチを使用)
     3. 一致あり → password を復号して比較
        - 同一パスワード → `action: "none"` (保存不要)
        - 異なるパスワード → `action: "update"` + `existingEntryId` + `existingTitle`
     4. 一致なし → `action: "save"`
   - `handleSaveLogin(msg, state)`:
     1. `crypto.randomUUID()` で entryId 生成
     2. `buildPersonalEntryAAD(currentUserId, entryId)` で AAD 構築
     3. fullBlob (username/password/url 等) + overviewBlob (title/username/urlHost) を JSON 化 → `encryptData()` で暗号化
     4. `swFetch(PASSWORDS, { method: "POST", body: JSON.stringify({ id, encryptedBlob, encryptedOverview, aadVersion: 1, keyVersion: 1, entryType: "LOGIN" }) })`
     5. キャッシュ無効化
   - `handleUpdateLogin(msg, state)`:
     1. 既存エントリ取得 → fullBlob 復号 → password 更新 → 再暗号化
     2. **overviewBlob も再暗号化** (復号→再暗号化して整合性を保つ)
     3. PUT `/api/passwords/{id}`
     4. キャッシュ無効化

8. **`extension/src/background/index.ts`** — login-save.ts からの import と `handleMessage` への統合

9. **`extension/src/lib/api-paths.ts`** — POST パス追加 (既存の PASSWORDS パスで OK)

10. **`extension/src/messages/en.json`** + **`ja.json`** — i18n キー追加

    ```json
    "saveBanner.saveLogin": "Save login for {host}?",
    "saveBanner.updateLogin": "Update password for \"{title}\"?",
    "saveBanner.save": "Save",
    "saveBanner.update": "Update",
    "saveBanner.dismiss": "Dismiss",
    "saveBanner.saved": "Login saved",
    "saveBanner.updated": "Password updated",
    "saveBanner.failed": "Failed to save"
    ```

### サーバー側の変更 (必須)

現在 POST `/api/passwords` は `auth()` (セッション認証のみ) を使用しており、拡張トークンでは書き込み不可。
拡張トークンに `passwords:write` スコープを追加する必要がある。

1. **`src/lib/constants/extension-token.ts`** — スコープ追加

   ```typescript
   PASSWORDS_WRITE: "passwords:write"
   ```

   - `EXTENSION_TOKEN_SCOPE_VALUES` に追加
   - **`EXTENSION_TOKEN_DEFAULT_SCOPES` には追加しない** (権限昇格リスク防止: ユーザーがトークン発行時に明示的にオプトインする)

2. **`src/app/api/passwords/route.ts`** — POST ハンドラ変更
   - `auth()` → `authOrToken(req, EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE)` に変更
   - UUID バリデーションは既存の `createE2EPasswordSchema` (`src/lib/validations.ts` L44) で `z.string().uuid().optional()` として実装済み。追加作業不要

3. **`src/app/api/passwords/[id]/route.ts`** — PUT ハンドラ変更
   - `auth()` → `authOrToken(req, EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE)` に変更
   - **userId 所有権チェック**: `authOrToken()` の結果から `userId` を取得し、既存の `where: { id, userId }` パターンで所有権を検証 (セッション認証時と同じロジック)

4. **拡張側のトークン発行 UI** — `passwords:write` スコープをオプトインで選択可能にする
   - トークン発行時のスコープ選択に `passwords:write` を追加
   - デフォルトではオフ、ユーザーが明示的に有効化する
   - **スコープ依存関係**: `passwords:write` を選択した場合、`passwords:read` も必須 (UPDATE_LOGIN では GET + PUT の両方が必要)。UI で `passwords:write` を ON にすると `passwords:read` が自動で ON になる (無効化不可)

### encryptData の実装

`crypto.ts` に追加。`decryptData` の逆操作:

```typescript
export async function encryptData(
  plaintext: string, key: CryptoKey, aad?: Uint8Array
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const params: AesGcmParams = { name: "AES-GCM", iv };
  if (aad) params.additionalData = aad;
  const encrypted = await crypto.subtle.encrypt(
    params, key, textEncode(plaintext)
  );
  // GCM appends 16-byte auth tag
  const encBytes = new Uint8Array(encrypted);
  const ciphertext = encBytes.slice(0, encBytes.length - 16);
  const authTag = encBytes.slice(encBytes.length - 16);
  return {
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}
```

### swFetch の拡張

現在の `swFetch` (background/index.ts L370-391) は GET のみ。**既存の `getSettings()` / `chrome.permissions.contains()` / origin 構築ロジックはそのまま保持**し、`init?: RequestInit` パラメータ追加と `fetch()` 呼び出し部分のヘッダーマージのみ変更する:

```typescript
async function swFetch(path: string, init?: RequestInit): Promise<Response> {
  // 既存: getSettings() → origin 構築 → permissions チェック → は変更なし
  // 変更箇所: Authorization と init.headers をマージ
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${currentToken}`);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${origin}${path}`, { ...init, headers });
}
```

### X-5 テスト

- `extension/src/__tests__/login-detector.test.ts` — フォーム検出テスト (偽陽性ヒューリスティック含む)
- `extension/src/__tests__/save-banner.test.ts` — UI テスト
- `extension/src/__tests__/background-login-save.test.ts` — メッセージハンドラテスト + UPDATE_LOGIN でフィールド保全を検証 (title, username, url, notes 等が変更されないこと)
- `extension/src/__tests__/crypto-encrypt.test.ts` — encryptData ↔ decryptData ラウンドトリップテスト + AAD 不一致時の復号失敗テスト
- `src/__tests__/api/passwords-write-scope.test.ts` — サーバー側: `passwords:write` スコープの認可テスト (POST/PUT) + スコープなし時の 403 拒否テスト

---

## 検証手順

1. `cd extension && npm run build` でビルド成功を確認
2. `cd extension && npm test` でテスト全パス
3. ルートで `npm test` — サーバー側テスト全パス
4. Chrome にロードして手動確認:
   - X-4: `Ctrl+Shift+C` でパスワードコピー、`Ctrl+Shift+U` でユーザー名コピー、30 秒後にクリップボードクリアを確認
   - X-3: 入力フィールドで右クリック → passwd-sso メニュー → エントリ選択で自動入力
   - X-5: ログインフォーム送信 → 保存バナー表示 → Save/Update/Dismiss 動作確認

## リスク・注意点

- **Chrome コマンド上限**: `_execute_action` を除き suggested_key は最大 4 つ。`lock-vault` は suggested_key なしで定義
- **Service Worker のクリップボード制限**: `navigator.clipboard` は使用不可 → `chrome.scripting.executeScript` (world: ISOLATED) でアクティブタブに委譲
- **クリップボード自動クリア**: `setTimeout(30s)` + `chrome.alarms(1min)` の二重構成で SW 停止時もフォールバック
- **コンテキストメニュー更新頻度**: タブ切り替えのたびにメニュー再構築はコストがかかる → デバウンス (200ms) + `onUpdated` は `status === "complete"` のみ
- **SW 再起動時のメニュー消失**: `onInstalled` に加え `onStartup` でもメニューを再構築
- **X-5 の MVP 制限**: form submit イベントのみ検出。programmatic `form.submit()` と fetch/XHR ベースの SPA ログインは Phase 2 で対応
- **ログイン検出の偽陽性**: パスワード変更・登録・リセットフォームを除外するヒューリスティック実装
- **encryptData の AAD**: Web アプリと同じ方式で aadVersion=1 を使用。`crypto.randomUUID()` → `buildPersonalEntryAAD(userId, entryId)` → 暗号化 → POST (`personal-entry-save.ts` と同パターン)
- **拡張トークンの書き込み権限**: `passwords:write` はデフォルトスコープに含めず、ユーザーがオプトインで有効化。`passwords:write` → `passwords:read` の依存関係を UI で強制
- **swFetch ヘッダーマージ**: `Authorization` ヘッダーと `init.headers` を `new Headers()` でマージし、両方が確実に含まれるようにする
