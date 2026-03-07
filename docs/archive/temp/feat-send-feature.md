# コードレビュー: feat/send-feature
日時: 2026-02-20T20:54:00+09:00
レビュー回数: 3回目

## 前回からの変更
- F-14: ダウンロードアクセスログ追加 (fire-and-forget)
- S-11: fileBuffer.fill(0) による平文クリア
- F-15: maxViews の falsy チェック修正 (0 が false にならないよう `!= null`)
- T2-1: formatFileSize ユニットテスト 7ケース追加
- T2-2: magic byte 正常パステスト 2ケース追加
- T2-3: ENTRY_SHARE ダウンロード拒否テスト追加
- F-18: personal context "all" で org share を除外する修正

## ループ 1 (33件) → 修正 11件, スキップ 22件

## ループ 2 (11件) → 修正 6件, スキップ 5件

## ループ 3 (9件)

### 機能観点 (3件)

| ID | 重要度 | 概要 | 対応 |
|----|--------|------|------|
| F-18 | 中 | personal context "all" で org share 混入 | **修正済み** — `orgPasswordEntryId: null` 追加 |
| F-19 | 低 | SEND_EXPIRY_MAP 型安全性 | スキップ: Zod enum で実行時保護済み |
| F-20 | 低 | ダウンロード時メモリ使用量 | スキップ: 10MB 制限で許容、F-9 と同じ |

### セキュリティ観点 (3件)

| ID | 重要度 | 概要 | 対応 |
|----|--------|------|------|
| S-12 | 低 | download maxViews 未チェック | スキップ: F-1/S-1/F-13 と同じ。意図的設計 |
| S-13 | 低 | shareType パラメータ未知値の扱い | スキップ: "all" にフォールバック、auth 保護あり |
| S-14 | 情報 | sendName 平文保存 | スキップ: S-7 と同じ。設計上のトレードオフ |

### テスト観点

**指摘なし**

## 全修正一覧 (ループ 1-3)

| ID | 対応 | 修正ファイル |
|----|------|-------------|
| F-2 | `SEND_EXPIRY_MAP` を constants に抽出 | constants/share-type.ts, sends/route.ts, sends/file/route.ts |
| F-4 | `formatFileSize()` を共有ユーティリティに抽出 | format-file-size.ts, share-send-view.tsx, send-dialog.tsx, share-links/page.tsx |
| F-7 | ストレージ aggregate を `shareType: "FILE"` のみに | sends/file/route.ts:117 |
| F-8/S-6 | ハングル範囲追加 + CRLF 明示拒否 | validations.ts |
| F-10 | rate limit エラーを API_ERROR 定数に | download/route.ts |
| F-11/T-13 | 未使用 contentType prop 削除 | share-send-view.tsx, page.tsx |
| F-14/S-9 | ダウンロードアクセスログ (fire-and-forget) | download/route.ts |
| F-15 | maxViews null チェック修正 | share-send-view.tsx |
| F-18 | personal "all" から org share 除外 | mine/route.ts |
| S-11 | fileBuffer.fill(0) 平文クリア | sends/file/route.ts |
| T-1 | isValidSendFilename テスト 22ケース | validations-send.test.ts |
| T-3 | INVALID_JSON テスト | sends/route.test.ts |
| T-4 | INVALID_FORM_DATA テスト | sends/file.test.ts |
| T-5 | file フィールド未送信テスト | sends/file.test.ts |
| T-6 | 10MB 境界値テスト | sends/file.test.ts |
| T-11 | shareType=entry フィルタテスト | mine.test.ts |
| T2-1 | formatFileSize テスト 7ケース | format-file-size.test.ts |
| T2-2 | magic byte 正常パステスト 2ケース | sends/file.test.ts |
| T2-3 | ENTRY_SHARE ダウンロード拒否テスト | download.test.ts |

## 全スキップ一覧 (理由付き)

| ID | 理由 |
|----|------|
| F-1/S-1/F-13/S-12 | 意図的設計: download は viewCount チェックしない。page で increment 済み。maxViews=1 FILE で download 不可バグ回避 |
| F-3 | SEND_TEXT_TOO_LARGE は将来の直接サイズチェック用。現在 Zod で VALIDATION_ERROR (正常) |
| F-5 | F-18 で修正済み |
| F-6 | page 表示時に share_access_logs 記録済み。S-9 で download にもログ追加済み |
| F-9/F-20 | 10MB bytea 許容範囲。将来 blob-store 移行 |
| F-12 | タブ切替クリアは UX 改善、優先度低 |
| F-16 | ファイルタブの UI フィードバック改善、優先度低 |
| F-17 | contentType フォールバック改善、現在の実装で十分 |
| F-19 | Zod enum で実行時保護済み |
| S-2 | TOCTOU は rate limit で軽減。将来アトミック化検討 |
| S-3 | GCM 16byte 差は無視可能 |
| S-4 | rate limit 20/min で十分制限 |
| S-5 | 期限切れ自動削除は別 issue (cron job) |
| S-7/S-14 | sendName 平文は意図的設計。リスト表示用 |
| S-8 | IP rate limit はデプロイ構成で対応 |
| S-10 | メモリ使用は F-9/F-20 と同じ |
| S-13 | 未知 shareType は "all" フォールバック、auth 保護あり |
| T-2 | Zod スキーマはルートテストで間接カバー |
| T-7 | FormData mock の複雑さ対比で見送り |
| T-8 | Server Component は E2E に委譲 |
| T-9 | 復号エラーは暗号化ライブラリ責務 |
| T-10 | maxViews 境界は Zod 経由で既にカバー |
| T-12 | INVALID_CURSOR は既存コード、スコープ外 |

## 検証結果

- vitest: **2101/2101 passed** (253 files)
- lint: **clean**
- build: **success**
