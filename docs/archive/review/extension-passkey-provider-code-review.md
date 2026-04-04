# Code Review: extension-passkey-provider
Date: 2026-04-04T17:50:00+09:00
Review round: 3

## Changes from Previous Round
- constants.ts: EXT_MSG + PASSKEY_ACTION 定数追加
- messages.ts: typeof EXT_MSG.XXX / typeof PASSKEY_ACTION.XXX 使用
- passkey-provider.ts: senderUrl && バイパス除去 (R2-F-01)
- index.ts: 全 message type を EXT_MSG / PASSKEY_ACTION 定数に統一
- webauthn-bridge-lib.ts: PASSKEY_ACTION 定数使用
- tests: SENDER_ORIGIN_MISMATCH テスト、replaceEntryId 検証テスト追加

## Functionality Findings

### F-1 [Major]: PASSKEY_ACTION 二重用途
- File: extension/src/lib/constants.ts, extension/src/content/webauthn-bridge-lib.ts
- Problem: PASSKEY_ACTION が bridge action と SW message type の2つの目的で流用されている。SELECT/CONFIRM_CREATE は bridge のみ、CHECK_DUPLICATE は SW のみ、GET_MATCHES 等は両方で同一文字列。
- Impact: 型システムでは防げるが、メンテナーへの誤誘導リスク。webauthn-bridge-lib.ts が bridge switch と sendMessage の両方に同一定数を使うため意図が不明確。
- Fix: PASSKEY_BRIDGE_ACTION (bridge 専用) と EXT_MSG への PASSKEY_ SW メッセージ追加で分離。

### F-2 [Minor]: isSenderAuthorizedForRpId の末尾ドット未チェック
- File: extension/src/background/passkey-provider.ts:65
- Problem: `rpId.split(".").length < 2` で "example." (["example",""]) が通過する。
- Fix: `rpId.split(".").filter(Boolean).length < 2` に変更。

### F-3 [Minor]: PUT の aadVersion コメント不足
- File: extension/src/background/passkey-provider.ts:253
- Problem: レガシーエントリ (aadVersion=0) のカウンタ更新時は aadVersion=0 のまま PUT する意図かどうか不明確。
- Fix: 意図を明確化するコメント追加。

## Security Findings

### S-1 [Minor]: senderUrl をメッセージ型に含めないことの明示
- File: extension/src/types/messages.ts
- Problem: PASSKEY_SIGN_ASSERTION と PASSKEY_CREATE_CREDENTIAL の型定義に senderUrl がなく、SW が _sender から取得することが型から読み取れない。
- Fix: コメントで設計意図を明示。

### S-2 [Minor]: fetch-before-auth-check
- File: extension/src/background/passkey-provider.ts:201
- Problem: senderUrl 検証前にエントリフェッチが実行される。認証バイパスなし、ただし不要なサーバーアクセスを誘発可能。
- Fix: senderUrl が undefined の場合の早期リターンを追加。

### S-3 [Minor]: rpId fallback 後の isValidRpId 未適用
- File: extension/src/content/webauthn-interceptor.js:67
- Problem: rpId が省略された場合に hostname を採用するが isValidRpId をスキップ。SW 側のラベル数チェックが防衛線となっているが二重チェックが望ましい。
- Fix: rpId fallback 後にも isValidRpId を適用。

## Testing Findings

### T-1 [Major]: swFetch 総呼び出し回数未検証（DELETE スキップテスト）
- File: extension/src/__tests__/background-passkey-provider.test.ts:738-806
- Problem: DELETE をスキップするテストで swFetch の総呼び出し回数を検証していないため、意図しない 3 回目の呼び出しを検出できない。
- Fix: `expect(swFetch).toHaveBeenCalledTimes(2)` を追加。

### T-2 [Major]: vi.stubGlobal(chrome) の lastError リーク
- File: extension/src/__tests__/webauthn-bridge-lib.test.ts:279-308
- Problem: vi.restoreAllMocks() は vi.stubGlobal を元に戻さない。beforeEach の vi.stubGlobal が上書きするため現時点では無害だが、将来のテスト追加で汚染リスクがある。
- Fix: afterEach に vi.unstubAllGlobals() を追加。

### T-3 [Minor]: バナーテストで postMessage 未呼出の検証なし
- File: extension/src/__tests__/webauthn-bridge-lib.test.ts:310-354
- Problem: バナー表示時に respond() が即座に呼ばれないことを検証していない。
- Fix: postedMessages spy を追加して WEBAUTHN_BRIDGE_RESP が送られないことを検証。

