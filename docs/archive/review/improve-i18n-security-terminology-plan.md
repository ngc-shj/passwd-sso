# Plan: improve-i18n-security-terminology

## Objective

Improve the accuracy and consistency of Japanese security terminology across all i18n translation files (`messages/ja/*.json`). Only Japanese values change; no key renames, no English changes, no code changes.

## Requirements

### Functional
- All `messages/ja/*.json` value-only changes (keys remain identical to `messages/en/`)
- Existing i18n consistency tests (`messages-consistency.test.ts`, `audit-log-keys.test.ts`, `entry-form-translation-keys.test.ts`) must continue to pass
- Production build must succeed

### Non-functional
- Terminology aligned with Japanese security industry standards (IPA, JIS, NIST JP, major cloud vendor JP docs)
- Consistent within the application — the same English concept uses the same Japanese term everywhere

## Technical Approach

Value-only edits to `messages/ja/*.json` files. No structural changes.

## Implementation Steps

### 1. Unify "revoke" terminology → `取り消し`

**Rationale**: `取り消し` is the most widely used term in Japanese security UIs (AWS, Azure, Google). It clearly conveys an intentional, irreversible user action and does not overlap with `期限切れ` (expired), unlike `失効`.

**Rule**:
- `取り消し` = revoke (permanent invalidation of tokens, sessions, links, grants)
- `無効化` = deactivate (toggleable state for accounts/configs only)
- `期限切れ` = expired (time-based expiration)

| File | Key | Current | Proposed |
|------|-----|---------|----------|
| `AuditLog.json` | `API_KEY_REVOKE` | `API キーを失効` | `API キーを取り消し` |
| `AuditLog.json` | `SERVICE_ACCOUNT_TOKEN_REVOKE` | `サービスアカウントトークンを失効` | `サービスアカウントトークンを取り消し` |
| `AuditLog.json` | `SCIM_TOKEN_REVOKE` | `SCIM トークンを無効化` | `SCIM トークンを取り消し` |
| `AuditLog.json` | `DELEGATION_REVOKE` | `委任セッションを失効` | `委任セッションを取り消し` |
| `AuditLog.json` | `DELEGATION_EXPIRE` | `委任セッションが期限切れ` | (no change — this IS expiration) |
| `AuditLog.json` | `MCP_CONNECTION_REVOKE` | `MCP接続を無効化` | `MCP接続を取り消し` |
| `AuditLog.json` | `MCP_CONNECTION_REVOKE_ALL` | `すべてのMCP接続を無効化` | `すべてのMCP接続を取り消し` |
| `AuditLog.json` | `delegationRevokeMeta` | `{revokedCount} 件のセッションを失効（{reason}）` | `{revokedCount} 件のセッションを取り消し（{reason}）` |
| `ApiKey.json` | `revoke` | `失効` | `取り消し` |
| `ApiKey.json` | `revokeConfirmTitle` | `API キーを失効` | `API キーの取り消し` |
| `ApiKey.json` | `revokeConfirmDescription` | `即座にキーが無効化されます。…` | `即座にキーが取り消されます。…` |
| `ApiKey.json` | `revoked_toast` | `API キーを失効しました。` | `API キーを取り消しました。` |
| `ApiKey.json` | `revokeError` | `API キーの失効に失敗しました。` | `API キーの取り消しに失敗しました。` |
| `ApiKey.json` | `revoked` | `失効済み` | `取り消し済み` |
| `ApiKey.json` | `inactiveKeys` | `失効済み / 期限切れのキー（{count}）` | `取り消し済み / 期限切れのキー（{count}）` |
| `ApiKey.json` | `limitExceeded` | `…不要なキーを失効してください。` | `…不要なキーを取り消してください。` |
| `MachineIdentity.json` | `revokeToken` | `無効化` | `取り消し` |
| `MachineIdentity.json` | `tokenRevoked` | `無効化済み` | `取り消し済み` |
| `MachineIdentity.json` | `tokenRevoked2` | `トークンを無効化しました` | `トークンを取り消しました` |
| `MachineIdentity.json` | `tokenRevokeFailed` | `トークンの無効化に失敗しました` | `トークンの取り消しに失敗しました` |
| `MachineIdentity.json` | `tokenRevokeConfirm` | `トークン「{name}」を無効化しますか？` | `トークン「{name}」を取り消しますか？` |
| `MachineIdentity.json` | `tokenRevokeWarning` | `この操作は元に戻せません。このトークンを使用しているクライアントはアクセスできなくなります。` | (no change — content is correct) |
| `MachineIdentity.json` | `delegation.revokeAll` | `すべて失効` | `すべて取り消し` |
| `MachineIdentity.json` | `delegation.revoke` | `失効` | `取り消し` |
| `MachineIdentity.json` | `delegation.revoked` | `委任セッションを失効しました` | `委任セッションを取り消しました` |
| `MachineIdentity.json` | `delegation.revokedAll` | `すべての委任セッションを失効しました` | `すべての委任セッションを取り消しました` |
| `MachineIdentity.json` | `mcpConnections.revoke` | `無効化` | `取り消し` |
| `MachineIdentity.json` | `mcpConnections.revokeTitle` | `接続の無効化` | `接続の取り消し` |
| `MachineIdentity.json` | `mcpConnections.revokeDescription` | `この接続を無効化しますか？MCPクライアントはこのトークンを使用してアカウントにアクセスできなくなります。` | `この接続を取り消しますか？MCPクライアントはこのトークンを使用してアカウントにアクセスできなくなります。` |
| `MachineIdentity.json` | `mcpConnections.revokeSuccess` | `接続を無効化しました。` | `接続を取り消しました。` |
| `MachineIdentity.json` | `mcpConnections.revokeError` | `接続の無効化に失敗しました。` | `接続の取り消しに失敗しました。` |
| `MachineIdentity.json` | `mcpConnections.revokeAll` | `すべて無効化` | `すべて取り消し` |
| `MachineIdentity.json` | `mcpConnections.revokeAllTitle` | `すべての接続を無効化しますか？` | `すべての接続を取り消しますか？` |
| `MachineIdentity.json` | `mcpConnections.revokeAllDescription` | `すべてのアクティブなMCP接続が無効化されます。接続中のエージェントは即座にアクセスを失います。` | `すべてのアクティブなMCP接続が取り消されます。接続中のエージェントは即座にアクセスを失います。` |
| `MachineIdentity.json` | `mcpConnections.revokeAllSuccess` | `すべての接続を無効化しました（{count}件）` | `すべての接続を取り消しました（{count}件）` |
| `MachineIdentity.json` | `mcpConnections.revokeAllError` | `接続の無効化に失敗しました。` | `接続の取り消しに失敗しました。` |

