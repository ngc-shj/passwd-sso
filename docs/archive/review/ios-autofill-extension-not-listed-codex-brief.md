# Codex 調査依頼: iOS AutoFill Credential Provider 拡張が「設定 → 自動入力とパスワード」に出てこない

## あなたへの依頼（要約）
iOS の AutoFill Credential Provider 拡張（`ASCredentialProviderViewController`）を実機に入れたが、
**設定 → 一般 → 自動入力とパスワード のソース一覧に永続的に出てこない**。
バンドルの静的構成・署名・entitlement・プロビジョニングは**すべて検証済みで正しい**。
デバイスログ解析の結果、**iOS の LaunchServices が拡張を AutoFill 拡張ポイントに紐付けていない**ところまで切り分け済み。
**「なぜ LS が紐付けないのか」を特定し、修正案を出してほしい。** 推測ではなく、コード/構成/Apple仕様の根拠付きで。

## 環境
- リポジトリ: `passwd-sso-ios`（Next.js 製サーバ `passwd-sso` のコンパニオン iOS アプリ）。iOS 部分は `ios/` 配下。
- ビルド: xcodegen（`ios/project.yml` → `ios/PasswdSSO.xcodeproj`）。Swift 6 / SwiftUI。
- 実機: iPhone 16 Pro Max, **iOS 26.5**(正式版)。Apple Developer Program 加入済み（有料）, Team `4789NDA9RQ`, 自動署名（Apple Development 証明書）。
- ホストアプリ bundle id: `jp.jpng.passwd-sso`（過去に `com.passwd-sso` から改名済み）。
- 拡張 bundle id: `jp.jpng.passwd-sso.PasswdSSOAutofillExtension`。
- 拡張ターゲット: `ios/PasswdSSOAutofillExtension/`（`CredentialProviderViewController.swift` ほか）。`Shared.framework`（`ios/Shared/`）を `link: true, embed: false` で参照（ホストが embed）。

## 症状
- 設定 → 自動入力とパスワードのマスタースイッチは ON。他社パスワードマネージャ等の**ソースが5つ正常に表示**されている（= デバイス・OS・AutoFill 機構自体は健全）。
- **passwd-sso だけが一覧に出ない。**
- OS 再起動・アプリ完全削除→再インストール（devicectl と Xcode Run の両方の正規 installd 経路）を複数回試しても改善せず。

## すでに検証済み（すべて正しいことを確認した項目 — ここは再調査不要）
ビルド成果物 `…/Build/Products/Debug-iphoneos/PasswdSSOApp.app/PlugIns/PasswdSSOAutofillExtension.appex` に対し：
1. **埋め込み**: `.app/PlugIns/` に `.appex` が同梱（embed: true）。
2. **CFBundlePackageType = `XPC!`**、CFBundleExecutable・CFBundleIdentifier（ホスト id が prefix）正しい。
3. **Info.plist の NSExtension 階層**（plutil で確認、フォーラム thread/745587 の失敗例＝直下配置には**該当しない**）:
   ```
   NSExtension
     NSExtensionPointIdentifier = com.apple.authentication-services-credential-provider-ui
     NSExtensionPrincipalClass  = PasswdSSOAutofillExtension.CredentialProviderViewController
     NSExtensionAttributes
       ASCredentialProviderExtensionCapabilities
         ProvidesPasswords    = true
         ProvidesOneTimeCodes = true
   ```
4. **entitlement（実署名 + プロビジョニングプロファイル両方）**: `com.apple.developer.authentication-services.autofill-credential-provider = true`。`codesign -d --entitlements` と `security cms -D` で確認。プロファイル名 `iOS Team Provisioning Profile: jp.jpng.passwd-sso.PasswdSSOAutofillExtension`。
5. **コード署名**: `codesign --verify --deep --strict` でアプリ全体＆ .appex 単体ともに valid、DR 満足。Authority = Apple Development。
6. **principal class**: バイナリに `_$s26PasswdSSOAutofillExtension32CredentialProviderViewControllerCN` が存在。superclass = `ASCredentialProviderViewController`。`PRODUCT_MODULE_NAME = PasswdSSOAutofillExtension` 一致。
7. **dylib リンク**: 拡張は `@rpath/Shared.framework/Shared` をロード。LC_RPATH に `@executable_path/../../Frameworks`。Shared.framework の install name = `@rpath/Shared.framework/Shared`。ホストの `Frameworks/` に Shared.framework 同梱。
8. **deployment target**: 拡張 minos 17.0 ≤ デバイス 26.5。
9. **ENABLE_DEBUG_DYLIB = NO**（Xcode16+ の Debug 既定 YES が app-extension 登録を壊す件は対策済み。`.appex` に `.debug.dylib` 無し）。
10. **切り分け実験済み**: 拡張 entitlement を `autofill-credential-provider` のみに最小化（App Group `group.jp.jpng.passwd-sso.shared` と keychain-access-group を一時除外）しても**症状変わらず** → 共有グループ系 entitlement は原因ではない。

