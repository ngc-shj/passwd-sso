# パスワード生成器: Include/Exclude文字フィールド追加 + Quick Length再配置

## Context

パスワード生成器の文字種選択は現在チェックボックス（A-Z, a-z, 0-9, シンボルグループ6種）のみ。ユーザーが特定の文字を「必ず含める」「必ず除外する」細かい制御ができない。また「クイック長さ」ボタンが長さスライダーから離れた位置にあり、UI/UXの一貫性に欠ける。

## 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/generator-prefs.ts` | `GeneratorSettings`に2フィールド追加、`buildEffectiveCharset()`抽出 |
| `src/lib/password-generator.ts` | `GeneratorOptions`拡張、生成ロジック変更 |
| `src/lib/validations.ts` | `generatePasswordSchema`に2フィールド追加、既存`symbols`に`.max(128)`+ASCII regex |
| `messages/en/PasswordGenerator.json` | i18nキー追加 |
| `messages/ja/PasswordGenerator.json` | i18nキー追加 |
| `src/components/passwords/password-generator.tsx` | UI再配置+入力フィールド+anyTypeEnabled修正+estimateBits修正 |
| `src/hooks/personal-password-form-initial-values.ts` | generatorSettingsのマージ方式変更 |
| `src/lib/password-generator.test.ts` | include/excludeテスト追加 |
| `src/lib/generator-prefs.test.ts` | buildEffectiveCharset + デフォルト値テスト追加 |
| `src/lib/validations.test.ts` | generatePasswordSchemaのパース/リジェクトテスト追加 |

コード変更不要（型定義変更で自動反映）: `src/lib/generator-summary.ts`（mode/lengthのみ参照）、`src/app/api/passwords/generate/route.ts`（`requestSchema`が`generatePasswordSchema`をmerge — `GeneratorOptions`への`includeChars?`/`excludeChars?`追加で型整合が取れる）

## 実装手順

### 1. データモデル — `src/lib/generator-prefs.ts`

`GeneratorSettings`インターフェースに2フィールド追加:

```typescript
export interface GeneratorSettings {
  // ...existing fields...
  includeChars: string;   // 追加
  excludeChars: string;   // 追加
  passphrase: PassphraseSettings;
}
```

`DEFAULT_GENERATOR_SETTINGS`にデフォルト値（`""`）追加。

**charset構築ユーティリティ `buildEffectiveCharset()` を追加** — サーバー(`generatePassword`)とクライアント(`estimateBits`)の両方で使用し、ロジック二重管理を防ぐ:

```typescript
/** symbols: string を受け取る中間型（GeneratorSettingsとGeneratorOptionsの型差異を吸収） */
export function buildEffectiveCharset(opts: {
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: string;          // buildSymbolString()の結果 or GeneratorOptions.symbols
  excludeAmbiguous: boolean;
  includeChars: string;
  excludeChars: string;
}): string {
  // 1. type別文字列を構築（uppercase/lowercase/numbers/symbols）
  // 2. includeCharsの未カバー文字を追加(重複除外)
  // 3. excludeCharsを除去
  // 4. excludeAmbiguousを適用（AMBIGUOUS_CHARS除去）
  // 5. [...new Set()]で重複排除して返す
}
```

呼び出し側:
- `generatePassword()`: `buildEffectiveCharset({ ...options })` — `symbols`はそのまま渡せる
- `estimateBits()`: `buildEffectiveCharset({ ...settings, symbols: buildSymbolString(settings.symbolGroups) })` — symbolGroupsを展開して渡す

この関数はピュアロジック（`node:crypto`不使用）なのでクライアント/サーバー双方で利用可能。

### 2. 生成ロジック — `src/lib/password-generator.ts`

`GeneratorOptions`に`includeChars?: string`と`excludeChars?: string`追加（**optional** — 既存テスト互換性維持）。