**Additional files found by pre-screening (missed in initial analysis)**:

| File | Key | Current | Proposed |
|------|-----|---------|----------|
| `ApiErrors.json` | `extensionTokenRevoked` | `拡張機能トークンは無効化されています。` | `拡張機能トークンは取り消されています。` |
| `ApiErrors.json` | `scimTokenRevoked` | `SCIM トークンは無効化されています。` | `SCIM トークンは取り消されています。` |
| `ApiErrors.json` | `scimTokenLimitExceeded` | `…不要なトークンを無効化してください。` | `…不要なトークンを取り消してください。` |
| `ApiErrors.json` | `apiKeyLimitExceeded` | `…不要なキーを失効してください。` | `…不要なキーを取り消してください。` |
| `ApiErrors.json` | `apiKeyAlreadyRevoked` | `API キーは既に失効済みです。` | `API キーは既に取り消し済みです。` |
| `ApiErrors.json` | `saTokenAlreadyRevoked` | `サービスアカウントトークンは既に失効しています。` | `サービスアカウントトークンは既に取り消されています。` |
| `Team.json` | `scimTokenRevoke` | `無効化` | `取り消し` |
| `Team.json` | `scimTokenRevoked` | `トークンを無効化しました。` | `トークンを取り消しました。` |
| `Team.json` | `scimTokenRevokeConfirm` | `この SCIM トークンを無効化しますか？このトークンを使用している IdP は即座にアクセスを失います。` | `この SCIM トークンを取り消しますか？このトークンを使用している IdP は即座にアクセスを失います。` |
| `Team.json` | `scimTokenRevokedStatus` | `無効化済み` | `取り消し済み` |
| `MachineIdentity.json` | `saDeleteWarning` | `すべてのトークンも無効化されます。この操作は元に戻せません。` | `すべてのトークンも取り消されます。この操作は元に戻せません。` |

