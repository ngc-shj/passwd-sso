# Code Review: unify-entry-id-to-uuid
Date: 2026-03-21
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### CF1 (Major → Resolved): teams/route.ts の optional guard 残存
- **File**: `src/app/api/teams/route.ts:127`
- **Problem**: `id` を required にしたのに `...(clientId ? { id: clientId } : {})` の optional guard が残存。スキーマが再び optional に戻された場合、AAD ミスマッチにつながる
- **Action**: `id: clientId` に変更

### CF2 (Minor → Resolved): 個人用ルートの UUID_RE が UUID v4 非限定
- **File**: `src/app/api/passwords/[id]/attachments/route.ts:174`
- **Problem**: UUID_RE がバージョン・バリアントビットを検証せず v1/v5 等も受け入れる。チーム用ルートとの非対称性
- **Action**: UUID v4 専用正規表現に変更

## Security Findings

### CS1 (Minor → Resolved): CF2 と同一（UUID_RE の v4 限定化）

## Testing Findings

### CT1 (Major → Resolved): bulk-* UUID テストに updateMany where clause assertion 追加
- **Files**: `bulk-archive/trash/restore/route.test.ts`
- **Action**: `expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: ... }))` を追加

### CT2 (Major → Resolved): rotate-key UUID テストに where clause assertion 追加
- **Files**: `vault/rotate-key/route.test.ts`, `teams/[teamId]/rotate-key/route.test.ts`
- **Action**: UUID ID が `updateMany` の where clause に渡されることを検証

### CT3 (Minor → Resolved): attachment テストで response.id 未検証
- **Files**: `attachments.test.ts`, `team-attachments.test.ts`
- **Action**: `expect(json.id).toBe(uppercaseId.toLowerCase())` を追加

## Adjacent Findings
なし

## Resolution Status

### CF1 Major — teams/route.ts optional guard
- Action: `...(clientId ? { id: clientId } : {})` → `id: clientId`
- Modified file: `src/app/api/teams/route.ts:127`

### CF2 Minor — UUID_RE v4 限定化
- Action: Regex を `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` に変更
- Modified file: `src/app/api/passwords/[id]/attachments/route.ts:174`

### CT1 Major — bulk-* where clause assertion
- Action: `mockUpdateMany.toHaveBeenCalledWith` assertion 追加
- Modified files: `bulk-archive/trash/restore/route.test.ts`

### CT2 Major — rotate-key where clause assertion
- Action: `updateMany.toHaveBeenCalledWith` assertion 追加
- Modified files: `vault/rotate-key/route.test.ts`, `teams/[teamId]/rotate-key/route.test.ts`

### CT3 Minor — attachment response.id assertion
- Action: `expect(json.id).toBe(uppercaseId.toLowerCase())` 追加
- Modified files: `attachments.test.ts`, `team-attachments.test.ts`
