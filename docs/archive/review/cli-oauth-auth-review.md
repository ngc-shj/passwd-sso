# Plan Review: cli-oauth-auth
Date: 2026-03-30T03:30:00+09:00

## Round 1

### Changes from Previous Round
Initial review

### Functionality Findings
- F-1 [Critical]: `mcp_token` + `userId: null` による既存エンドポイント破壊 → **Resolved (Step 3)**
- F-2 [Major]: `scope-parser.ts` に `vault:unlock-data` 未登録 → **Resolved (Step 1b)**
- F-3 [Major]: `resolveActorType()` 未対応 → **Resolved (Step 3b)**
- F-4 [Major]: `enforceAccessRestriction` 未対応 → **Resolved (Step 3)**
- F-5 [Major]: スコープ名前空間マッピング未明示 → **Resolved (設計方針追記)**
- F-6 [Minor]: `tokenExpiresAt` 削除未明示 → **Resolved (Step 9)**

### Security Findings
- S-1 [Major]: `enforceAccessRestriction` null userId → **Resolved (F-4 統合)**
- S-2 [Major]: スコープバリデーション不整合 → **Resolved (Step 5)**
- S-3 [Major]: OAuth state 検証未記載 → **Resolved (Step 5)**
- S-4 [Minor]: IPv6 バインド → Acknowledged
- S-5 [Minor]: HTTPS 強制 → **Resolved (Step 5)**

### Testing Findings
- T-1 [Critical]: mock レスポンス旧形式 → **Resolved (Step 11)**
- T-2 [Critical]: saveToken mock 空洞化 → **Resolved (Step 11)**
- T-3 [Major]: PKCE テストベクトル → **Resolved (Step 11)**
- T-4 [Major]: config.test.ts gaps → **Resolved (Step 11)**
- T-5 [Major]: タイムアウトテスト → **Resolved (Step 11)**
- T-6 [Minor]: null refresh skip → **Resolved (Step 11)**
- T-7 [Adjacent/Major]: auth-or-token.test.ts 不在 → **Resolved (Step 4)**

---

## Round 2

### Changes from Previous Round
Round 1 の全 findings をプランに反映。Step 1b, 3, 3b, 4, 5, 9, 11 を更新。Critical Files 拡張。設計方針追記。

### Functionality Findings
- F-1 (R2) [Critical → New]: `authOrToken` 直接呼び出しハンドラ（`/api/passwords/route.ts` 等）への `mcp_token` guard が未計画 → **Resolved (Step 3a 追加)**
- F-2/F-3 (R2): 「実装未反映」指摘 → プランレビュー段階のため非該当
- F-4 (R2) [Major]: TypeScript 型 narrowing 方針 → 実装時に解決（Step 2 の AuthResult 設計で対処）
- F-5 (R2) [Major]: `vault:unlock-data` の `VALID_RESOURCE_ACTIONS` → F-2 と同根、Step 1b で解決済み
- F-6 (R2) [Minor]: `mcp_token` の `tenantId` 直接渡し最適化 → 記録のみ（実装時に検討）

### Security Findings
- S-6 [Minor/New]: `resolveUserTenantId` の `mcp_token` 動作 → extension token と同等。記録のみ
- S-7 [Minor/New]: consent state 最大長バリデーション → 対処任意（RFC 準拠済み）
- S-8 [Minor/New]: refreshToken plaintext 保存のトレードオフ → **Resolved (Considerations に追記)**
- S-9 [Critical/New]: `KNOWN_PREFIXES` 未追加リスク → Step 2 に記載済み + Step 4 テストで gate 保証。**Resolved**
- S-10 [Minor/New]: localhost SSRF → RFC 8252 準拠、対処不要
- S-11: コールバックサーバー設計 → No finding

### Testing Findings
- QA-1 [Critical/New]: `saveCredentials` アサーション仕様未定義 → **Resolved (Step 11 に 4 フィールド全検証追加)**
- QA-2 [Major/New]: `mcp_token` + `userId: null` テスト → **Resolved (Step 4 に追加)**
- QA-3 [Major/New]: state 欠如ケーステスト → **Resolved (Step 11 に追加)**
- QA-4 [Minor/New]: `deleteCredentials` テスト → **Resolved (Step 11 に追加)**
- QA-5 [Minor/New]: `openBrowser` ヘッドレス検出テスト → 記録のみ（環境依存のため unit test 困難）
- QA-6 [Major/New]: `resolveActorType` テスト追加先が曖昧 → **Resolved (Step 4 に `src/__tests__/audit.test.ts` 明記)**
- QA-7 [Minor/New]: `check-auth.ts` mcp_token 除外テスト → Step 4 の auth-or-token.test.ts に含まれる

### Adjacent Findings
None

### Quality Warnings
None

---

## Round 3

### Changes from Previous Round
Round 2 の全 findings をプランに反映。Step 3a 追加（authOrToken 直接呼び出しハンドラの guard）。Critical Files に passwords/route.ts、audit.test.ts 追加。Step 4/11 テスト仕様詳細化。Considerations にセキュリティトレードオフ追記。

### Functionality Findings
- F-1 R3 [Major/New]: Step 3a の guard 条件式が曖昧 → **Resolved（条件式をプランに明示）**
- F-4 R3 [Major/New]: `resolveActorType` の exhaustive check 欠如 → **Resolved（`never` assertion 追記）**
- F-2/F-3 R3: 「実装未反映」再指摘 → プランレビュー段階のため非該当（Step 1/1b で計画済み）
- F-5 R3 [Minor]: `check-auth.ts` narrowing → Step 3 guard で対処（Step 3a 条件式で型保証）

### Security Findings
- S-9 R3: `KNOWN_PREFIXES` 再指摘 → 非該当（プラン Step 2 に記載済み、実装前）
- S-12 [Major/New]: `userId: null` が Prisma `where` に伝播 → F-1 R3 と同根、Step 3a guard 条件式で対処
- S-8 追加 [Minor]: Windows `O_NOFOLLOW ?? 0` フォールバック → 記録のみ（既存実装と同等）
- S-13 [Minor]: scope 文字列 `.replace` 二重変換リスク → 記録のみ（既存挙動）

### Testing Findings
- QA-8/9/10/11: テストファイル未更新の再指摘 → プランレビュー段階のため非該当（Step 11 に仕様記載済み）
- 推奨: 各 Step 実装直後にテスト更新（Step 6/9 実装 → 直後に Step 11 テスト更新の順序を遵守）

### Adjacent Findings
None

### Quality Warnings
None