**Keep as `無効化` (deactivate/disable — toggleable state)**:
- `MachineIdentity.json`: `saDeactivateWarning` — SA deactivation, re-activatable
- `AuditLog.json`: `SCIM_USER_DEACTIVATE` — SCIM user deactivation
- `DirectorySync.json`: `forceRunDescription`, `logUsersDeactivated`, `safetyGuardTriggered` — user deactivation
- `TravelMode.json`: `disable`, `disableTitle`, `disableFailed` — feature toggle
- `TenantAdmin.json`: `deactivated` — account state
- `TeamPolicy.json`: `minPasswordLengthHelp` — feature toggle ("0で無効化")

### 2. Unify "credential" terminology → `認証情報`

**Rationale**: `認証情報` is the standard Japanese translation for "credentials" in password management and identity contexts (IPA, NIST JP). `資格情報` and `クレデンシャル` are understandable but inconsistent.

| File | Key | Current | Proposed |
|------|-----|---------|----------|
| `McpConsent.json` | `scopeDescriptions.credentials:use` | `ローカルエージェント経由でのクレデンシャル使用` | `ローカルエージェント経由での認証情報使用` |
| `McpConsent.json` | `scopeDescriptions.credentials:decrypt` | `クレデンシャルの一覧と使用（レガシー）` | `認証情報の一覧と使用（レガシー）` |
| `McpConsent.json` | `scopeDescriptions.team:credentials:read` | `チーム資格情報の読み取り` | `チーム認証情報の読み取り` |
| `AuditLog.json` | `DELEGATION_READ` | `委任された認証情報にアクセス` | (no change — already correct) |
| `AuditLog.json` | `delegationGetMeta` | `委任された認証情報を取得` | (no change — already correct) |

**Exclusion**: WebAuthn `credentialId` keys (`PasswordDetail.json`, `PasskeyForm.json`, `Share.json`, `PasswordCard.json`) use `クレデンシャルID` as a technical proper noun (WebAuthn Credential ID). These are NOT changed — they refer to a specific protocol identifier, not general "credentials".

### 3. Replace `グラント` with natural Japanese in Break Glass

**Rationale**: `グラント` is a katakana loanword not commonly used in Japanese security contexts. Replace with contextually appropriate natural Japanese.

| File | Key | Current | Proposed |
|------|-----|---------|----------|
| `Breakglass.json` | `activeGrants` | `有効なグラント` | `有効なアクセス許可` |
| `Breakglass.json` | `grantHistory` | `グラント履歴` | `アクセス許可の履歴` |
| `Breakglass.json` | `noGrants` | `Break-Glass グラントはありません。` | `Break Glass のアクセス許可はありません。` |
| `Breakglass.json` | `revokeConfirm` | `このグラントを取り消しますか？` | `このアクセス許可を取り消しますか？` |
| `Breakglass.json` | `revokeSuccess` | `グラントを取り消しました。` | `アクセス許可を取り消しました。` |
| `Breakglass.json` | `grantExpiresAt` | `グラントの有効期限: {expiresAt}` | `アクセス許可の有効期限: {expiresAt}` |
| `Breakglass.json` | `backToGrants` | `グラント一覧に戻る` | `アクセス許可一覧に戻る` |
| `Breakglass.json` | `selfAccessError` | `自分自身のBreak-Glassグラントは作成できません。` | `自分自身の Break Glass アクセス許可は作成できません。` |
| `Breakglass.json` | `duplicateGrantError` | `このユーザーへの有効なグラントがすでに存在します。` | `このユーザーへの有効なアクセス許可がすでに存在します。` |
| `Breakglass.json` | `grantExpired` | `このグラントは期限切れです。` | `このアクセス許可は期限切れです。` |
| `Breakglass.json` | `grantRevoked` | `このグラントは取り消し済みです。` | `このアクセス許可は取り消し済みです。` |
| `Breakglass.json` | `noActiveGrants` | `有効なグラントはありません。` | `有効なアクセス許可はありません。` |
| `Breakglass.json` | `grantCreated` | `アクセスが許可されました。24時間後に失効します。` | `アクセスが許可されました。24時間後に期限切れになります。` |

