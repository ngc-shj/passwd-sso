# Plan: Next.js basePath 対応（リバースプロキシ配下のサブパス運用）

## Context

Apache リバースプロキシで `https://example.com/passwd-sso` として配信するため、Next.js の `basePath` を設定する。
`NEXT_PUBLIC_BASE_PATH` 環境変数で制御し、開発時は空（ルート直下）、本番は `/passwd-sso` とする。

### Next.js basePath の自動対応・非対応

| 自動対応（変更不要） | 非対応（要修正） |
|---|---|
| `<Link>`, `router.push()` | クライアント側 `fetch("/api/...")` |
| `next/image` | `window.location.origin + path` の URL構築 |
| proxy.ts の `request.nextUrl.pathname`（basePath 除去済） | `window.location.href = path` の直接代入 |
| proxy.ts の matcher パターン | CSP の `report-uri` |
| static assets (`/_next/...`) | proxy.ts 内の `new URL(path, request.url)` |

---

## 実装ステップ

### Step 1: `next.config.ts` に basePath 追加

**ファイル:** [next.config.ts](next.config.ts)

```typescript
const nextConfig: NextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  output: "standalone",
  // ...
};
```

### Step 2: ヘルパー関数を作成

**新規ファイル:** `src/lib/url-helpers.ts`

```typescript
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * パスに basePath を付与（fetch、window.location.href 用）。
 * クライアントサイド専用 — サーバーサイド route handler 内では使用しないこと。
 */
export function withBasePath(path: string): string {
  return `${BASE_PATH}${path}`;
}

/**
 * API fetch のラッパー。basePath を自動付与。
 * クライアントサイド専用 — サーバーサイド route handler 内では使用しないこと。
 */
export function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(withBasePath(path), init);
}

/**
 * origin + basePath + path のフル URL（クリップボード/共有用）。
 * ブラウザ環境専用（window.location.origin を参照）。
 */
export function appUrl(path: string): string {
  return `${window.location.origin}${BASE_PATH}${path}`;
}
```

### Step 3: クライアント側 `fetch()` を一括置換（~46ファイル、~100箇所）

`fetch(API_PATH.xxx)` / `fetch(apiPath.xxx())` / `` fetch(`${API_PATH.xxx}?...`) `` を `fetchApi()` に置換。

**注意: `"use client"` ディレクティブを持つファイル（またはクライアントコンポーネントから呼ばれるファイル）のみ対象。サーバーサイド route handler は対象外。**

**パターン:**
- `fetch(API_PATH.VAULT_UNLOCK, opts)` → `fetchApi(API_PATH.VAULT_UNLOCK, opts)`
- `` fetch(`${API_PATH.TAGS}?tree=true`) `` → `` fetchApi(`${API_PATH.TAGS}?tree=true`) ``
- `fetch(apiPath.teamById(id))` → `fetchApi(apiPath.teamById(id))`
- `` fetch(`/api/teams/${id}/policy`) `` → `` fetchApi(`/api/teams/${id}/policy`) ``

各ファイルに `import { fetchApi } from "@/lib/url-helpers"` を追加。

**対象ファイル一覧（主要）:**
- `src/lib/vault-context.tsx` (8箇所)
- `src/lib/team-vault-core.tsx` (3箇所)
- `src/hooks/use-team-policy.ts`, `src/hooks/use-watchtower.ts`
- `src/components/share/send-dialog.tsx`, `share-dialog.tsx`
- `src/components/team/` 配下 (team-scim-token-manager, team-create-dialog, team-trash-list, team-archived-list, team-edit-dialog-loader, team-export, team-tag-input, team-policy-settings)
- `src/components/passwords/` 配下 (password-list, trash-list, password-export, password-generator, attachment-section, password-card, entry-history-section, personal-password-edit-dialog-loader, password-import-steps, password-import-importer)
- `src/components/notifications/notification-bell.tsx`
- `src/components/sessions/sessions-card.tsx`
- `src/components/tags/tag-input.tsx`
- `src/components/vault/recovery-key-dialog.tsx`
- `src/components/emergency-access/grant-card.tsx`, `create-grant-dialog.tsx`
- `src/components/layout/language-switcher.tsx`
- `src/components/extension/auto-extension-connect.tsx`
- `src/components/settings/scim-provisioning-card.tsx`
- `src/app/[locale]/dashboard/` 配下の各 page.tsx
- `src/app/[locale]/recovery/page.tsx`, `vault-reset/page.tsx`
- `src/lib/password-analyzer.ts`