`generatePassword()`の文字プール構築を拡張:
1. 既存のtype別charset構築（変更なし）
2. `includeChars`のユニーク文字（`new Set()`）をcharsetに追加、**全体から1文字のみ**ランダムに`required[]`に追加（「指定文字群のうち少なくとも1文字が出現」の意味。各文字を個別にrequiredに入れるとlength超過リスクがある）
3. `excludeChars`の各文字をcharsetと`required[]`から除去
4. excludeCharsがincludeCharsより優先（明示的除外が勝つ）
5. charset空なら既存エラー「At least one character type must be selected」

### 3. バリデーション — `src/lib/validations.ts`

```typescript
export const generatePasswordSchema = z.object({
  length: z.number().int().min(8).max(128).default(16),
  uppercase: z.boolean().default(true),
  lowercase: z.boolean().default(true),
  numbers: z.boolean().default(true),
  symbols: z.string().max(128).regex(/^[\x20-\x7E]*$/).default(""),  // max(128)+ASCII regex追加
  excludeAmbiguous: z.boolean().default(false),
  includeChars: z.string().max(128).regex(/^[\x20-\x7E]*$/).default(""),  // 追加: ASCII印字可能文字のみ
  excludeChars: z.string().max(128).regex(/^[\x20-\x7E]*$/).default(""),  // 追加: ASCII印字可能文字のみ
});
```

- `.regex(/^[\x20-\x7E]*$/)` で制御文字・ゼロ幅文字・絵文字・サロゲートペアを防止（`charset[index]`のコードユニット分断問題を予防）
- `.default("")`で後方互換性確保
- 既存`symbols`にも`.max(128)` + `.regex(/^[\x20-\x7E]*$/)`追加（UIは`buildSymbolString()`経由で安全だがAPI直接呼び出しに対する防御）

### 4. i18n — `messages/{en,ja}/PasswordGenerator.json`

追加キー:
- `includeChars`: "Include" / "含める"
- `excludeChars`: "Exclude" / "除外"
- `includeCharsPlaceholder`: "Always include these characters" / "必ず含める文字"
- `excludeCharsPlaceholder`: "Never use these characters" / "使用しない文字"

### 5. UIコンポーネント — `src/components/passwords/password-generator.tsx`

#### 5a. Quick Length再配置

現在の位置（L259-277、モード切替と生成結果の間）から削除し、設定ボックス内の長さスライダー直下（L350の後）へ移動:

```
Settings box:
  Length: [---slider---] [20]
  Quick Length: [16] [24] [32]    ← ここに移動
  --- border ---
  Character Types: [A-Z] [a-z] ...
  [Exclude ambiguous]
  --- border ---
  Include: [____________]         ← 新規
  Exclude: [____________]         ← 新規
```

#### 5b. Include/Exclude入力フィールド追加

文字種セクション（excludeAmbiguous）の後に、border-tで区切って2つのテキスト入力を追加。monospaceフォント、maxLength=128。

#### 5c. `anyTypeEnabled` ガード修正

L190-195の`anyTypeEnabled`にincludeCharsチェックを追加:

```typescript
const anyTypeEnabled =
  settings.mode === "passphrase" ||
  settings.uppercase ||
  settings.lowercase ||
  settings.numbers ||
  anySymbolEnabled ||
  (settings.includeChars?.length ?? 0) > 0;  // 追加
```

これにより、type全OFFでもincludeCharsに値があれば生成ボタンが有効になる。

#### 5d. generate()コールバック更新

API呼び出しbodyに`includeChars`と`excludeChars`を追加。

#### 5e. estimateBits()修正

`buildEffectiveCharset()`（ステップ1で抽出）を利用して正確なcharsetSizeを算出:

```typescript
function estimateBits(settings: GeneratorSettings, generated: string): number {
  if (!generated) return 0;
  if (settings.mode === "passphrase") {
    return settings.passphrase.wordCount * 12;
  }
  const charset = buildEffectiveCharset({
    uppercase: settings.uppercase,
    lowercase: settings.lowercase,
    numbers: settings.numbers,
    symbolGroups: settings.symbolGroups,
    excludeAmbiguous: settings.excludeAmbiguous,
    includeChars: settings.includeChars ?? "",
    excludeChars: settings.excludeChars ?? "",
  });
  const charsetSize = new Set(charset).size;
  if (charsetSize <= 1) return 0;
  return generated.length * Math.log2(charsetSize);
}
```

