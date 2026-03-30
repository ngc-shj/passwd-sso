# Coding Deviation Log: cli-oauth-auth
Created: 2026-03-30T12:35:00+09:00

## Deviations from Plan

### D-1: Phase A サーバー側変更は既に main に存在
- **Plan description**: Step 1-4 でサーバー側の MCP scope 追加、auth-or-token.ts dispatch、check-auth.ts 更新、audit.ts 更新を実装
- **Actual implementation**: Phase 6 (DCR) と Phase 7 (Zero-Knowledge CLI) のマージで既に main に含まれていた。新規コード追加は不要
- **Reason**: Phase 6/7 で MCP OAuth インフラ構築時に先行実装されていた
- **Impact scope**: なし（プランの意図通りの状態が既に存在）

### D-2: `mcp_token` + `userId: null` の TypeScript 型 narrowing 修正が追加で必要
- **Plan description**: Step 3a で `authOrToken` 直接呼び出しハンドラに guard 追加
- **Actual implementation**: `checkAuth` 経由のハンドラ（`api-keys/route.ts`, `api-keys/[id]/route.ts`, `passwords/[id]/route.ts`, `vault/status/route.ts`, `vault/unlock/data/route.ts`）でも `userId: string | null` 型の narrowing が必要で、`as string` キャストを追加
- **Reason**: `AuthResult` union に `mcp_token` (userId: string | null) が追加されたため、`service_account` を除外しただけでは TypeScript が `userId` を `string` に narrow できない
- **Impact scope**: 5 ファイルの型修正。ランタイム動作は変わらない（guard で null userId は事前排除済み）

### D-3: `api-client.ts` の `getToken()` を同期関数に変更
- **Plan description**: Step 9 で `getToken()` を `loadCredentials()` から全フィールド読み込みに変更
- **Actual implementation**: `loadCredentials()` が同期関数（keytar 除去後）のため、`getToken()` も `async` → 同期に変更
- **Reason**: keytar の非同期 API が不要になったため
- **Impact scope**: `getToken()` の呼び出し元は内部的に結果を使うだけなので影響なし

---
