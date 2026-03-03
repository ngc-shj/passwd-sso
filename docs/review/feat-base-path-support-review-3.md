# コードレビュー: feat/base-path-support (ループ3-5)
日時: 2026-03-04T03:15:00+09:00

## ループ3 結果

### 機能観点の指摘
- F-1: `src/proxy.ts` callbackUrl に basePath が含まれない → `${basePath}${pathname}${search}` に修正

### セキュリティ観点の指摘
- S-7 CRITICAL: Extension `swFetch` の basePath regression — `new URL(path, serverUrl)` が basePath を破棄 → `${serverUrl}${path}` に戻して修正

### テスト観点の指摘
- 指摘なし

### 対応状況 (コミット 6161c76)
- F-1: `src/proxy.ts:53` — callbackUrl に `${basePath}` をプレフィクス
- S-7: `extension/src/background/index.ts:609` — 文字列連結に復元

---

## ループ4 結果

### 機能観点の指摘
- 指摘なし

### セキュリティ観点の指摘
- S-1 [低]: `next.config.ts` basePath validation regex が `//` で始まるパスを許可 → `/^\/[\w-]+(?:\/[\w-]+)*$/` に強化

### テスト観点の指摘
- T-1 [中]: `proxy.test.ts` に basePath テストなし → `_applySecurityHeaders` エクスポート + テスト追加
- T-2 [低]: `auth.test.ts` basePath テストが環境依存 → `endsWith("/api/auth")` に修正

### 対応状況 (コミット 209dfc2)
- S-1: `next.config.ts:5` — 各セグメント `[\w-]+` のみ許可する正規表現に変更
- T-1: `src/proxy.ts:209`, `src/__tests__/proxy.test.ts:250-273` — エクスポート + 2テスト追加
- T-2: `src/auth.test.ts:393-403` — 環境非依存のアサーションに統合

---

## ループ5 結果

### 機能観点の指摘
- 指摘なし

### セキュリティ観点の指摘
- 指摘なし

### テスト観点の指摘
- T-1 [低]: `fetchApi` サーバーサイドガードの未テスト言及 → **対応不要** (既に `url-helpers.server.test.ts` で検証済み)
- T-2 [低]: `withAuthBasePath` Cookie 転送の検証なし → テスト追加

### 対応状況 (コミット 1a1349e)
- T-2: `src/app/api/auth/[...nextauth]/route.test.ts` — Cookie 保持テスト追加

---

## レビュー完了サマリー

| ループ | 機能 | セキュリティ | テスト | 合計 |
|--------|------|-------------|--------|------|
| 3 | 1 | 1 (CRITICAL) | 0 | 2 |
| 4 | 0 | 1 (低) | 2 (中1/低1) | 3 |
| 5 | 0 | 0 | 1 (低) | 1 |

全観点で重大な指摘がクリアされ、レビュー完了。
