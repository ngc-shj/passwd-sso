# 調査依頼: 正しく構成された iOS AutoFill Credential Provider 拡張が「設定 → 自動入力とパスワード」の提供元一覧に出ない

## 依頼概要
iOS の AutoFill Credential Provider 拡張（`ASCredentialProviderViewController`）が、
**設定 → 一般 → 自動入力とパスワード の「次から自動入力」提供元一覧に出てこない**。
バンドル・Info.plist・entitlement・署名は**すべて検証済みで正しく**、**実機2台 + シミュレータ**で再現する。
さらに **Shared 依存も SwiftUI も無い「教科書的に最小なスタブ拡張」でも同じく出ない**ことを実機で確認済み。
**「正しく構成された拡張が iOS 26.5 で提供元一覧に surface されない原因」を特定し、修正策（あれば）を一次情報の根拠付きで提示してほしい。**

## 環境
- アプリ: `passwd-sso-ios`（自前ホスト型パスワードマネージャの iOS クライアント）。iOS 部分は `ios/`。
- ビルド: xcodegen（`ios/project.yml` → `.xcodeproj`）、Swift 6 / SwiftUI、Xcode（iOS 26 SDK）。
- 実機A: iPhone 16 Pro Max, iOS 26.5。実機B: iPhone SE 2nd gen (iPhone12,8), iOS 26.5（**クリーン端末**）。両方で再現。
- 署名: Apple Developer Program（有料）、Team `4789NDA9RQ`、**自動署名・Apple Development 証明書（= 開発サイドロード）**。
- ホスト bundle id: `jp.jpng.passwd-sso`（過去に `com.passwd-sso` から改名）。拡張 bundle id: `jp.jpng.passwd-sso.PasswdSSOAutofillExtension`。
- 拡張は `Shared.framework`（`ios/Shared/`）を `link: true, embed: false`（ホストが embed）で参照。

## 症状
- 設定の AutoFill マスタースイッチは ON。**他社パスワードマネージャ等の提供元が（実機A で）5つ正常表示**。Edge (`com.microsoft.msedge.CredentialProviderExtension`) 等が見える。
- **passwd-sso だけが永続的に一覧に出ない。** 実機A・実機B・シミュレータ すべてで同様。
- OS 再起動、アプリ完全削除→再インストール（devicectl / Xcode Run / シミュレータ）を多数回試行、いずれも改善せず。

## 検証済み（すべて正しいと確認済み — 再調査不要）
1. `.app/PlugIns/PasswdSSOAutofillExtension.appex` が埋め込み済み（embed: true）。
2. appex Info.plist: `CFBundlePackageType = XPC!`、`CFBundleExecutable`/`CFBundleIdentifier`（ホスト id が prefix）正しい。
3. Info.plist NSExtension 階層（plutil 確認）:
   ```
   NSExtension
     NSExtensionPointIdentifier = com.apple.authentication-services-credential-provider-ui
     NSExtensionPrincipalClass  = PasswdSSOAutofillExtension.CredentialProviderViewController
     NSExtensionAttributes
       ASCredentialProviderExtensionCapabilities
         ProvidesPasswords    = true
         ProvidesOneTimeCodes = true
   ```
   （フォーラム thread/745587 の「直下配置」失敗例には該当しない＝正しくネスト）
4. entitlement（実署名 + 埋め込みプロビジョニングプロファイル両方）: `com.apple.developer.authentication-services.autofill-credential-provider = true`。`codesign -d --entitlements` と `security cms -D -i embedded.mobileprovision` で確認。
5. コード署名: `codesign --verify --deep --strict` でアプリ全体＆ appex 単体ともに valid、DR 満足、Authority = Apple Development。
6. principal class: バイナリに Swift クラスメタデータ存在、superclass = `ASCredentialProviderViewController`、`PRODUCT_MODULE_NAME` 一致。
7. dylib リンク: `@rpath/Shared.framework/Shared` を解決可能（LC_RPATH に `@executable_path/../../Frameworks`、ホストに Shared.framework 同梱）。
8. deployment target 17.0 ≤ デバイス 26.5。`ENABLE_DEBUG_DYLIB = NO`（appex に debug dylib 無し）。`APPLICATION_EXTENSION_API_ONLY = YES`（Shared/拡張とも、ビルド成功）。
9. シミュレータで `pluginkit -mAvvv -i <ext id>` → **AutoFill 拡張ポイントに正しく登録**: `SDK = com.apple.authentication-services-credential-provider-ui`。

