# App Store Listing & Submission — passwd-sso iOS

This is the single source for the App Store Connect listing copy and the
step-by-step first-time submission runbook. Code/build readiness (encryption
declaration, Privacy Manifest, Release build) is already done in the repo; this
file covers everything that happens in App Store Connect and Xcode that an
automated agent cannot perform for you.

---

## Part 1 — Listing Metadata

### Store Metadata

| Field | Value |
|-------|-------|
| App Name (30 chars max) | passwd-sso |
| Subtitle (30 chars max) | Self-hosted password vault |
| Bundle ID | `jp.jpng.passwd-sso` |
| Primary Category | Productivity |
| Secondary Category | Utilities |
| Primary Language | English (U.S.) |
| Additional Language | Japanese |
| Price | Free |
| Age Rating | 4+ |

### Promotional Text (170 chars max — editable without re-review)

Your passwords, on your server. End-to-end encrypted, with native AutoFill, TOTP, and passkeys — connected only to the passwd-sso instance you run yourself.

### Description

passwd-sso is the iOS companion to your self-hosted passwd-sso vault. It brings
your credentials to your iPhone with native iOS AutoFill — log in to apps and
websites without ever typing a password.

**This app requires your own passwd-sso server.** It is not a cloud service. You
point the app at the passwd-sso instance you operate, and it connects only there.

Why passwd-sso for iOS?

- Native AutoFill — Fill passwords, one-time codes (TOTP), and passkeys directly
from iOS's AutoFill picker in Safari and any app. QuickType suggestions surface
the right credential above the keyboard.

- Zero-knowledge encryption — Your master passphrase never leaves your device.
Everything is encrypted with AES-256-GCM before it touches the network. The
server stores only ciphertext.

- Face ID unlock — Unlock your vault and reveal credentials with Face ID. The
vault re-locks automatically after a timeout you choose.

- Passkeys — Sign in with WebAuthn passkeys stored in your vault, and create new
ones, all from the AutoFill flow.

- Your server, your data — No third-party cloud, no analytics, no tracking. The
app talks to exactly one host: yours.

- Auto-lock — Configurable timeout, clipboard auto-clear, and a lock-on-exit
option keep your vault closed when you step away.

To get started you need a running passwd-sso server (open source — see the
project repository). Enter your server URL, sign in, set your master passphrase,
and turn on passwd-sso under Settings → General → AutoFill & Passwords.

### Keywords (100 chars max, comma-separated, no spaces after commas)

password,vault,autofill,passkey,totp,2fa,self-hosted,e2e,encryption,sso,security,passwords

### What's New (release notes for v0.4.60)

First public release. Self-hosted password vault with native iOS AutoFill,
TOTP, passkey assertion and registration, and Face ID unlock.

### Support & Marketing URLs

| Field | Value | Status |
|-------|-------|--------|
| Support URL | (required — e.g. GitHub repo issues page or a docs page) | ⚠️ TODO: confirm URL |
| Marketing URL | (optional — project landing page) | optional |
| Privacy Policy URL | `https://www.jpng.jp/passwd-sso/en/privacy-policy/` (ja: `…/ja/privacy-policy/`) | ✅ updated to cover the iOS app (`public/{en,ja}/privacy-policy/index.html`) — deploy before submit |

> The shared privacy policy now covers both the browser extension and the iOS
> app (subtitle "Browser Extension & iOS App", with a dedicated "passwd-sso for
> iOS" section on Keychain/App Group, Face ID, AutoFill, passkeys, and local
> cache; data collection = none). Source lives in this repo under
> `public/{en,ja}/privacy-policy/index.html` — **redeploy the site so the live
> URL reflects these edits before submitting for review.**

---

## Part 2 — App Privacy ("Nutrition Label") answers

In App Store Connect → App Privacy, answer the data-collection questionnaire.
For this app the honest answer is **"Data Not Collected"** for every category:

- The app sends data only to the user's own self-hosted server (first-party,
  user-operated — not "collected by the developer").
- No analytics, no ads, no third-party SDKs.
- Select **"No, we do not collect data from this app."**

