# プランレビュー: cozy-munching-eclipse.md
日時: 2026-03-01T12:30:00+09:00
レビュー回数: 2回目

## 前回からの変更

1回目の指摘を反映:
- anyTypeEnabled修正追加、required[]を1文字方式に変更
- buildEffectiveCharset()抽出、後方互換マージ方式変更
- ASCII regex制約追加、既存symbols .max(128)追加
- テスト計画拡充

## 機能観点の指摘

### F-S-1 [重要] (新規): buildEffectiveCharset()のシグネチャ未定義
- **問題**: GeneratorSettings(symbolGroups: SymbolGroupFlags)とGeneratorOptions(symbols: string)で入力型が異なる
- **推奨対応**: 中間型`{ uppercase, lowercase, numbers, symbols: string, excludeAmbiguous, includeChars, excludeChars }`を受け取る設計
- **判定**: 妥当 → プランに反映

### F-S-2 [重要] (新規): route.ts「変更不要」記述の不正確さ
- **推奨対応**: 「コード変更不要（型定義変更で自動反映）」に修正
- **判定**: 妥当 → プランに反映

### F-S-4 [中] (新規): team-password-form-initial-values.tsの不整合
- **判定**: スキップ — team側は意図的にデフォルト固定。今回のスコープ外

## セキュリティ観点の指摘

### S-2 [推奨] (継続・格下げ): エントロピー低下UI警告
- **判定**: スキップ — estimateBits修正+既存strengthバー(4段階色)で十分。追加警告は今回スコープ外

### S-8 [必須] (新規): symbolsフィールドにもASCII regex制約が必要
- **問題**: symbolsも`charset[index]`で使用されサロゲートペア分断リスクあり
- **推奨対応**: `symbols: z.string().max(128).regex(/^[\x20-\x7E]*$/).default("")`
- **判定**: 妥当 → プランに反映

## テスト観点の指摘

### T-2 [重大] (継続): バリデーションスキーマテスト欠落
- **推奨対応**: validations.test.tsにgeneratePasswordSchemaのパース/リジェクトテスト追加
- **判定**: 妥当 → プランに反映

### T-9 [中] (新規): estimateBitsとbuildEffectiveCharsetの整合性テスト
- **推奨対応**: buildEffectiveCharsetテストでcharset.lengthの具体値を検証
- **判定**: 妥当 → プランに反映（buildEffectiveCharsetテスト詳細化で対応）

### T-10 [中] (新規): includeCharsのみ生成時の結果構成検証
- **推奨対応**: includeCharsのみ生成時に結果がincludeChars文字のみで構成されることを検証
- **判定**: 妥当 → プランに反映

### T-11 [軽微] (新規): 手動テスト手順の具体化
- **判定**: 妥当 → プランに反映
