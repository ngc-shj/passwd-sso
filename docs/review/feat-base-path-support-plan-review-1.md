# プランレビュー: fancy-juggling-toucan.md (basePath対応)
日時: 2026-03-04T00:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

---

## 機能観点の指摘 (11件)

### F-1 [致命的] Auth.js の callbackUrl / AUTH_URL との整合
- **問題**: `AUTH_URL` を basePath 込みに設定しないと OAuth callback URL が不正になる。Google Console / SAML Jackson の ACS URL も更新が必要。
- **影響**: Google OIDC / SAML 認証フロー全体が壊れる
- **推奨対応**: AUTH_URL=https://www.jpng.jp/passwd-sso と設定する手順、OAuth プロバイダの callback URL 更新手順をプランに追加

### F-2 [致命的] SCIM の getScimBaseUrl() が AUTH_URL/NEXTAUTH_URL に依存
- **問題**: `src/lib/scim/response.ts` の `getScimBaseUrl()` が NEXTAUTH_URL ベース。basePath 込みの AUTH_URL 設定で解決するが、プランに明記がない。
- **影響**: SCIM プロビジョニングが機能しない
- **推奨対応**: AUTH_URL に basePath を含める旨を明記し、getScimBaseUrl() の動作検証を追加

### F-3 [中] next-intl middleware の basePath 対応が未検証
- **問題**: `defineRouting()` に basePath 設定がなく、locale リダイレクト時に basePath が含まれるか不明
- **影響**: `/passwd-sso/` → `/passwd-sso/ja/` のリダイレクトが壊れる可能性
- **推奨対応**: 実装前にローカル検証、検証ステップに追加

### F-4 [低] 共有リンク `/s/...` の表示確認が検証に含まれていない
- **問題**: `/passwd-sso/s/[token]` が外部ブラウザから正しく表示されるか未検証
- **推奨対応**: 検証項目に追加

### F-5 [致命的] Extension の serverUrl が origin に切り詰められ basePath が失われる
- **問題**: `extension/src/options/App.tsx` の `validateServerUrl()` が `url.origin` を返すため basePath が消失
- **影響**: ブラウザ拡張の全 API 通信が 404
- **推奨対応**: Extension 対応ステップをプランに追加

### F-6 [高] hasValidSession の fetch URL（プラン Step 6a で対応済み、検証要）
- **問題**: `new URL("/api/auth/session", request.url)` は URL resolution で basePath が消える
- **推奨対応**: Step 6a の対応方針は正しいが、basePath 有無両条件でのテスト追加を推奨

### F-7 [高] signIn リダイレクト URL（プラン Step 6b で対応済み、検証要）
- **推奨対応**: `request.nextUrl.clone()` + pathname 設定後に basePath が含まれるか実装時に確認

### F-8 [軽微] csp-nonce Cookie path — プラン Step 6c で対応済み。指摘なし。

### F-9 [中] client-navigation.ts — プラン Step 8 で対応済み。テスト追加を推奨。

### F-10 [中] fetchApi() のサーバーサイド誤用リスク
- **問題**: 一括置換時にサーバーサイド route handler 内の fetch まで変換するリスク
- **推奨対応**: `"use client"` ファイルに限定。JSDoc に「クライアントサイド専用」と明記。

### F-11 [中] 検証手順の不足
- **推奨対応**: locale リダイレクト、SAML、Extension、SCIM、共有リンクを検証項目に追加

---

## セキュリティ観点の指摘 (8件)

### S-1 [中] Session cookie path の scope 肥大化
- **問題**: Auth.js のセッション cookie `path: "/"` が basePath 運用で同一ドメインの他アプリに送信される
- **影響**: Cookie Tossing / Session Hijacking のリスク（同一ドメイン上に他アプリがある場合）
- **推奨対応**: `auth.config.ts` に cookie 設定を追加し path を basePath に制限

### S-2 [高] hasValidSession URL 構築 — F-6 と同一。プラン Step 6a で対応済み。テスト追加推奨。

### S-3 [中] 共有リンク URL basePath 欠落 — プラン Step 4 で対応済み。data.url の二重付与防止を確認。

### S-4 [中] window.location.href 代入 — プラン Step 5 で対応済み。

### S-5 [低] callbackUrl の将来的オープンリダイレクトリスク — 現時点では安全。コメント追記程度。

### S-6 [中] CSP Report-To / Reporting-Endpoints basePath 不整合 — プラン Step 6c で対応済み。

### S-7 [高] AUTH_URL と basePath 未検証 — F-1 と同一。対応必須。

### S-8 [中] client-navigation basePath 二重付与 — プラン Step 8 で対応済み。

---

## テスト観点の指摘 (8件)

### T-1 [高] url-helpers.ts の単体テストが計画に含まれていない
- **推奨対応**: `src/lib/url-helpers.test.ts` を作成。basePath 各パターン（空、`/passwd-sso`、末尾スラッシュ付き）を網羅。

### T-2 [中] proxy.test.ts が basePath 環境でのパスマッチングを検証していない
- **推奨対応**: basePath 設定時のサインインリダイレクト URL・セッション確認 URL テストグループ追加

### T-3 [高] CI の AUTH_URL が basePath 付きでテストされない
- **推奨対応**: CI に `NEXT_PUBLIC_BASE_PATH=/passwd-sso` での `npm run build` ステップを追加

### T-4 [低] E2E テストが basePath 環境をカバーしていない
- **推奨対応**: 将来課題として認識。初期実装では手動検証で許容。

### T-5 [高] fetch() 置換漏れのリグレッション検出が不十分
- **推奨対応**: CI に `src/` 配下の `fetch("/api/` or `fetch(API_PATH` パターン検出 grep を追加

### T-6 [高] Extension の basePath 対応とテスト — F-5 と同一。

### T-7 [中] client-navigation.test.ts が basePath ストリップをテストしていない
- **推奨対応**: basePath 付き URL のストリップテストケース追加

### T-8 [中] window.location.origin URL 構築箇所の精査 — プラン Step 4 で対応済み。data.url の basePath 有無を確認。
