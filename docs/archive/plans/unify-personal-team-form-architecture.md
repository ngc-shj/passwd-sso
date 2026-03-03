# 個人Vault / チームVault フォームアーキテクチャ統一

## Context

個人VaultとチームVaultのフォーム構造に以下の不整合がある:

1. **個人Vault**: エントリタイプ別に専用フォーム (`PasswordForm`, `SecureNoteForm`, `CreditCardForm` 等)
2. **チームVault**: 全タイプを1つの `TeamPasswordForm` + `TeamEntrySpecificFields` (630行/230プロップの巨大switch文) に集約
3. **デッドコード**: 個人Vaultにページルート (`/dashboard/new`, `/dashboard/[id]`, `/dashboard/[id]/edit`) があるが、UIからの導線がなく事実上未使用

目標:
- チームVaultのフォーム構造を個人Vaultと同じパターン（エントリタイプ別個別フォーム）に揃える
- **共通フィールドコンポーネント**を両Vaultで共有し、片方の更新忘れを構造的に不可能にする
- デッドコードを削除する

---

## Phase 1: デッドコード削除

### 削除対象ファイル

| ファイル | 理由 |
|---------|------|
| `src/app/[locale]/dashboard/new/page.tsx` | UIからの導線なし (作成はDialogのみ) |
| `src/app/[locale]/dashboard/[id]/page.tsx` | UIからの導線なし (詳細はインライン展開) |
| `src/app/[locale]/dashboard/[id]/edit/page.tsx` | UIからの導線なし (編集はDialogのみ) |
| `src/components/passwords/password-detail.tsx` | 上記ページルートのみが参照 |
| `src/components/passwords/password-form-page-shell.tsx` | `password-form.tsx`のpage variantのみが使用 |
| `src/components/passwords/password-form-page-shell.test.tsx` | 上記のテスト |

### 追加クリーンアップ

- `PasswordForm` の `PasswordFormPageShell` import を削除し、`variant === "page"` 分岐を `SecureNoteForm` 等と同じインラインpage variant rendering（`ArrowLeft` + `Card` パターン）に書き換える
- **i18n namespaceクリーンアップ**: `src/i18n/namespace-groups.ts` と `src/i18n/messages.ts` から `PasswordDetail` 関連のnamespace登録を削除

### 残すもの

各フォームの `variant: "page" | "dialog"` プロップとpage variant用の条件分岐はそのまま残す（低コストかつ将来的に有用な可能性）。

---

## Phase 2: 共通フィールドコンポーネントの作成

チームの既存フィールドコンポーネントを共通化し、**両Vaultで共有する単一のコンポーネント**にする。

### 移動/リネーム

```
src/components/team/team-credit-card-fields.tsx    → src/components/entry-fields/credit-card-fields.tsx
src/components/team/team-secure-note-fields.tsx     → src/components/entry-fields/secure-note-fields.tsx
src/components/team/team-identity-fields.tsx         → src/components/entry-fields/identity-fields.tsx
src/components/team/team-passkey-fields.tsx           → src/components/entry-fields/passkey-fields.tsx
src/components/team/team-bank-account-fields.tsx     → src/components/entry-fields/bank-account-fields.tsx
src/components/team/team-software-license-fields.tsx → src/components/entry-fields/software-license-fields.tsx
src/components/team/team-form-fields.tsx             → src/components/entry-fields/form-fields.tsx
```

コンポーネント名から `Team` プレフィックスを除去:
- `TeamCreditCardFields` → `CreditCardFields`
- `TeamSecureNoteFields` → `SecureNoteFields`
- etc.

### アクセシビリティ強化

共通フィールドコンポーネントに `idPrefix` プロップを追加（`EntryLoginMainFields` の既存パターンに合わせる）。個人フォームは `idPrefix=""`、チームフォームは `idPrefix="team-"` を渡す。これにより `htmlFor`/`id` ペアリングが両Vaultで機能する。