### Step 4: `window.location` URL 構築を `appUrl()` に置換

2種類のパターンがある:

**(a) API レスポンスのパス連結** — `data.url` は basePath を含まないカノニカルパス（例: `/s/abc123`）。`appUrl()` が basePath を付与するため二重付与にはならない。

| ファイル | 変更前 | 変更後 |
|---|---|---|
| `src/components/share/send-dialog.tsx` (2箇所) | `` `${window.location.origin}${data.url}` `` | `appUrl(data.url)` |
| `src/components/share/share-dialog.tsx` | `` `${window.location.origin}${data.url}` `` | `appUrl(data.url)` |

**(b) ハードコードパス連結** — ページパスを直接連結するパターン。

| ファイル | 変更前 | 変更後 |
|---|---|---|
| `src/components/emergency-access/grant-card.tsx` | `` `${window.location.origin}/dashboard/...` `` | `` appUrl(`/dashboard/...`) `` |
| `src/components/emergency-access/create-grant-dialog.tsx` | 同上 | 同上 |
| `src/components/team/team-scim-token-manager.tsx` | `` `${window.location.origin}/api/scim/v2` `` | `appUrl("/api/scim/v2")` |
| `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx` (2箇所) | `` `${window.location.origin}/dashboard/teams/invite/...` `` | `` appUrl(`/dashboard/teams/invite/...`) `` |

### Step 5: `window.location.href` 代入を `withBasePath()` に置換（2箇所）

| ファイル | 変更前 | 変更後 |
|---|---|---|
| `src/app/[locale]/vault-reset/page.tsx` | `` window.location.href = `/${locale}/dashboard` `` | `` window.location.href = withBasePath(`/${locale}/dashboard`) `` |
| `src/app/[locale]/recovery/page.tsx` | 同上 | 同上 |

### Step 6: `src/proxy.ts` の修正

**6a: `hasValidSession` のセッション URL に basePath 付与**

```typescript
// Before:
const sessionUrl = new URL(API_PATH.AUTH_SESSION, request.url);
// After:
const sessionUrl = new URL(
  `${request.nextUrl.basePath}${API_PATH.AUTH_SESSION}`,
  request.url,
);
```

**6b: サインインリダイレクトで `request.nextUrl.clone()` を使用**

```typescript
// Before:
const signInUrl = new URL(`/${locale}/auth/signin`, request.url);
signInUrl.searchParams.set("callbackUrl", request.url);
// After:
const signInUrl = request.nextUrl.clone();
signInUrl.pathname = `/${locale}/auth/signin`;
signInUrl.searchParams.set("callbackUrl", request.url);
```

**6c: CSP report URL と cookie path に basePath 付与**

`applySecurityHeaders` に `basePath` パラメータを追加（`request.nextUrl.basePath` を呼び出し元から渡す）。

```typescript
// Report-To / Reporting-Endpoints
const cspReportUrl = `${basePath}${API_PATH.CSP_REPORT}`;
// ... use cspReportUrl in Report-To JSON and Reporting-Endpoints header

// Cookie path
response.cookies.set("csp-nonce", nonce, {
  httpOnly: true,
  sameSite: "lax",
  path: `${basePath}/` || "/",
});
```

**6d: `clearAuthSessionCookies` に cookie path を指定**

Step 9 でセッション cookie の path を basePath に制限するため、削除時にも同じ path を指定しないと cookie が残存する。

```typescript
function clearAuthSessionCookies(response: NextResponse, basePath: string): void {
  const cookiePath = `${basePath}/` || "/";
  for (const name of authSessionCookieNames) {
    response.cookies.delete({ name, path: cookiePath });
  }
}
```

### Step 7: root `proxy.ts` の CSP report-uri 修正

