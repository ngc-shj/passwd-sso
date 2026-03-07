# WebAuthn サインイン + Magic Link 認証の実装計画

## Context

現在の passwd-sso は SSO（Google OIDC / SAML Jackson）でしかサインインできない。個人ユーザーが SSO なしでも使えるように、以下の 2 つの認証手段を追加する:

1. **Magic Link**（メール認証） — 初回アカウント作成 + ログイン
2. **WebAuthn サインイン**（パスキー） — 2 回目以降のパスワードレスログイン

フロー: Magic Link で初回登録 → パスキー登録 → 以降はパスキーでサインイン（PRF 対応なら Vault も自動アンロック）

## 設計方針

### ユーザー種別ごとの認証フロー

| | 企業ユーザー（SSO 設定あり） | 個人ユーザー（SSO 設定なし） |
|--|---------------------------|--------------------------|
| **サインイン** | SSO のみ（パスキーサインイン不可） | Magic Link or パスキー |
| **パスキーの用途** | PRF Vault アンロック専用 | サインイン + PRF Vault アンロック |
| **サインインページ** | SSO ボタンのみ | メールフォーム + パスキーボタン |

### パスキー PRF の扱い

PRF 対応・非対応は **登録してみるまで判明しない**（ブラウザ/認証器の組み合わせ次第）。

- **両方の登録を許可**（企業・個人ともに）
- 非 PRF で登録された場合は「Vault 自動アンロックは使えません」と表示（既存実装通り）
- 個人ユーザーの非 PRF パスキー: サインインは可能、Vault はパスフレーズで別途アンロック

### Known Limitations

- Magic Link トークンは要求元クライアントにバインドされない（Auth.js の制約）。メールアカウントが侵害された場合、別デバイスからのトークン使用が可能。新デバイス検出メール通知で緩和。
- PRF salt の導出に credentialId を含めることで相関攻撃を防げるが、既存クレデンシャルとの互換性問題があるため将来検討。

---

## Phase 1: Magic Link（Auth.js Email プロバイダー）

### 1-1. Auth.js に Email プロバイダーを追加

**ファイル: `src/auth.config.ts`**
- Auth.js v5 の `Nodemailer` プロバイダーを追加（ただし実際のメール送信は既存の `sendEmail()` を使用）
- `sendVerificationRequest` をカスタマイズし、`src/lib/email/index.ts` の `sendEmail()` で送信
- 条件: `EMAIL_PROVIDER` が設定されている場合のみ有効化
- `VerificationToken` モデルは Prisma スキーマに既存
- Magic Link のレート制限: IP ベース 5req/min + メールアドレスベース 3req/10min

### 1-2. Magic Link メールテンプレート

**新規ファイル: `src/lib/email/templates/magic-link.ts`**
- ブランド付き HTML メールテンプレート（APP_NAME 使用）
- テキストフォールバック
- リンクの有効期限を表示（デフォルト: 24時間、Auth.js のデフォルト）
- 既存のメールテンプレートパターン（new-device-detection.ts 等）に合わせる

### 1-3. サインインページにメールフォーム追加

**新規ファイル: `src/components/auth/email-signin-form.tsx`**
- メールアドレス入力フォーム（Client Component）
- Auth.js の `signIn("nodemailer", { email })` を呼び出す
- 送信後に「メールを確認してください」メッセージを表示
- バリデーション: メールアドレス形式チェック

**変更ファイル: `src/app/[locale]/auth/signin/page.tsx`**
- `EMAIL_PROVIDER` が設定されている場合、メールフォームを表示
- 既存 SSO ボタンとの間にセパレーター追加

### 1-4. signIn callback で SSO テナントの Email ログインを拒否

**変更ファイル: `src/auth.ts`**
- `signIn` callback 内で、`nodemailer` プロバイダーの場合:
  - 既存ユーザーのテナントが非 bootstrap（= SSO テナント）なら `return false`
  - API 直接呼び出しでの迂回を防止（UI 非表示だけでは不十分）

### 1-5. 環境変数バリデーション更新

**変更ファイル: `src/lib/env.ts`**
- 本番環境のプロバイダー必須チェックを更新:
  - 現状: Google OR Jackson が必須
  - 変更: Google OR Jackson OR Email（`EMAIL_PROVIDER` 設定済み）が必須

