# Phase 4: Watchtower 実装計画

## Context
E2E 暗号化 (Phase 1-3) が完了。全パスワードデータはクライアント側で暗号化されており、サーバーは何も読めない。
Watchtower はパスワードのセキュリティ状態を**全てクライアント側で**分析し、問題を可視化する。

## 設計判断

- **チャートライブラリ不要**: CSS conic-gradient で円形スコアゲージを実装
- **パスワード強度**: 軽量カスタム実装（zxcvbn は ~800KB で重すぎる）
- **HIBP**: クライアントから直接 `api.pwnedpasswords.com` に k-Anonymity リクエスト（SHA-1 先頭5文字のみ送信）
- **新規 npm パッケージ不要**: Web Crypto API + fetch で全て実装可能
- **DB 変更なし**: 既存の `updatedAt` をパスワード鮮度チェックに利用

## 新規ファイル

### 1. `src/lib/password-analyzer.ts` — コア分析ロジック

```typescript
// エントロピー計算
calculateEntropy(password: string): number
// log2(charset_size) * length

// 強度分析
analyzeStrength(password: string): StrengthResult
// エントロピー + 文字クラス多様性 + パターン検出 → 0-100 スコア

// HIBP k-Anonymity チェック
checkHIBP(password: string): Promise<{ breached: boolean; count: number }>
// SHA-1(password) → 先頭5文字を HIBP に送信 → サフィックス一覧から照合

// 共通パターン検出
detectPatterns(password: string): string[]
// 連続文字(abc, 123)、繰り返し(aaa)、キーボード配列(qwerty)
```

### 2. `src/hooks/use-watchtower.ts` — 分析オーケストレーター

```typescript
interface WatchtowerReport {
  totalPasswords: number;
  overallScore: number;  // 0-100
  breached: PasswordIssue[];
  weak: PasswordIssue[];
  reused: ReusedGroup[];
  old: PasswordIssue[];
}

export function useWatchtower(): {
  report: WatchtowerReport | null;
  loading: boolean;
  progress: { current: number; total: number; step: string };
  analyze: () => Promise<void>;
}
```

分析フロー:
1. `GET /api/passwords` で全暗号化エントリ取得
2. 各エントリの `encryptedBlob` を復号（パスワード本体が必要）
3. 重複チェック（SHA-256 ハッシュ比較）
4. 強度チェック（エントロピー + パターン）
5. 鮮度チェック（`updatedAt` > 90日）
6. HIBP チェック（1.5秒間隔でレート制限）
7. スコア算出: 侵害(40%) + 強度(30%) + 一意性(20%) + 鮮度(10%)

### 3. `src/app/[locale]/dashboard/watchtower/page.tsx` — Watchtower ページ

```
┌─────────────────────────────────────────┐
│ ← Watchtower                   [再分析] │
├─────────────────────────────────────────┤
│         ┌───────┐                       │
│         │  78   │  セキュリティスコア    │
│         └───────┘                       │
│  合計 24 件中 3 件に問題あり             │
├─────────────────────────────────────────┤
│ 🔴 侵害されたパスワード (1)             │
│ 🟡 弱いパスワード (1)                   │
│ 🟡 使い回しパスワード (1)               │
│ 🟢 古いパスワード (0)                   │
├─────────────────────────────────────────┤
│ ▼ 侵害されたパスワード                  │
│   GitHub — user@example.com             │
│   「5,234 件のデータ漏洩に含まれています」│
│                           [詳細を見る]   │
│ ▼ 弱いパスワード                        │
│   AWS Console — admin                   │
│   「エントロピー: 28 bits」              │
│                           [詳細を見る]   │
└─────────────────────────────────────────┘
```

### 4. `src/components/watchtower/score-gauge.tsx` — CSS 円形ゲージ

- `conic-gradient` で円形プログレス
- 色: 0-40 赤、41-70 黄、71-100 緑
- 中央にスコア数値

### 5. `src/components/watchtower/issue-section.tsx` — 問題セクション

- アコーディオン形式の問題カテゴリ表示
- 各問題: タイトル + ユーザー名 + 詳細 + 「詳細を見る」リンク
- severity バッジ (critical/high/medium/low)

## 変更ファイル

### `src/components/layout/sidebar.tsx`

Watchtower リンクを追加（「すべてのパスワード」の下）:
```tsx
<Link href="/dashboard/watchtower">
  <Shield className="h-4 w-4" />
  {t("watchtower")}
</Link>
```

### `messages/en.json` / `messages/ja.json`

`Watchtower` ネームスペース追加:
- title, subtitle, overallScore
- analyzing, step descriptions
- breached, weak, reused, old (各カテゴリ名 + 説明)
- severity labels
- noIssues

### `src/components/layout/sidebar.tsx`

`Dashboard` ネームスペースに `watchtower` キー追加

## 実装順序

1. **`password-analyzer.ts`** — コアロジック（エントロピー、HIBP、パターン検出）
2. **`use-watchtower.ts`** — 分析 hook（復号 → 分析 → スコア算出）
3. **`score-gauge.tsx`** — CSS 円形ゲージコンポーネント
4. **`issue-section.tsx`** — 問題表示コンポーネント
5. **`watchtower/page.tsx`** — Watchtower ダッシュボードページ
6. **`sidebar.tsx`** — Watchtower リンク追加
7. **翻訳** — en.json / ja.json に Watchtower キー追加
8. **ビルド確認**

## 検証方法

1. `/dashboard/watchtower` にアクセスして「分析」ボタンをクリック
2. プログレスが表示され、各ステップが進行する
3. HIBP API にリクエストが飛ぶ（DevTools Network で SHA-1 prefix のみ確認）
4. スコアゲージと問題リストが表示される
5. 「詳細を見る」リンクでパスワード詳細ページに遷移する
6. サイドバーに Watchtower リンクが表示される
