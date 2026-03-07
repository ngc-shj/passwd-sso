# Phase 1-3 バッチ実装計画

作成日: 2026-02-18

## 背景

P0 (S-1 クリップボード自動クリア, S-2 マスターパスワード再確認) が完了。
残りの P0 (#69 N-4) および P1 (#70-#75) を効率的に進めるためのバッチ計画。

---

## 依存関係マップ

```
N-1 Email Infrastructure (#74)
 └─→ N-4 Emergency Access Email (#69)  ← P0 唯一の残り
 └─→ S-6 New Device Login Notification (#77, P2, 将来)
 └─→ V-4 Password Expiry Reminders (将来)

V-1 Folders (#70) ─── 独立
V-2 Entry History (#71) ─── 独立
C-1 Send (#73) ─── 独立 (既存 PasswordShare 拡張)
B-1 SCIM (#75) ─── 独立
X-5 Auto-detect Logins (#72) ─── 独立 (拡張機能のみ)
```

**クリティカルパス:** N-1 → N-4 (メール基盤がないと通知が送れない)

---

## バッチ構成

### Batch A: Vault 管理強化 — V-1 + V-2

**Issue:** #70, #71
**根拠:** 同じ PasswordEntry 周辺の DB マイグレーション + API + UI。1回の PR でスキーマ変更をまとめる。

| 項目 | V-1 フォルダ | V-2 変更履歴 |
|------|-------------|-------------|
| 新テーブル | `Folder` (id, userId, name, parentId, sortOrder) | `PasswordEntryHistory` (id, entryId, encryptedBlob, blobIv, blobAuthTag, keyVersion, changedAt) |
| 既存変更 | `PasswordEntry` に `folderId` 追加 | なし |
| API | CRUD 4 エンドポイント + Org 4 | GET history, GET revision, POST restore |
| UI | サイドバーフォルダツリー, D&D 移動 | 詳細画面に「履歴」タブ, 復元ボタン |
| 設計参考 | `docs/archive/folders-nesting.md` | — |

**注意点:**
- フォルダ最大深度 5 で制限 (循環参照防止)
- 履歴保持: 90 日 or 20 件の上限
- 暗号化ブロブはそのままコピー保存 (サーバーは復号不要)

---

### Batch B: Send 機能 — C-1

**Issue:** #73
**根拠:** 既存 `PasswordShare` モデルの拡張で済む。スキーマ変更が小さく単独で完結。

| 項目 | 内容 |
|------|------|
| スキーマ変更 | `PasswordShare` に `shareType` (ENTRY/TEXT/FILE) + `textContent` 追加 |
| API | 既存 `/api/share-links` を拡張 |
| UI | 新規 Send 作成ダイアログ, 公開ページ `/s/{token}` の TEXT/FILE 表示対応 |
| 再利用 | 期限・閲覧数制限・パスワード保護・アクセスログはすべて既存基盤 |

---

### Batch C: メール基盤 + 緊急アクセス通知 — N-1 + N-4

**Issue:** #74, #69
**根拠:** N-4 は N-1 なしでは実装不可。N-1 単体では価値が薄い。まとめて実装し、最初の利用者 (N-4) まで一気に通す。

| 項目 | N-1 メール基盤 | N-4 緊急アクセス通知 |
|------|--------------|-------------------|
| 新テーブル | `UserNotificationPreference`, `EmailLog` | なし (既存 EmergencyAccessGrant を利用) |
| インフラ | メールプロバイダ SDK (Resend or SendGrid), テンプレートエンジン | — |
| API | GET/POST `/api/user/notification-preferences` | なし (内部トリガー) |
| トリガー | — | EmergencyAccessGrant ステート遷移時 (PENDING→WAITING→ACTIVATED) |
| UI | 設定画面に通知設定セクション | — |

**メールプロバイダ候補:**
- Resend (シンプル API, React Email テンプレート対応)
- SendGrid (実績豊富, 無料枠あり)
- Amazon SES (低コスト, AWS 利用時)

---

### Batch D: SCIM プロビジョニング — B-1

**Issue:** #75
**根拠:** エンタープライズ専用で他機能と結合点がない。独立して進められる。

| 項目 | 内容 |
|------|------|
| 新テーブル | `SCIMToken`, `SCIMMapping` |
| API | SCIM 2.0 準拠: `/api/scim/v2/Users`, `/api/scim/v2/Groups` + discovery エンドポイント |
| 対応 IdP | Okta, Azure AD, Google Workspace |
| 設計参考 | `docs/archive/scim-provisioning.md` |

---

### Batch E: 拡張機能 — X-5

**Issue:** #72
**根拠:** サーバー側スキーマ変更なし。拡張機能の Content Script 修正のみ。

| 項目 | 内容 |
|------|------|
| スキーマ変更 | なし |
| 拡張側 | form submit / fetch / XHR インターセプト → 「保存しますか？」通知 |
| API | 既存 `POST /api/passwords` を利用 |
| 既存基盤 | `form-detector.ts`, `ExtensionToken`, Background Worker |

---

## 実装順序

```
Week 1-2: ┌─ Batch A (V-1 + V-2) ──────────────────┐
          │  DB migration × 2, API, UI              │
          └─────────────────────────────────────────┘
          ┌─ Batch B (C-1 Send) ────────┐
          │  Schema extend, UI          │
          └─────────────────────────────┘

Week 3-4: ┌─ Batch C (N-1 + N-4) ──────────────────┐
          │  Email infra → emergency notifications  │
          └─────────────────────────────────────────┘
          ┌─ Batch E (X-5 Auto-detect) ─┐
          │  Extension content script    │
          └─────────────────────────────┘

Week 5+:  ┌─ Batch D (B-1 SCIM) ───────────────────┐
          │  SCIM 2.0 endpoints, IdP integration    │
          └─────────────────────────────────────────┘
```

**並列可能:**
- Batch A と B は完全に独立 → 同時着手可
- Batch C と E も独立 → 同時着手可
- Batch D はいつでも開始可能だが工数が大きいため後半に配置

---

## DB マイグレーション一覧

| Batch | マイグレーション | 新テーブル | 既存変更 |
|-------|----------------|-----------|---------|
| A | `add_folders` | `Folder` | `PasswordEntry.folderId` |
| A | `add_entry_history` | `PasswordEntryHistory` | — |
| B | `add_send_feature` | — | `PasswordShare.shareType`, `.textContent` |
| C | `add_notification_infra` | `UserNotificationPreference`, `EmailLog` | — |
| D | `add_scim` | `SCIMToken`, `SCIMMapping` | — |

---

## Issue → Batch マッピング

| Issue | Feature | Batch | Priority |
|-------|---------|-------|----------|
| #69 | N-4 緊急アクセス通知 | **C** | P0 |
| #70 | V-1 フォルダ | **A** | P1 |
| #71 | V-2 変更履歴 | **A** | P1 |
| #72 | X-5 ログイン自動検出 | **E** | P1 |
| #73 | C-1 Send | **B** | P1 |
| #74 | N-1 メール基盤 | **C** | P1 |
| #75 | B-1 SCIM | **D** | P1 |
