# Plan Review: fix-invitation-callback-vault
Date: 2026-03-14T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 (Major): accept API が vault 未セットアップでも招待を消費 + InviteInfo 型不整合
- `alreadyMember: true` レスポンスに `role` フィールドが欠如 → `InviteInfo` 型不整合
- VaultGate が SETUP_REQUIRED で children をブロックするため auto-accept は vault setup 後にのみ発火するが、この依存関係がプランに明示されていない
- **Recommended**: Fix 4 で「vault 未 UNLOCKED 時は accept API を呼ばない」を明示。`alreadyMember: true` 時のレスポンスに `role` を含めるか `InviteInfo` 型をオプショナルに変更

### F2 (Major): Auth.js v5 コールバック実行順序の調査がブロッカーとして未定義
- 実装ステップ 1（調査）がステップ 2（修正）のブロッカーであることが曖昧
- **Recommended**: ステップ 1 を明示的なブロッカーとして定義

### F3 (Minor): searchParams は Next.js 16 で Promise 型
- Auth error ページの Server Component で `searchParams: Promise<{error?: string}>` として受け取り await が必要
- **Recommended**: Fix 2 の実装ノートに追加

## Security Findings

### S1 (Major): tenantClaimStorage AsyncLocalStorage コンテキスト境界
- signIn → createUser 間のコンテキスト伝播の正確性が未検証
- tenant claim が別リクエストに漏洩するリスク
- **Recommended**: 実装ステップ 1 の調査対象に追加

### S2 (Major): invitation accept の email 照合がエイリアス未対応
- `toLowerCase()` のみ、Gmail のドット正規化や `+tag` 除去なし
- **Recommended**: スコープ外として明示的に除外し、既知の制限として文書化

### S3 (Minor): proxy セッションキャッシュ TTL（30秒）
- 失効セッションが30秒間有効として扱われるが、route handler の `auth()` が最終防衛線
- **Recommended**: Security Considerations に既知のトレードオフとして記載

### S4 (Minor): App Router layout→children props 制約
- レイアウトから子ページへ直接 props を渡せない
- **Recommended**: React Context または `usePathname()` で対応

## Testing Findings

### T1 (Major): nodemailer プロバイダのテストが auth.test.ts に存在しない
- 全既存テストが `provider: "google"` のみ
- **Recommended**: nodemailer 新規ユーザー、bootstrap ユーザー、SSO ユーザーのテストケースを追加

### T2 (Major): VaultGate contextMessage prop 転送テストが欠落
- VaultGate → VaultSetupWizard への prop 転送テストが必要
- **Recommended**: テスト戦略に追加

### T3 (Major): SETUP_REQUIRED vs LOCKED の vault status テストケースが欠落
- 招待ページで両状態を個別にテストする必要がある
- **Recommended**: テスト戦略に追加

### T4 (Minor): Auth.js エラーコードの検証
- `AccessDenied` のケーシング、nodemailer 固有のエラーコードが未確認
- **Recommended**: 調査ステップで実際のエラーコードを確認し、テストに反映
