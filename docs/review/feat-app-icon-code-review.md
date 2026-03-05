# Code Review: feat/app-icon
Date: 2026-03-06
Review rounds: Session 1 Round 1-2

## Round 1 Findings

### FUNC-High-1: proxy.ts の静的ファイルスキップパターンが過度に広い
- **File**: `proxy.ts:11`
- **Problem**: `/\.\w+$/.test(pathname)` は `/api/passwords.json` や `/dashboard/settings.html` 等にもマッチし、認証・CSP チェックをバイパスする
- **Recommendation**: 拡張子をホワイトリストにし、`/api/` パスを除外する

### FUNC-Medium-1: manifest.ts に start_url / scope 未設定
- **File**: `src/app/manifest.ts`
- **Problem**: PWA として `display: "standalone"` だが `start_url` と `scope` が未設定。basePath 環境で起動 URL が不定
- **Recommendation**: `start_url: \`${BASE_PATH}/\`` と `scope: \`${BASE_PATH}/\`` を追加

### FUNC-Medium-2: generate-icons.sh のツール存在チェック不足
- **File**: `scripts/generate-icons.sh`
- **Problem**: `rsvg-convert` / `magick` 未インストール時にエラーメッセージが不明瞭
- **Recommendation**: `command -v` で存在チェックを追加

### FUNC-Medium-3: AppIcon に aria 属性がない
- **File**: `src/components/ui/app-icon.tsx`
- **Problem**: `role` / `aria-label` のデフォルトなし。スクリーンリーダー対応不足
- **Recommendation**: `role="img" aria-label="passwd-sso"` をデフォルト追加

### FUNC-Low-1: テーマカラーのハードコード重複
- **File**: `src/app/manifest.ts`, `src/components/ui/app-icon.tsx`
- **Problem**: `#5B57D6` が複数箇所にリテラル
- **Recommendation**: 将来のリファクタリングで定数化。現時点では低優先

### FUNC-Low-2: layout.tsx の icons に SVG が未含
- **File**: `src/app/[locale]/layout.tsx`
- **Problem**: manifest には SVG があるが layout の icons メタデータに含まれていない
- **Recommendation**: `{ url: \`${BASE_PATH}/icon.svg\`, type: "image/svg+xml" }` を追加

### SEC-High-1: proxy.ts の `/\.\w+$/` による認証バイパス
- **File**: `proxy.ts:11`
- **CWE**: CWE-863
- **Problem**: FUNC-High-1 と同一。`/api/` パスも拡張子付きならバイパスされる
- **Recommendation**: FUNC-High-1 と同一

### SEC-Low-1: manifest.ts の start_url / scope 未設定
- **File**: `src/app/manifest.ts`
- **CWE**: CWE-1021
- **Problem**: FUNC-Medium-1 と同一
- **Recommendation**: FUNC-Medium-1 と同一

### TEST-High-1: proxy.ts の静的ファイルスキップにテストなし
- **File**: `proxy.ts`
- **Problem**: セキュリティガードのバイパス条件にテストがない
- **Recommendation**: `/favicon.ico` スキップ、`/api/passwords.json` 非スキップ等のテスト追加

### TEST-Medium-1: config.matcher と関数内ガードの重複未検証
- **File**: `proxy.ts`
- **Problem**: matcher の `.*\\..*` と関数内の `/\.\w+$/` のレイヤリング意図が未検証
- **Recommendation**: テストで両パターンの挙動を文書化

### TEST-Low-1: manifest.ts のテストなし
- **File**: `src/app/manifest.ts`
- **Problem**: BASE_PATH 依存のアイコンパス生成にテストなし
- **Recommendation**: 低優先。単純な値返却のため

## Summary

| Severity | Count |
|----------|-------|
| High | 3 (1 func + 1 sec + 1 test) — 実質同一問題 |
| Medium | 4 (3 func + 1 test) |
| Low | 4 (2 func + 1 sec + 1 test) |

### ACCEPTED (修正不要)

- FUNC-Low-1: テーマカラー重複 — 2箇所のみ、将来リファクタリング時に対応
- SEC-Low-1: manifest scope — FUNC-Medium-1 で対応
- TEST-Low-1: manifest テスト — 単純な値返却、低優先
- TEST-Medium-1: matcher レイヤリング — proxy 正規表現修正で解消

## 対応状況

### FUNC-High-1 / SEC-High-1: proxy.ts 静的ファイルスキップ修正

- **Action**: 正規表現を拡張子ホワイトリスト + `/api/` 除外に変更
- **Modified**: `proxy.ts:11` — `/\.\w+$/` → `(!pathname.startsWith("/api/") && /\.(ico|png|svg|...)$/.test(pathname))`

### FUNC-Medium-1: manifest.ts に start_url / scope 追加

- **Action**: `start_url` と `scope` を `${BASE_PATH}/` で追加
- **Modified**: `src/app/manifest.ts:25-26`

### FUNC-Medium-2: generate-icons.sh ツール存在チェック追加

- **Action**: `command -v` で `rsvg-convert` / `magick` の存在チェックを追加
- **Modified**: `scripts/generate-icons.sh:8-14`

### FUNC-Medium-3: AppIcon aria 属性追加

- **Action**: `role="img" aria-label="passwd-sso"` をデフォルト属性として追加
- **Modified**: `src/components/ui/app-icon.tsx:5`

### FUNC-Low-2: layout.tsx icons に SVG 追加

- **Action**: `{ url: \`${BASE_PATH}/icon.svg\`, type: "image/svg+xml" }` を追加
- **Modified**: `src/app/[locale]/layout.tsx:36`

### TEST-High-1: proxy.ts 静的ファイルガードのテスト追加

- **Action**: 10 テストケース追加（スキップ対象 5 + 非スキップ対象 5）
- **Created**: `src/__tests__/proxy-static-guard.test.ts`

## Round 2 Findings

### Functionality

- FUNC-Low-1 (new): signin page.test.ts に古い KeyRound モック残存 → 修正
- FUNC-Low-2 (new): manifest.ts に maskable icon 未設定 → ACCEPTED（低優先、現時点ではクリッピング問題のみ）

### Security

- No findings（Round 1 の全指摘が解消確認済み）

### Testing

- TEST-Low-1 (new): proxy-static-guard.test.ts の誤解を招くコメント → 修正
- TEST-Low-2 (new): signin page.test.ts の古い KeyRound モック → FUNC-Low-1 と同一、修正済み

### ACCEPTED (Round 2)

- FUNC-Low-2: maskable icon — PWA ホーム画面アイコンの見た目のみ影響、低優先

### Round 2 対応状況

#### FUNC-Low-1 / TEST-Low-2: signin page.test.ts モック更新

- **Action**: `KeyRound` モック削除、`AppIcon` モック追加
- **Modified**: `src/app/[locale]/auth/signin/page.test.ts:44-48`

#### TEST-Low-1: proxy-static-guard.test.ts コメント修正

- **Action**: 誤解を招くコメントを修正（`.html` は whitelist 外なので proxy を通過）
- **Modified**: `src/__tests__/proxy-static-guard.test.ts:63-66`
