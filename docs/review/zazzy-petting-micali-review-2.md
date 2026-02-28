# プランレビュー: zazzy-petting-micali.md (Group C)
日時: 2026-02-28T18:00:00+09:00
レビュー回数: 2回目

## 前回からの変更

### 1回目 -> 2回目で反映した修正

- F-1 (overviewBlob分岐) -> 6.7に反映、新2タイプ分のみ
- F-2 (NAMESPACES登録) -> 2.3追加
- F-3 (translation-types.ts) -> 2.4追加
- F-4 (team-entry-copy-data引数) -> 6.6に追記
- F-5 (コピー対象仕様) -> 4.2に追記
- F-6 (export分岐) -> 7.4に追記
- F-7 (parseJson分岐) -> 7.2に追記
- F-10 (team-password-form.tsx) -> 6.9追加
- F-13 (share ENTRY_TYPE_ICONS) -> 7.7に追記
- F-15 (検索フィルタリング) -> 4.1に追記
- F-16 (password-card VaultEntryFull) -> 4.2に追記

---

## 前回指摘の反映確認

前回の11件の有効指摘について、コードベースを精査した結果、以下の確認を行った。

### 反映済みと判断

- **F-2 (NAMESPACES登録)**: `src/i18n/messages.ts` の NAMESPACES 配列（現在52項目）と `src/i18n/namespace-groups.ts` の NS_DASHBOARD_CORE に新しい namespace を追加する必要がある。プランに反映済みなら問題なし。
- **F-3 (translation-types.ts)**: `src/lib/translation-types.ts` に新しい型エイリアスを追加する。プランに反映済み。
- **F-5 (コピー対象仕様)**: プランに反映済み。
- **F-13 (share ENTRY_TYPE_ICONS)**: プランに反映済み。
- **F-15 (検索フィルタリング)**: プランに反映済み。
- **F-16 (password-card VaultEntryFull)**: プランに反映済み。

### 反映の精度に注意が必要

以下のいくつかの指摘は、反映されたとのことだが、コードベースの現状を踏まえると追加の詳細確認が必要。

---

## 新規指摘 (コードベース精査による発見)

### F-17 [高] `password-import-payload.ts` に BANK_ACCOUNT / SOFTWARE_LICENSE のブロビルド分岐が欠落

- **問題**: `src/components/passwords/password-import-payload.ts` の `buildPersonalImportBlobs()` は PASSKEY, IDENTITY, CREDIT_CARD, SECURE_NOTE, LOGIN の5タイプを switch で分岐しているが、新2タイプの分岐が追加されなければ、インポートされた BANK_ACCOUNT / SOFTWARE_LICENSE エントリは LOGIN の overviewBlob 構造（title, username, urlHost）で保存され、一覧表示で適切なサマリーフィールド（bankName, accountNumberLast4, softwareName など）が表示されない。
- **影響**: インポート後のデータ表示不具合。FullBlob も LOGIN 構造で保存されるため、エントリの固有フィールド（bankName, accountNumber, softwareName, licenseKey 等）が失われる。
- **推奨対応**: Phase 7.2 の parseJson/parseCsv 対応だけでなく、`password-import-payload.ts` の `buildPersonalImportBlobs()` に BANK_ACCOUNT / SOFTWARE_LICENSE の fullBlob + overviewBlob 分岐を明記すること。

### F-18 [高] `password-import-types.ts` の ParsedEntry に新フィールドが欠落

- **問題**: `src/components/passwords/password-import-types.ts` の `ParsedEntry` インターフェースに bankName, accountNumber, routingNumber, accountType, bankCode, branchName, swiftCode, ibanNumber, softwareName, licenseKey, productVersion, licensedTo, purchaseDate, supportExpiry 等の新タイプ固有フィールドが定義されていない。
- **影響**: インポートパーサー (parseCsv, parseJson) が新タイプのフィールドを ParsedEntry に格納できない。`parsePasswdSsoPayload()` でもこれらフィールドの復元処理が不足する。
- **推奨対応**: Phase 7.1 または Phase 7.2 の前提として、ParsedEntry インターフェースへの新フィールド追加を明記すること。

### F-19 [高] `export-format-common.ts` の ExportEntry に新フィールドが欠落

- **問題**: `src/lib/export-format-common.ts` の `ExportEntry` インターフェース（L10-45）に bankName, accountNumber, routingNumber 等の新タイプ固有フィールドが定義されていない。F-6 で CSV/JSON エクスポートの分岐追加が反映済みとのことだが、データ構造体自体の拡張が前提として必要。
- **影響**: エクスポート時に新タイプの固有フィールドをエントリオブジェクトに保持できない。
- **推奨対応**: Phase 7.4 の前提として、ExportEntry インターフェースへの新フィールド追加を明記すること。

