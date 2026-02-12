# 2-5 フォルダ / ネスト構造 — Plan

## Scope
- 対象: Personal + Org の両方
- 既存のタグに加えて階層フォルダを提供

## MVP Requirements
- フォルダ作成/編集/削除
- フォルダの階層（親子）
- エントリーをフォルダに割り当て（単一フォルダ）
- フォルダで絞り込み/表示
- サイドバーにツリー表示

## Implementation Plan
1. データモデル
- Folder テーブル追加
  - id, name, parentId, orgId(optional), userId(optional)
  - sortOrder, createdAt, updatedAt
- Entry に folderId を追加
  - Personal: passwordEntry
  - Org: orgPasswordEntry

2. API
- folders CRUD
  - POST /api/folders
  - GET /api/folders
  - PUT /api/folders/{id}
  - DELETE /api/folders/{id}
- entry update で folderId を受け付け

3. UI/UX
- サイドバーにフォルダツリー
- フォルダ作成/編集/削除ダイアログ
- エントリー作成/編集でフォルダ選択
- フォルダフィルタ適用

4. セキュリティ
- Org は org permission をチェック
- Personal は本人のみ

5. Tests
- API: folders CRUD / entry update
- UI: tree表示 / filter

## Detailed Scope (MVP)
### Folder Rules
- 最大階層: 5
- 同一親下での名前重複は不可
- ルートフォルダは parentId=null
- 削除時は子フォルダ/エントリーの扱いを選択
  - デフォルト: 子は親へ昇格、entryは未所属に

### Validation
- name: required, max 100
- parentId: cuid or null
- orgId/userId: cuid (排他)

### API Endpoints (Proposed)
- Personal
  - POST /api/folders
  - GET /api/folders
  - PUT /api/folders/{id}
  - DELETE /api/folders/{id}
- Org
  - POST /api/orgs/{orgId}/folders
  - GET /api/orgs/{orgId}/folders
  - PUT /api/orgs/{orgId}/folders/{id}
  - DELETE /api/orgs/{orgId}/folders/{id}

### API Field Checks (Proposed)
- name: required, max 100
- parentId: optional, cuid
- orgId/userId: required depending on scope
- folderId (entry update): optional, cuid

## Open Questions
- 削除時の挙動（子フォルダの扱い）を固定で良いか
- エントリーの複数フォルダ割当を将来やるか
- 並び順の管理方法（drag & drop or manual）