This matches the bundled `PrivacyInfo.xcprivacy` files, which declare:
- `NSPrivacyTracking = false`, empty tracking domains, empty collected-data types.
- Required-reason API: UserDefaults (`CA92.1` — access app's own settings) and
  Disk Space (`E174.1` — display/compute written cache size to the user).

---

## Part 3 — Review Notes (paste into "App Review Information → Notes")

> passwd-sso is a client for a self-hosted password manager. It connects to a
> passwd-sso server that the user runs themselves — there is no shared cloud
> backend. We have provided a demo server and a test account below so you can
> review the full experience.
>
> IMPORTANT — sign-in is two steps:
> 1) Sign in to the server with the test Google account (single sign-on), then
> 2) unlock the encrypted vault with the master passphrase. The passphrase is
> separate from the Google password — it is the end-to-end encryption key and is
> never sent to the server. Both are listed below.
>
> Demo server URL:  https://www.jpng.jp/passwd-sso
> Test Google account (email):  appreview.passwdsso@gmail.com
> Test Google account (password):  «see docs/.review-credentials.local.md — gitignored»
> Vault master passphrase:  «see docs/.review-credentials.local.md — gitignored»
>
> Steps to reproduce:
> 1. Launch the app. On the first screen, enter the demo server URL above and continue.
> 2. Tap "Sign in to passwd-sso". A secure Safari sheet opens the server's sign-in page.
> 3. Choose "Sign in with Google" and sign in with the test Google account above.
>    The sheet returns automatically to the app via the passwd-sso://auth/callback scheme.
> 4. When prompted to unlock the vault, enter the master passphrase above
>    (you may also be offered Face ID — decline it to use the passphrase).
> 5. The vault list appears. Tap any entry to view its details (password is hidden
>    until you tap reveal). Sample entries are pre-loaded for review.
> 6. (Optional) To see AutoFill: iOS Settings → General → AutoFill & Passwords →
>    enable "passwd-sso", then trigger a login form in Safari and pick a credential.

> Notes on the test Google account:
> - Two-factor authentication is intentionally disabled on this throwaway test
>   account so sign-in does not require a second device.
> - If Google shows a "verify it's you / unusual sign-in" interstitial, it can
>   usually be cleared by continuing; the account exists solely for App Review.

> ⚠️ "We could not sign in" (Guideline 2.1) is the most common rejection for
> self-hosted/SSO apps. Before submitting, confirm on a real device that the
> exact steps above work end-to-end with the credentials as written — including
> the separate vault-unlock step, which reviewers frequently miss.

### App Review contact

- First/Last name, phone, email of a reachable contact (App Review may call).

---

## Part 4 — Required Assets (must be uploaded in App Store Connect)

