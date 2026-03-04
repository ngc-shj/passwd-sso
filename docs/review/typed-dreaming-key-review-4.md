# プランレビュー: typed-dreaming-key.md (Batch E)

日時: 2026-03-04T15:00:00+09:00
レビュー回数: 4回目

## 前回からの変更

3回目の指摘を受けて以下を追加:
- Group A: 結合型 expiry 書き込みフォーマット、select 数値正規化完全一致、可視性テスト
- Group B: lastKnownBreachCount 方式、hook ライフサイクルテスト
- Group C: rate limit Redis キー設計、URL フラグメント方式、confirmation 英語固定
- Group D: keytar optionalDependencies、CLI 長寿命プロセス方式、credentials TOCTOU 防止、進捗ファイル制限

## 機能観点の指摘

### A-1: performAutofillForEntry に entryType が渡されない
- **問題:** SW 内で entryType による inject ファイル切り替えが必要だが、メッセージに entryType が含まれない。
- **推奨:** API レスポンスの entryType フィールドを使用。
- **判定: 採用** — Step 5 に追記。

### A-2: CC blob フィールド名対応の明示
- **判定: スコープ外** — 実装段階で既存 validations.ts と blob 構造を照合すれば自然に解決。

### B-1: auto-monitor の analyze() が既存 rate limit と衝突
- **推奨:** 既存 analyze() をそのまま呼び、サーバー側 5分 cooldown がマルチタブ重複を防止。
- **判定: 採用** — Step 2 に追記。

### B-2: encryptionKey effect と analyze 再生成の無限ループ
- **推奨:** useEffect 依存配列は [encryptionKey] のみ、analyze は ref 経由で参照。
- **判定: 採用** — Step 2 に追記。

### C-1: Group C 内容略記で権限モデル確認不能
- **判定: 不要** — エージェントへの入力の都合で略記しただけ。プランファイルには完全に記載済み。

## セキュリティ観点の指摘

### D-1(S): CLI 用 Extension token の TTL が実装 (15分) と矛盾
- **問題:** プランに 24h TTL と記載されているが、実装は 15分。
- **推奨:** 既存 15分 TTL を維持し、CLI 側で自動 refresh。
- **判定: 採用** — Step 3 を修正。

### B-1(S): newBreachCount の範囲バリデーション欠如
- **推奨:** Zod で `z.number().int().nonnegative().max(10000)` バリデーション追加。
- **判定: 採用** — Step 3 に追記。

## テスト観点の指摘

### T-B4: hasNewBreaches の件数減少テストケース
- **推奨:** `hasNewBreaches(2, 3) → false` ケース追加。
- **判定: 採用** — Step 8 に追記。

### T-B5: useEffect cleanup 実装方針
- **推奨:** `isMounted` フラグ方式を Step 2 に明記。
- **判定: 採用** — Step 2 に追記。

### T-C4: 2つの rate limiter の mock 設計
- **推奨:** `mockReturnValueOnce` で個別モック。
- **判定: 採用** — Step 9 を修正。