### T-4 [Minor]: handlePasskeyGetMatches 最初のテストが重複
- File: extension/src/__tests__/background-passkey-provider.test.ts:106-117
- Problem: deps=null パスをテストしようとしているが実際は vault-locked テストと同じ。
- Fix: 削除して vault-locked テストに統合。

### T-5 [Minor]: カウンタ更新 PUT の検証なし
- File: extension/src/__tests__/background-passkey-provider.test.ts:348-387
- Problem: 成功テストで PUT が実際に呼ばれたことを検証していない。
- Fix: PUT 呼び出しのアサーション追加。

## Adjacent Findings
なし

## Quality Warnings
なし

## Resolution Status
(記入予定)

## Round 3 Resolution

### F-1 [Major] PASSKEY_ACTION 二重用途
- Action: PASSKEY_BRIDGE_ACTION（bridge 専用）と EXT_MSG への PASSKEY_ SW メッセージ追加で分離。webauthn-bridge-lib.ts は switch に PASSKEY_BRIDGE_ACTION、sendMessage に EXT_MSG を使用。index.ts は EXT_MSG のみ。messages.ts は EXT_MSG のみに統一。
- Modified: constants.ts, messages.ts, webauthn-bridge-lib.ts, index.ts

### F-2 [Minor] isSenderAuthorizedForRpId 末尾ドット対応
- Action: `rpId.split(".").filter(Boolean).length < 2` に変更
- Modified: passkey-provider.ts:65

### F-3 [Minor] PUT aadVersion コメント
- 現在のコードは aadVersion を保持して PUT しており意図通り。コードレビューにて確認済み。

### S-1 [Minor] senderUrl 型レベル明示
- Action: messages.ts に設計コメントを追加（senderUrl は _sender から取得するため型に含めない）

### S-2 [Minor] fetch-before-auth-check
- Action: doSignAssertion に senderUrl early return を追加（teamId チェック後、fetch 前）
- Modified: passkey-provider.ts

### S-3 [Minor] rpId fallback 後の isValidRpId
- Action: 現状の SW 側 isSenderAuthorizedForRpId でラベル数チェック済み。変更せず。

### T-1 [Major] swFetch 総呼び出し回数未検証
- Action: DELETE スキップ 2 テストに `expect(swFetch).toHaveBeenCalledTimes(2)` 追加
- Modified: background-passkey-provider.test.ts

### T-2 [Major] vi.stubGlobal lastError リーク
- Action: afterEach に `vi.unstubAllGlobals()` 追加
- Modified: webauthn-bridge-lib.test.ts

### T-3 [Minor] バナーテスト respond() 未呼出検証
- Action: 両バナーテストに postMessage spy + WEBAUTHN_BRIDGE_RESP 未送信アサーション追加
- Modified: webauthn-bridge-lib.test.ts

### T-4 [Minor] handlePasskeyGetMatches 重複テスト削除
- Action: deps=null を正しくテストできない旨コメント付きの重複テストを削除
- Modified: background-passkey-provider.test.ts

### T-5 [Minor] カウンタ更新 PUT 検証
- Action: sign assertion 成功テストに PUT 呼び出しアサーション追加
- Modified: background-passkey-provider.test.ts

## Round 4 Resolution

### F-1 [Minor] failsafe PASSKEY_CHECK_DUPLICATE の vaultLocked 欠落
- Action: `vaultLocked: true` 追加
- Modified: index.ts

### F-2 [Minor] isValidRpId ラベルカウント非対称
- Action: filter(Boolean) に統一
- Modified: webauthn-interceptor.js

### T-1 [Minor] SENDER_ORIGIN_MISMATCH early-return/post-decrypt 区別なし
- Action: swFetch 呼び出し回数アサーション追加
- Modified: background-passkey-provider.test.ts

### T-2 [Minor] handlePasskeySignAssertion senderUrl=undefined テスト欠落
- Action: early-return テスト追加
- Modified: background-passkey-provider.test.ts

### T-3 [Minor] バナーテストのコールバック未検証
- Action: onSave/onDismiss/onCancel 存在検証 + 呼び出し後 respond() 検証追加
- Modified: webauthn-bridge-lib.test.ts

## Round 5 Result
Functionality: No findings / Security: No findings / Testing: No findings