Note: `grantCreated` also changes `失効します` → `期限切れになります` for consistency with the "expire" vs "revoke" rule.

### 4. Normalize "Break Glass" spelling

**Rationale**: Standardize on `Break Glass` (two words, no hyphen) — the original English compound from fire safety.

| File | Key | Current | Proposed |
|------|-----|---------|----------|
| `Breakglass.json` | `noGrants` | `Break-Glass グラント…` | (covered in step 3) |
| `Breakglass.json` | `selfAccessError` | `…Break-Glassグラント…` | (covered in step 3) |
| `AuditLog.json` | `PERSONAL_LOG_ACCESS_REQUEST` | `Break-Glass アクセスを申請` | `Break Glass アクセスを申請` |
| `AuditLog.json` | `PERSONAL_LOG_ACCESS_VIEW` | `個人ログを参照（Break-Glass）` | `個人ログを参照（Break Glass）` |
| `AuditLog.json` | `PERSONAL_LOG_ACCESS_REVOKE` | `Break-Glass アクセスを取り消し` | `Break Glass アクセスを取り消し` |
| `AuditLog.json` | `PERSONAL_LOG_ACCESS_EXPIRE` | `Break-Glass アクセスが期限切れ` | `Break Glass アクセスが期限切れ` |
| `AuditLog.json` | `groupBreakglass` | `Break-Glass アクセス` | `Break Glass アクセス` |
| `AuditLog.json` | `subTabBreakglass` | `Break-Glass` | `Break Glass` |

### 5. Normalize "Watchtower" notation

**Rationale**: The feature name is `Watchtower` (English, as used in the Watchtower page title). Katakana `ウォッチタワー` in notifications is inconsistent.

| File | Key | Current | Proposed |
|------|-----|---------|----------|
| `Notifications.json` | `type_WATCHTOWER_ALERT` | `ウォッチタワー警告` | `Watchtower 警告` |

### 6. Fix `失効` → `期限切れ` where meaning is actually "expire"

The word `失効` in `grantCreated` refers to time-based expiration, not user-initiated revocation. Use `期限切れ` for clarity. (Covered in step 3, `Breakglass.json` `grantCreated` — no separate implementation needed.)

## Testing Strategy

1. `npx vitest run` — all i18n consistency tests must pass (key sets aligned, audit log keys present)
2. `npx next build` — production build must succeed
3. Manual review: all changed values are Japanese-only, no key changes

## Considerations & Constraints

- **No key changes**: English keys remain unchanged. Only Japanese values are modified.
- **No English changes**: `messages/en/*.json` is untouched.
- **No code changes**: No TypeScript/TSX files are modified.
- **Emergency Access**: Terms like `取り消し` for EA revoke, `権限` for EA grant are already correct and not changed.
- **`無効化` for SA deactivation**: Preserved because SA deactivation is a toggleable state, semantically different from revoke.
- **`saDeleteWarning`**: Included in step 1 — changes `無効化されます` → `取り消されます` (SA deletion is irreversible).

## User Operation Scenarios

1. **Admin revokes an API key**: Settings > Developer > API Keys > `取り消し` button → toast `API キーを取り消しました。` → key shows `取り消し済み`
2. **Admin revokes SA token**: Admin Console > Service Accounts > Tokens > `取り消し` button → confirm dialog → toast `トークンを取り消しました`
3. **User revokes MCP connection**: Settings > MCP > MCP Connections > `取り消し` button → confirm dialog `この接続を取り消しますか？` → toast `接続を取り消しました。`
4. **User revokes delegation session**: Settings > MCP > Delegated Access > `取り消し` button → toast `委任セッションを取り消しました`
5. **Admin views Break Glass grants**: Admin Console > Audit Logs > Break Glass → `有効なアクセス許可` section → `アクセス許可を取り消しますか？`
6. **User views audit log**: Audit log shows `API キーを取り消し`, `MCP接続を取り消し`, `委任セッションを取り消し` — all consistently use `取り消し`
7. **MCP OAuth consent**: Scope descriptions show `認証情報` consistently
