# プランレビュー: fancy-juggling-toucan.md (basePath対応)

日時: 2026-03-04T00:00:00+09:00
レビュー回数: 2回目

## 前回からの変更

1回目の指摘を受けて以下を追加:

- Step 9: Auth.js セッション cookie path 制限
- Step 10: Extension serverUrl basePath 保持
- Step 11: AUTH_URL basePath 込み手順 + OAuth プロバイダ更新注記
- Step 13: テスト追加（url-helpers, proxy, client-navigation）
- Step 14: CI basePath ビルド + fetch 置換漏れ検出
- fetchApi JSDoc にクライアント専用明記
- 検証方法 14 項目に拡充

## 機能観点の指摘

### N-1 [高] getScimBaseUrl が NEXTAUTH_URL を参照 — 解決していない

- **問題**: `src/lib/scim/response.ts` は `NEXTAUTH_URL` を参照。AUTH_URL 変更では恩恵を受けない。
- **推奨対応**: getScimBaseUrl() を AUTH_URL 優先に変更

### N-2 [高] Step 4 の説明が data.url パターンのみで、ハードコードパターンに言及不足

- **推奨対応**: Step 4 を2カテゴリに分離して明記

### N-3〜N-5 [中] Step 6 の具体性不足

- **判定**: Step 6 にコード例は記載済み。エージェントの読み落とし。対応不要。

### N-6 [中] auth.config.ts を変更しない根拠が未記載

- **推奨対応**: 根拠を一文追加

### N-7 [低] Extension Step 10 の修正箇所詳細不足

- **推奨対応**: background.ts の具体箇所を追記

### N-8 [低] csp-nonce cookie path — Step 6c で対応済み。対応不要。

## セキュリティ観点の指摘

### S-9 [中] clearAuthSessionCookies の cookie path 不一致

- **問題**: Step 9 で cookie path を basePath に制限するが、clearAuthSessionCookies は path 指定なしで delete。path 不一致で cookie 削除失敗。
- **推奨対応**: clearAuthSessionCookies に path 指定追加。Step 6 の修正対象に追加。

### S-11 [中] getScimBaseUrl — N-1 と同一

### S-12 [低] signOut callbackUrl basePath 未考慮

- **推奨対応**: 検証項目にサインアウト後リダイレクト確認を追加

### S-13 [低] Extension isAppPage() が basePath 外も認識

- **推奨対応**: Step 10 スコープに含める

## テスト観点の指摘

### T-14 [高] テストで vi.stubEnv を使って basePath を切り替える方針が未記載

- **推奨対応**: Step 13 にテスト内での環境変数モック方針を追記

### T-9 [中] CI grep がサーバーサイド route handler を誤検出

- **推奨対応**: grep 対象から src/app/api/ を除外

### T-10 [中] Extension テスト計画が Step 13 に含まれていない

- **推奨対応**: Extension テストを Step 13 に追加

### T-11 [中] SCIM テストに basePath ケースなし

- **推奨対応**: response.test.ts に 1 ケース追加

### T-13 [中] signIn callbackUrl の basePath 検証が未計画

- **推奨対応**: 手動検証項目に追加

### T-12 [低], T-15 [低] — 実装詳細レベル。プラン更新不要。
