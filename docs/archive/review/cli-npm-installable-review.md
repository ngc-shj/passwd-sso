# Plan Review: cli-npm-installable
Date: 2026-03-30T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings
F1 Minor: version.test.ts の description 文字列 "root package.json" が変更後の意図と一致しない。変数名 rootPkg も cliPkg に変更すべき。→ **Reflected in plan**

## Security Findings
S1 Major: serverUrl に対する https:// スキーム検証の欠如。npm 公開後は不特定多数が使用するため、http:// 使用時に警告が必要。→ **Out of scope** (既存コードの問題、今回の変更と独立)
S2 Minor: BLOCKED_KEYS に NODE_EXTRA_CA_CERTS, SSL_CERT_FILE 等が不足。→ **Out of scope** (別PR対応)

## Testing Findings
T1 Major: テスト説明文とアサート対象の乖離。→ **Reflected in plan** (F1と統合)
T2 Major: npm pack --dry-run 検証が CI に統合されていない。→ **Reflected in plan**
T3 [Adjacent] Major: グローバルインストール後の require("../package.json") パス解決の検証。→ **Reflected in plan** (テスト戦略にシミュレーション追加)

## Adjacent Findings
T3: グローバルインストール時のパス解決 → テスト戦略で対処

## Quality Warnings
None (local LLM flagged VAGUE/NO-EVIDENCE on several items but evidence was provided in original agent outputs)