## デバイスログ（idevicesyslog で実機 syslog を取得）からの決定的所見
インストール（uninstall→install）時:
- `installd(Security)`: 拡張の署名・entitlement を読み取り受理。entitlement に `autofill-credential-provider=true` を確認。
- `installd(MobileSystemServices)`: `Data container for jp.jpng.passwd-sso.PasswdSSOAutofillExtension is now at /…/PluginKitPlugin/…`（= PlugInKit プラグインとしてのデータコンテナ作成済み）。
- `lsd(CoreServices)`: 第1パス（placeholder）で `-[LSBundleRecordBuilder registerBundleRecord:error:] Skipped registering extensions`、第2パスで `Registering extensions` → `sending plugin notification com.apple.LaunchServices.pluginsregistered`。
- uninstall 時に `lsd: Beginning _LSUnregisterAppWithBundleID`（= 毎回フレッシュ登録。古いキャッシュ滞留ではない）。

設定アプリで AutoFill discovery が走った時（インストール後）:
- `AuthenticationServicesAgent(PlugInKit)`: `Beginning discovery for … point: com.apple.authentication-services-credential-provider-ui`
- `pkd(CoreServices)`: **`Will enumerate 5 candidate plugins`** → 各候補について `Found LSExtensionPoint … for identifier com.apple.authentication-services-credential-provider-ui` → `Created plugin`。
- **候補は 5 個のまま（= 既存の他社5アプリ）。我々の拡張は候補に含まれない。**
- 我々の拡張に対する `reject`/`invalid`/`disqualified`/`denied`/`excluded` 等の明示的拒否ログは**一切無し**。
- pkd userprefs の `exclusions` キーは無し（手動除外もされていない）。

### 確定した切り分け
**バンドルは正しく、installd も受理し、LS はプラグインとして登録通知まで出す。しかし LS は拡張を
`com.apple.authentication-services-credential-provider-ui` 拡張ポイントの候補として返さない**
（LS DB へ EP クエリした結果が 5 件で、我々が不在）。**静かに EP 紐付けがスキップされている。**

伏字（`<private>`）解除には監視対象（supervised/MDM）デバイスが必要で、非監視実機では
`Enable-Private-Data` ロギングプロファイルが「無効な署名」で拒否されるため、通常ログでは
pkd/LS の該当判定の詳細が読めない。

## 調査してほしいこと（具体的な問い）
1. **iOS 26 で、Info.plist の NSExtension 構成が完全に正しく、`autofill-credential-provider` entitlement も
   署名・プロファイル両方に存在するのに、LaunchServices が app-extension を
   `com.apple.authentication-services-credential-provider-ui` 拡張ポイントに紐付け「ない」既知の条件は何か。**
   - 例: NSExtension に追加で必須なキー（`ASCredentialProviderExtensionShowsConfigurationUI` 等）はあるか? 必須なら出ない、を裏付ける一次情報（Apple Developer doc / WWDC / フォーラム）付きで。
   - `ASCredentialProviderExtensionCapabilities` に `ProvidesPasskeys` 等の追加キーが iOS 26 で実質必須になっていないか。
2. **Shared.framework 依存（host-embedded, `embed:false`）が LS の EP 紐付けや pkd の検証で問題を起こす条件はあるか。** 一般には標準構成だが、Swift 6 / iOS 26 特有の落とし穴がないか。
3. **`jp.jpng.passwd-sso` という bundle id に紐づく永続的な LaunchServices 状態**（CSStore のレコード、`com.passwd-sso` からの改名残渣、過去の壊れた拡張構成のレコード）が、uninstall で完全に purge されず EP 紐付けを阻害している可能性はあるか。検証方法と、もし該当する場合のリセット手順。
4. **同じ拡張ポイントに登録する他社5アプリは出るが我々だけ出ない**点を踏まえ、App Store 配布アプリ と Apple Development 署名のサイドロードアプリ で、AutoFill credential provider 拡張の LS/pkd 登録挙動に差がある（iOS 26 のバグ/制限を含む）か。
5. `ios/project.yml` の拡張ターゲット定義・スキーム・依存関係に、上記を引き起こす設定上の問題がないかレビュー。

