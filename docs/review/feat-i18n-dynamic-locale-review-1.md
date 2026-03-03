# プランレビュー: happy-brewing-kite (i18n 動的ロケール対応)
日時: 2026-02-28T18:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1 [高] `defaultLocale` の変更が破壊的変更になる
- **問題**: `defaultLocale` が `"ja"` → `"en"` に変わることで、proxy リダイレクト先、`safeLocale()` フォールバック、SEO インデックス等に影響
- **影響**: 既存ブックマーク・Accept-Language ヘッダー未対応ユーザーのフォールバック先が変わる
- **推奨対応**: ユーザーの判断として `"en"` に変更するなら、破壊的変更であることをプランに明記

### F-2 [中] `import.meta.dirname` が Node.js 20 で未サポート
- **問題**: Dockerfile のベースイメージ `node:20-alpine` では `import.meta.dirname` が利用できない
- **影響**: Docker ビルド時に `discover-locales.ts` が失敗する可能性
- **推奨対応**: `fileURLToPath(import.meta.url)` + `path.dirname()` を使うか、Node.js 22 にアップグレード

### F-3 [高] CI/Docker で生成ファイルが存在しない
- **問題**: Dockerfile は `npx next build` を直接呼ぶため npm lifecycle hooks (`prebuild`) が発火しない
- **影響**: Docker ビルドが `Module not found` で失敗
- **推奨対応**: Dockerfile builder ステージに `RUN npx tsx scripts/discover-locales.ts` を追加

### F-4 [高] `import()` で存在しない JSON がバンドラーエラーになる
- **問題**: 部分翻訳ロケールで `import("../../messages/fr/PasswordForm.json")` がバンドル時にエラー。`try/catch` では捕捉不可
- **影響**: 部分翻訳ロケールでビルド失敗
- **推奨対応**: `fs.readFileSync` ベースに切り替えるか、バンドラーの挙動を検証。`loadAllMessages` はサーバー専用なので `fs` 使用可能

### F-5 [低] `Intl.DisplayNames` の長い表示名
- **問題**: `zh-Hant` 等のサブタグ付きロケールで表示名が長くなりレイアウト崩れの可能性
- **推奨対応**: 現時点では許容。拡張点としてコメントを残す

### F-6 [中] テストの `loadLocale()` 修正が未記載
- **問題**: `messages-consistency.test.ts` の `loadLocale()` が `readFileSync` で全ファイル読み込み。部分翻訳ロケールで ENOENT
- **推奨対応**: `loadLocale()` を修正し、non-default locale は部分許容に変更

### F-7 [中] Dockerfile の `messages/` コピー要否が実装方針依存
- **問題**: `import()` vs `fs` の方針未確定で Dockerfile の変更内容が不明確
- **推奨対応**: `loadAllMessages` の実装方針を先に確定

### F-8 [低] メールテンプレートの型安全性低下
- **問題**: `as Record<string, ...>` キャストで翻訳漏れが型レベルで検出不可
- **推奨対応**: JSDoc コメントで「新ロケール追加時はメールテンプレートも要翻訳」と明記

## セキュリティ観点の指摘

### S-1 [高] `discover-locales.ts` のディレクトリ名バリデーション不足
- **問題**: `defaultLocale` 出力がテンプレートリテラルで直接埋め込み。ディレクトリ名に `"` を含むと構文破壊
- **影響**: サプライチェーン攻撃の可能性（コミット権限を持つ攻撃者）
- **推奨対応**: BCP 47 バリデーション正規表現を追加 + `defaultLocale` 出力に `JSON.stringify` 使用

### S-2 [中] 生成ファイル `.gitignore` 化によるサプライチェーンリスク
- **問題**: 生成ファイルがバージョン管理されず、ビルド環境汚染の検出手段がない
- **推奨対応**: (A) バージョン管理に含め CI で差分検出、(B) `.gitignore` のままなら CI でバリデーション追加

