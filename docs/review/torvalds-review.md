# プランレビュー: zany-greeting-torvalds.md (Batch C: P0 セキュリティ基盤強化)

日時: 2026-02-20T12:00:00+09:00
レビュー回数: 1回目

## 前回からの変更

初回レビュー

## 機能観点の指摘 (14件)

### F-1: DuplicateGroup 型未定義 → ✅ プランに定義済み (Step 4a)
### F-2: calculateScore 重み変更で既存テスト破壊 → ✅ プランに反映 (Step 10a スコア期待値更新)
### F-3: expiresAt の格納方針 (DB vs blob) → ✅ スコープ決定事項で方針 (A) DB列を明記
### F-4: Org 側の expiresAt 対応欠落 → ✅ スコープ決定事項で後続バッチに明記
### F-5: Org パスワードフォーム変更漏れ → ✅ 後続バッチへの申し送りに含む
### F-6: PasswordCard に expiresAt が渡されるパス → ✅ Step 3 で API レスポンス追加、Step 8 で props + 呼び出し元を明記
### F-7: Export/Import への expiresAt 対応 → ✅ 後続バッチへの申し送りに含む
### F-8: personal-entry-save.ts への追加漏れ → ✅ Step 7b #1 で SavePersonalEntryParams 明記
### F-9: フォームチェーン9ファイルの詳細 → ✅ Step 7b で全9ファイル + 具体的変更内容を記載
### F-10: 有効期限検出の仕様不明確 → ✅ Step 4c で条件を明確化 (expired + expiring soon 両方検出)
### F-11: Org API パスの誤記 (org → orgs) → ✅ 後続バッチ申し送りで正しいパス使用
### F-12: WatchtowerReport 型拡張 → ✅ Step 4a で明記
### F-13: IssueSection の IssueType 拡張方針 → ✅ Step 6a で expiring は IssueType、duplicate は独立コンポーネント
### F-14: Org の Watchtower 未対応 → ✅ 後続バッチ申し送りに含む

## セキュリティ観点の指摘 (6件)

### S-1: expiresAt 平文 DB 列が E2E モデルと矛盾 → ✅ スコープ決定事項で requireReprompt と同じ前例を根拠に方針 (A) を選択
### S-2: OrgPasswordEntry の認可設計未記載 → ✅ Org 側は後続バッチ (認可は既存パターン踏襲)
### S-3: new URL() 例外ハンドリング → ✅ Step 4b で normalizeHostname 関数に try-catch を含む
### S-4: hostname 正規化不足 (www. prefix) → ✅ Step 4b で www. 除去を追加
### S-5: calculateScore 重み合計 → ✅ Step 4e で合計100% を明記 (40+25+20+5+5+5)
### S-6: 過去日バリデーション → ✅ Step 7a で UI 側 min 制限、API 側は制限なし (設計判断として記載)

## テスト観点の指摘 (11件)

### T-1: API テストファイルパス誤り → ✅ Step 10c で正しいパス src/app/api/passwords/route.test.ts に修正
### T-2: expiresAt バリデーションテスト欠落 → ✅ Step 10c で expiresAt フィールドのテスト追加
### T-3: 重複検出の境界条件不足 → ✅ Step 10a で 3エントリー重複、www. 正規化、大文字小文字テスト追加
### T-4: 30日閾値の定数化 → ✅ Step 4a で EXPIRING_THRESHOLD_DAYS = 30 を export
### T-5: calculateTotalIssues の型拡張 → ✅ Step 5a + Step 10b で既存テスト更新明記
### T-6: makeRawEntry ヘルパー更新 → ✅ Step 10a に明記
### T-7: jsdom 環境指定 → ✅ Step 10d で // @vitest-environment jsdom を明記
### T-8: DuplicateGroup 型定義 → ✅ Step 4a で定義済み
### T-9: personal-form-sections-props.test.ts 更新 → ✅ Step 10d で createState() ヘルパー更新内容を明記
### T-10: スコア計算の既存テスト更新 → ✅ Step 10a で期待値更新を明記
### T-11: fixtures.ts の makePasswordEntry 更新 → ✅ Step 10c に明記

## 対応状況

全指摘をプランに反映済み。