**ファイル:** [proxy.ts](proxy.ts)

```typescript
function buildCspHeader(nonce: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  // ...
  `report-uri ${basePath}/api/csp-report`,
  // ...
}
```

### Step 8: `src/lib/client-navigation.ts` に basePath ストリップ追加

```typescript
function normalizeForRouter(pathWithQueryHash: string, locale: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  let path = pathWithQueryHash;
  if (basePath && path.startsWith(basePath)) {
    path = path.slice(basePath.length) || "/";
  }
  // 既存の locale ストリップ処理...
}
```

### Step 9: Auth.js セッション cookie の path を basePath に制限

**ファイル:** [src/auth.config.ts](src/auth.config.ts)

同一ドメインの他アプリに cookie が漏洩しないよう、セッション cookie の path を basePath に制限する。

```typescript
cookies: {
  sessionToken: {
    name: isSecure
      ? "__Secure-authjs.session-token"
      : "authjs.session-token",
    options: {
      path: `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/` || "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
    },
  },
},
```

### Step 10: Extension の serverUrl basePath 保持

**ファイル:** `extension/src/options/App.tsx`, `extension/src/background/index.ts`

現在 `validateServerUrl()` が `url.origin` を返すため basePath が消失する。

**(a) `validateServerUrl()` 修正:**

```typescript
// Before (options/App.tsx):
return { ok: true, value: url.origin };
// After:
const path = url.pathname.replace(/\/+$/, ""); // 末尾スラッシュ除去
return { ok: true, value: `${url.origin}${path}` };
```

**(b) `background/index.ts` の `new URL(serverUrl).origin` 全箇所を修正:**

`serverUrl`（basePath 込み）をそのまま API パスのベースとして使用。`${origin}${EXT_API_PATH.xxx}` → `${serverUrl}${EXT_API_PATH.xxx}` に変更。

**(c) `isAppPage()` で basePath チェック追加:**

```typescript
// origin 一致だけでなく、pathname が basePath で始まることも確認
const base = new URL(serverUrl);
return pageUrl.origin === base.origin && pageUrl.pathname.startsWith(base.pathname || "/");
```

**(d) ホストパーミッション / `registerTokenBridgeScript` の matches:**

origin ベースのため変更不要。

### Step 11: `getScimBaseUrl()` を AUTH_URL ベースに修正

**ファイル:** [src/lib/scim/response.ts](src/lib/scim/response.ts)

現在 `NEXTAUTH_URL` を参照しており、`AUTH_URL` に basePath を含めても反映されない。

```typescript
// Before:
const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
// After:
const base = process.env.AUTH_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
```

### Step 12: `.env.example` にドキュメント追加・AUTH_URL 手順明記

**ファイル:** [.env.example](.env.example)

```bash
# --- Base Path (optional) ---
# Set when deploying behind a reverse proxy at a sub-path.
# Must start with "/" and NOT end with "/". Leave empty for root.
# Build-time variable — set before `npm run build`.
# NEXT_PUBLIC_BASE_PATH=/passwd-sso
```

`AUTH_URL` のコメントを更新:

```bash
# Base URL of the application.
# IMPORTANT: basePath 使用時は basePath を含めること (e.g., https://example.com/passwd-sso)
# OAuth callback URL も AUTH_URL ベースで構築されるため、
# Google Console / SAML Jackson の Authorized redirect URI も更新が必要。
AUTH_URL=http://localhost:3000
```

### Step 13: Apache 設定の変更

basePath 設定により Next.js 自体が `/passwd-sso/` でリッスンするため、Apache はパスをストリップせずにそのまま転送:

```apache
ProxyPass        /passwd-sso/  https://app-server.internal:3000/passwd-sso/
ProxyPassReverse /passwd-sso/  https://app-server.internal:3000/passwd-sso/
```

### Step 14: テスト追加

テスト内で basePath 環境を再現するには `vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso")` を使用。basePath なし環境の回帰テストも併記。

**14a: `src/lib/url-helpers.test.ts`（新規）**

basePath の各パターン（空文字列、`/passwd-sso`）で `withBasePath`、`fetchApi`、`appUrl` の動作を検証。

