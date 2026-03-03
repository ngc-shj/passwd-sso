# コードレビュー: feat/base-path-support
日時: 2026-03-04T11:15:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1: `password-analyzer.ts` の import 文がファイル末尾に配置
- ファイル: `src/lib/password-analyzer.ts:198`
- 問題: `import { API_PATH }` がファイル末尾にある。ESModules の hoisting で動作はするが可読性が低い
- 推奨: ファイル先頭の import ブロックに移動

### F-2: `auth.config.ts` の `pages` に basePath を含めることの正当性
- ファイル: `src/auth.config.ts:80-83`
- 問題: Auth.js v5 の `pages` は内部パスを期待する可能性があり、basePath 二重付加のリスク
- 推奨: 実環境での E2E テストで確認（既に動作確認済みであれば問題なし）

### F-3: CI の `fetch basePath compliance` チェックの対象範囲が限定的
- ファイル: `.github/workflows/ci.yml:99-108`
- 問題: `src/lib/` の一部ファイルのみ対象。新ファイル追加時に検出漏れのリスク
- 推奨: `src/` 全体を対象にし、`src/app/api/` を除外するパターンに変更

### F-4: `withBasePath` に対する入力バリデーション不足
- ファイル: `src/lib/url-helpers.ts:7-9`
- 問題: path が `/` で始まらない場合に不正な URL が生成される
- 推奨: 開発時アサーション追加

### F-5: `session-provider.test.tsx` のテストが環境依存
- ファイル: `src/components/providers/session-provider.test.tsx:40-52`
- 問題: `if (!process.env.NEXT_PUBLIC_BASE_PATH)` ガードでスキップの可能性
- 推奨: `vi.stubEnv` + `vi.resetModules` パターンに統一

### F-6: `auth.test.ts` の basePath テストが環境依存
- ファイル: `src/auth.test.ts:402-408`
- 問題: 同上、条件付きテスト
- 推奨: 環境制御または else ブランチ追加

### F-7: `proxy.ts` の callbackUrl にフル URL を設定
- ファイル: `src/proxy.ts:53`
- 問題: basePath 環境下でサインイン後リダイレクトの二重付加リスク
- 推奨: 実環境 E2E テストで確認

### F-8: fetch → fetchApi 移行漏れ
- 結果: **漏れなし**

## セキュリティ観点の指摘

### S-1: proxy.ts の callbackUrl にフル URL を設定（= F-7 と同一）
- ファイル: `src/proxy.ts:53`
- 問題: `request.url` をそのまま callbackUrl に設定。リバースプロキシが Host を正規化しない環境でオープンリダイレクトの理論的リスク
- 影響: 低（クライアント側 origin 比較が防御層として機能）
- 推奨: pathname + search のみ設定に変更

### S-2: NEXT_PUBLIC_BASE_PATH の入力バリデーション不在
- ファイル: `next.config.ts:5`, `src/lib/url-helpers.ts:1`
- 問題: 不正な値設定時の防御がない
- 影響: 低（ビルド時変数のためランタイム攻撃不可）
- 推奨: `src/lib/env.ts` に Zod バリデーション追加

### S-3: withAuthBasePath の二重プレフィックス可能性
- ファイル: `src/app/api/auth/[...nextauth]/route.ts:28`
- 問題: basePath が既に含まれている場合の防御なし
- 影響: 低（現 Next.js 16 では問題にならない）
- 推奨: `if (!url.pathname.startsWith(basePath))` ガード追加

### S-4: セッションクッキー path のデッドコード
- ファイル: `src/auth.config.ts:72`, `src/proxy.ts:202`
- 問題: `` `${basePath}/` || "/" `` の右辺は到達不可能
- 影響: 情報レベル
- 推奨: `|| "/"` を削除

### S-5: fetchApi のサーバーサイド誤用防止
- ファイル: `src/lib/url-helpers.ts:15-18`
- 問題: サーバーサイドからも呼出可能（現時点では全て正しく使用）
- 影響: 低
- 推奨: `typeof window === "undefined"` ガード追加

### S-6: Extension の serverUrl 正規化不足
- ファイル: `extension/src/background/index.ts:72-73, 281-284`
- 問題: `attemptTokenRefresh` と `revokeCurrentTokenOnServer` で URL 構築前の正規化なし
- 影響: 低（Chrome host_permissions が制約）
- 推奨: `new URL(serverUrl)` でパースして正規化

## テスト観点の指摘

### T-1: `session-provider.test.tsx` の条件付きテスト（= F-5）
### T-2: `auth.test.ts` の条件付きテスト（= F-6）

### T-3: `withAuthBasePath` にテストが存在しない
- ファイル: `src/app/api/auth/[...nextauth]/route.ts:22-38`
- 問題: 認証フロー中核のラッパーにテストなし
- 推奨: 関数を export してユニットテスト追加

### T-4: `withBasePath` の不正入力テスト不足（= F-4）

### T-5: basePath なしブロックに fetchApi の init 省略テストがない
- ファイル: `src/lib/url-helpers.test.ts`
- 推奨: basePath なしでも `fetchApi("/api/passwords")` の init 省略テスト追加

### T-6: `proxy.ts` の basePath ロジックにテストがない
- ファイル: `src/proxy.ts`
- 問題: `hasValidSession`, `applySecurityHeaders`, `clearAuthSessionCookies` の basePath 分岐未テスト
- 推奨: `proxy.test.ts` に basePath ありの describe ブロック追加

### T-7: `signin-button.tsx` の callbackUrl テストがない
- ファイル: `src/components/auth/signin-button.tsx:29`
- 推奨: `signin-button.test.tsx` 作成

### T-8: `auth.config.ts` の pages 設定値テストがない
- ファイル: `src/auth.config.ts:80-83`
- 推奨: config export のテスト追加

### T-9: `client-navigation.test.ts` に basePath + query + hash テストがない
- ファイル: `src/lib/client-navigation.test.ts:36-73`
- 推奨: basePath ありブロックに `?x=1#top` 付きテスト追加

### T-10: `scim/response.test.ts` に basePath + 末尾スラッシュテストがない
- ファイル: `src/lib/scim/response.test.ts`
- 推奨: `AUTH_URL=https://example.com/passwd-sso/` のテスト追加

## 対応状況
（修正後に追記）
