# プランレビュー: cozy-munching-eclipse.md
日時: 2026-03-01T12:00:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1 [重要]: `anyTypeEnabled` ガードが includeChars のみの生成をブロック
- **問題**: `password-generator.tsx` L190-195 の `anyTypeEnabled` が uppercase/lowercase/numbers/symbolGroups のみチェック。includeChars に値があってもtype全OFFだとRefreshボタンが disabled になりAPIコール不可。
- **影響**: 「includeCharsのみで生成」ユースケースがUI上で不可能。
- **推奨対応**: `anyTypeEnabled` 条件に `(settings.includeChars?.length ?? 0) > 0` を追加。

### F-2 [重要]: `required[]` が length を超過するリスク
- **問題**: includeChars の各文字を required に追加すると、includeChars が多数の場合に `required.length > length` となり生成パスワード長が仕様と不一致。
- **影響**: `length=8` で includeChars 10文字なら8文字超のパスワードが生成される。
- **推奨対応**: includeChars 全体から1文字のみランダムに required に追加する方式に変更（「指定文字群のうち少なくとも1文字が出現」の意味）。

### F-3 [中]: charset構築ロジックの二重管理
- **問題**: `estimateBits()`(クライアント) と `generatePassword()`(サーバー) で同じcharset構築ロジックが重複。
- **影響**: 片方変更忘れで強度表示が乖離。
- **推奨対応**: `generator-prefs.ts` に `buildEffectiveCharset()` を抽出し双方から利用。

### F-4 [中]: 後方互換性 — 既存blobにフィールド未存在
- **問題**: 既存暗号化blobの `generatorSettings` に `includeChars`/`excludeChars` がない → `undefined`。TypeScript型はrequiredなのでランタイムエラーの可能性。
- **推奨対応**: `personal-password-form-initial-values.ts` で `{ ...DEFAULT_GENERATOR_SETTINGS, ...initialData.generatorSettings }` マージを採用。

### F-5 [低]: includeChars 重複文字処理の明確化
- **推奨対応**: `new Set(includeChars)` でユニーク化を明記。

### F-6 [低]: excludeAmbiguous + excludeChars 同時指定テスト追加
- **推奨対応**: テストケース追加。

## セキュリティ観点の指摘

### S-1 [必須]: includeChars/excludeChars に対する文字種制約欠如
- **問題**: `z.string().max(128)` は制御文字・ゼロ幅文字・絵文字・サロゲートペアをすべて許可。`randomChar()` が `charset[index]` でコードユニット単位アクセスするため、サロゲートペア分断で不正UTF-16文字列が生成される。
- **推奨対応**: Zodで ASCII 印字可能文字(0x20-0x7E) に制限: `.regex(/^[\x20-\x7E]*$/)`

### S-2 [必須]: 文字プール縮小によるエントロピー危険水準
- **問題**: excludeChars で charset が極端に小さくなっても空でなければ生成成功。charset=2文字で length=16 → 16bits。
- **推奨対応**: charset サイズが小さい場合にUI警告表示。

### S-3 [任意]: includeChars の暗号化blob内保存リスク
- **影響**: 低い（AES-256-GCM暗号化済み）。対応不要。

### S-4 [必須]: required[] 超過 → F-2 と同一

### S-5 [推奨]: 既存 symbols フィールドに .max() 制約なし
- **推奨対応**: `symbols: z.string().max(128).default("")` に変更。

### S-6 [推奨]: includeChars 多数指定時のパスワード予測可能性
- **推奨対応**: F-2 の「1文字のみrequiredに追加」方式で軽減。

## テスト観点の指摘

### T-1 [重大]: estimateBits() のテスト欠落
- **問題**: 大幅書き換え予定なのにテスト計画なし。
- **推奨対応**: ユーティリティに抽出してユニットテスト追加。

### T-2 [重大]: バリデーションスキーマのテスト欠落
- **推奨対応**: `generatePasswordSchema` のパース・リジェクトテスト追加。

### T-3 [中]: GeneratorOptions 型変更の既存テスト互換性
- **推奨対応**: optional として追加し既存テスト無変更確認を明記。

### T-4 [中]: Unicode/マルチバイト → S-1 と同一

### T-5 [中]: includeChars が length 超過 → F-2 と同一

### T-6 [軽微]: generator-summary.ts 影響なしの明記
- **推奨対応**: プランに「変更不要確認済み」と記載。

### T-7 [重大]: UIコンポーネントのテスト欠落
- **推奨対応**: estimateBits 抽出+ユニットテスト。手動テスト手順の詳細化。

### T-8 [軽微]: 暗号化ブロブ後方互換性 → F-4 と同一