## 除外済みの原因（実験で無罪と確定）
- **拡張のコード／Shared.framework 依存**: Shared も SwiftUI も無い最小スタブ（バレな `ASCredentialProviderViewController` サブクラスのみ、Info.plist は実物と同一）に置換しても、**実機・シミュレータとも出ない** → 一覧表示は Info.plist 駆動でコード無関係。
- **`ASCredentialProviderExtensionCapabilities` dict**: 完全削除（Apple テンプレート同等）しても変化なし。
- **共有グループ系 entitlement**: App Group / keychain-access-group を一時除外しても変化なし。
- **旧 `com.passwd-sso` の残骸**: 実機 LS DB に旧 id 登録は 0 件。旧プロビジョニングプロファイル2件を削除＋再起動＋再インストールしても変化なし。
- **端末固有の LS 状態**: クリーンな2台目（iPhone SE2、同 iOS 26.5）でも再現 → 端末固有ではない。

## 実機ログ（sysdiagnose / idevicesyslog、伏字あり）からの所見
- インストール時: `installd` が署名・entitlement を受理。`Data container for …PasswdSSOAutofillExtension … /PluginKitPlugin/…` 作成。`lsd: Registering extensions` → `com.apple.LaunchServices.pluginsregistered` 通知。
- 設定で AutoFill discovery 実行時（インストール後）: `AuthenticationServicesAgent` が `point: com.apple.authentication-services-credential-provider-ui` で discovery → `pkd: Candidate plugin count from LaunchServices: 5` / `Final plugin count: 5`。**`Matches:` は `<private>` で焼き込み redaction**、5件に我々が含まれるかは実機ログ単体では未確定（目視では一覧に無い）。
- シミュレータ（伏字なし）では `pkd` が我々の拡張を EP にマッチさせるが、**pkd レコードの `annotations = {}` が空**（当該 EP の appexpt 定義に capability annotation キー宣言は無く、空 annotation 自体は正常な可能性が高い）。
- シミュレータの設定 UI は、最小スタブを含め第三者 AutoFill プロバイダを描画しない（= シミュレータ設定 UI はこの用途で信頼できない）。
- 非監視デバイスのため `<private>` の伏字解除（`Enable-Private-Data` ロギングプロファイル）は「無効な署名」で不可。

## 確定した切り分け（要点）
- バンドル/Info.plist/entitlement/署名は正しい。pkd は拡張を AutoFill EP に登録する。
- **しかし AutoFill 提供元一覧（設定 UI）に surface されない。実機2台 + 最小スタブ でも再現。**
- 動作中の他社5提供元との唯一の一貫した差は **App Store 配布 vs Apple Development 署名（開発サイドロード）**。
- pkd/LS の最終判定理由は、実機ログ伏字＋CSStore バイナリ＋シミュレータ設定 UI の制限 により、手元のツールでは読めない。

## 調査してほしいこと（具体的な問い）
1. **iOS 18/26 で、Info.plist・entitlement・署名がすべて正しい AutoFill credential provider 拡張が「設定 → 自動入力とパスワード」の提供元一覧に surface されない既知の条件は何か。** 一覧表示（surface）に必要な要件を一次情報（Apple Developer doc / WWDC / リリースノート / フォーラム）で。
2. **Apple Development 署名（開発サイドロード）の AutoFill credential provider 拡張が、iOS 26 で提供元一覧に出ない/出るのか。** App Store / TestFlight 配布との差を示す一次情報はあるか。出る前提なら、開発ビルドで surface させる追加条件は。
3. **ホストアプリ側に必要な宣言/entitlement はあるか**（iOS 18+ の credential manager 化要件、`ASCredentialProviderViewController` 以外に host app が満たすべきもの）。
4. **iOS 26.5 固有のリグレッション/既知不具合**（第三者・特に開発署名の credential provider が一覧に出ない）の報告はあるか。
5. もし「正しいのに出ない」が Apple 側の挙動なら、**Apple DTS/TSI に出す際の最小再現条件・必要ログ**の整理。

## 期待アウトプット
(a) 最有力の根本原因（根拠付き、推測と事実を分けて）、(b) 検証手順、(c) 具体的修正（`ios/project.yml` / Info.plist / entitlements / ホスト構成 の差分案）または「Apple 側要因で手元修正不可」の結論と次アクション。

## 参考: 重要ファイル
- `ios/project.yml`（`targets.PasswdSSOAutofillExtension`, `schemes.PasswdSSOApp`）
- `ios/PasswdSSOAutofillExtension/Info.plist` / `.entitlements`
- `ios/PasswdSSOAutofillExtension/CredentialProviderViewController.swift`（+ `Views/`）
- `ios/PasswdSSOApp/Info.plist` / `PasswdSSOApp.entitlements`（ホスト側）
- 既存の詳細ブリーフ: `docs/archive/review/ios-autofill-extension-not-listed-codex-brief.md`
