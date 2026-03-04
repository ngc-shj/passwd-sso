# プランレビュー: typed-dreaming-key.md
日時: 2026-03-04T18:30:00+09:00
レビュー回数: 2回目

## 前回からの変更

### 修正済み (10件)
| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| F1/S1/T3 | Critical | TOCTOU: executeVaultReset が updateMany の前に実行 | updateMany を先に実行するよう順序変更。テストに `not.toHaveBeenCalled()` 追加 |
| S2 | High | FORCE ROW LEVEL SECURITY 欠落 | 新マイグレーション `20260305020000` で追加 |
| F2 | High | proxy.ts に `/api/tenant` 保護なし | `pathname.startsWith(\`${API_PATH.API_ROOT}/tenant\`)` 追加 |
| T1 | High | admin-vault-reset-revoked テンプレートテスト欠如 | `admin-vault-reset-revoked.test.ts` 新規作成 (7テスト) |
| T2 | High | APP_URL 未設定時の 500 テスト欠如 | テストケース追加 |
| T4 | Medium | withTenantRls tenantId 検証欠如 | 3ファイルに named mock + tenantId assertion 追加 |
| S6 | Low | トークンバリデーション緩い | `z.string().length(64).regex(/^[0-9a-f]{64}$/)` に厳密化 |
| S5 | Low | Folder が vault reset で削除されない | `prisma.folder.deleteMany` 追加、テスト更新 |
| F5/F6 | Low | fetchHistory の useCallback + onRevoke | useCallback 化、onRevoke コールバック追加 |
| F7/S3 | Info | Revoke にロール階層チェックなし | デザインコメント追加（安全側の操作として意図的な非対称） |

### 妥当な理由でスキップ (5件)
| # | 重要度 | 指摘 | スキップ理由 |
|---|--------|------|-------------|
| F3 | Medium | useSession() への変更 | Auth.js v5 database session + fetchApi はプロジェクト統一パターン |
| F4 | Medium | tenant タブ表示制御 | 既存 SCIM タブと同構造。スコープ外 |
| S4 | Medium | Execute API レート制限 | 256-bit token + 認証必須。cost に見合わない |
| T5 | Medium | Rate limiter mock 順序依存 | Promise.all は仕様上入力順序保証。安定動作中 |
| T6/T7/T8 | Low | 各種テスト追加 | 別テストでカバー済み or サーバー生成値のみ |

## 機能観点の指摘
指摘なし

## セキュリティ観点の指摘
指摘なし

## テスト観点の指摘
指摘なし