現在の実装では`excludeAmbiguous`が反映されていないバグも同時修正。

### 6. 後方互換性 — `src/hooks/personal-password-form-initial-values.ts`

現在の実装:
```typescript
generatorSettings: initialData?.generatorSettings ?? { ...DEFAULT_GENERATOR_SETTINGS },
```

変更後（デフォルトとマージして欠損フィールドを補完）:
```typescript
generatorSettings: { ...DEFAULT_GENERATOR_SETTINGS, ...initialData?.generatorSettings },
```

`team-password-form-initial-values.ts`は常に`{ ...DEFAULT_GENERATOR_SETTINGS }`を使用するため変更不要。

### 7. テスト

#### 7a. `src/lib/password-generator.test.ts` — 追加テストケース:

- includeCharsが生成結果に含まれることを確認
- excludeCharsが生成結果から除外されることを確認
- excludeCharsがincludeCharsより優先されることを確認
- excludeCharsで全文字除外時にエラーが投げられること
- includeCharsのみ（type全OFF）で生成でき、結果がincludeChars文字のみで構成されること
- uppercase + includeCharsの併用時、結果にA-ZとincludeChars両方が含まれること
- excludeAmbiguous + excludeCharsの同時指定で両方除外されること
- includeCharsに重複文字を指定しても正常動作すること

#### 7b. `src/lib/generator-prefs.test.ts` — 追加テストケース:

- `DEFAULT_GENERATOR_SETTINGS`に`includeChars`と`excludeChars`が空文字列として存在すること
- `buildEffectiveCharset()`:
  - uppercase有効時に26文字が含まれること（`charset.length === 26`）
  - lowercase+numbers有効時に36文字（`charset.length === 36`）
  - includeCharsで未カバー文字がcharsetに追加され、charsetサイズが正しく増加すること
  - includeCharsに既存charset内文字を指定してもcharsetサイズが変わらないこと
  - excludeCharsでcharsetから除外され、charsetサイズが正しく減少すること
  - excludeAmbiguous有効時にAMBIGUOUS_CHARSが除外されること
  - excludeChars + excludeAmbiguousの併用で重複除去が正しいこと
  - 全オプションOFFでincludeCharsのみの場合にそのcharsetが返ること
  - 空文字列のincludeChars/excludeCharsで既存動作と同一であること

#### 7c. `src/lib/validations.test.ts` — 追加テストケース:

- `includeChars`にASCII印字可能文字が通ること
- `includeChars`に制御文字（`\x00`, `\x1F`）が拒否されること
- `includeChars`に絵文字/サロゲートペアが拒否されること
- `excludeChars`に同様のASCII制約が効くこと
- `symbols`に128文字超が拒否されること
- `symbols`に非ASCII文字が拒否されること
- 両フィールド省略時にデフォルト空文字列が適用されること

## 検証方法

### 自動テスト

1. `npm run build` — 型エラーなし
2. `npx vitest run src/lib/password-generator.test.ts` — 既存+新規テスト全パス
3. `npx vitest run src/lib/generator-prefs.test.ts` — 既存+新規テスト全パス
4. `npx vitest run src/lib/validations.test.ts` — スキーマテスト全パス

### 手動テスト

`npm run dev` → パスワードエントリ作成 → 生成器を開き以下を確認:

1. Quick Lengthボタンが長さスライダー直下に表示されること
2. Include/Excludeフィールドがmonospaceフォントで表示されること
3. Includeに「@#」入力 → 生成結果に@か#が含まれること
4. Excludeに「abc」入力 → 生成パスワードにa,b,cが一切含まれないこと
5. type全OFF + includeCharsに文字入力 → 生成ボタンが有効で生成できること
6. 強度バー（StrengthメーターHD）がinclude/exclude変更に応じてリアルタイム更新されること
7. 既存エントリ編集時にincludeChars/excludeCharsが空文字列で初期化されること（後方互換）