### テスト更新 (Phase 2)

移動対象コンポーネントを参照しているテストの更新。既知の影響ファイル:

- `src/components/team/team-entry-specific-fields.test.tsx` — vi.mockパス7箇所
- `src/hooks/team-entry-specific-fields-props.test.ts`
- `src/hooks/team-entry-specific-fields-callbacks.test.ts`
- `src/components/team/team-password-form.test.tsx` — 間接的影響

**網羅確認**: パス変更後に以下を実行し、漏れを機械的に検出:

```bash
grep -r "@/components/team/team-.*-fields" src/ --include='*.test.*'
```

### 個人フォームのリファクタ

各個人フォームのインライン JSX を共通フィールドコンポーネントに置き換える:

| 個人フォーム | 変更内容 |
|-------------|---------|
| `secure-note-form.tsx` | テンプレートセレクタ以外のMarkdownエディタ部分を `SecureNoteFields` に委譲 |
| `credit-card-form.tsx` | カードフィールド描画を `CreditCardFields` に委譲 |
| `identity-form.tsx` | フィールド部分を `IdentityFields` に委譲 |
| `passkey-form.tsx` | フィールド部分を `PasskeyFields` に委譲 |
| `bank-account-form.tsx` | フィールド部分を `BankAccountFields` に委譲 |
| `software-license-form.tsx` | フィールド部分を `SoftwareLicenseFields` に委譲 |

**重要な保持事項**:
- 個人フォームはstate管理・submit処理・Dialog/page variant wrapper を維持し、JSXのフィールド描画のみを共通コンポーネントに委譲する
- **タイトルフィールド**: 各親フォームで描画（`required` 属性の維持、チーム既存パターンと同一）
- **CreditCardForm**: `brandSource` 状態、`handleCardNumberChange`（auto-detect + format）、`detectCardBrand`/`formatCardNumber` ロジックは個人フォーム側に維持。共通 `CreditCardFields` は最終的なフォーマット済み値を受け取る

---

## Phase 3: チームフォーム分離

### 3a: エントリタイプ別チームフォームの作成

個人Vaultの各フォームに対応するチーム版を作成:

```
src/components/team/
├── team-password-form.tsx          (既存 — LOGIN専用に縮小)
├── team-secure-note-form.tsx       (NEW)
├── team-credit-card-form.tsx       (NEW)
├── team-identity-form.tsx          (NEW)
├── team-passkey-form.tsx           (NEW)
├── team-bank-account-form.tsx      (NEW)
├── team-software-license-form.tsx  (NEW)
```

**注意**: Dialog (`team-new-dialog.tsx`, `team-edit-dialog.tsx`) はPhase 3aでは作成しない。Phase 3cで作成する。

各チームフォームの構造 (例: `team-credit-card-form.tsx`):

```tsx
export function TeamCreditCardForm({ teamId, open, onOpenChange, onSaved, editData, ... }) {
  // 1. 現行 useTeamPasswordFormModel() を呼び出す（Phase 3bでベースフックに分解予定）
  // 2. インラインuseState — エントリ固有フィールドのみ
  // 3. 共通フィールドコンポーネント <CreditCardFields {...fieldProps} idPrefix="team-" />
  // 4. 共通セクション (Tags, CustomFields, Reprompt, Expiration, ActionBar)
  // 5. Dialog wrapper
}
```

**注意**: Phase 3a では現行の `useTeamPasswordFormModel` をそのまま使用する。`use-team-base-form-model.ts` への分離は Phase 3b で行う。

### セキュリティ制約

