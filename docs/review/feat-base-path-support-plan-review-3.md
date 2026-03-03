# プランレビュー: fancy-juggling-toucan.md (basePath対応)

日時: 2026-03-04T00:00:00+09:00
レビュー回数: 3回目

## 前回からの変更

2回目の指摘を受けて以下を追加:

- Step 6d: clearAuthSessionCookies に cookie path 指定
- Step 10 詳細化: (a)~(d) 4ポイント、isAppPage() basePath チェック
- Step 11: getScimBaseUrl() AUTH_URL 優先に修正
- Step 14 拡充: vi.stubEnv 方針、SCIM テスト、Extension テスト
- Step 15 修正: grep 対象を src/app/[locale]/ に限定
- 検証項目: サインアウト後リダイレクト、callbackUrl 二重付与チェック追加
- 「変更しないもの」: auth.config.ts 根拠追記

## 機能観点の指摘

指摘なし。
13件の指摘はすべてプラン既載項目の再指摘または実装詳細レベルの要求。

## セキュリティ観点の指摘

指摘なし。
6件の指摘はすべてプラン既載項目 (Step 6d, 7, 10, 11, 12) の再指摘。
S-6 (セッションキャッシュ LRU 化) は basePath と無関係でスコープ外。

## テスト観点の指摘

指摘なし。
13件の指摘はすべて「プランに書いてあるが実装がまだ」という内容。
これはプランレビューであり、実装前の段階で未実装は当然。