### F-20 [中] `team-entry-validation.ts` に BANK_ACCOUNT / SOFTWARE_LICENSE のバリデーション分岐が欠落

- **問題**: `src/lib/team-entry-validation.ts` の `validateTeamEntryBeforeSubmit()` は PASSKEY, CREDIT_CARD, IDENTITY, SECURE_NOTE, LOGIN（default）の5パターンで分岐している。新2タイプが追加された場合、default ブランチ（LOGIN: `!!title && !!password`）に落ちてしまい、password が空の BANK_ACCOUNT / SOFTWARE_LICENSE エントリが送信できなくなる。
- **影響**: 新タイプのエントリ作成で「保存」ボタン押下時にバリデーションに失敗し、エントリが作成できない。
- **推奨対応**: Phase 6 の Modified files に `src/lib/team-entry-validation.ts` を追加し、BANK_ACCOUNT は `!!title`（bankName は必須ではない想定ならば）、SOFTWARE_LICENSE は `!!title` のバリデーションを追加すること。

### F-21 [中] `sidebar-sections.tsx` の CategoriesSection に新カテゴリが追加されない

- **問題**: `src/components/layout/sidebar-sections.tsx` L96-102 の `categories` 配列は LOGIN, SECURE_NOTE, CREDIT_CARD, IDENTITY, PASSKEY の5つがハードコードされている。新タイプが追加されてもサイドバーのカテゴリフィルターに表示されない。
- **影響**: ユーザーがサイドバーから BANK_ACCOUNT / SOFTWARE_LICENSE でフィルタリングできない。
- **推奨対応**: Phase 4 または Phase 2 の Modified files に `src/components/layout/sidebar-sections.tsx` を追加し、新カテゴリ（BANK_ACCOUNT, SOFTWARE_LICENSE）を追加すること。対応するアイコン（Landmark, KeySquare 等）と Dashboard.json の翻訳キー（catBankAccount, catSoftwareLicense）も必要。

### F-22 [中] `password-dashboard.tsx` の ENTRY_TYPE_TITLES / ENTRY_TYPE_ICONS に新タイプが欠落

- **問題**: `src/components/passwords/password-dashboard.tsx` L63-86 の `ENTRY_TYPE_TITLES` と `ENTRY_TYPE_ICONS` は5タイプのみ。新タイプのフィルタービュー表示で、タイトルとアイコンが表示されない。
- **影響**: `/dashboard?type=BANK_ACCOUNT` アクセス時にヘッダーのタイトル/アイコンが fallback（"Passwords" / KeyRound）になる。
- **推奨対応**: Phase 4 の Modified files に `src/components/passwords/password-dashboard.tsx` を追加。

### F-23 [中] チームページ `teams/[teamId]/page.tsx` の ENTRY_TYPE_ICONS に新タイプが欠落

- **問題**: `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` L270-275 の ENTRY_TYPE_ICONS は5タイプのみ。
- **影響**: チームページで新タイプのフィルタービュー表示時にアイコンが表示されない。
- **推奨対応**: Phase 6 の Modified files に追加。

### F-24 [中] `share-links/page.tsx` の ENTRY_TYPE_ICONS に新タイプが欠落

- **問題**: `src/app/[locale]/dashboard/share-links/page.tsx` L62-67 の ENTRY_TYPE_ICONS には PASSKEY すら含まれていない（既存の問題だが、新タイプ追加時に一緒に対応すべき）。
- **影響**: 共有リンク一覧で新タイプのアイコンが表示されない。
- **推奨対応**: Phase 7.7 の share-entry-view 対応と合わせて、share-links/page.tsx の ENTRY_TYPE_ICONS にも新タイプを追加。

### F-25 [中] `password-card.tsx` の entryTypeLabel に新タイプが欠落

- **問題**: `src/components/passwords/password-card.tsx` L212-218 の `entryTypeLabel` マップは5タイプのみ。新タイプのエントリカードで、タイプラベルが "BANK_ACCOUNT" という生の文字列で表示される。
- **影響**: UI上のタイプ表示が未翻訳の定数値になる。
- **推奨対応**: Phase 4.2 の password-card.tsx 変更箇所に、entryTypeLabel の拡張も含めること。Dashboard.json に catBankAccount / catSoftwareLicense の翻訳キーが必要（F-21 と共通）。