**変更ファイル: `src/__tests__/env.test.ts`**
- テストケース追加:
  - `EMAIL_PROVIDER` のみで本番バリデーション通過
  - プロバイダー全未設定で本番バリデーション失敗
  - エラーメッセージに Email を含める

---

## Phase 2: WebAuthn サインイン（Auth.js Credentials プロバイダー方式）

### 設計変更（レビュー指摘対応）

当初計画ではカスタムセッション作成ヘルパーを使用する予定だったが、レビューで以下の問題が指摘された:
- Auth.js の signIn callback（テナント検証）をバイパス
- sessionMetaStorage（IP/UA キャプチャ）をバイパス
- 新デバイス検出が動作しない
- 監査ログが発火しない
- セッショントークン形式の不一致リスク

**→ Auth.js Credentials プロバイダーを使用し、Auth.js ライフサイクル内でセッション作成を行う方式に変更。`auth-session-helper.ts` は不要。**

### 2-1. Auth.js に WebAuthn Credentials プロバイダーを追加

**変更ファイル: `src/auth.config.ts`**
```
Credentials({
  id: "webauthn",
  name: "Passkey",
  credentials: {
    credentialResponse: { type: "text" },
    challengeId: { type: "text" },
  },
  authorize: async (credentials) => {
    // 1. Redis からチャレンジを取得・消費
    // 2. credentialResponse をパース
    // 3. credentialId で WebAuthnCredential を DB 検索（withBypassRls）
    // 4. @simplewebauthn/server で検証（assertOrigin 含む）
    // 5. カウンター CAS 更新（リプレイ防止）
    // 6. タイミングオラクル防止: credential 未発見時はダミー検証実行
    // 7. User オブジェクトを返す（Auth.js が signIn callback → createSession を実行）
    return { id: user.id, email: user.email };
  },
})
```

- Auth.js が `signIn` callback を呼び出す → `ensureTenantMembershipForSignIn` が実行される
- Auth.js が `createSession` を adapter 経由で呼び出す → IP/UA、新デバイス検出が動作
- `signIn` event → 監査ログ `AUTH_LOGIN` が発火
- セッション cookie は Auth.js が管理 → 形式・フラグの不一致なし

### 2-2. signIn callback で WebAuthn サインインの SSO テナント拒否

**変更ファイル: `src/auth.ts`**
- `signIn` callback 内で、`webauthn` プロバイダーの場合:
  - 既存ユーザーのテナントが非 bootstrap（= SSO テナント）なら `return false`
  - 企業ユーザーがパスキーでサインインすることを防止

### 2-3. チャレンジ生成 API ルート（未認証）

**新規ファイル: `src/app/api/auth/passkey/options/route.ts`**
- POST — セッション不要
- `webauthn-server.ts` の新関数 `generateDiscoverableAuthOpts()` を呼び出し
- チャレンジを Redis に保存（TTL: 300s, key: `webauthn:challenge:signin:${random}`）
- レスポンス: `{ options, challengeId }`
- レート制限: IP ベース 10req/min
- `assertOrigin()` を適用（defense-in-depth）

### 2-4. サーバーサイド WebAuthn 拡張

**変更ファイル: `src/lib/webauthn-server.ts`**
- 新関数 `generateDiscoverableAuthOpts()` を追加
  - `allowCredentials` を空配列に設定（ブラウザが Discoverable Credentials を表示）
  - `userVerification: "required"`
- 既存の `generateRegistrationOpts()` は `residentKey: "preferred"` のまま維持（既存クレデンシャルとの互換性）

### 2-5. クライアントサイド パスキーサインインボタン

**新規ファイル: `src/components/auth/passkey-signin-button.tsx`**
- Client Component
- フロー:
  1. POST `/api/auth/passkey/options` でオプション取得
  2. `webauthn-client.ts` の `startPasskeyAuthentication()` を呼び出し（PRF salt なし版）
  3. `signIn("webauthn", { credentialResponse, challengeId, redirect: false })` で Auth.js に送信
  4. 成功時: `sessionStorage` に `psso:webauthn-signin` フラグをセット → ダッシュボードへ遷移
- エラーハンドリング: キャンセル、タイムアウト、クレデンシャルなし

**変更ファイル: `src/lib/webauthn-client.ts`**
- `startPasskeyAuthentication()` の PRF salt パラメータをオプショナルに変更
- PRF salt なしの場合、PRF 拡張をリクエストしない（`undefined` を `hexDecode` に渡さない）