## 重要ファイル
- `ios/project.yml`（特に `targets.PasswdSSOAutofillExtension` と `schemes.PasswdSSOApp`）
- `ios/PasswdSSOAutofillExtension/Info.plist`
- `ios/PasswdSSOAutofillExtension/PasswdSSOAutofillExtension.entitlements`（実験中: 最小化済み。本来は App Group + keychain あり）
- `ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift`
- `ios/PasswdSSOAutofillExtension/Views/`（`CredentialPickerView.swift`, `OneTimeCodePickerView.swift` — `import Shared`）
- `ios/Shared/`（Shared.framework のソース）

## 制約・運用
- 端末ログの伏字解除は不可（監視デバイス必須）。`xcrun devicectl device sysdiagnose` は当環境では `CoreDeviceCLISupport.DiagnoseError` で失敗。`log collect --device-udid` は root 必須で sudo 不可。**オンデバイス sysdiagnose（ボタン操作）→ AirDrop → `pluginkit -mAvvv` 出力を読む** ルートは別途人間が並行実施中。
- 期待アウトプット: (a) 最有力の根本原因（根拠付き）, (b) 検証手順, (c) 具体的な修正差分案（`project.yml` / Info.plist / entitlements / コード）。

---

## 追記: sysdiagnose + シミュレータ検証の新発見（2回目の調査ラウンド）

### 実機 sysdiagnose（pymobiledevice3 で USB 取得、`pkd` ログ・伏字なし範囲）
- インストール後の AutoFill discovery で **`pkd: Candidate plugin count from LaunchServices: 5` / `Final plugin count: 5`**。`Matches:` は `<private>` で焼き込み済みのため、5件に我々が含まれるかは実機ログ単体では未確定。ユーザーの目視では一覧に passwd-sso 無し。
- 実機 LS CSStore（`lsaw.csstoredump`）に我々の拡張のバンドルレコードは存在。旧 `com.passwd-sso` の登録は **0 件**（実機では旧 id 競合なし）。EP 紐付けは CSStore の数値参照で strings では読めず。
- 実機の `system_logs.logarchive` も `[d <private>]` 等が焼き込み redaction されており、discovery の matches 詳細は読めない（非監視デバイスのため伏字解除不可）。

### iOS シミュレータ検証（iPhone 16 Pro）
- `pluginkit -mAvvv` で **我々の拡張は AutoFill EP に正しく登録**される: `SDK = com.apple.authentication-services-credential-provider-ui`。→ **バンドル構造は正しいと実証**。
- ただし **pkd レコードの `annotations = {}` が空**（capabilities が pkd annotation に入っていない）。なお当該 EP の appexpt 定義に capability annotation キーの宣言は無く、空 annotation 自体は正常な可能性が高い。
- **シミュレータの 設定→自動入力 にも passwd-sso は出ない。** ただし iOS シミュレータが第三者 AutoFill プロバイダを設定 UI に描画するかは一次情報で確定できず（信頼性に疑問）。
- 切り分け実験: `ASCredentialProviderExtensionCapabilities` を**完全削除**（Apple テンプレート同等）しても sim の挙動変わらず → **capabilities dict は原因ではない**。
- 旧 `com.passwd-sso` プロビジョニングプロファイル2件を実機から削除（pymobiledevice3 provision remove）＋再起動＋再インストールしても実機で出ない → **stale profile も原因ではない**。
- `APPLICATION_EXTENSION_API_ONLY: YES` を Shared/拡張に付与してビルド成功（Shared は元々拡張安全）→ これも単独の決め手ではない。

### 確定した切り分け（更新）
- **バンドルは構造的に正しい**（sim の pluginkit で EP 登録を実証、全静的検査パス、Codex 同意）。
- **除外済み原因**: entitlement(autofill/app-group/keychain), capabilities dict, stale profile, debug dylib, 署名, principal class, dylib リンク, Info.plist 階層, APPLICATION_EXTENSION_API_ONLY。
- **未解決**: なぜ iOS の AutoFill サブシステムが、EP 登録済みの我々の拡張を「設定の AutoFill 提供元一覧」に出さないのか。正確な理由は実機ログ伏字＋CSStore バイナリ＋sim 設定 UI の信頼性不明により、現有ツールでは読めない。

### Codex への追加依頼
1. iOS 18/26 で **pkd は EP 登録するが AuthenticationServicesAgent / 設定の「AutoFill 提供元」リストに出さない**ケースの既知条件（capability annotation の格納経路、`ASCredentialProviderExtension` の listing 要件）を一次情報で。
2. iOS シミュレータが第三者 AutoFill credential provider を Settings に表示する/しないの確証（公式記述・FB）。
3. Apple DTS/TSI に出す場合の最小再現条件と必要ログ。