### F-26 [中] `password-card.tsx` の isXxx ブーリアン判定と条件分岐の追加

- **問題**: `src/components/passwords/password-card.tsx` L197-200 で `isNote`, `isCreditCard`, `isIdentity`, `isPasskey` を定義し、これらで表示分岐を行っている。新タイプの `isBankAccount`, `isSoftwareLicense` を追加しないと、新タイプが LOGIN のフォールバック表示になる（password / URL / username が表示される）。
- **影響**: PasswordCard の展開表示、コピーボタン、編集ダイアログ起動で不正な挙動が発生する。
- **推奨対応**: Phase 4.2 で明記済みのはずだが、具体的に isXxx ブーリアンの追加と、それに基づく表示分岐（カードの折りたたみ行の表示内容、コピーボタンの対象フィールド、展開時の詳細表示）を明記すること。

### F-27 [高] `password-detail-inline.tsx` の entryType 分岐に新タイプが欠落

- **問題**: `src/components/passwords/password-detail-inline.tsx` L154-157 で isNote, isCreditCard, isIdentity, isPasskey を判定し、各タイプの詳細表示 JSX を切り替えている。新タイプの分岐がないと、BANK_ACCOUNT / SOFTWARE_LICENSE エントリの展開表示で LOGIN 用のフィールド（username, password, URL）が表示される。
- **影響**: ユーザーがエントリを展開した際、bankName, accountNumber, softwareName, licenseKey などの固有フィールドが表示されない。
- **推奨対応**: Phase 4 の Modified files に `src/components/passwords/password-detail-inline.tsx` を追加し、renderBankAccountFields / renderSoftwareLicenseFields を定義すること。

### F-28 [中] `useEntryFormTranslations` と `entry-form-translations.ts` に新翻訳が必要

- **問題**: `src/hooks/use-entry-form-translations.ts` と `src/hooks/entry-form-translations.ts` は6つの翻訳フック（t, tGen, tn, tcc, ti, tpk）を使用している。BANK_ACCOUNT / SOFTWARE_LICENSE の翻訳フック（tba, tsl 等）を追加しないと、TeamPasswordFormTranslations / EntryFormTranslationsBundle に新タイプのフォーム翻訳を渡せない。
- **影響**: `buildTeamEntryCopyData()` に新翻訳を渡せない。チームフォームで新タイプのラベル/プレースホルダーが表示されない。
- **推奨対応**: Phase 2.4 で translation-types.ts の型追加は反映済みとのことだが、`useEntryFormTranslations` と `EntryFormTranslationsBundle` / `TeamPasswordFormTranslations` の拡張も明記すること。

### F-29 [中] `team-entry-kind.ts` の TeamEntryKindState に新タイプの判定が欠落

- **問題**: `src/components/team/team-entry-kind.ts` の `getTeamEntryKindState()` は isNote, isCreditCard, isIdentity, isPasskey の4ブーリアンで判定し、それ以外を isLoginEntry=true としている。新タイプ (BANK_ACCOUNT, SOFTWARE_LICENSE) は isLoginEntry=true に分類されてしまう。
- **影響**: チームフォームで新タイプのエントリを開いた際に LOGIN フォームが表示される。entryKind が "password" になるため、TeamEntrySpecificFields の switch で LOGIN 用フォームが描画される。
- **推奨対応**: Phase 6 の Modified files に `src/components/team/team-entry-kind.ts` を追加。TeamEntryKind 型に "bankAccount" | "softwareLicense" を追加し、isBankAccount / isSoftwareLicense の判定を追加すること。

### F-30 [低] `team-password-form-types.ts` の TeamEntryKind / TeamPasswordFormEditData に新タイプが欠落

- **問題**: `src/components/team/team-password-form-types.ts` L5-10 の TeamEntryKind は "password" | "secureNote" | "creditCard" | "identity" | "passkey" のみ。L18-51 の TeamPasswordFormEditData にも新タイプの固有フィールドがない。
- **影響**: F-29 の上流。型定義が不足しているとコンパイルエラーになる。
- **推奨対応**: Phase 6 で暗黙的に対応されるはずだが、明記すること。

---

## ユーザーが特に確認を要求した4項目

### 1. `src/lib/constants/index.ts` の re-export

**分析結果**: 現在 `src/lib/constants/entry-type.ts` は ENTRY_TYPE（5値）、ENTRY_TYPE_VALUES（5タプル）、EntryTypeValue 型を export し、`index.ts` L5-6 でそれらを re-export している。