| Asset | Requirement | Status |
|-------|-------------|--------|
| App Icon | 1024×1024 PNG, no alpha, no rounded corners | ✅ `Assets.xcassets/AppIcon-1024.png` — verified 1024×1024, no alpha |
| 6.7"/6.9" screenshots | Required. 1290×2796 (iPhone 15/16 Pro Max) — at least 1, up to 10 | ⚠️ TODO: capture |
| 6.5" screenshots | Recommended (older fallback) | optional |
| iPad screenshots | Not needed — app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`) | n/a |

> Screenshot tip: capture on the 6.9" simulator, then App Store Connect can
> down-scale to other required sizes. Capture the vault list, an entry detail,
> the unlock/Face ID screen, and the AutoFill picker.

---

## Part 5 — First-Time Submission Runbook

> Prerequisites you must have (agent cannot do these):
> - Active **Apple Developer Program** membership (Team ID `4789NDA9RQ`).
> - Agreements signed in App Store Connect → Agreements, Tax, and Banking
>   (Paid apps agreement not needed for free, but the **Free** agreement must be
>   active).
> - Xcode signed in with an account that has access to Team `4789NDA9RQ`.

### Step 1 — Register App IDs & capabilities (developer.apple.com)

The bundle uses an App Group, Keychain Sharing, and AutoFill Credential Provider.
Confirm these App IDs exist with matching capabilities (Certificates, IDs &
Profiles → Identifiers):

- `jp.jpng.passwd-sso` — App Groups, Keychain Sharing, AutoFill Credential
  Provider, Associated Domains (if used).
- `jp.jpng.passwd-sso.PasswdSSOAutofillExtension` — same App Group + Keychain +
  AutoFill Credential Provider.
- `jp.jpng.passwd-sso.Shared` (framework — no special capabilities).
- App Group `group.jp.jpng.passwd-sso.shared` must exist and be assigned to both
  app and extension IDs.

> With `CODE_SIGN_STYLE = Automatic`, Xcode will create/register most of this on
> first archive — but the App Group must be created and the capabilities enabled
> on the App IDs, or the upload is rejected at signing.

### Step 2 — Build number (automatic)

App Store Connect rejects a re-uploaded build number. You normally do **not**
need to bump anything: `CURRENT_PROJECT_VERSION` is set to `$(MARKETING_VERSION)`
in `ios/project.yml`, so the build number tracks the marketing version
release-please manages — each release advances both. Just `xcodegen generate`
after pulling a release.

The only manual case: re-uploading the **same** marketing version (e.g. a
rejected build re-submitted without a release bump). Then give that one upload a
unique build number by hand (e.g. set `CURRENT_PROJECT_VERSION` to
`0.4.59.1`) and `xcodegen generate`. **Revert it to `$(MARKETING_VERSION)`
afterwards** — leaving the literal in place freezes the build number and the
next release will be rejected for a duplicate build number.

### Step 3 — Archive & export the .ipa

One-shot script — runs `xcodegen generate` → `xcodebuild archive` →
`-exportArchive`, producing `ios/build/PasswdSSO.ipa`:

```bash
ios/scripts/build-appstore-ipa.sh
```

It uses automatic signing (`-allowProvisioningUpdates`), so Xcode must be signed
in with an Apple ID on team `4789NDA9RQ`; export options live in
`ios/scripts/ExportOptions.plist` (method `app-store-connect`). No secrets are
stored in the repo.

Xcode GUI equivalent: select scheme `PasswdSSOApp`, destination
"Any iOS Device (arm64)", then Product → Archive.

> The simulator Release build already passes in this repo, so code/config is
> sound. The device archive additionally exercises real distribution code
> signing.

### Step 4 — Upload to App Store Connect

- **Transporter.app**: drag in `ios/build/PasswdSSO.ipa` (from Step 3).
- Or Xcode Organizer → select the archive → **Distribute App** → **App Store
  Connect** → **Upload** (lets Xcode manage signing).
- Or CLI with an App Store Connect API key (`.p8` + key id + issuer id):
  `xcrun altool --upload-app -f ios/build/PasswdSSO.ipa -t ios --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>`.
- Wait for the build to finish **processing** in App Store Connect (minutes to
  ~1 hour), then it becomes selectable under the app version.

### Step 5 — Create the app record & fill the listing

App Store Connect → Apps → **+ New App**:
- Platform iOS, name `passwd-sso`, primary language English (U.S.),
  bundle ID `jp.jpng.passwd-sso`, SKU (any stable string, e.g. `passwd-sso-ios`).
- Fill all of Part 1 (description, keywords, URLs), Part 2 (App Privacy),
  Part 4 (icon + screenshots), and attach the processed build.

### Step 6 — Export compliance

When you select the build, App Store Connect asks about encryption. Because
`ITSAppUsesNonExemptEncryption = false` is now in the Info.plist, **the prompt is
skipped** — the answer is baked in (standard crypto only, exemption applies).

### Step 7 — (Recommended) TestFlight first

Before submitting for review, add yourself as an internal tester and install via
TestFlight on a real device. Verify: server URL entry, OAuth sign-in, vault
unlock with Face ID, and that passwd-sso appears and works under
Settings → General → AutoFill & Passwords. This catches device-only signing and
AutoFill registration issues that the simulator cannot.

### Step 8 — Submit for Review

- Paste the Part 3 review notes (with a live demo server + credentials).
- Set the App Review contact.
- Choose manual or automatic release.
- Submit. First reviews typically take ~24–48 hours.

---

## Pre-Submit Checklist

- [ ] Apple Developer membership active; Free app agreement signed.
- [ ] App IDs + App Group + capabilities registered (Step 1).
- [ ] `xcodegen generate` run; build number = marketing version (auto, Step 2).
- [ ] Device archive uploaded and processed (Steps 3–4).
- [ ] Privacy Policy URL published and reachable.
- [ ] Support URL set.
- [ ] App Icon 1024 has no alpha channel.
- [ ] 6.9" screenshots (≥1) uploaded.
- [ ] App Privacy = "Data Not Collected".
- [ ] Review notes include a working demo server URL + credentials.
- [ ] App Review contact filled.
- [ ] TestFlight smoke test passed on a real device (recommended).