- **暗号化パス**: 全フォームは `executeTeamEntrySubmit()` → `saveTeamEntry()` を経由すること。`saveTeamEntry()` が**唯一のAPIフェッチパス**であり、AADが自動構築されるため、各フォームがAADを直接触らない。各フォームが独自に `fetch()` を呼ぶことは禁止
- **overviewBlobの型安全性**: エントリタイプ別の `OverviewBlob` 型定義を作成し、blob構造の欠落をコンパイル時に検知可能にする。`entryType` フィールドの包含可否を型定義設計時に決定し文書化する
- **UI権限分岐の引き継ぎ**: 既存の編集ボタン非表示等の条件分岐を新フォームに確実に移行
- **Zodスキーマ refinement**: `createTeamE2EPasswordSchema` に個人用と同様の `id` 必須 refinement を追加（Phase 3と並行で実施可能）

### テスト (Phase 3a)

各エントリタイプ別フォームのテスト作成:
- 現行 `team-password-form.test.tsx` の**全テストケース**を TeamNewDialog / TeamEditDialog 用テストに移植（件数はテストファイル自体から機械的にカウント）
- 最低テスト項目: ダイアログ表示、editData反映、submitペイロード（entryType, teamFolderId含む）、再オープン時のデータリセット

### 3b: チームフォームモデルフックの分離

現在の `useTeamPasswordFormModel` は全エントリタイプの state を管理する巨大フック。これを分離:

| 新フック | 責務 |
|---------|------|
| `use-team-base-form-model.ts` | 共通ロジック: 翻訳, teamPolicy取得, folders取得, attachments, `executeTeamEntrySubmit` フロー |
| 各フォーム内 inline useState | エントリタイプ固有のフィールドstate（個人フォームパターンに合わせる） |

**エントリタイプ別submitヘルパー**: `submitTeamPasswordForm` の全フィールドflat引数パターンを廃止し、エントリタイプ別submitヘルパー（例: `submitTeamCreditCardEntry`）を作成。関連フィールドのみ受け取り、内部で `saveTeamEntry()` に委任する。

### テスト (Phase 3b)

- ベースフックの単体テスト（policy/folders/attachments取得のワイヤリング）
- 主要エントリタイプ（login, creditCard, secureNote）のsubmitフロー単体テスト

### 3c: TeamNewDialog / TeamEditDialog の作成

`PasswordNewDialog` / `PasswordEditDialog` と同じパターン:

```tsx
// team-new-dialog.tsx
export function TeamNewDialog({ teamId, open, onOpenChange, onSaved, entryType, ... }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {entryType === ENTRY_TYPE.SECURE_NOTE ? (
          <TeamSecureNoteForm teamId={teamId} mode="create" variant="dialog" onSaved={handleSaved} />
        ) : entryType === ENTRY_TYPE.CREDIT_CARD ? (
          <TeamCreditCardForm teamId={teamId} mode="create" variant="dialog" onSaved={handleSaved} />
        ) : ... }
      </DialogContent>
    </Dialog>
  );
}
```

### 3d: 削除対象

Phase 3a-cの完了により不要になるファイル。プロダクションコードとテストコードに分類:

**プロダクションコード削除対象**:

| ファイル | 理由 |
|---------|------|
| `src/components/team/team-entry-specific-fields.tsx` | 630行の巨大switch → 各フォームに分散 |
| `src/hooks/use-team-password-form-state.ts` | → エントリタイプ別inline useStateに分離 |
| `src/hooks/use-team-password-form-controller.ts` | → エントリタイプ別controllerに分離 |
| `src/hooks/use-team-password-form-value-state.ts` | formStateの一部 → inline化 |
| `src/hooks/use-team-password-form-ui-state.ts` | formStateの一部 → inline化 |
| `src/hooks/use-team-password-form-model.ts` | → use-team-base-form-model + 各フォーム内 |
| `src/hooks/use-team-password-form-presenter.ts` | → 各フォーム内 |
| `src/hooks/use-team-password-form-derived.ts` | → 各フォーム内 |
| `src/hooks/use-team-password-form-derived-helpers.ts` | → 各フォーム内 |
| `src/hooks/team-password-form-presenter-card.ts` | → team-credit-card-form内 |
| `src/hooks/team-password-form-initial-values.ts` | → 各フォーム内 |
| `src/hooks/team-password-form-submit-args.ts` | → エントリタイプ別submitヘルパーに分離 |
| `src/hooks/team-entry-specific-fields-props.ts` | → 各フォームのprops構築に分散 |
| `src/hooks/team-entry-specific-fields-callbacks.ts` | → 各フォームのハンドラに分散 |
| `src/hooks/team-entry-specific-fields-text-props.ts` | → 各フォームの翻訳に分散 |
| `src/components/team/team-entry-specific-fields-types.ts` | → 各フォームの型定義に分散 |
| `src/hooks/team-entry-submit.ts` | → エントリタイプ別submitヘルパーに置換 |
| `src/components/team/team-password-form-actions.tsx` | → 各フォームのActionBarに分散 |