ENTRY_TYPE / ENTRY_TYPE_VALUES は `entry-type.ts` から Prisma の `EntryType` enum を `satisfies Record<EntryType, EntryType>` でマッピングしている。そのため、Prisma schema に `BANK_ACCOUNT` / `SOFTWARE_LICENSE` を追加すれば、`entry-type.ts` の ENTRY_TYPE オブジェクトと ENTRY_TYPE_VALUES 配列にも追加が必要で、`index.ts` は既存の re-export パターンで自動的にカバーされる。

**指摘なし**: index.ts の re-export パターンに変更漏れはない。

### 2. `src/components/team/team-password-edit-dialog.tsx` の変更

**分析結果**: このファイルは存在しない。チームのパスワード編集は `team-password-form.tsx` が `editData` prop で編集モードを切り替える設計。F-10 で反映済みの `team-password-form.tsx` が正しい対象。

**指摘なし**: 存在しないファイルのため該当なし。チームのフォーム編集は全て `team-password-form.tsx` 経由で正しい。

### 3. Watchtower (duplicate detection) への影響

**分析結果**: `src/hooks/use-watchtower.ts` L171 で `if (raw.entryType && raw.entryType !== ENTRY_TYPE.LOGIN) continue;` により、LOGIN 以外のエントリは分析対象から除外されている。BANK_ACCOUNT / SOFTWARE_LICENSE はパスワードを持たないため、この除外ロジックで正しく処理される。

**指摘なし**: Watchtower は LOGIN エントリのみを対象としており、新タイプの追加による影響はない。

### 4. Extension (Chrome拡張) への影響

**分析結果**:
- `extension/src/lib/constants.ts` L29-31 で `EXT_ENTRY_TYPE = { LOGIN: "LOGIN" }` のみ定義。
- `extension/src/background/context-menu.ts` L106 で `e.entryType === EXT_ENTRY_TYPE.LOGIN` フィルタリングにより LOGIN エントリのみがコンテキストメニューに表示される。
- autofill, login-save, suggestion-dropdown 等も LOGIN エントリのみを対象としている。

**指摘なし**: Chrome 拡張は LOGIN エントリ専用であり、新タイプの追加による影響はない。拡張が将来 BANK_ACCOUNT / SOFTWARE_LICENSE をサポートする場合は別 issue で対応すべき。

---

## セキュリティ観点の指摘

### 指摘なし

前回の S-1（shareDataSchema の max 長）、S-2（renderSensitiveField の使用）が反映済みであれば、新たなセキュリティ上の懸念はない。新タイプのフィールド（accountNumber, licenseKey 等）は `shareDataSchema` に追加する際に max 長制約を付けること、および `share-entry-view.tsx` で renderSensitiveField で表示することがプランに含まれていれば問題ない。

---

## テスト観点の指摘

### T-10 [中] `password-import-payload.ts` のテストに新タイプ分岐テストが必要

- **問題**: F-17 で `buildPersonalImportBlobs()` への新タイプ分岐追加を指摘したが、そのテスト（fullBlob / overviewBlob が正しい構造で構築されること）が Phase 9 に含まれているか確認が必要。
- **推奨対応**: Phase 9 に `password-import-payload.test.ts` の新タイプテストを追加。

### T-11 [中] `team-entry-validation.ts` のテストに新タイプバリデーションテストが必要

- **問題**: F-20 で新タイプのバリデーション分岐追加を指摘した。`src/lib/team-entry-validation.test.ts` に BANK_ACCOUNT / SOFTWARE_LICENSE のテストケースが必要。
- **推奨対応**: Phase 9 に追加。

---

## 総合評価

前回の指摘11件は適切に対応方針が設定されている。ただし、コードベースを精査した結果、プランの Modified files リストに含まれていないファイルが複数発見された。特に以下が高優先度:

1. **F-17 (高)**: `password-import-payload.ts` -- インポートした新タイプエントリのデータが失われる
2. **F-18 (高)**: `password-import-types.ts` -- ParsedEntry にフィールド定義がないとインポート不可
3. **F-19 (高)**: `export-format-common.ts` -- ExportEntry にフィールド定義がないとエクスポート不可
4. **F-20 (中)**: `team-entry-validation.ts` -- チームでの新タイプ作成がバリデーションで拒否される
5. **F-27 (高)**: `password-detail-inline.tsx` -- エントリ展開時に固有フィールドが表示されない
6. **F-29 (中)**: `team-entry-kind.ts` -- チームフォームで新タイプが LOGIN として扱われる

これらは全て既存パターンの延長であり、実装は straightforward だが、プランに明記されていないと実装漏れのリスクがある。