**14b: `src/__tests__/proxy.test.ts` に basePath テストグループ追加**

basePath 設定時の:
- `hasValidSession` のセッション確認 URL 構築
- サインインリダイレクト URL に basePath が含まれること
- CSP report URL / cookie path
- `clearAuthSessionCookies` の path 指定

**14c: `src/lib/client-navigation.test.ts` に basePath テストケース追加**

basePath 付き URL のストリップが正しく動作し、basePath なし環境で回帰がないことを検証。

**14d: `src/lib/scim/response.test.ts` に basePath ケース追加**

`AUTH_URL=https://example.com/passwd-sso` のときに `getScimBaseUrl()` が `https://example.com/passwd-sso/api/scim/v2` を返すことを検証。

**14e: Extension テスト**

`validateServerUrl` が basePath を保持すること、`background/index.ts` の API URL 構築が basePath 込みになることを検証。

### Step 15: CI に basePath ビルド検証と置換漏れチェックを追加

**ファイル:** `.github/workflows/ci.yml`

```yaml
# basePath 付きビルドが通ることを確認
- name: Build with basePath
  run: npm run build
  env:
    NEXT_PUBLIC_BASE_PATH: /passwd-sso

# fetch() 置換漏れ検出（クライアントファイルで生の fetch("/api/ を使っていないか）
# src/app/api/ (サーバーサイド route handler) は対象外
- name: Check fetch basePath compliance
  run: |
    if grep -rn --include='*.tsx' --include='*.ts' \
      -E 'fetch\((API_PATH\.|apiPath\.|`/api/|"/api/)' \
      src/lib/vault-context.tsx src/lib/team-vault-core.tsx \
      src/hooks/ src/components/ src/app/\[locale\]/ src/lib/password-analyzer.ts \
      | grep -v 'fetchApi' | grep -v '\.test\.' | grep -v 'node_modules'; then
      echo "ERROR: Found fetch() calls that should use fetchApi()"
      exit 1
    fi
```

---

## 変更しないもの

- `proxy.ts` の matcher パターン（Next.js が basePath を自動除去してから matcher に渡す）
- `src/proxy.ts` の `pathname.startsWith()` 比較（`request.nextUrl.pathname` は basePath 除去済）
- `src/auth.config.ts` の pages / callbacks（`nextUrl.pathname` は proxy 内部で basePath ストリップ済みのため変更不要。Auth.js が pages の basePath を処理する）
- `API_PATH` 定数の値自体（canonical route paths として維持）
- サーバーサイドの route handler コード
- Docker Compose / Jackson の URL 設定

## 検証方法

### ビルド・起動

1. `NEXT_PUBLIC_BASE_PATH=/passwd-sso npm run build && NEXT_PUBLIC_BASE_PATH=/passwd-sso npm start`
2. ブラウザで `http://localhost:3000/passwd-sso/ja` にアクセス

### 認証フロー

3. `/passwd-sso/` → `/passwd-sso/ja/` の locale リダイレクト確認
4. Google OIDC サインイン → ダッシュボード遷移を確認
5. SAML Jackson 経由のサインインフロー確認（環境がある場合）
6. サインアウト → サインインページへのリダイレクト確認（basePath 付き URL になること）

### 機能

7. Vault unlock / パスワード CRUD が動作することを確認
8. 共有リンクのコピーに `/passwd-sso` が含まれることを確認
9. `/passwd-sso/s/[token]` に外部ブラウザからアクセスして表示確認
10. チーム招待リンク・緊急アクセス招待リンクに `/passwd-sso` が含まれることを確認
11. サインイン callbackUrl が basePath 二重付与にならないことを確認

### SCIM / Extension

12. SCIM エンドポイント URL が basePath 込みを返すことを確認
13. Extension で serverUrl に basePath 込み URL を設定して API 通信確認

### 回帰テスト

14. `NEXT_PUBLIC_BASE_PATH` 未設定で `npm run dev` → 従来通りルート直下で動作することを確認
15. `npm run lint` でエラーなし
16. テスト実行（url-helpers, proxy, client-navigation, scim/response, extension）
