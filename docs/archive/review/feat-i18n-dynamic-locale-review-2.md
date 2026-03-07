# プランレビュー: happy-brewing-kite (i18n 動的ロケール対応) — 2回目
日時: 2026-02-28T18:30:00+09:00
レビュー回数: 2回目

## 前回からの変更

1回目レビューの指摘を反映:
- BCP 47 バリデーション追加、`JSON.stringify` による出力安全化
- `import()` → `fs.readFileSync` + `JSON.parse` に方針変更
- `deepMerge()` にプロトタイプ汚染対策追加
- 生成ファイルをバージョン管理に含める方針に変更
- `SECURITY_CRITICAL_NAMESPACES` を定義
- CI / Dockerfile に `i18n:discover` ステップ追加
- 新規テスト計画 T-A ~ T-D を追加

## 機能観点の指摘

### G-1 [低] Docker standalone でのパス順序 — 対応済み
プランに「standalone 展開後にコピー」の順序制約を明記。

### G-2 [スキップ] emergency-access.ts フォールバック
既にプランのステップ6に記載済み。

### G-3 [低] layout.ts の FOOTER に NOTE コメント — 対応済み
ステップ6に layout.ts への NOTE コメント追加を明記。

### G-4 [中] locale-utils.test.ts のハードコード期待値 — 対応済み
ステップ9に具体的な変更箇所（L15, L32, L33, L34）を明記。

### G-5 [低] Intl.DisplayNames の表記方式 — 対応済み
自国語表記（endonym）を採用することを明記。コード例も更新。

### G-6 [中] vitest --watch の無限ループ — 対応済み
生成内容が同一ならスキップする diff チェックを追加。

### G-7 [低] SECURITY_CRITICAL テスト分割方針 — 対応済み
ステップ7にテスト分割の具体的方針を明記。

## セキュリティ観点の指摘

**指摘なし** — 前回の S-1 ~ S-6 への対応はすべて十分と評価。

## テスト観点の指摘

### T-11 [スキップ] git diff と .gitignore の矛盾
プランでは既に「バージョン管理に含める」と明記済み。

### T-12 [低] emergencyInviteEmail("", ...) の期待値 — 対応済み
T-C に「en にフォールバックすること」を明記。
