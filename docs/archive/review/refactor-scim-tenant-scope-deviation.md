# コーディング差分記録: refactor/scim-tenant-scope
作成日時: 2026-03-05T00:00:00+09:00

## プランとの差分

### DEV-1: teams/[teamId]/members/[memberId]/route.ts の ScimExternalMapping 修正
- **プランの記述**: Step 1B で `ScimExternalMapping.teamId` カラムを削除する際、影響範囲として SCIM v2 API のみを想定
- **実際の実装**: チームメンバー削除エンドポイント (`DELETE /api/teams/[teamId]/members/[memberId]`) の `prisma.scimExternalMapping.deleteMany` も `teamId` を参照していた。`teamId: teamId` → `tenantId: target.tenantId` に変更
- **理由**: DB スキーマから `ScimExternalMapping.teamId` を削除したため、ビルド時に TypeScript エラーが発生。テナント ID は `TeamMember.tenantId` から取得可能
- **影響範囲**: `src/app/api/teams/[teamId]/members/[memberId]/route.ts` および対応テスト

---