### 2-6. サインインページにパスキーボタン追加

**変更ファイル: `src/app/[locale]/auth/signin/page.tsx`**
- WebAuthn サポートチェック（`isWebAuthnSupported()` はクライアントサイドなのでクライアントコンポーネントとして分離）
- パスキーボタンの表示条件: **SSO（Google/Jackson）が未設定** かつ `WEBAUTHN_RP_ID` が設定されている場合のみ
- SSO が設定されている企業環境ではパスキーサインインボタンを表示しない（パスキーは PRF Vault アンロック専用）
- 配置: メールフォームの上（パスキーが主要サインイン手段）

### 2-7. RLS ポリシー修正

**新規マイグレーション**
- `webauthn_credentials` の RLS ポリシーを修正:
  - `app.current_tenant_id` → `app.tenant_id` に統一
  - `app.bypass_rls` による bypass 句を追加
- 他の同様のテーブル（`api_keys`, `directory_sync_configs`, `directory_sync_logs`）も同時修正

### 2-8. Discoverable Credential の警告表示

**変更ファイル: `src/components/settings/passkey-credentials-card.tsx`**
- 非 Discoverable なクレデンシャルに対して「このパスキーはサインインには使用できません」と警告表示
- `credentialDeviceType` が `singleDevice` で `residentKey` が非対応の場合を検出

---

## Phase 3: PRF 自動 Vault アンロック（サインイン後）

### 3-1. サインイン後の PRF Vault アンロックフロー

WebAuthn サインイン時に PRF で Vault を自動アンロックする。ただし、サインイン API では PRF salt がない（Discoverable Credentials ではユーザー特定前に salt を生成できない）。

**アプローチ: 2 段階 PRF 認証**
1. サインイン時: PRF なしで WebAuthn 認証 → Auth.js がセッション作成
2. ダッシュボード遷移後: 既存の `unlockWithPasskey()` フロー（認証済み）で PRF Vault アンロック

### 3-2. 自動アンロックのトリガー条件（レビュー指摘対応）

**問題**: 非 PRF パスキーユーザーに対して無意味な 2 回目の WebAuthn ダイアログが表示される

**変更ファイル: `src/components/vault/vault-lock-screen.tsx`**
- `sessionStorage` フラグ `psso:webauthn-signin` を検出
- **PRF 対応パスキーが存在する場合のみ** 自動的に `handlePasskeyUnlock()` を呼び出す
  - 既存の `hasPrfPasskeys` チェック（`useEffect` で `/api/webauthn/credentials` を取得）を活用
  - `hasPrfPasskeys === false` の場合はフラグを消去し、通常のパスフレーズ入力画面を表示
- フラグ使用後は即座に削除（1 回限り）

### 3-3. パスキー登録後の通知メール

**レビュー指摘対応: Magic Link → パスキー登録チェーンのリスク軽減**

**変更ファイル: `src/app/api/webauthn/register/verify/route.ts`**
- パスキー登録成功時に通知メール送信（既存の `sendEmail()` を使用）
- メール内容: 「新しいパスキーが登録されました」+ デバイス情報 + 登録日時
- 不正登録の早期発見を可能にする

---

## Phase 4: i18n + 定数 + テスト + .env

### 4-1. 翻訳キー追加

**変更ファイル: `messages/en/Auth.json`, `messages/ja/Auth.json`**
- `signInWithEmail` / `emailPlaceholder` / `emailSent` / `emailSentDescription`
- `signInWithPasskey` / `passkeyNotSupported`
- `orContinueWith` / `orSignInWith`
- `ssoTenantEmailRejected` / `ssoTenantPasskeyRejected`

**変更ファイル: `messages/en/WebAuthn.json`, `messages/ja/WebAuthn.json`**
- `notDiscoverable` / `notDiscoverableDescription`
- `passkeyRegisteredNotification`

### 4-2. API パス定数

**変更ファイル: `src/lib/constants/api-path.ts`**
- `AUTH_PASSKEY_OPTIONS: "/api/auth/passkey/options"`

### 4-3. テスト

**新規テストファイル:**
- `src/app/api/auth/passkey/options/route.test.ts` — チャレンジ生成、レート制限、Redis 保存
- `src/lib/webauthn-client.test.ts` — `startPasskeyAuthentication()` PRF salt オプショナル対応
- Proxy ルートテスト — `/api/auth/passkey/*` がセッション不要で通過すること

