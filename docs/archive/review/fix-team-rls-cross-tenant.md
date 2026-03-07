# コードレビュー: fix/team-rls-cross-tenant
日時: 2026-03-01T12:30:00+09:00
レビュー回数: 2回目（2回目で全観点クリア）

## レビュー1回目: RLS修正・クロステナント識別 (e0f4496〜74a80f5)

### 機能観点の指摘 (2件)

| ID | 重要度 | 状態 | 概要 |
|----|--------|------|------|
| F-1 | 高 | 修正済み | `getTeamParent` に `userId` が渡されている（バグ） |
| F-2 | 低 | 修正済み | `GET /api/teams` の不要な try-catch（dead code） |

### セキュリティ観点の指摘

- 指摘なし（`withBypassRls` 使用箇所は全て安全、IDOR リスクなし）

### テスト観点の指摘 (1件)

| ID | 重要度 | 状態 | 概要 |
|----|--------|------|------|
| T-2 | 中 | 修正済み | RLSコンテキスト呼び出しの引数検証不足 |

### 対応

- F-1: `getTeamParent` シグネチャを `(teamId, folderId)` に変更、呼び出し元修正
- F-2: try-catch 除去、`withBypassRls` 直接呼び出しに変更
- T-2: GET /api/teams に `withBypassRls` 引数検証追加、invitations/accept に 3種RLS検証追加

## レビュー2回目: UI改善コミット (6a4aefd〜2bfcb97)

対象コミット:
- `6a4aefd` fix: navigate to team settings page from personal vault team list
- `24f51bc` fix: highlight active sidebar item for settings, export, and import
- `6c2bfb9` feat: improve team audit log display with email and layout
- `2bfcb97` feat: add email to team password createdBy and improve card layout

### 機能観点の指摘 (2件)

| ID | 重要度 | 状態 | 概要 |
|----|--------|------|------|
| F-3 | 低 | 修正済み | テストモックデータに `email` 欠落（audit-logs 3箇所, passwords 2ファイル） |
| F-4 | 低 | スキップ | `password-card.tsx` の `createdBy` 表示に `isTeamMode` ガードなし（現状実害なし、設計意図通り） |

### セキュリティ観点の指摘

- **指摘なし**
- メールアドレス(PII)の新規公開は、既存の認証・認可・RLS（FORCE RLS）の枠内で適切に保護されている
- 監査ログは ADMIN/OWNER 限定（`TEAM_UPDATE`）、パスワード一覧は同一チームメンバー限定（`PASSWORD_READ`）
- XSS リスクなし（React JSX テンプレート + next-intl のエスケープ）

### テスト観点の指摘

- **指摘なし**（F-3 のモックデータ修正で吸収）
- 監査ログテスト: email のモック・アサーション・Prisma select 検証済み
- サイドバーテスト: 新規プロパティの baseProps 追加済み

### 対応

- F-3: 以下5ファイルのモックデータに `email` フィールド追加
  - `src/__tests__/api/teams/audit-logs.test.ts` (L321, L384, L433)
  - `src/app/api/teams/[teamId]/passwords/route.test.ts` (L104-105, L286-287)
  - `src/app/api/teams/[teamId]/passwords/[id]/route.test.ts` (L90-91)
- F-4: スキップ（個人ボールト側は `createdBy` を渡さないため実害なし）

## 総合サマリ

| 判定 | 件数 | 指摘ID |
|------|------|--------|
| 修正済み | 4 | F-1, F-2, F-3, T-2 |
| スキップ | 1 | F-4（設計意図通り） |
| 指摘なし | — | セキュリティ全観点、テスト2回目 |

テスト結果: 303ファイル / 2768テストケース 全パス