**テストコード削除対象**:

| ファイル | 理由 |
|---------|------|
| `src/components/team/team-entry-specific-fields.test.tsx` | 対象コンポーネント削除 |
| `src/hooks/team-entry-specific-fields-props.test.ts` | 対象フック削除 |
| `src/hooks/team-entry-specific-fields-callbacks.test.ts` | 対象フック削除 |

**注意**: 上記リストは既知のファイル。削除前に以下のgrepで網羅確認すること。

**維持するファイル** (削除リストから除外):

- `src/hooks/team-form-sections-props.ts` — Tags, Reprompt, Expiration, ActionBar等の共通セクションprops構築は全エントリタイプで共用するため維持

**削除前チェックリスト** (プロダクションコードとテストコードで分離grep):

```bash
# プロダクションコード参照チェック（削除対象ファイル自身を除く残存参照がゼロであること）
grep -r "use-team-password-form-state\|TeamPasswordFormState" src/ --include='*.ts' --include='*.tsx' --exclude='*.test.*'
grep -r "use-team-password-form-controller\|TeamPasswordFormController" src/ --include='*.ts' --include='*.tsx' --exclude='*.test.*'
grep -r "team-entry-specific-fields\|TeamEntrySpecificFields" src/ --include='*.ts' --include='*.tsx' --exclude='*.test.*'
grep -r "use-team-password-form-model\|useTeamPasswordFormModel" src/ --include='*.ts' --include='*.tsx' --exclude='*.test.*'
# team-entry-submit: 依存先 (team-password-form-actions等) のimportを先にエントリタイプ別submitヘルパーに切り替えてから削除
grep -r "team-entry-submit\|executeTeamEntrySubmit" src/ --include='*.ts' --include='*.tsx' --exclude='*.test.*'

# テストコード参照チェック（上記と同じパターン、テストファイルのみ）
grep -r "use-team-password-form-state\|TeamPasswordFormState" src/ --include='*.test.*'
grep -r "team-entry-specific-fields\|TeamEntrySpecificFields" src/ --include='*.test.*'
# 全て結果ゼロであることを確認してから削除（削除対象ファイル自身のヒットは除外して判断）
```

**型定義の移行先**: `TeamPasswordFormState` 型はベースフックの型定義ファイル（`use-team-base-form-model.ts` 内 or 独立した `team-form-types.ts`）に移行

---

## Phase 4: チームダッシュボード更新

以下のファイルを更新:
- `src/app/[locale]/dashboard/teams/[teamId]/page.tsx` — `TeamPasswordForm` の使用を `TeamNewDialog` + `TeamEditDialog` に置き換え
- **`src/components/team/team-archived-list.tsx`** — 同じく `TeamPasswordForm` を参照しているため更新。**editData 型を全エントリタイプのフィールドを網羅する型に拡張**し、非Loginエントリ編集時のフィールド消失を防止

個人ダッシュボードの `PasswordNewDialog` + `PasswordEditDialog` パターンに合わせる。