**変更テストファイル:**
- `src/__tests__/env.test.ts` — EMAIL_PROVIDER のみで本番バリデーション通過
- `vitest.config.ts` — カバレッジ除外パターンを `src/app/api/auth/[...nextauth]/**` に限定

### 4-4. 環境変数ドキュメント

**変更ファイル: `.env.example`**
- Magic Link セクション追加（既存の Email セクションを参照として強調）
- WebAuthn セクションにサインイン用途の説明追加

---

## 変更ファイル一覧

### 新規作成

| ファイル | 目的 |
|---------|------|
| `src/app/api/auth/passkey/options/route.ts` | 未認証 WebAuthn チャレンジ生成 |
| `src/components/auth/passkey-signin-button.tsx` | パスキーサインインボタン |
| `src/components/auth/email-signin-form.tsx` | メールサインインフォーム |
| `src/lib/email/templates/magic-link.ts` | Magic Link メールテンプレート |
| RLS 修正マイグレーション | webauthn_credentials ポリシー修正 |

### 変更

| ファイル | 変更内容 |
|---------|---------|
| `src/auth.config.ts` | Email + WebAuthn Credentials プロバイダー追加 |
| `src/auth.ts` | signIn callback: SSO テナント拒否ガード追加 |
| `src/app/[locale]/auth/signin/page.tsx` | メールフォーム + パスキーボタン追加 |
| `src/lib/env.ts` | 本番プロバイダー検証に Email 追加 |
| `src/lib/webauthn-server.ts` | `generateDiscoverableAuthOpts()` 追加 |
| `src/lib/webauthn-client.ts` | PRF salt オプショナル化 |
| `src/lib/constants/api-path.ts` | AUTH_PASSKEY_OPTIONS パス追加 |
| `src/components/vault/vault-lock-screen.tsx` | 自動パスキーアンロック（PRF 確認付き） |
| `src/components/settings/passkey-credentials-card.tsx` | 非 Discoverable 警告表示 |
| `src/app/api/webauthn/register/verify/route.ts` | 登録通知メール送信 |
| `messages/en/Auth.json`, `messages/ja/Auth.json` | 翻訳キー追加 |
| `messages/en/WebAuthn.json`, `messages/ja/WebAuthn.json` | 翻訳キー追加 |
| `.env.example` | Magic Link 説明追加 |
| `vitest.config.ts` | カバレッジ除外パターン修正 |

### 削除（当初計画から除外）

| ファイル | 理由 |
|---------|------|
| ~~`src/lib/auth-session-helper.ts`~~ | Credentials プロバイダー採用により不要 |
| ~~`src/app/api/auth/passkey/verify/route.ts`~~ | Auth.js callback で処理するため不要 |

---

## 検証方法

### 1. Magic Link フロー
- `EMAIL_PROVIDER=smtp` + Mailpit で開発環境テスト
- メールアドレス入力 → Mailpit でリンク確認 → クリックでサインイン
- 初回ユーザーの bootstrap テナント作成を確認
- **SSO テナントユーザーのメールで signIn が拒否されること**

### 2. WebAuthn サインイン
- パスキー登録済みユーザーでサインインページからパスキーログイン
- Auth.js セッションが正しく作成されること（`/api/auth/session` で確認）
- IP/UA がセッションに記録されること
- 監査ログに `AUTH_LOGIN` が記録されること
- `npm run dev` で localhost テスト（WebAuthn は localhost で許可）

### 3. PRF 自動 Vault アンロック
- PRF 対応パスキーでサインイン後、ダッシュボードで自動的にパスキー認証ダイアログが表示されること
- Vault がパスフレーズ入力なしでアンロックされること
- **非 PRF パスキーでのサインイン後、二重プロンプトが出ないこと**

### 4. セキュリティ確認
- SSO テナントユーザーが WebAuthn/Email でサインインできないこと（API 直接呼び出し含む）
- RLS bypass が正しく動作すること（withBypassRls でクレデンシャル検索）
- レート制限が機能すること（passkey options: 10req/min, magic link: 5req/min）
- パスキー登録時に通知メールが送信されること

### 5. 既存フローへの影響なし
- Google OIDC / SAML でのサインインが引き続き動作すること
- 既存パスキー設定画面（settings）が正常に動作すること
- 既存 PRF Vault アンロックが引き続き動作すること
