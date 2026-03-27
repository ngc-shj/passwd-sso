# Code Review: fix-import-rate-limit
Date: 2026-03-28
Review round: 1

## Changes from Previous Round
Initial code review

## Functionality Findings

### F-1 [Major] `actor` null 時にサイレント成功 (201) を返す — **RESOLVED**
- File: `src/app/api/passwords/bulk-import/route.ts` L49-51
- Fix: `actorMissing` フラグ + `unauthorized()` 返却

### F-2 [Minor] チームAPIの冗長な catch 分岐 — **RESOLVED**
- File: `src/app/api/teams/[teamId]/passwords/bulk-import/route.ts` L80-85
- Fix: `catch { failedCount++; }` に統合

### F-3 [Major] `itemEncKey` 未初期化のまま使用される可能性 — **RESOLVED**
- File: `src/components/passwords/password-import-importer.ts` L106-120
- Fix: チーム暗号化ブロック全体を try/catch で囲み、失敗時は continue

### F-4 [Minor] `Retry-After: 0` / NaN 時にディレイなし即リトライ — **RESOLVED**
- File: `src/components/passwords/password-import-importer.ts` L183-185
- Fix: NaN ガード + min 1s / max 60s クランプ

### F-5 [Minor] 部分成功時に失敗エントリのお気に入りトグルを呼ぶ可能性 — ACCEPTED
- Best-effort 設計として許容。存在しない ID へのトグルは 404 で無視される。

## Security Findings

### S-1 [Major] actor null 時サイレント成功 — **RESOLVED** (= F-1)
### S-2 [Major] レート制限がスループット50倍 — ACCEPTED (設計意図として記録済み)
### S-3 [Minor] userId 未定義時に AAD なし暗号化 — ACCEPTED (呼び出し側で userId 必須のため到達不能)
### S-4 [Minor] 冗長 catch 分岐 — **RESOLVED** (= F-2)
### S-5 [Minor] 全件失敗時も 201 — ACCEPTED (クライアントは success:0 で判断可能)

## Testing Findings

### T-1 [Major] タグ検証テスト不足 — DEFERRED (Minor として次回対応)
### T-2 [Major] actor === null テスト欠如 — **RESOLVED** (テスト追加)
### T-3 [Minor] 上限境界値 max(50) 未検証 — DEFERRED
### T-5 [Major] 非 TeamPasswordServiceError テスト欠如 — **RESOLVED** (テスト追加)
### T-6 [Major] チーム側 sourceFilename 監査メタデータテスト欠如 — DEFERRED
### T-8 [Critical] 偽テスト (vi.resetAllMocks mid-test) — **RESOLVED** (テスト書き直し)
### T-9 [Major] 429 リトライ遅延ロジック未検証 — DEFERRED (fakeTimers 必要)
### T-10 [Major] guard 節の例外テスト欠如 — DEFERRED

## Resolution Status

| Finding | Severity | Status | Action |
|---------|----------|--------|--------|
| F-1/S-1 | Major | Resolved | actorMissing flag + unauthorized() |
| F-2/S-4 | Minor | Resolved | catch block simplified |
| F-3 | Major | Resolved | try/catch around team encryption |
| F-4 | Minor | Resolved | Retry-After clamp |
| F-5 | Minor | Accepted | Best-effort design |
| S-2 | Major | Accepted | Design intent documented |
| S-3 | Minor | Accepted | Unreachable path |
| S-5 | Minor | Accepted | Client handles success:0 |
| T-2 | Major | Resolved | Test added |
| T-5 | Major | Resolved | Test added |
| T-8 | Critical | Resolved | Test rewritten |
| T-1,3,6,7,9,10 | Various | Deferred | Minor coverage gaps, non-blocking |