### S-3 [高] `deepMerge()` によるプロトタイプ汚染リスク
- **問題**: `__proto__`, `constructor`, `prototype` キーによるプロトタイプ汚染
- **推奨対応**: 危険キーを除外するか、`Object.create(null)` をベースに使用

### S-4 [低] `emergency-access.ts` の `escapeHtml` 呼び出し漏れリスク
- **問題**: 新ロケール LABELS 追加時に `escapeHtml` 漏れが起きやすくなる
- **推奨対応**: `escapeHtml` をテンプレート内部に移動

### S-5 [低] `Intl.DisplayNames` 入力値のサニタイゼーション
- **問題**: React の自動エスケープで XSS リスクは低いが、不正値の表示が混乱を招く
- **推奨対応**: S-1 のバリデーションで解消

### S-6 [中] セキュリティクリティカルネームスペースの翻訳完全性
- **問題**: `Vault`, `Recovery`, `VaultReset` 等の警告メッセージが未翻訳のままフォールバック表示される
- **推奨対応**: `SECURITY_CRITICAL_NAMESPACES` を定義し、全ロケールで完全翻訳を必須とする

## テスト観点の指摘

### T-1 [中] `discover-locales.ts` のユニットテスト欠落
- **問題**: スクリプト自体のテストが計画にない。`.DS_Store` 等の非ディレクトリ除外、空ディレクトリの扱い等
- **推奨対応**: `scripts/__tests__/discover-locales.test.mjs` を追加

### T-2 [中] `deepMerge()` のユニットテスト欠落
- **問題**: フォールバックの中核ロジックに対するテスト計画がない
- **推奨対応**: `deepMerge()` を export し、エッジケースを含むテストを追加

### T-3 [中] `loadAllMessages` フォールバック動作の値レベル検証不足
- **問題**: キー存在確認のみで、フォールバック後の「値」を検証していない
- **推奨対応**: fixture ロケールを用いたフォールバック値検証テストを追加

### T-4 [中] `Intl.DisplayNames` 非対応環境テスト不足
- **問題**: `Intl.DisplayNames` が `undefined` の場合のフォールバックテストがない
- **推奨対応**: モックでフォールバック動作を検証

### T-5 [高] `locale-utils.test.ts` の `isAppLocale("fr")` が壊れる
- **問題**: `messages/fr/` 追加時に `isAppLocale("fr")` が `true` になりテスト失敗
- **推奨対応**: 未知ロケールのテストに `"xx"` 等の実在しないコードを使用

### T-6 [中] `emergency-access.ts` の `getLabels()` 変更に対するテスト不足
- **問題**: 動的キー参照のフォールバックテストがない
- **推奨対応**: `emergencyInviteEmail("fr", "Alice")` が en フォールバックを返すテストを追加

### T-7 [中] テストの決定性が `messages/` ディレクトリ依存
- **問題**: ローカルに `messages/fr/` を作成するとテスト結果が変わる
- **推奨対応**: ロケール一覧に依存するテストは `vi.mock("@/i18n/discovered-locales")` でモック

### T-8 [中] フォールバック `try/catch` がサイレントで空オブジェクト返却
- **問題**: エラーログ出力なし。テスト側で「フォールバック発生」と「正常読み込み」を区別不可
- **推奨対応**: warning ログ出力 + テストでロガーをモックしてフォールバック検知

### T-9 [高] CI ワークフローに `i18n:discover` ステップ不足
- **問題**: `ci.yml` の app-ci / e2e ジョブで `npm run lint` や `npm test` 前に生成ファイルが存在しない
- **推奨対応**: `npx prisma generate` の直後に `npm run i18n:discover` を追加

### T-10 [高] Dockerfile builder ステージで `i18n:discover` 未実行
- **問題**: `npx next build` は npm lifecycle hooks を経由しない
- **推奨対応**: `RUN npx tsx scripts/discover-locales.ts` を `npx next build` の前に追加