### UI権限分岐の追加

MEMBERが他人のエントリの編集ボタンを見れる問題（サーバーは403返却するがUI上は表示される）を修正:
- `createdBy.id === session.user.id` による分岐を追加し、MEMBERは自分のエントリのみ編集ボタンを表示

---

## 最終的なアーキテクチャ

```
新規作成フロー:
  個人: Dashboard → PasswordNewDialog → {PasswordForm | SecureNoteForm | CreditCardForm | ...}
  チーム: Dashboard → TeamNewDialog    → {TeamPasswordForm | TeamSecureNoteForm | TeamCreditCardForm | ...}

編集フロー:
  個人: Dashboard → PasswordEditDialog → {PasswordForm | SecureNoteForm | CreditCardForm | ...}
  チーム: Dashboard → TeamEditDialog    → {TeamPasswordForm | TeamSecureNoteForm | TeamCreditCardForm | ...}

フィールドコンポーネント (共有):
  src/components/entry-fields/
    ├── credit-card-fields.tsx     ← 両Vaultで共有, idPrefix対応
    ├── secure-note-fields.tsx     ← 両Vaultで共有, idPrefix対応
    ├── identity-fields.tsx        ← 両Vaultで共有, idPrefix対応
    ├── passkey-fields.tsx         ← 両Vaultで共有, idPrefix対応
    ├── bank-account-fields.tsx    ← 両Vaultで共有, idPrefix対応
    ├── software-license-fields.tsx← 両Vaultで共有, idPrefix対応
    └── form-fields.tsx            ← VisibilityToggleInput等

既存の共有コンポーネント (変更なし):
  src/components/passwords/
    ├── entry-login-main-fields.tsx    ← 既にLOGINタイプで共有済み
    ├── entry-custom-fields-totp-section.tsx
    ├── entry-reprompt-section.tsx
    ├── entry-expiration-section.tsx
    └── entry-form-ui.tsx (EntryActionBar等)
```

**「忘れ得ない」保証**: フィールドの追加・変更は `entry-fields/` の共通コンポーネントで行うため、個人・チーム両方に自動反映される。Vault固有のロジック（暗号化、API、ポリシー）のみが各フォームのラッパーに閉じ込められる。

---

## 実装順序

1. **Phase 1** (デッドコード削除) — 独立して安全に実行可能
2. **Phase 2** (共通フィールド) — Phase 1後に実施
3. **Phase 3a-c** (チームフォーム分離) — Phase 2後に実施。最大の変更
4. **Phase 3d** (旧コード削除) — Phase 3a-c完了後。削除前チェックリスト必須
5. **Phase 4** (ダッシュボード更新) — Phase 3完了後

---

## 検証

### 各Phase完了後の自動検証

```bash
npx vitest run          # 全テスト実行（必須）
npm run build           # 本番ビルド確認
npm run lint            # リント確認
```

### Phase 3d 実行前の追加確認

```bash
# プロダクションコード参照チェック
grep -r "旧モジュール名" src/ --include='*.ts' --include='*.tsx' --exclude='*.test.*'
# テストコード参照チェック
grep -r "旧モジュール名" src/ --include='*.test.*'
# 両方とも結果ゼロであること
```

### Phase別 手動テストマトリクス

| Phase | テスト範囲 |
|-------|----------|
| Phase 1完了後 | 個人Vault: LOGIN新規作成・編集がDialogで正常動作 |
| Phase 2完了後 | 個人Vault: 全7エントリタイプの新規作成（共通コンポーネント置き換え確認）。特に CreditCard のブランド自動検出、SecureNote のテンプレートセレクタ |
| Phase 3c完了後 | チームVault: 全7エントリタイプ x 新規/編集ダイアログの表示・保存 |
| Phase 4完了後 | チームダッシュボード + アーカイブリストからの新規作成・編集 E2Eフロー。チームポリシー適用の確認 |
