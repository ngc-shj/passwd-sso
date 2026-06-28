# Changelog

## [0.4.62](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.61...passwd-sso-v0.4.62) (2026-06-28)


### Features

* **extension:** copy-username button + confirmed cross-origin autofill in popup ([#619](https://github.com/ngc-shj/passwd-sso/issues/619)) ([8726161](https://github.com/ngc-shj/passwd-sso/commit/8726161e4ad03ae72bdbcee2e4404c75d61f7bcc))


### Bug Fixes

* **security:** fail-closed rate limiters + remove GET-side trash auto-purge ([#611](https://github.com/ngc-shj/passwd-sso/issues/611)) ([e52932e](https://github.com/ngc-shj/passwd-sso/commit/e52932ecc0a078f65b6d89253016393b11b178e2))
* **security:** narrow Bearer-bypass matcher to method + exact path ([#612](https://github.com/ngc-shj/passwd-sso/issues/612)) ([7d2d6cd](https://github.com/ngc-shj/passwd-sso/commit/7d2d6cd907c6350bb8ac8a754b090734eba75a52))
* **security:** step-up on permanent purge + fail-closed mint/SCIM/reset limiters ([#617](https://github.com/ngc-shj/passwd-sso/issues/617)) ([fca1acb](https://github.com/ngc-shj/passwd-sso/commit/fca1acbb9dd65959f2b6c3166d00182187f01b29))
* **security:** treat Redis pipeline per-command errors as fail-closed ([#614](https://github.com/ngc-shj/passwd-sso/issues/614)) ([d5bb0fc](https://github.com/ngc-shj/passwd-sso/commit/d5bb0fcad4a3e4beec316c8a7d26a6decd45d9ee))

## [0.4.61](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.60...passwd-sso-v0.4.61) (2026-06-25)


### Features

* **ios:** demo mode for App Store review (read-only, isolated) ([#609](https://github.com/ngc-shj/passwd-sso/issues/609)) ([952dd35](https://github.com/ngc-shj/passwd-sso/commit/952dd3589a33170102ee9e05089b47e982fa6b80))
* **ios:** favicon display via server proxy, per-user opt-in (default OFF) ([#605](https://github.com/ngc-shj/passwd-sso/issues/605)) ([56ff138](https://github.com/ngc-shj/passwd-sso/commit/56ff13883535c917f1865b7bcd183a432e4df703))
* **ios:** tappable entry URL + unified copy feedback (toast+haptic) ([#610](https://github.com/ngc-shj/passwd-sso/issues/610)) ([0423b3d](https://github.com/ngc-shj/passwd-sso/commit/0423b3dcef986d1b597507351bc2a2076987ce8b))
* **security:** step-up reauth on team config/identity/key ops + narrow /api/teams Bearer-bypass ([#607](https://github.com/ngc-shj/passwd-sso/issues/607)) ([8351a1e](https://github.com/ngc-shj/passwd-sso/commit/8351a1ea31659e097d303f712329a29016e9ef3e))
* **security:** step-up reauth on tenant-admin mutations + no-store on secret responses ([#606](https://github.com/ngc-shj/passwd-sso/issues/606)) ([bf328fb](https://github.com/ngc-shj/passwd-sso/commit/bf328fb17cc87761a96f63a49b167d7d4b28fe61))
* **web:** server-side favicon proxy with per-user opt-in (default OFF) ([#603](https://github.com/ngc-shj/passwd-sso/issues/603)) ([d73ac24](https://github.com/ngc-shj/passwd-sso/commit/d73ac241a6ffe375ebbad2e40a112f3e03597f54))


### Bug Fixes

* **extension:** enforce user-presence on WebAuthn bridge sign/create ([#608](https://github.com/ngc-shj/passwd-sso/issues/608)) ([41ab672](https://github.com/ngc-shj/passwd-sso/commit/41ab67233dd22587e871414cbb5f16da02552c6d))

## [0.4.60](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.59...passwd-sso-v0.4.60) (2026-06-22)


### Features

* **ios:** build-number auto-track + App Store .ipa build script ([#600](https://github.com/ngc-shj/passwd-sso/issues/600)) ([194424c](https://github.com/ngc-shj/passwd-sso/commit/194424cba9ec7de9779381bfbc36f58be4ebd2cf))
* **ios:** in-app language switcher (System / 日本語 / English) ([#599](https://github.com/ngc-shj/passwd-sso/issues/599)) ([8e9d5e8](https://github.com/ngc-shj/passwd-sso/commit/8e9d5e8da4afaef463d7a3dd6aa3ef4e2638ada9))


### Bug Fixes

* **api:** enforce streaming body-size caps on form/raw/multipart routes ([#595](https://github.com/ngc-shj/passwd-sso/issues/595)) ([42a0ffc](https://github.com/ngc-shj/passwd-sso/commit/42a0ffc2d919917886d631dda1245afd5d065cec))
* **api:** harden ssh-sign cap, tag dedup, SA token count, webauthn challenge scoping ([#593](https://github.com/ngc-shj/passwd-sso/issues/593)) ([4019d33](https://github.com/ngc-shj/passwd-sso/commit/4019d33a2641c7262b8c9ef9da52253538e35556))
* **ios:** decode SSH keySize as number to fix undecryptable SSH entries ([#598](https://github.com/ngc-shj/passwd-sso/issues/598)) ([175d85d](https://github.com/ngc-shj/passwd-sso/commit/175d85d3f31815bf55234c486b7a7d18094f96bd))
* **ui:** wrap long unbreakable tokens in AlertDialog descriptions ([#596](https://github.com/ngc-shj/passwd-sso/issues/596)) ([522e29a](https://github.com/ngc-shj/passwd-sso/commit/522e29a128a60244b10f3276e0b6dbce0296a844))

## [0.4.59](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.58...passwd-sso-v0.4.59) (2026-06-18)


### Features

* **ios:** render type-specific fields in entry detail view ([#587](https://github.com/ngc-shj/passwd-sso/issues/587)) ([b17112f](https://github.com/ngc-shj/passwd-sso/commit/b17112fd43583877f662a9588949c1b21882702d))
* **ios:** restore session at launch — skip URL/sign-in screens for returning users ([#569](https://github.com/ngc-shj/passwd-sso/issues/569)) ([1a96fc6](https://github.com/ngc-shj/passwd-sso/commit/1a96fc6ff0098907f35ec403751ba45d40e26c47))
* **security:** emergency-access-grant GC with status-aware guard (SC6b) ([#582](https://github.com/ngc-shj/passwd-sso/issues/582)) ([0e6d5c5](https://github.com/ngc-shj/passwd-sso/commit/0e6d5c54b0ad0e7867b8d8ea324b569bfeb609c1))
* **security:** family-aware GC for MCP OAuth token rotation family (SC5) ([#576](https://github.com/ngc-shj/passwd-sso/issues/576)) ([449bcfe](https://github.com/ngc-shj/passwd-sso/commit/449bcfe4b8c97e2b61903af6ae486cf756fad45f))
* **security:** forensic-credential GC with emit-provenance-before-delete (SC4) ([#577](https://github.com/ngc-shj/passwd-sso/issues/577)) ([7911587](https://github.com/ngc-shj/passwd-sso/commit/7911587c44265a70abf16610aa8386bd9f8a2d8e))
* **security:** generic retention-GC worker for expired-data physical deletion ([#571](https://github.com/ngc-shj/passwd-sso/issues/571)) ([fd7984f](https://github.com/ngc-shj/passwd-sso/commit/fd7984fea30e740091dc358b4e29dd6f9cedb5ec))
* **security:** per-tenant retention for append-only logs (SC7) ([#580](https://github.com/ngc-shj/passwd-sso/issues/580)) ([4bca973](https://github.com/ngc-shj/passwd-sso/commit/4bca9736ba5f012cc4dcf92ae1b9e206de568159))
* **security:** security-record retention GC with provenance (SC6) ([#581](https://github.com/ngc-shj/passwd-sso/issues/581)) ([76b9308](https://github.com/ngc-shj/passwd-sso/commit/76b9308dae8c0ac21f8e7a5b7b84f8e01b8af7a7))
* **security:** tenant-configurable password-history auto-trim (SC3) ([#579](https://github.com/ngc-shj/passwd-sso/issues/579)) ([7b77587](https://github.com/ngc-shj/passwd-sso/commit/7b77587e5df2d2b5ad49c3700ca403a85eb7850f))
* **security:** tenant-configurable trash auto-purge with blob cleanup (SC2) ([#578](https://github.com/ngc-shj/passwd-sso/issues/578)) ([483d8d9](https://github.com/ngc-shj/passwd-sso/commit/483d8d96cb600e9927ae73d827278d502645b37e))
* **tenant:** expose per-tenant retention windows in policy API + settings card ([#583](https://github.com/ngc-shj/passwd-sso/issues/583)) ([1df9c58](https://github.com/ngc-shj/passwd-sso/commit/1df9c58ca28371026e13c2207869575ba91f459a))


### Bug Fixes

* **deps:** bump nodemailer to 9.0.1 to clear high-severity CVEs ([#585](https://github.com/ngc-shj/passwd-sso/issues/585)) ([a2840b1](https://github.com/ngc-shj/passwd-sso/commit/a2840b114597bf5d0cf400a692ad869e6075cd03))
* **deps:** declare undici as a direct dependency; bump undici/babel off CVEs ([#589](https://github.com/ngc-shj/passwd-sso/issues/589)) ([2dd8bf5](https://github.com/ngc-shj/passwd-sso/commit/2dd8bf5dcddd34130b0e00cb4809699fefe99b62))
* **extension:** override undici &gt;=7.28.0 to clear transitive CVEs ([#591](https://github.com/ngc-shj/passwd-sso/issues/591)) ([fdcfef3](https://github.com/ngc-shj/passwd-sso/commit/fdcfef345b69f67ad219d89fe15f008b325592b9))
* **security:** harden multi-tenant boundaries (TOCTOU, token tenant cross-checks, mutation scoping) ([#567](https://github.com/ngc-shj/passwd-sso/issues/567)) ([c72313e](https://github.com/ngc-shj/passwd-sso/commit/c72313e19fcb5f93f8651306023fd20dac79a473))
* **security:** patch HIGH CVEs — hono 4.12.25, base-image OpenSSL 3.5.7-r0 ([#572](https://github.com/ngc-shj/passwd-sso/issues/572)) ([b26aaea](https://github.com/ngc-shj/passwd-sso/commit/b26aaea32725e994ec411e85970eafd47a21b182))
* **vault:** sync 3-pane detail header to edited entry overview ([#592](https://github.com/ngc-shj/passwd-sso/issues/592)) ([0d1b86b](https://github.com/ngc-shj/passwd-sso/commit/0d1b86b0bbdccfa8d0d428c1737ff6107ab3cd31))


### Code Refactoring

* **ios:** replace hardcoded values with shared constants ([#570](https://github.com/ngc-shj/passwd-sso/issues/570)) ([e36dde6](https://github.com/ngc-shj/passwd-sso/commit/e36dde6455c35cb870f5c3a8ad92cc0477169f05))

## [0.4.58](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.57...passwd-sso-v0.4.58) (2026-06-15)


### Features

* iOS passkey registration — AutoFill provider, DPoP-bound upload, vault sync UI ([#560](https://github.com/ngc-shj/passwd-sso/issues/560)) ([64d1065](https://github.com/ngc-shj/passwd-sso/commit/64d10656ed4f0dac1f02090b2692074fe2d4a0cf))
* **ios:** auto-copy TOTP to clipboard after AutoFill login (opt-in) ([#555](https://github.com/ngc-shj/passwd-sso/issues/555)) ([82b29dc](https://github.com/ngc-shj/passwd-sso/commit/82b29dcf04c1bc4a4b16495edab7eb7d926a09af))
* **ios:** category landing grid for the vault ([#559](https://github.com/ngc-shj/passwd-sso/issues/559)) ([6a4d87a](https://github.com/ngc-shj/passwd-sso/commit/6a4d87a4cc5c4fe6e69c6c634df8052bc8d17a00))
* **ios:** dedicated quota-exceeded message on entry create (S10-A) ([#564](https://github.com/ngc-shj/passwd-sso/issues/564)) ([d312675](https://github.com/ngc-shj/passwd-sso/commit/d3126750b82710b0d8707842d8874dd42384d943))
* **ios:** team vault support — AutoFill QuickType, fill, and in-app team vault ([#565](https://github.com/ngc-shj/passwd-sso/issues/565)) ([3b7be11](https://github.com/ngc-shj/passwd-sso/commit/3b7be1126981517558cdba777960df5856993e11))


### Bug Fixes

* **deps:** pin esbuild &gt;=0.28.1 in root and cli to close RCE/file-read CVEs ([#566](https://github.com/ngc-shj/passwd-sso/issues/566)) ([e4f1270](https://github.com/ngc-shj/passwd-sso/commit/e4f12705fa245dab0f6890f98561ca645c8a95eb))
* **ios:** sync MARKETING_VERSION to released 0.4.57 ([#556](https://github.com/ngc-shj/passwd-sso/issues/556)) ([ba64d20](https://github.com/ngc-shj/passwd-sso/commit/ba64d20362a4e704e0544ed78974797508a9310c))


### Code Refactoring

* replace hardcoded values with shared constants ([#561](https://github.com/ngc-shj/passwd-sso/issues/561)) ([ea97e0f](https://github.com/ngc-shj/passwd-sso/commit/ea97e0f0c8f1d2db8a90a6c0c8f7d5b8f2d66c02))

## [0.4.57](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.56...passwd-sso-v0.4.57) (2026-06-12)


### Features

* **extension:** search all vault entries from the popup search box ([#553](https://github.com/ngc-shj/passwd-sso/issues/553)) ([967826a](https://github.com/ngc-shj/passwd-sso/commit/967826a138144cbd8671577502fb9a4111fcd402))
* **ios:** add app icon (full-bleed brand keyhole) ([#531](https://github.com/ngc-shj/passwd-sso/issues/531)) ([6327a25](https://github.com/ngc-shj/passwd-sso/commit/6327a259bf42521d355ddf0391caf9baacd77d2c))
* **ios:** Face ID vault unlock (biometric host re-unlock) ([#542](https://github.com/ngc-shj/passwd-sso/issues/542)) ([756e5cc](https://github.com/ngc-shj/passwd-sso/commit/756e5ccbd3c12077b664ca9e4240f615507fff28))
* **ios:** host-server integration (custom-scheme OAuth, personal vault, AutoFill) ([#529](https://github.com/ngc-shj/passwd-sso/issues/529)) ([ab8e2b2](https://github.com/ngc-shj/passwd-sso/commit/ab8e2b2cb3c89c9580fcfd2f0db8c200423b70fd))
* **ios:** localize app + AutoFill extension (en + ja via String Catalog) ([#543](https://github.com/ngc-shj/passwd-sso/issues/543)) ([a3415ac](https://github.com/ngc-shj/passwd-sso/commit/a3415aca871edee09d1b844e11e4b62bd6928467))
* **ios:** manual Sign Out + tenant auto-lock override ([#544](https://github.com/ngc-shj/passwd-sso/issues/544)) ([0e7db75](https://github.com/ngc-shj/passwd-sso/commit/0e7db75efe79c404e149e37af5a66afa5f80554e))
* **ios:** meet 44pt HIG tap targets across views ([#532](https://github.com/ngc-shj/passwd-sso/issues/532)) ([609f299](https://github.com/ngc-shj/passwd-sso/commit/609f2999fb05088e9d095970ba51597fff10aa0f))
* **ios:** passkey (WebAuthn) provider — assertion-only AutoFill ([#549](https://github.com/ngc-shj/passwd-sso/issues/549)) ([fc4d568](https://github.com/ngc-shj/passwd-sso/commit/fc4d5686205da006ba985c74e375303ade0c7ca5))
* **ios:** QuickType inline AutoFill suggestions (ASCredentialIdentityStore) ([#537](https://github.com/ngc-shj/passwd-sso/issues/537)) ([6141399](https://github.com/ngc-shj/passwd-sso/commit/614139960cbd0dca671873896b41cf3eeaad2ab9))
* **ios:** settings screen with extension parity (auto-lock, timeout action, clipboard, theme) ([#535](https://github.com/ngc-shj/passwd-sso/issues/535)) ([7608f61](https://github.com/ngc-shj/passwd-sso/commit/7608f61856b1f8078f7dca47cc18898cc9056470))


### Bug Fixes

* **api:** align v1 password API crypto guards with session API ([#525](https://github.com/ngc-shj/passwd-sso/issues/525)) ([5893bb7](https://github.com/ngc-shj/passwd-sso/commit/5893bb75f08800feb262169ea9cffe7b7ee7859d))
* **extension:** bound the service-worker hydration wait so GET_STATUS can't hang ([#551](https://github.com/ngc-shj/passwd-sso/issues/551)) ([8683d89](https://github.com/ngc-shj/passwd-sso/commit/8683d896ff44ba6722a877293fd6f45247385203))
* **extension:** route expired-session reauth to full sign-in; add verifying label + cancel ([#550](https://github.com/ngc-shj/passwd-sso/issues/550)) ([36e8990](https://github.com/ngc-shj/passwd-sso/commit/36e8990dc2371dbca948220638a20f826acb7a4e))
* **ext:** recover popup from stuck "loading" when service worker is unreachable ([#545](https://github.com/ngc-shj/passwd-sso/issues/545)) ([74e646a](https://github.com/ngc-shj/passwd-sso/commit/74e646ab36bc990d5b82c90fcf6251909075c308))
* **hardening:** post-[#530](https://github.com/ngc-shj/passwd-sso/issues/530) follow-ups (Redis HA, Sentry scrub, Jackson connect isolation, env-example, CodeQL) ([#536](https://github.com/ngc-shj/passwd-sso/issues/536)) ([024ee44](https://github.com/ngc-shj/passwd-sso/commit/024ee44dd909554346363293878687a4e7838f44))
* **ios:** AutoFill credential list (iOS 17+ methods) + matched-only picker with search ([#533](https://github.com/ngc-shj/passwd-sso/issues/533)) ([8a54937](https://github.com/ngc-shj/passwd-sso/commit/8a54937c71c70932954690da2e8fe642e7601a11))
* **ios:** honest "Vault is Locked" AutoFill copy (no fake "Open app" button) ([#539](https://github.com/ngc-shj/passwd-sso/issues/539)) ([98ef98d](https://github.com/ngc-shj/passwd-sso/commit/98ef98ddb24a53aca21e978b64aa2df6f06680f3))
* **ios:** passkey AutoFill backgrounding + AutoFill hardening (full-tree review, -1004 deferral, search guards) ([#552](https://github.com/ngc-shj/passwd-sso/issues/552)) ([0a0e27c](https://github.com/ngc-shj/passwd-sso/commit/0a0e27c7190ab5986fa1448398f9a79ffd0a18dc))
* **ios:** refresh access token on sync so unlock reflects web updates ([#547](https://github.com/ngc-shj/passwd-sso/issues/547)) ([41d8fd4](https://github.com/ngc-shj/passwd-sso/commit/41d8fd49336794c709da786f22e47c15453cdb7d))
* **mcp:** mitigate DCR cross-tenant DoS at the root (TTL 15min + cap 1000) ([#538](https://github.com/ngc-shj/passwd-sso/issues/538)) ([f9ee31f](https://github.com/ngc-shj/passwd-sso/commit/f9ee31f4639c76a13c2c95616b77838e11ef537f))
* **passwords:** lost-update-safe history snapshot + v1/api-key consistency ([#534](https://github.com/ngc-shj/passwd-sso/issues/534)) ([cee9734](https://github.com/ngc-shj/passwd-sso/commit/cee973487ac8bcd35505b2dc9abd9f02c5f5975c))
* **security:** remediate 2026-06 audit short + mid-term findings (C1–C13) ([#530](https://github.com/ngc-shj/passwd-sso/issues/530)) ([40e23fa](https://github.com/ngc-shj/passwd-sso/commit/40e23fa38492a932ef7b057b2752a2a32ecd2fe6))
* **webauthn:** abort stale in-flight ceremony so the passkey prompt always surfaces ([#546](https://github.com/ngc-shj/passwd-sso/issues/546)) ([f3edfac](https://github.com/ngc-shj/passwd-sso/commit/f3edfac1a2f7b93c3dab72198a4529dc3a8c96b8))

## [0.4.56](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.55...passwd-sso-v0.4.56) (2026-06-07)


### Features

* add dev.sh compose helper and systemd self-host unit ([#519](https://github.com/ngc-shj/passwd-sso/issues/519)) ([97ee716](https://github.com/ngc-shj/passwd-sso/commit/97ee7166ecc286053a1950628e981a88f4c0daeb))
* RFC 9987 audited SSH agent with per-signature authorization ([#518](https://github.com/ngc-shj/passwd-sso/issues/518)) ([7aa321c](https://github.com/ngc-shj/passwd-sso/commit/7aa321c4f8923f62ac81348f8403a81b49b32a1b))
* **vault:** reorganize 3-pane action buttons and label copy actions ([#516](https://github.com/ngc-shj/passwd-sso/issues/516)) ([14bbbe1](https://github.com/ngc-shj/passwd-sso/commit/14bbbe1fedf05cf7b849bf645fdf5421486ca5e8))
* **vault:** three-pane master-detail layout for desktop vault (personal + team) ([#515](https://github.com/ngc-shj/passwd-sso/issues/515)) ([6e47d1d](https://github.com/ngc-shj/passwd-sso/commit/6e47d1d31855db05d1b516a0df30938b45d30a1f))


### Bug Fixes

* **ci:** add gitleaks secret-scan job and fix Dockerfile version compare ([#512](https://github.com/ngc-shj/passwd-sso/issues/512)) ([1e9c6b7](https://github.com/ngc-shj/passwd-sso/commit/1e9c6b7a95f21e7fd1db89365bf4cae8ae86e548))
* **ci:** pin Actions to SHAs, gate static checks in CI, pin Dockerfile prisma ([#510](https://github.com/ngc-shj/passwd-sso/issues/510)) ([b9232e1](https://github.com/ngc-shj/passwd-sso/commit/b9232e12b49e8f39c628240f8516d60cc5b154b9))
* **dashboard:** contain vault scroll inside detail pane when banner shown ([#524](https://github.com/ngc-shj/passwd-sso/issues/524)) ([9529d66](https://github.com/ngc-shj/passwd-sso/commit/9529d66421911459808e1c3fa2ceec4808d0ce7b))
* **deps:** patch hono and vitest security advisories ([#517](https://github.com/ngc-shj/passwd-sso/issues/517)) ([a33cbbb](https://github.com/ngc-shj/passwd-sso/commit/a33cbbb8a97ed1f54b4d21f7b5367baee45ea7e8))


### Code Refactoring

* **generator:** move password-generator into src/lib/generator/ ([#522](https://github.com/ngc-shj/passwd-sso/issues/522)) ([88c8a85](https://github.com/ngc-shj/passwd-sso/commit/88c8a859e743963b88b5e84d8f1dc27bb7c438d1))
* **tests:** co-locate orphan src/lib tests + drop a duplicate ([#523](https://github.com/ngc-shj/passwd-sso/issues/523)) ([862611a](https://github.com/ngc-shj/passwd-sso/commit/862611ab86d329020dd973d22ba0667b136f27eb))

## [0.4.55](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.54...passwd-sso-v0.4.55) (2026-05-31)


### Features

* **ext:** inline in-page autofill suggestions for credit cards and identities ([#504](https://github.com/ngc-shj/passwd-sso/issues/504)) ([ed67abd](https://github.com/ngc-shj/passwd-sso/commit/ed67abd565fa4a0aaa120aa61433869cc5e0b602))
* **identity:** structured name + address fields for autofill ([#507](https://github.com/ngc-shj/passwd-sso/issues/507)) ([fdf6937](https://github.com/ngc-shj/passwd-sso/commit/fdf693768563befc0c1d1216ddd132d7dc583cb5))


### Bug Fixes

* **i18n:** use distinct recovery-key warning when key already invalidated ([#506](https://github.com/ngc-shj/passwd-sso/issues/506)) ([936d7b2](https://github.com/ngc-shj/passwd-sso/commit/936d7b21a88f40ab2b6b3843dd567a598ed7e8e4))
* security hardening sweep — sub-threshold review findings, propagation, tests & docs ([#500](https://github.com/ngc-shj/passwd-sso/issues/500)) ([f66f2b0](https://github.com/ngc-shj/passwd-sso/commit/f66f2b0e8f6f52074ba85e26cefb6e27ffe46d0e))
* **security:** decrypt personal entry history with the entry AAD; unify and gate all AAD construction ([#508](https://github.com/ngc-shj/passwd-sso/issues/508)) ([ddb7844](https://github.com/ngc-shj/passwd-sso/commit/ddb784466e8e346c38efcb793647d78d005fb881))
* **security:** pre-v1.0 XSS hardening — in-memory PRF handoff + API baseline headers ([#502](https://github.com/ngc-shj/passwd-sso/issues/502)) ([196ecb4](https://github.com/ngc-shj/passwd-sso/commit/196ecb4b43ac3a96e259a02a98ef845b1555d961))
* **security:** sync personal-vault AAD to 3-field scheme (extension + iOS) ([#503](https://github.com/ngc-shj/passwd-sso/issues/503)) ([fc2e507](https://github.com/ngc-shj/passwd-sso/commit/fc2e507ff5bb207be1c5678f921ca52679b27a7c))
* **security:** zeroize PRF output and unwrapped vault key on all paths ([#505](https://github.com/ngc-shj/passwd-sso/issues/505)) ([21f9939](https://github.com/ngc-shj/passwd-sso/commit/21f99397b4dac52938cddf8fceaf074eea253e55))

## [0.4.54](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.53...passwd-sso-v0.4.54) (2026-05-27)


### Features

* **extension:** click-driven ext_connect + userActivation gate (C15-v2) ([#497](https://github.com/ngc-shj/passwd-sso/issues/497)) ([bc6e578](https://github.com/ngc-shj/passwd-sso/commit/bc6e578f051ad05e817830d706ac80cc6cb61b2b))
* **extension:** emit EXTENSION_BRIDGE_CODE_ISSUE_FAILURE on every fail path ([#495](https://github.com/ngc-shj/passwd-sso/issues/495)) ([6b07d6e](https://github.com/ngc-shj/passwd-sso/commit/6b07d6e8c3bb5fa21881bfc3a5ccdf4857f1e23b))


### Bug Fixes

* **extension:** clearer disconnect icon + accurate login-prompt wording ([#498](https://github.com/ngc-shj/passwd-sso/issues/498)) ([dcdd94a](https://github.com/ngc-shj/passwd-sso/commit/dcdd94a8a9b18d80887688e628f94b6274a7bda8))

## [0.4.53](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.52...passwd-sso-v0.4.53) (2026-05-25)


### Features

* **extension:** SW-initiated bridge-code + cnf_jkt trust path ([#492](https://github.com/ngc-shj/passwd-sso/issues/492)) ([24a2002](https://github.com/ngc-shj/passwd-sso/commit/24a20026e54cedf549e00e1aabc3774da53c9756))

## [0.4.52](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.51...passwd-sso-v0.4.52) (2026-05-25)


### Features

* **extension:** DPoP sender-constrained tokens (RFC 9449) ([#491](https://github.com/ngc-shj/passwd-sso/issues/491)) ([3f08e60](https://github.com/ngc-shj/passwd-sso/commit/3f08e60d33e9ee4f3d9d500bb310ba029412de2c))


### Bug Fixes

* **auth:** preserve freshly-issued session in passkey re-auth cascade ([#486](https://github.com/ngc-shj/passwd-sso/issues/486)) ([4ae21db](https://github.com/ngc-shj/passwd-sso/commit/4ae21dbe1602f39235a50ccd389c5c98312598cc))
* **env:** require AUDIT_ANCHOR_PUBLISHER_ENABLED in production (A08-3) ([#485](https://github.com/ngc-shj/passwd-sso/issues/485)) ([f821126](https://github.com/ngc-shj/passwd-sso/commit/f82112656481e592707f3e887ee8d59dae41b14f))
* **security:** batch 1 — critical + high findings from codebase audit ([#479](https://github.com/ngc-shj/passwd-sso/issues/479)) ([4265725](https://github.com/ngc-shj/passwd-sso/commit/4265725d7b885b89b9131454f6e0dbfab419b35e))
* **security:** batch 2 — medium + low findings from codebase audit ([#481](https://github.com/ngc-shj/passwd-sso/issues/481)) ([79373df](https://github.com/ngc-shj/passwd-sso/commit/79373df33ba21c8717575dd1b6ec80098b2c1c98))
* **security:** deprecate legacy extension token endpoint (P0) ([#489](https://github.com/ngc-shj/passwd-sso/issues/489)) ([a152cd0](https://github.com/ngc-shj/passwd-sso/commit/a152cd0d30a8cc0125753a5405c62ca061f138fc))
* **security:** OWASP batch 3 — Low + Info findings (14 items) ([#484](https://github.com/ngc-shj/passwd-sso/issues/484)) ([522ee05](https://github.com/ngc-shj/passwd-sso/commit/522ee0588b704aa4e3785ed77836d598f6f3fcbb))


### Code Refactoring

* extract BRIDGE_CODE_LENGTH constant + post-review minor fixes ([#490](https://github.com/ngc-shj/passwd-sso/issues/490)) ([5c05a92](https://github.com/ngc-shj/passwd-sso/commit/5c05a9268013a4b1899b632982d345509037583c))

## [0.4.51](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.50...passwd-sso-v0.4.51) (2026-05-20)


### Bug Fixes

* **auth:** restore SameSite=Lax on session cookie to unblock OAuth sign-in ([#477](https://github.com/ngc-shj/passwd-sso/issues/477)) ([0643b7a](https://github.com/ngc-shj/passwd-sso/commit/0643b7a8136c582a9b2648e499278e6e3103a174))
* **security:** clear GitHub security advisories (brace-expansion DoS + 3 CodeQL findings) ([#478](https://github.com/ngc-shj/passwd-sso/issues/478)) ([aacd5fa](https://github.com/ngc-shj/passwd-sso/commit/aacd5fa7cbfa35fbee1e27e25e2e11c347787d63))
* **security:** harden RLS/delegation/mobile-DPoP/webhook boundaries (10 contracts) ([#475](https://github.com/ngc-shj/passwd-sso/issues/475)) ([ab1b168](https://github.com/ngc-shj/passwd-sso/commit/ab1b1689963b69871c51a135dbeb47e6058502e2))

## [0.4.50](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.49...passwd-sso-v0.4.50) (2026-05-17)


### Features

* **security:** add fail-closed rate-limit on Redis errors for auth/credential boundaries ([#473](https://github.com/ngc-shj/passwd-sso/issues/473)) ([0d7dc04](https://github.com/ngc-shj/passwd-sso/commit/0d7dc04d5f9e99ddf311f44f5f88707bef23aa02))


### Bug Fixes

* **security:** close Bearer-token scope boundary gaps (OWASP A01/A04/A07) ([#470](https://github.com/ngc-shj/passwd-sso/issues/470)) ([a354a8b](https://github.com/ngc-shj/passwd-sso/commit/a354a8b968e520c89baef36a81b4519ffa5d8f80))
* **security:** close PR [#470](https://github.com/ngc-shj/passwd-sso/issues/470) followup gaps (intra-user IDOR + AAD re-wrap + 2 minor) ([#472](https://github.com/ngc-shj/passwd-sso/issues/472)) ([5ecacce](https://github.com/ngc-shj/passwd-sso/commit/5ecacced7a10320704e6b41db40c50700f7fde57))

## [0.4.49](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.48...passwd-sso-v0.4.49) (2026-05-16)


### Bug Fixes

* OWASP Top 10 followup (A05/A07/A09) — centralize Redis fallback log throttle, sanitize audit-outbox `lastError`, warn-log passkey policy fetch failure, scope OAuth callback rate limit to `/api/auth/callback/*`, centralize session cookie naming with `__Host-` + `sameSite=strict`, fail-closed docker-compose DB passwords ([#468](https://github.com/ngc-shj/passwd-sso/issues/468)) ([a8e3a74](https://github.com/ngc-shj/passwd-sso/commit/a8e3a74bff7d6f56e9d127dd1c6a7a99c3a72f44))


### Notes

* PR [#465](https://github.com/ngc-shj/passwd-sso/issues/465) initially attempted these OWASP hardenings but was reverted via PR [#467](https://github.com/ngc-shj/passwd-sso/issues/467) after a post-merge review found 4 Critical + 13 Major defects (production-breaking session cookie name propagation gap, broken docker-compose env wiring, failing CI gate, etc.). The salvageable items were re-implemented correctly in PR [#468](https://github.com/ngc-shj/passwd-sso/issues/468). Items intentionally dropped: A02 (CLI TLS NODE_ENV guard — ineffective in practice), A07 (vault setup `entropyBits` validation — bypassable in zero-knowledge model). Rationale and the remaining tracked finding (A04/A07 passkey policy fail-OPEN) documented in [`docs/security/owasp-top10-2026-05.md`](https://github.com/ngc-shj/passwd-sso/blob/main/docs/security/owasp-top10-2026-05.md).

## [0.4.48](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.47...passwd-sso-v0.4.48) (2026-05-13)


### Bug Fixes

* enable cross-tenant guest team admin operations ([#459](https://github.com/ngc-shj/passwd-sso/issues/459)) ([d78e01a](https://github.com/ngc-shj/passwd-sso/commit/d78e01a8c29f46f001dbbbcb4d14d86d6038e3ee))
* **proxy:** correct port leak under tailscale serve ([#461](https://github.com/ngc-shj/passwd-sso/issues/461)) ([f26fdb8](https://github.com/ngc-shj/passwd-sso/commit/f26fdb82ff6cc4d2359b7716233956aa257a5584))


### Code Refactoring

* unify API error handling — 156-code map, 10-rule gate, ~454 sites ([#463](https://github.com/ngc-shj/passwd-sso/issues/463)) ([f6c0c52](https://github.com/ngc-shj/passwd-sso/commit/f6c0c5267e238267b8539a952adfc0374fa30f4e))
* rebalance personal passkey sessions to AAL2 + unify inline-reauth UX ([#458](https://github.com/ngc-shj/passwd-sso/issues/458)) ([7ccfd48](https://github.com/ngc-shj/passwd-sso/commit/7ccfd48c8bc8e9269ec83195b1d5e80bec9adae9))
* **settings:** unify developer-tools card layout via InactiveItemsSection helper ([#460](https://github.com/ngc-shj/passwd-sso/issues/460)) ([90902b6](https://github.com/ngc-shj/passwd-sso/commit/90902b64651ffded9d8481591329d035fac90a99))
* **settings:** unify new-creation UI and scope token-mint errors ([#456](https://github.com/ngc-shj/passwd-sso/issues/456)) ([96d7b2a](https://github.com/ngc-shj/passwd-sso/commit/96d7b2af1a776fc90b8e97f3fdba1712a8e19e66))


### Miscellaneous

* **deps:** bump next from 16.2.3 to 16.2.6 ([#462](https://github.com/ngc-shj/passwd-sso/issues/462)) ([6f5ed58](https://github.com/ngc-shj/passwd-sso/commit/6f5ed584b60a3cfd0202721d074aa42bed9904f0))
* **deps:** bump hono override to 4.12.18 to close 4 Dependabot alerts ([#464](https://github.com/ngc-shj/passwd-sso/issues/464)) ([47a442b](https://github.com/ngc-shj/passwd-sso/commit/47a442baafcbe0d8f47de73ffeed418e00e68d9d))

## [0.4.47](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.46...passwd-sso-v0.4.47) (2026-05-06)


### Code Refactoring

* **cli:** derive secrets server URL from CLI login config ([#450](https://github.com/ngc-shj/passwd-sso/issues/450)) ([c21eed6](https://github.com/ngc-shj/passwd-sso/commit/c21eed6c4e1f78106a82744bed219a541bfc1c60))

## [0.4.46](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.45...passwd-sso-v0.4.46) (2026-05-05)


### Features

* **api/mobile:** server-side foundation for iOS AutoFill MVP — DPoP-bound /api/mobile/* endpoints ([#418](https://github.com/ngc-shj/passwd-sso/issues/418)) ([edf082b](https://github.com/ngc-shj/passwd-sso/commit/edf082b14b48b5a3263506af316a7f9b1765a79c))
* **audit-anchor:** external commitment — ADR + publisher + verifier CLI (Phase 1-3) ([#419](https://github.com/ngc-shj/passwd-sso/issues/419)) ([2462e5e](https://github.com/ngc-shj/passwd-sso/commit/2462e5eaa6781e07597f99a111f59446644bce53))
* **auth:** bind userId to OAuth token AAD + audit GCM tampering ([#421](https://github.com/ngc-shj/passwd-sso/issues/421)) ([7198d46](https://github.com/ngc-shj/passwd-sso/commit/7198d465611b5bc33021739ee8d18c93d4852f73))
* **ci:** runtime cross-tenant RLS predicate verification ([#440](https://github.com/ngc-shj/passwd-sso/issues/440)) ([f4d4068](https://github.com/ngc-shj/passwd-sso/commit/f4d4068ce2371eff99c62aeced6c5608f9f9fd16))
* **crypto:** dual-version verifier pepper support for non-disruptive rotation ([#414](https://github.com/ngc-shj/passwd-sso/issues/414)) ([9f43522](https://github.com/ngc-shj/passwd-sso/commit/9f4352217370a3638f45d61e5671c40d3338a38d))
* **ia:** admin-ia redesign — tenant + team admin restructure (mental-model-driven) ([#424](https://github.com/ngc-shj/passwd-sso/issues/424)) ([9c9bc8b](https://github.com/ngc-shj/passwd-sso/commit/9c9bc8baca5a82719f372f6aa8997b554fe2e805))
* **ia:** personal-security IA redesign — mental-model-driven settings restructure ([#423](https://github.com/ngc-shj/passwd-sso/issues/423)) ([6394f95](https://github.com/ngc-shj/passwd-sso/commit/6394f95ec18b3feb10624f4cb5695423f71d3475))
* **security:** adversarial tests + MCP refresh race fix ([#435](https://github.com/ngc-shj/passwd-sso/issues/435)) ([a910199](https://github.com/ngc-shj/passwd-sso/commit/a9101993a50f854a51bef603aa75790699da44e8))
* **vault:** Admin Vault Reset dual-admin approval + post-reset session invalidation ([#415](https://github.com/ngc-shj/passwd-sso/issues/415)) ([a1efe8a](https://github.com/ngc-shj/passwd-sso/commit/a1efe8a77d2c4b8df45729e34ea3eb0b15b58117))
* **vault:** non-destructive attachment rotation (Phase B) ([#444](https://github.com/ngc-shj/passwd-sso/issues/444)) ([ab31f82](https://github.com/ngc-shj/passwd-sso/commit/ab31f822e0cea10654dd94d036fe8d4a5ce0c8e4))


### Bug Fixes

* **audit-anchor:** apply encodeURIComponent sanitizer for CodeQL taint flow ([#420](https://github.com/ngc-shj/passwd-sso/issues/420)) ([52e505c](https://github.com/ngc-shj/passwd-sso/commit/52e505c6f475d421f25c827e6924bb9f8a764ff5))
* **audit:** emit cacheTombstoneFailures on vault reset / tenant policy invalidation ([#431](https://github.com/ngc-shj/passwd-sso/issues/431)) ([dc294e8](https://github.com/ngc-shj/passwd-sso/commit/dc294e86365630c800a4f839050deb908635cdf3))
* **audit:** honor actorType filter in personal/tenant download ([#430](https://github.com/ngc-shj/passwd-sso/issues/430)) ([4cbe340](https://github.com/ngc-shj/passwd-sso/commit/4cbe3407763e71d9e5e04389610e1f1e96119768))
* **crypto:** cover Recovery / EmergencyAccess / WebAuthn PRF wrappings + token revocation in vault key rotation ([#438](https://github.com/ngc-shj/passwd-sso/issues/438)) ([c07bba1](https://github.com/ngc-shj/passwd-sso/commit/c07bba13e9cfb5c4e9bd11eca871134ae34da1ea))
* **ios/autofill:** harden cache AAD, split bridge-key keychain, rename leaf-key hash ([#432](https://github.com/ngc-shj/passwd-sso/issues/432)) ([2b26c4a](https://github.com/ngc-shj/passwd-sso/commit/2b26c4ad710d88499918976b009589fd49861b37))
* **maintenance:** scope op_* token routes to issuer tenant ([#410](https://github.com/ngc-shj/passwd-sso/issues/410)) ([560b019](https://github.com/ngc-shj/passwd-sso/commit/560b019048dc16d7b614f71d192b577083a13bde))
* **vault:** close upload TOCTOU by moving cekKeyVersion check into tx ([#446](https://github.com/ngc-shj/passwd-sso/issues/446)) ([afb71e6](https://github.com/ngc-shj/passwd-sso/commit/afb71e6f00a5ad5ae00bbe74c8cb44f358fbee5f))
* **vault:** invalidate user sessions/tokens on self-initiated vault reset ([#422](https://github.com/ngc-shj/passwd-sso/issues/422)) ([0fc159a](https://github.com/ngc-shj/passwd-sso/commit/0fc159afaa5989952b8b803fd0741a32b34b2a92))
* **vault:** reject malformed base64 at attachment CEK trust boundaries ([#447](https://github.com/ngc-shj/passwd-sso/issues/447)) ([9a5d458](https://github.com/ngc-shj/passwd-sso/commit/9a5d4580e0fed4cd64119379920e2ad7614b7688))
* **vault:** tighten attachment CEK validation on upload, migrate, and rotation ([#445](https://github.com/ngc-shj/passwd-sso/issues/445)) ([03e037a](https://github.com/ngc-shj/passwd-sso/commit/03e037a1ec59cd0b3f0654c646d4d8e6cd2e195d))


### Code Refactoring

* **dcr-cleanup:** replace tenant-admin endpoint with background sweeper ([#412](https://github.com/ngc-shj/passwd-sso/issues/412)) ([1ececb2](https://github.com/ngc-shj/passwd-sso/commit/1ececb21e73f4fef675a4692fe4d589de987af3e))
* **ia:** split team General into Profile/Delete sub-tabs ([#426](https://github.com/ngc-shj/passwd-sso/issues/426)) ([105400c](https://github.com/ngc-shj/passwd-sso/commit/105400ca62337b9e2fdf13d974e879511c84941a))
* **state-machine:** centralize EmergencyAccess + AccessRequest transitions ([#436](https://github.com/ngc-shj/passwd-sso/issues/436)) ([#442](https://github.com/ngc-shj/passwd-sso/issues/442)) ([c0671bd](https://github.com/ngc-shj/passwd-sso/commit/c0671bd25bab6070a48622819efc7a684f070925))

## [0.4.45](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.44...passwd-sso-v0.4.45) (2026-04-27)


### Features

* **admin-token:** per-operator op_* tokens replace shared ADMIN_API_TOKEN ([#408](https://github.com/ngc-shj/passwd-sso/issues/408)) ([c510abc](https://github.com/ngc-shj/passwd-sso/commit/c510abc25c98325e29d0f980b9586523b4d32fd4))
* **audit-emit:** bound metadata payload size to prevent outbox bloat ([#402](https://github.com/ngc-shj/passwd-sso/issues/402)) ([9091da8](https://github.com/ngc-shj/passwd-sso/commit/9091da8cf8c9e14a6ec7ddafa955fb99ac073793))
* **audit:** add AUDIT_LOG_PURGE action and dryRun audit emission ([#401](https://github.com/ngc-shj/passwd-sso/issues/401)) ([e07dd7c](https://github.com/ngc-shj/passwd-sso/commit/e07dd7ca065a7553d7079b624d7ed09f14cd9339))


### Bug Fixes

* **admin:** align operator validation across maintenance routes ([#400](https://github.com/ngc-shj/passwd-sso/issues/400)) ([de3ea33](https://github.com/ngc-shj/passwd-sso/commit/de3ea334c15acebe58db799fce27fd0131ae08f6))
* **cache:** TTL sweep before FIFO fallback in policy and session timeout caches ([#405](https://github.com/ngc-shj/passwd-sso/issues/405)) ([4e73f88](https://github.com/ngc-shj/passwd-sso/commit/4e73f88878aacc3d93188aba38bb2c6916d140a2))
* **proxy:** use staleness-based eviction for passkey audit dedup map ([#404](https://github.com/ngc-shj/passwd-sso/issues/404)) ([34527fe](https://github.com/ngc-shj/passwd-sso/commit/34527fea36ce5938a2fde6484566787b94cf76f6))


### Code Refactoring

* **csp:** unify loopback redirect URI accept set across DCR, manual MCP routes, frontend, and CSP ([#403](https://github.com/ngc-shj/passwd-sso/issues/403)) ([9bd0c23](https://github.com/ngc-shj/passwd-sso/commit/9bd0c23f3ba04f0d7944b3da7493616d169dec04))
* **proxy:** enforce baseline CSRF at the ingress layer (closes pre1 + R3 baseline) ([#398](https://github.com/ngc-shj/passwd-sso/issues/398)) ([cb6fbec](https://github.com/ngc-shj/passwd-sso/commit/cb6fbecc44789e101f1ed61cc9a23f135b1a9a89))
* **proxy:** extract page/api route handlers + clarify consent origin check ([#406](https://github.com/ngc-shj/passwd-sso/issues/406)) ([10449b0](https://github.com/ngc-shj/passwd-sso/commit/10449b07bb225d1b5d02f28bf143efeb89de2b7f))
* **session-cache:** Redis-backed cache with tombstone-based revocation propagation ([#407](https://github.com/ngc-shj/passwd-sso/issues/407)) ([ce79ab6](https://github.com/ngc-shj/passwd-sso/commit/ce79ab635fe72a983d364afb8c1ec829b1f5a3fd))

## [0.4.44](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.43...passwd-sso-v0.4.44) (2026-04-25)


### Features

* **env:** Zod SSOT + interactive .env generator + drift checker ([#394](https://github.com/ngc-shj/passwd-sso/issues/394)) ([516acb5](https://github.com/ngc-shj/passwd-sso/commit/516acb5b3fb79fa44f0ead9b33ed08a6d831972c))


### Bug Fixes

* correct external spec citations and i18n share group label ([#386](https://github.com/ngc-shj/passwd-sso/issues/386)) ([0c1753a](https://github.com/ngc-shj/passwd-sso/commit/0c1753aafa91dbce74e64a02ecf32fd58caaf881))
* **security:** close XFF spoofing and Origin fail-open ([#391](https://github.com/ngc-shj/passwd-sso/issues/391)) ([6a0e330](https://github.com/ngc-shj/passwd-sso/commit/6a0e330b3ebe950e5ca57a57b1593c765bbb9be2))
* **security:** enforce tenant IP on bearer routes and close share-content TOCTOU ([#390](https://github.com/ngc-shj/passwd-sso/issues/390)) ([a8cff21](https://github.com/ngc-shj/passwd-sso/commit/a8cff2151d8061614400c6827b2c8e12e79e3065))


### Code Refactoring

* **audit:** enforce *AuditBase helper usage on logAudit calls ([#389](https://github.com/ngc-shj/passwd-sso/issues/389)) ([7f8e039](https://github.com/ngc-shj/passwd-sso/commit/7f8e039cfdd0b17a0a9e5f13ed3b207b04cef1de))
* cleanup legacy extension token relay + audit doc/comment sync ([#388](https://github.com/ngc-shj/passwd-sso/issues/388)) ([f3f9975](https://github.com/ngc-shj/passwd-sso/commit/f3f9975cf030a092011e58fa270d36343dea6e87))
* **db:** drop team_policies.max_session_duration_minutes ([#396](https://github.com/ngc-shj/passwd-sso/issues/396)) ([43473c5](https://github.com/ngc-shj/passwd-sso/commit/43473c5e370c75c20d83ab5896aca0b12e6fa7af))
* second-level directory split (src/lib, constants, components, auth) ([#393](https://github.com/ngc-shj/passwd-sso/issues/393)) ([736747a](https://github.com/ngc-shj/passwd-sso/commit/736747ac07bbf9316ea8853c68a3cfae18f3a512))
* split overcrowded src/{lib,hooks,components/passwords} into feature-based subdirs ([#392](https://github.com/ngc-shj/passwd-sso/issues/392)) ([02752a8](https://github.com/ngc-shj/passwd-sso/commit/02752a8e3b352dc7fd8e76c95b04e6b6f1bd26f6))

## [0.4.43](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.42...passwd-sso-v0.4.43) (2026-04-18)


### Features

* **session-timeout:** unify tenant/team/extension session lifetime policy ([#384](https://github.com/ngc-shj/passwd-sso/issues/384)) ([9d3f743](https://github.com/ngc-shj/passwd-sso/commit/9d3f7434db114bef6ccacf76d471141c14b3a66c))


### Bug Fixes

* **security:** bump hono to 4.12.14 and remove process-wide TLS bypass ([#382](https://github.com/ngc-shj/passwd-sso/issues/382)) ([949eb14](https://github.com/ngc-shj/passwd-sso/commit/949eb14999bc5d4e8bd253f4d4010426e682a38e))


### Code Refactoring

* 10 /simplify passes — extract helpers, dedup, O(n²)→O(1), meta-patterns, adoption coverage ([#380](https://github.com/ngc-shj/passwd-sso/issues/380)) ([dd65b09](https://github.com/ngc-shj/passwd-sso/commit/dd65b09a8f6b7b53bb87534d5658dc795fd457a9))

## [0.4.42](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.41...passwd-sso-v0.4.42) (2026-04-16)


### Bug Fixes

* address 8 findings from full codebase review ([#379](https://github.com/ngc-shj/passwd-sso/issues/379)) ([eff787e](https://github.com/ngc-shj/passwd-sso/commit/eff787ef36a3194375c0912348293f937fd6f78f))
* **docker:** upgrade musl to close CVE-2026-40200 ([#377](https://github.com/ngc-shj/passwd-sso/issues/377)) ([8249c2a](https://github.com/ngc-shj/passwd-sso/commit/8249c2a45e1652b6ef0db47c5b273231137c3752))


### Code Refactoring

* unify audit paths via sentinel UUIDs + ANONYMOUS ActorType ([#378](https://github.com/ngc-shj/passwd-sso/issues/378)) ([a75f37c](https://github.com/ngc-shj/passwd-sso/commit/a75f37c2ea6f3a6b2b496135cfe1368facd54b9c))
* unify audit paths with type-safe null userId for anonymous/SYSTEM events ([#375](https://github.com/ngc-shj/passwd-sso/issues/375)) ([e167f9c](https://github.com/ngc-shj/passwd-sso/commit/e167f9c0e7758eb6d3508c2a4813be2d2071d149))

## [0.4.41](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.40...passwd-sso-v0.4.41) (2026-04-14)


### Features

* add audit delivery target CRUD API + admin UI ([#372](https://github.com/ngc-shj/passwd-sso/issues/372)) ([c794e1e](https://github.com/ngc-shj/passwd-sso/commit/c794e1e7438cfd2a2fb86fd3b994d5097fa10fff))


### Code Refactoring

* migrate all logAudit/logAuditBatch to logAuditAsync ([#374](https://github.com/ngc-shj/passwd-sso/issues/374)) ([af91f48](https://github.com/ngc-shj/passwd-sso/commit/af91f48b9d86bd00dcf26e3a4c489cc637fad384))

## [0.4.40](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.39...passwd-sso-v0.4.40) (2026-04-13)


### Features

* durable audit outbox — Phase 2 ([#367](https://github.com/ngc-shj/passwd-sso/issues/367)) ([1ab59c4](https://github.com/ngc-shj/passwd-sso/commit/1ab59c4bbb3770902f6fa63fec45d403e37581da))
* durable audit outbox — Phase 3 ([#369](https://github.com/ngc-shj/passwd-sso/issues/369)) ([db08c7a](https://github.com/ngc-shj/passwd-sso/commit/db08c7ae82682d9fdc7a7028251407402568e7b3))
* durable audit outbox — Phase 4 + TIMESTAMPTZ migration ([#370](https://github.com/ngc-shj/passwd-sso/issues/370)) ([46e775a](https://github.com/ngc-shj/passwd-sso/commit/46e775a99d2f060f3c742633c61fc02f57a8f208))

## [0.4.39](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.38...passwd-sso-v0.4.39) (2026-04-12)


### Features

* durable audit outbox — Phase 1 ([#366](https://github.com/ngc-shj/passwd-sso/issues/366)) ([0ed24a3](https://github.com/ngc-shj/passwd-sso/commit/0ed24a3862999a8c374e095ea32fef13da4b1a46))
* extension bridge code exchange — replace bearer token postMessage ([#364](https://github.com/ngc-shj/passwd-sso/issues/364)) ([5a96fb7](https://github.com/ngc-shj/passwd-sso/commit/5a96fb7f48985a0b12170b111c6e60dfcfceb386))


### Bug Fixes

* **docker:** patch HIGH CVEs flagged by Trivy container scan ([#365](https://github.com/ngc-shj/passwd-sso/issues/365)) ([64108f5](https://github.com/ngc-shj/passwd-sso/commit/64108f5cc980253fa8415932c4c8c29209961788))
* restore dev server after next 16.2.3 bump ([#362](https://github.com/ngc-shj/passwd-sso/issues/362)) ([17693ff](https://github.com/ngc-shj/passwd-sso/commit/17693ff26aba2cd244269d8cf0c29794445dbdae))

## [0.4.38](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.37...passwd-sso-v0.4.38) (2026-04-11)


### Bug Fixes

* resolve CodeQL prototype pollution and Dependabot alerts ([#359](https://github.com/ngc-shj/passwd-sso/issues/359)) ([06fc9f4](https://github.com/ngc-shj/passwd-sso/commit/06fc9f430ebff71967a6c3005fa3497b5d07511b))
* use Object.defineProperty to eliminate CodeQL property injection sink ([#361](https://github.com/ngc-shj/passwd-sso/issues/361)) ([51825b1](https://github.com/ngc-shj/passwd-sso/commit/51825b13d9836541dccd5c2eddf60e16c47bb2b0))

## [0.4.37](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.36...passwd-sso-v0.4.37) (2026-04-11)


### Features

* expand tenant and team security policy settings ([#357](https://github.com/ngc-shj/passwd-sso/issues/357)) ([cae2b18](https://github.com/ngc-shj/passwd-sso/commit/cae2b18df277327c77fdaf1141364210d2f9436c))

## [0.4.36](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.35...passwd-sso-v0.4.36) (2026-04-06)


### Features

* UI/UX improvements - theme toggle, passkey badge, extension bypass, dark theme ([#348](https://github.com/ngc-shj/passwd-sso/issues/348)) ([a496319](https://github.com/ngc-shj/passwd-sso/commit/a496319212cf297c14a1e3df17985b00f33125f5))

## [0.4.35](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.34...passwd-sso-v0.4.35) (2026-04-06)


### Bug Fixes

* force node24 runtime for release-please-action ([#346](https://github.com/ngc-shj/passwd-sso/issues/346)) ([49f3d8e](https://github.com/ngc-shj/passwd-sso/commit/49f3d8e90517c501dc5ce475f1f5afc7712d0b01))

## [0.4.34](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.33...passwd-sso-v0.4.34) (2026-04-06)


### Code Refactoring

* migrate Zod validation errors from flatten() to treeifyError() ([#344](https://github.com/ngc-shj/passwd-sso/issues/344)) ([86380fd](https://github.com/ngc-shj/passwd-sso/commit/86380fdae718c5f02688fa6e63085155f059160d))

## [0.4.33](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.32...passwd-sso-v0.4.33) (2026-04-05)


### Code Refactoring

* unify error responses to use errorResponse helper ([#343](https://github.com/ngc-shj/passwd-sso/issues/343)) ([793df49](https://github.com/ngc-shj/passwd-sso/commit/793df491a0d1f3db55c83a3cba38ecc598acb41c))

## [0.4.32](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.31...passwd-sso-v0.4.32) (2026-04-05)


### Bug Fixes

* add P2002 error handling to folder and tag PUT routes ([#340](https://github.com/ngc-shj/passwd-sso/issues/340)) ([a4de794](https://github.com/ngc-shj/passwd-sso/commit/a4de79475d7ea9b3a32582987e9e6baea2226d95))

## [0.4.31](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.30...passwd-sso-v0.4.31) (2026-04-05)


### Bug Fixes

* add unsaved changes indicator to settings screens, fix MCP client edit P2002 ([#338](https://github.com/ngc-shj/passwd-sso/issues/338)) ([3d94290](https://github.com/ngc-shj/passwd-sso/commit/3d942900b0a79d4414c9b85c1c3a0a9b25ef09bf))

## [0.4.30](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.29...passwd-sso-v0.4.30) (2026-04-05)


### Bug Fixes

* harden security boundaries, remove legacy decrypt scope, replace global isNaN ([#336](https://github.com/ngc-shj/passwd-sso/issues/336)) ([133ecf3](https://github.com/ngc-shj/passwd-sso/commit/133ecf30d02415d99f455e15e062399f7566e37d))

## [0.4.29](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.28...passwd-sso-v0.4.29) (2026-04-05)


### Bug Fixes

* add cursor validation, MCP authorize hardening, header cleanup ([#334](https://github.com/ngc-shj/passwd-sso/issues/334)) ([6ce655a](https://github.com/ngc-shj/passwd-sso/commit/6ce655a4ff47a9811c9b61041e3fde134e415bf9))

## [0.4.28](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.27...passwd-sso-v0.4.28) (2026-04-05)


### Bug Fixes

* add UX warnings for sends encryption, HIBP cache, and Google multi-domain ([#332](https://github.com/ngc-shj/passwd-sso/issues/332)) ([3916793](https://github.com/ngc-shj/passwd-sso/commit/3916793a6e1f748d99ab44c7e9d2403ce58bca01))

## [0.4.27](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.26...passwd-sso-v0.4.27) (2026-04-05)


### Bug Fixes

* enforce aadVersion &gt;= 1 in personal entry and attachment schemas ([#330](https://github.com/ngc-shj/passwd-sso/issues/330)) ([494a030](https://github.com/ngc-shj/passwd-sso/commit/494a0304bc72a2f8ff6b7d3ad403dd1b3232fc0f))

## [0.4.26](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.25...passwd-sso-v0.4.26) (2026-04-04)


### Bug Fixes

* address security review findings (CSP, session cache, WebAuthn constants, PSSO_PASSPHRASE) ([#328](https://github.com/ngc-shj/passwd-sso/issues/328)) ([90293a3](https://github.com/ngc-shj/passwd-sso/commit/90293a31f740c31c8cac9544de2828f5281f4c82))

## [0.4.25](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.24...passwd-sso-v0.4.25) (2026-04-04)


### Bug Fixes

* **extension:** harden passkey provider with sender-origin validation and security fixes ([#326](https://github.com/ngc-shj/passwd-sso/issues/326)) ([d10e4a7](https://github.com/ngc-shj/passwd-sso/commit/d10e4a79728714e7513baf2952cc874a7b1631d0))

## [0.4.24](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.23...passwd-sso-v0.4.24) (2026-04-04)


### Features

* add passkey provider to browser extension ([#323](https://github.com/ngc-shj/passwd-sso/issues/323)) ([8d2ad7e](https://github.com/ngc-shj/passwd-sso/commit/8d2ad7e6d344441590923ebe99e7a65a4351452a))

## [0.4.23](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.22...passwd-sso-v0.4.23) (2026-04-03)


### Bug Fixes

* resolve CodeQL alerts [#112](https://github.com/ngc-shj/passwd-sso/issues/112) and [#113](https://github.com/ngc-shj/passwd-sso/issues/113) ([#321](https://github.com/ngc-shj/passwd-sso/issues/321)) ([ce7cf12](https://github.com/ngc-shj/passwd-sso/commit/ce7cf1246bba3174b65b06a596a6e0fae0fbd12b))

## [0.4.22](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.21...passwd-sso-v0.4.22) (2026-04-03)


### Features

* enhance extension options page with 14 settings across 6 sections ([#318](https://github.com/ngc-shj/passwd-sso/issues/318)) ([71dfc88](https://github.com/ngc-shj/passwd-sso/commit/71dfc88ded72425fb2f46c8482073e688682af03))

## [0.4.21](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.20...passwd-sso-v0.4.21) (2026-04-03)


### Features

* harden extension token bridge, encrypt session storage, and add audit retry ([#316](https://github.com/ngc-shj/passwd-sso/issues/316)) ([0c27b66](https://github.com/ngc-shj/passwd-sso/commit/0c27b66f3b630ec39beb79f7e5fd51d22e2998d3))

## [0.4.20](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.19...passwd-sso-v0.4.20) (2026-04-03)


### Bug Fixes

* zero secretKeyBytes in lockVault() before releasing reference ([#314](https://github.com/ngc-shj/passwd-sso/issues/314)) ([93a284a](https://github.com/ngc-shj/passwd-sso/commit/93a284a427aea827595b02e3ccbb7de921b9f5a3))

## [0.4.19](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.18...passwd-sso-v0.4.19) (2026-04-02)


### Bug Fixes

* block aadVersion:0 writes, zero IPC key bytes, document HKDF salt ([#312](https://github.com/ngc-shj/passwd-sso/issues/312)) ([e11d4b8](https://github.com/ngc-shj/passwd-sso/commit/e11d4b875b4b8425465fc855f1295fd1012cbb58))

## [0.4.18](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.17...passwd-sso-v0.4.18) (2026-04-02)


### Bug Fixes

* unify audit log UI consistency across views ([#308](https://github.com/ngc-shj/passwd-sso/issues/308)) ([4f36b44](https://github.com/ngc-shj/passwd-sso/commit/4f36b44a607267cc2b590ffe2a165ffe845491e3))

## [0.4.17](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.16...passwd-sso-v0.4.17) (2026-04-02)


### Bug Fixes

* enable bump-patch-for-minor-pre-major in release-please config ([#309](https://github.com/ngc-shj/passwd-sso/issues/309)) ([1fb98f7](https://github.com/ngc-shj/passwd-sso/commit/1fb98f73f9524f04496634aeae6b4b47df34675d))

## [0.4.16](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.15...passwd-sso-v0.4.16) (2026-04-02)


### Bug Fixes

* improve i18n security terminology and phrasing consistency ([#304](https://github.com/ngc-shj/passwd-sso/issues/304)) ([83bab0c](https://github.com/ngc-shj/passwd-sso/commit/83bab0c6d04fe5eede8104835867c3d3b184f540))

## [0.4.15](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.14...passwd-sso-v0.4.15) (2026-04-01)


### Bug Fixes

* suppress keyboard shortcuts while extension connect overlay is active ([#302](https://github.com/ngc-shj/passwd-sso/issues/302)) ([fcb86c0](https://github.com/ngc-shj/passwd-sso/commit/fcb86c0b44c8ae153f8e01316b8e9714fb732203))

## [0.4.14](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.13...passwd-sso-v0.4.14) (2026-04-01)


### Bug Fixes

* improve MCP connection management UI ([#299](https://github.com/ngc-shj/passwd-sso/issues/299)) ([cc989a2](https://github.com/ngc-shj/passwd-sso/commit/cc989a20c89f8584425b475cb351171d1cc8568f))

## [0.4.13](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.12...passwd-sso-v0.4.13) (2026-04-01)


### Bug Fixes

* correct webhook subscribable events and centralize dispatch in logAudit ([#297](https://github.com/ngc-shj/passwd-sso/issues/297)) ([50ddfad](https://github.com/ngc-shj/passwd-sso/commit/50ddfadf5bf8da4d17583437635dd54955f21da5))

## [0.4.12](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.11...passwd-sso-v0.4.12) (2026-04-01)


### Code Refactoring

* restructure sidebar navigation and unify settings UI ([#295](https://github.com/ngc-shj/passwd-sso/issues/295)) ([32c75dc](https://github.com/ngc-shj/passwd-sso/commit/32c75dc6fa049340dfbdcbf8f70ee80a112aef18))

## [0.4.11](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.10...passwd-sso-v0.4.11) (2026-04-01)


### Bug Fixes

* align BaseWebhookCard with SectionCardHeader and unify key rotation labels ([#293](https://github.com/ngc-shj/passwd-sso/issues/293)) ([1b4da82](https://github.com/ngc-shj/passwd-sso/commit/1b4da82064bd97918907be212ff6c49c771d764e))

## [0.4.10](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.9...passwd-sso-v0.4.10) (2026-04-01)


### Bug Fixes

* add MCP Connections page and restructure Machine Identity nav ([#291](https://github.com/ngc-shj/passwd-sso/issues/291)) ([5cb7cad](https://github.com/ngc-shj/passwd-sso/commit/5cb7cad32c28bd190121192b5637b50e631dbba7))

## [0.4.9](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.8...passwd-sso-v0.4.9) (2026-03-31)


### Bug Fixes

* bypass RLS in all Auth.js adapter methods to prevent OAuth login failure ([#289](https://github.com/ngc-shj/passwd-sso/issues/289)) ([2e980d7](https://github.com/ngc-shj/passwd-sso/commit/2e980d7af55428ae06bfbd619b835576dae1f56b))

## [0.4.8](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.7...passwd-sso-v0.4.8) (2026-03-31)


### Code Refactoring

* extract BaseWebhookCard shared component ([#287](https://github.com/ngc-shj/passwd-sso/issues/287)) ([5e72620](https://github.com/ngc-shj/passwd-sso/commit/5e7262060259ff6215e2a4cdf03d0145451ec1d3))

## [0.4.7](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.6...passwd-sso-v0.4.7) (2026-03-31)


### Bug Fixes

* unify card structure and extract SectionCardHeader ([#285](https://github.com/ngc-shj/passwd-sso/issues/285)) ([64c3211](https://github.com/ngc-shj/passwd-sso/commit/64c3211015d2e7632ceab0dda523ca46f7c37f6f))

## [0.4.6](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.5...passwd-sso-v0.4.6) (2026-03-31)


### Refactoring

* separate vault and admin console with page-per-route navigation ([#282](https://github.com/ngc-shj/passwd-sso/issues/282)) ([cdf82ee](https://github.com/ngc-shj/passwd-sso/commit/cdf82ee8eacaad3b4513be16bac79d6ca1d39a77))
  * Vault (`/dashboard`) and Admin (`/admin`) contexts fully separated
  * Admin console with scope selector (tenant/team switching) and tree nav sidebar
  * Personal settings split into page-per-route (`/account`, `/security/*`, `/developer/*`)
  * MCP consent UI with scope risk-level badge coloring
  * Unified sidebar style (border-l tree nav) across dashboard and admin

### Bug Fixes

* improve inline vault unlock edge cases in TeamCreateDialog ([#283](https://github.com/ngc-shj/passwd-sso/issues/283)) ([08e412d](https://github.com/ngc-shj/passwd-sso/commit/08e412db4409edeaf82e66838d8654556bf36ecc))

## [0.4.5](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.4...passwd-sso-v0.4.5) (2026-03-30)


### Bug Fixes

* CLI OAuth 2.1 PKCE login, remove keytar, add token revocation ([#280](https://github.com/ngc-shj/passwd-sso/issues/280)) ([429fd41](https://github.com/ngc-shj/passwd-sso/commit/429fd41a5008c5364670ae5c32ac435121d8b8df))

## [0.4.4](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.3...passwd-sso-v0.4.4) (2026-03-29)


### Bug Fixes

* Phase 7 — zero-knowledge MCP with CLI decrypt agent ([3b901df](https://github.com/ngc-shj/passwd-sso/commit/3b901df7dddcaec4afdc3161add024dd5b151455))
* add missing delegation_sessions migration and fix RLS gaps ([#278](https://github.com/ngc-shj/passwd-sso/issues/278)) ([e544228](https://github.com/ngc-shj/passwd-sso/commit/e5442281a135fa94f4afa4ef07a3f31c8c53f72e))
* make CLI publishable to npm ([#276](https://github.com/ngc-shj/passwd-sso/issues/276)) ([d996bd0](https://github.com/ngc-shj/passwd-sso/commit/d996bd0d80d5bdb1f31df5fc8b5702ff128c1e9c))

## [0.4.3](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.2...passwd-sso-v0.4.3) (2026-03-29)


### Bug Fixes

* Phase 6 — DCR + Native OAuth for MCP clients ([#272](https://github.com/ngc-shj/passwd-sso/issues/272)) ([a676507](https://github.com/ngc-shj/passwd-sso/commit/a676507c4f0d1415261bff59fa34fa090a9ebb51))

## [0.4.2](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.1...passwd-sso-v0.4.2) (2026-03-29)


### Bug Fixes

* Delegated Decryption review fixes — tests, audit display, IP extraction, docs ([37ba683](https://github.com/ngc-shj/passwd-sso/commit/37ba683e463be95f461634665c64424f4d5e01ac))

## [0.4.1](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.4.0...passwd-sso-v0.4.1) (2026-03-28)


### Bug Fixes

* enforce RLS in dev by separating DB roles (passwd_app / passwd_user) ([#267](https://github.com/ngc-shj/passwd-sso/issues/267)) ([05cb302](https://github.com/ngc-shj/passwd-sso/commit/05cb3028aac3d4d62e4f022c828589111c95b163))

## [0.4.0](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.12...passwd-sso-v0.4.0) (2026-03-28)


### Features

* add Machine Identity — service accounts, MCP Gateway & JIT access ([#264](https://github.com/ngc-shj/passwd-sso/issues/264)) ([4acb958](https://github.com/ngc-shj/passwd-sso/commit/4acb9586acc4dded248838dc2a868e144f16422f))

## [0.3.12](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.11...passwd-sso-v0.3.12) (2026-03-27)


### Bug Fixes

* update sample data, remove unused code, and harden extension message listeners ([#262](https://github.com/ngc-shj/passwd-sso/issues/262)) ([cb894be](https://github.com/ngc-shj/passwd-sso/commit/cb894be5cafd82a0f72b9fc22b0fcf60e84bf939))

## [0.3.11](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.10...passwd-sso-v0.3.11) (2026-03-27)


### Bug Fixes

* add bulk import API to fix rate limit blocking large imports ([#260](https://github.com/ngc-shj/passwd-sso/issues/260)) ([88f1010](https://github.com/ngc-shj/passwd-sso/commit/88f1010a332eba1e343d13e6d15bf39f4514afbf))

## [0.3.10](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.9...passwd-sso-v0.3.10) (2026-03-27)


### Bug Fixes

* generic custom field autofill and multi-URL matching ([#257](https://github.com/ngc-shj/passwd-sso/issues/257)) ([2a63029](https://github.com/ngc-shj/passwd-sso/commit/2a63029cc48d53148ff2010967a579db9315e2d7))

## [0.3.9](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.8...passwd-sso-v0.3.9) (2026-03-27)


### Bug Fixes

* refine extension popup UX ([#254](https://github.com/ngc-shj/passwd-sso/issues/254)) ([ed0267c](https://github.com/ngc-shj/passwd-sso/commit/ed0267c5486c17b92e9e457c54164a40d3d06d6a))

## [0.3.8](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.7...passwd-sso-v0.3.8) (2026-03-27)


### Bug Fixes

* suppress auto-save banner on own app pages in browser extension ([#251](https://github.com/ngc-shj/passwd-sso/issues/251)) ([aa721a7](https://github.com/ngc-shj/passwd-sso/commit/aa721a783228a23ff163e57c670ec992195f2a11))

## [0.3.7](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.6...passwd-sso-v0.3.7) (2026-03-26)


### Bug Fixes

* unify entry list layout between personal and team vaults ([#248](https://github.com/ngc-shj/passwd-sso/issues/248)) ([0e53f1e](https://github.com/ngc-shj/passwd-sso/commit/0e53f1e6532b3d9f3c25c5ce75ab2af95da36bf1))

## [0.3.6](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.5...passwd-sso-v0.3.6) (2026-03-25)


### Bug Fixes

* security hardening — webhook IP pinning, password rate limits, session rotation ([#243](https://github.com/ngc-shj/passwd-sso/issues/243)) ([532a1a3](https://github.com/ngc-shj/passwd-sso/commit/532a1a35f99dc2333bd4aa60e0d7e96179fd22db))

## [0.3.5](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.4...passwd-sso-v0.3.5) (2026-03-25)


### Bug Fixes

* clear vault unlock rate-limit keys in E2E global setup ([#241](https://github.com/ngc-shj/passwd-sso/issues/241)) ([6eac77f](https://github.com/ngc-shj/passwd-sso/commit/6eac77f46283ef617c57d3839fd8605976885481))

## [0.3.4](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.3...passwd-sso-v0.3.4) (2026-03-25)


### Bug Fixes

* harden rate-limit architecture across all API endpoints ([#239](https://github.com/ngc-shj/passwd-sso/issues/239)) ([88b07ba](https://github.com/ngc-shj/passwd-sso/commit/88b07ba9342f36ccec1a1e9f7afc8ed93cee50a7))

## [0.3.3](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.2...passwd-sso-v0.3.3) (2026-03-25)


### Bug Fixes

* support Tailscale Serve proxy for access restriction ([d6f25d5](https://github.com/ngc-shj/passwd-sso/commit/d6f25d58208db3c15e7ec59404154d37b9181929))

## [0.3.2](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.1...passwd-sso-v0.3.2) (2026-03-24)


### Bug Fixes

* scope team slug uniqueness to tenant ([6daa165](https://github.com/ngc-shj/passwd-sso/commit/6daa165f5fd1c671b920c450d173b60fe6e0d64a))

## [0.3.1](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.3.0...passwd-sso-v0.3.1) (2026-03-24)


### Bug Fixes

* add import audit metadata to team password creation ([f0847e4](https://github.com/ngc-shj/passwd-sso/commit/f0847e4f2e2ce4929e15c10b4ec3ad62b439e916))

## [0.3.0](https://github.com/ngc-shj/passwd-sso/compare/passwd-sso-v0.2.1...passwd-sso-v0.3.0) (2026-03-22)


### Features

* add app icon (favicon, PWA manifest, extension icons) ([2b0a654](https://github.com/ngc-shj/passwd-sso/commit/2b0a654ad1a3daea7c5592dc86136ce2542ae78a)), closes [#146](https://github.com/ngc-shj/passwd-sso/issues/146)
* add Bank Account, Software License, custom field types, and requireReprompt/expiresAt ([#125](https://github.com/ngc-shj/passwd-sso/issues/125)) ([fa430f8](https://github.com/ngc-shj/passwd-sso/commit/fa430f8ca94618852ae168fcd47f71d8f93d4600))
* add basePath support for sub-path deployment ([#139](https://github.com/ngc-shj/passwd-sso/issues/139)) ([0bb5db5](https://github.com/ngc-shj/passwd-sso/commit/0bb5db54eac2096f993b5d3841ee26552efa8f1c))
* add client-side validation and improve API error handling ([#171](https://github.com/ngc-shj/passwd-sso/issues/171)) ([9fa5920](https://github.com/ngc-shj/passwd-sso/commit/9fa5920b00e4f06676502f6203718bf4afe934d6))
* add direct team member addition from tenant ([#182](https://github.com/ngc-shj/passwd-sso/issues/182)) ([130b040](https://github.com/ngc-shj/passwd-sso/commit/130b040dcc044b72a0779a08b43484b3c16fdc15))
* add email infrastructure, session management, and EA notifications ([fd9307d](https://github.com/ngc-shj/passwd-sso/commit/fd9307d5399f3791f8c7785847cbfb0cd4bd9365))
* add email infrastructure, session management, and emergency access notifications ([6999f88](https://github.com/ngc-shj/passwd-sso/commit/6999f880f099f45d1545e92fb3bd61d7cf23a5a1))
* add folder hierarchy and entry change history (Batch A) ([2ae816a](https://github.com/ngc-shj/passwd-sso/commit/2ae816afe09318a790f6cd551c43422ba589d01e))
* add folder hierarchy and entry change history (Batch A) ([8b32630](https://github.com/ngc-shj/passwd-sso/commit/8b32630ac826259464e844ed335f9f60d1d1dcae))
* add include/exclude character fields to password generator ([#132](https://github.com/ngc-shj/passwd-sso/issues/132)) ([63b228c](https://github.com/ngc-shj/passwd-sso/commit/63b228c8eaa56057dd7b844e243b4b818ffa6c1a))
* add KeePassXC export file import (CSV and XML) ([#170](https://github.com/ngc-shj/passwd-sso/issues/170)) ([88b3e64](https://github.com/ngc-shj/passwd-sso/commit/88b3e6444fd2f09cffb83b5fa5952ab3e75cfcfc))
* add key rotation API and migration lock guard for org E2E ([ae73ffc](https://github.com/ngc-shj/passwd-sso/commit/ae73ffc18ca8cffecba3b59a661d28f13a801592))
* add key rotation consumers and refactor purge-history to admin auth ([a4eb762](https://github.com/ngc-shj/passwd-sso/commit/a4eb762f8c173688701a19a753cf6ddd5c4c183e))
* add org vault E2E encryption (ECDH-P256) ([cfb50b1](https://github.com/ngc-shj/passwd-sso/commit/cfb50b117313b2c389bd9182b6e6e7435969d7d9))
* add org vault E2E encryption (ECDH-P256) — Phases 1-4 ([01baebc](https://github.com/ngc-shj/passwd-sso/commit/01baebc2c3c674cd22b34db40ce649a78c03cfe6))
* add passwd-sso export profile and import format coverage ([98265b0](https://github.com/ngc-shj/passwd-sso/commit/98265b097d2221019b886ce848a205cfd4f67f5b))
* add password protection for shared links and Send ([#177](https://github.com/ngc-shj/passwd-sso/issues/177)) ([2f5f400](https://github.com/ngc-shj/passwd-sso/commit/2f5f400595cb2a2a5c4c9748eb6ed65d430e53f5))
* add privacy policy page and Chrome Web Store unlisted distribution ([#179](https://github.com/ngc-shj/passwd-sso/issues/179)) ([3cf0785](https://github.com/ngc-shj/passwd-sso/commit/3cf07854da312e4f626b32d129bdda331d6b77f9))
* add Redis Sentinel HA docker-compose overlay ([#159](https://github.com/ngc-shj/passwd-sso/issues/159)) ([f2df2df](https://github.com/ngc-shj/passwd-sso/commit/f2df2df86eb54c0aaf60dd6d69d1d241cecc71a8))
* add static privacy policy HTML for Apache fallback ([#181](https://github.com/ngc-shj/passwd-sso/issues/181)) ([d6b0e91](https://github.com/ngc-shj/passwd-sso/commit/d6b0e91303f09eed9900cb89394ce77f31a77da8))
* add team bulk selection with trash/archive/restore ([#129](https://github.com/ngc-shj/passwd-sso/issues/129)) ([399de0a](https://github.com/ngc-shj/passwd-sso/commit/399de0ac4f2a9fa0454dd68f6ffc270b23fac12b))
* add team password entries to browser extension ([#160](https://github.com/ngc-shj/passwd-sso/issues/160)) ([d2ce1d3](https://github.com/ngc-shj/passwd-sso/commit/d2ce1d3999190f59b93da262d22921bfa585593e))
* add tenant audit log UI with Break-Glass personal log access ([#201](https://github.com/ngc-shj/passwd-sso/issues/201)) ([b9ba161](https://github.com/ngc-shj/passwd-sso/commit/b9ba161969a8c127f213e218f708a9ed53615138))
* add tenant member role update UI and API ([#175](https://github.com/ngc-shj/passwd-sso/issues/175)) ([6f61e56](https://github.com/ngc-shj/passwd-sso/commit/6f61e56beefadf16e4f3b48d9eb4448cc55cd868))
* add tenant-level webhook support ([#202](https://github.com/ngc-shj/passwd-sso/issues/202)) ([afbe238](https://github.com/ngc-shj/passwd-sso/commit/afbe23854dda7297ecd3f33f24997d8ea14c7e04))
* add unified checkAuth() utility and migrate pilot routes ([#187](https://github.com/ngc-shj/passwd-sso/issues/187)) ([c788a7a](https://github.com/ngc-shj/passwd-sso/commit/c788a7a2640c9fcbc87f1daa88d99a0b90bec3dc))
* add versioned master key rotation mechanism ([#108](https://github.com/ngc-shj/passwd-sso/issues/108)) ([e81cea0](https://github.com/ngc-shj/passwd-sso/commit/e81cea0c920bde36765dcecb89ce683b9d97caab))
* add WebAuthn Level 3 extensions (credProps, minPinLength, largeBlob) ([#212](https://github.com/ngc-shj/passwd-sso/issues/212)) ([705803a](https://github.com/ngc-shj/passwd-sso/commit/705803aa35e409337cc67e0028f4fde5a8905c3e))
* **audit:** add parent action metadata and strengthen audit log tests ([27034ff](https://github.com/ngc-shj/passwd-sso/commit/27034ffc0bd1fe3e10e9eb1b43de9a724049f1e3))
* **audit:** add structured log forwarding via pino + Fluent Bit ([a6bcb35](https://github.com/ngc-shj/passwd-sso/commit/a6bcb3551e3b392f280285ad57765e8b5e425574))
* **audit:** add structured log forwarding via pino + Fluent Bit ([6fdc27d](https://github.com/ngc-shj/passwd-sso/commit/6fdc27de380985bcf1169d3496896e1fbf57627e))
* **audit:** implement bulk delete summary + per-entry logs ([f86156d](https://github.com/ngc-shj/passwd-sso/commit/f86156db3ad2780777ed408d57bc28b715bc1b68))
* **audit:** refine import/export audit actions and transfer grouping ([ccf3420](https://github.com/ngc-shj/passwd-sso/commit/ccf34207a7dabb816183ccf07f96270848ce8cab))
* **auth:** add DB-persistent progressive account lockout ([dec0fa4](https://github.com/ngc-shj/passwd-sso/commit/dec0fa4497b0a097688a81ea4475e678f1e0b160))
* **auth:** add DB-persistent progressive account lockout for vault unlock ([3f4eb87](https://github.com/ngc-shj/passwd-sso/commit/3f4eb8764eebc0117d32e47066b5624419d42019))
* **backup:** add ransomware-resistant backup strategy with Vault Lock ([eea87d1](https://github.com/ngc-shj/passwd-sso/commit/eea87d15cb9921a4b44b51d9bf62f790a6e83434))
* Batch D — notification center, policies, templates, markdown, nested tags, SIEM, share permissions ([#136](https://github.com/ngc-shj/passwd-sso/issues/136)) ([d58278e](https://github.com/ngc-shj/passwd-sso/commit/d58278e9cc9eae7ab588a1d78b795ae278a3d002))
* Batch E — CLI tool, CC/address autofill, dark-web monitoring, admin vault reset ([#140](https://github.com/ngc-shj/passwd-sso/issues/140)) ([7010d40](https://github.com/ngc-shj/passwd-sso/commit/7010d4048c9df347231a7567cdf82da4abadc4c2))
* Batch F — API keys, SSH keys, TOTP QR, travel mode, directory sync, passkey unlock ([fe44758](https://github.com/ngc-shj/passwd-sso/commit/fe44758cae136b9b6942b1d7129924c7a45ae9ba))
* **ci:** add lockfile-based license audit for app and extension ([#44](https://github.com/ngc-shj/passwd-sso/issues/44)) ([67bc325](https://github.com/ngc-shj/passwd-sso/commit/67bc3255f595aa55ca8fff0175467554278317a6))
* **compliance:** complete dependency license audit [5.2] ([#64](https://github.com/ngc-shj/passwd-sso/issues/64)) ([88aeb8c](https://github.com/ngc-shj/passwd-sso/commit/88aeb8c0eb01d3543547493fd245e9ee1f0b9721))
* **db:** add configurable connection pool with graceful shutdown ([166d778](https://github.com/ngc-shj/passwd-sso/commit/166d778ef59867ae05f0822c6a20aba85c168d2b))
* **db:** add configurable connection pool with graceful shutdown ([#48](https://github.com/ngc-shj/passwd-sso/issues/48)) ([f1dc39d](https://github.com/ngc-shj/passwd-sso/commit/f1dc39d75afdab3df16f84533ef47a1f26a70eba))
* distribute TOTP digits across split OTP input fields ([#224](https://github.com/ngc-shj/passwd-sso/issues/224)) ([8768b2e](https://github.com/ngc-shj/passwd-sso/commit/8768b2e4a57b1251563d90584a79a7ae3b173f1b))
* **e2e:** add Playwright E2E tests for vault encryption flow ([#28](https://github.com/ngc-shj/passwd-sso/issues/28)) ([2bf649e](https://github.com/ngc-shj/passwd-sso/commit/2bf649e4ab8ee092ae2fa90b8fa0d72129b29d1c))
* error tracking and cloud key provider abstraction ([#220](https://github.com/ngc-shj/passwd-sso/issues/220)) ([be321ab](https://github.com/ngc-shj/passwd-sso/commit/be321ab3e39513dcf44d68284704de0223b70529))
* **ext:** add AWS account/iam/password autofill support ([7831162](https://github.com/ngc-shj/passwd-sso/commit/7831162fee38d4db18b24ac3bdfd8fb710c28c13))
* **ext:** add context menu for autofill from right-click (X-3) ([06d9fd9](https://github.com/ngc-shj/passwd-sso/commit/06d9fd90ea25589d15df34ccbe0076c6bb578c8f))
* **ext:** add disconnect flow with token revoke ([6dfcbd5](https://github.com/ngc-shj/passwd-sso/commit/6dfcbd5d58b8afd69c61dbfa9472ad7074c35eae))
* **ext:** add keyboard shortcuts for copy password, copy username, lock vault (X-4) ([c9993e0](https://github.com/ngc-shj/passwd-sso/commit/c9993e0972b86ad1bbc6e6e199c73bd6fd849b71))
* **ext:** add keyboard shortcuts, context menu, and login save detection (Batch D Group A) ([0f7b812](https://github.com/ngc-shj/passwd-sso/commit/0f7b812fbf7617f37d6465056710d3c07e9bed88))
* **ext:** detect login form submissions and offer save/update prompt (X-5) ([0210483](https://github.com/ngc-shj/passwd-sso/commit/02104835a19f578cb4acdd38d427aa124a31d437))
* **extension:** add TOTP code generation and autofill ([#65](https://github.com/ngc-shj/passwd-sso/issues/65)) ([09e6555](https://github.com/ngc-shj/passwd-sso/commit/09e65557ea0ac9c3f4068e96eca559579391a9db))
* **health:** add health check endpoints and CloudWatch monitoring ([8d0d496](https://github.com/ngc-shj/passwd-sso/commit/8d0d496c4e1478e56ad4d4d9a2c786dcd4d26601))
* improve entry card UX — density, hover feedback, and mobile scroll ([#183](https://github.com/ngc-shj/passwd-sso/issues/183)) ([da39dbd](https://github.com/ngc-shj/passwd-sso/commit/da39dbd10b77bf2e5fbfe3a348c04193edefcfd0))
* **infra:** separate migration from app startup ([782d8b3](https://github.com/ngc-shj/passwd-sso/commit/782d8b3846ef167edac617c8be39e8f343b72bc1))
* **infra:** separate migration from app startup ([#47](https://github.com/ngc-shj/passwd-sso/issues/47)) ([6a5338f](https://github.com/ngc-shj/passwd-sso/commit/6a5338f1d7b31df16e4e9aedc1105890dc6b2e1d))
* integrate client-side ItemKey generation in team entry save flow ([#164](https://github.com/ngc-shj/passwd-sso/issues/164)) ([7c90a38](https://github.com/ngc-shj/passwd-sso/commit/7c90a38d429565c4fc76c5a9b054d89b0f221fa8))
* **logging:** add structured app logging with request tracing ([#20](https://github.com/ngc-shj/passwd-sso/issues/20)) ([0ac2ff8](https://github.com/ngc-shj/passwd-sso/commit/0ac2ff8337498a5fe647dac8e750bcb1b6859546))
* notify tenant admins on vault lockout threshold crossing ([#215](https://github.com/ngc-shj/passwd-sso/issues/215)) ([6a5bac8](https://github.com/ngc-shj/passwd-sso/commit/6a5bac8ada2947a8339ce3e1072745b01e5b0f37))
* **org:** add folder selection to org password create/edit forms ([36b86d9](https://github.com/ngc-shj/passwd-sso/commit/36b86d9fed54534b3bad235415f47552700cb441))
* P0 security foundations (KDF metadata, crypto ledger, key retention) ([#151](https://github.com/ngc-shj/passwd-sso/issues/151)) ([078983d](https://github.com/ngc-shj/passwd-sso/commit/078983de0f9809c63516ffe891514f7d5ea2fbfc))
* P1 security hardening — session kill, CI scanning, incident runbook ([#153](https://github.com/ngc-shj/passwd-sso/issues/153)) ([587ec65](https://github.com/ngc-shj/passwd-sso/commit/587ec65fc7c586dd79269aa3931d1681b414d994))
* P2 security hardening — ItemKey, Argon2id, Sentry, threat model ([#155](https://github.com/ngc-shj/passwd-sso/issues/155)) ([4ad991e](https://github.com/ngc-shj/passwd-sso/commit/4ad991ef2e84de0eb9ff3e757dd042f3739ea708))
* P3 security hardening — session limits, idle timeout, vault auto-lock ([#158](https://github.com/ngc-shj/passwd-sso/issues/158)) ([40b19b7](https://github.com/ngc-shj/passwd-sso/commit/40b19b7cedb4a440a1b9b12c3f33398cf25860da))
* **passwords:** add bulk archive action with audit and tests ([2b7fc7a](https://github.com/ngc-shj/passwd-sso/commit/2b7fc7ad12217f69e3bfba3eb88da29011dced3e))
* per-tenant network access restriction (CIDR + Tailscale) ([#169](https://github.com/ngc-shj/passwd-sso/issues/169)) ([1d33d1d](https://github.com/ngc-shj/passwd-sso/commit/1d33d1da707805034fc51712fdad6e6da6a2f898))
* quality and security hardening batch ([#37](https://github.com/ngc-shj/passwd-sso/issues/37), [#27](https://github.com/ngc-shj/passwd-sso/issues/27), [#54](https://github.com/ngc-shj/passwd-sso/issues/54), [#38](https://github.com/ngc-shj/passwd-sso/issues/38), [#51](https://github.com/ngc-shj/passwd-sso/issues/51), [#56](https://github.com/ngc-shj/passwd-sso/issues/56), [#55](https://github.com/ngc-shj/passwd-sso/issues/55), [#32](https://github.com/ngc-shj/passwd-sso/issues/32)) ([#217](https://github.com/ngc-shj/passwd-sso/issues/217)) ([32996df](https://github.com/ngc-shj/passwd-sso/commit/32996df43553593bd52a75b0345fe0e229fe28f7))
* restrict team creation to tenant OWNER/ADMIN ([#141](https://github.com/ngc-shj/passwd-sso/issues/141)) ([ab32fef](https://github.com/ngc-shj/passwd-sso/commit/ab32feffabebbdf58c99291336dc848aec34c207))
* **scim:** implement SCIM 2.0 provisioning for organizations ([af50c60](https://github.com/ngc-shj/passwd-sso/commit/af50c60ddf8c48bb11cc698f10c8bcab98f8fa49))
* **scim:** implement SCIM 2.0 provisioning with security hardening ([72eb78f](https://github.com/ngc-shj/passwd-sso/commit/72eb78fe05cd1422e262683c446debb09a18c75e))
* **security:** add explicit same-origin CORS policy + a11y fix ([6a327df](https://github.com/ngc-shj/passwd-sso/commit/6a327dfb87e9a00e70243dc6ad80f08862f37537))
* **security:** add explicit same-origin CORS policy for all API routes ([d7c30a9](https://github.com/ngc-shj/passwd-sso/commit/d7c30a91e00eef7afea8ce6d1c2f06b0ebf34dbe)), closes [#46](https://github.com/ngc-shj/passwd-sso/issues/46)
* **security:** add master password re-prompt for sensitive entries ([#66](https://github.com/ngc-shj/passwd-sso/issues/66)) ([15aaedb](https://github.com/ngc-shj/passwd-sso/commit/15aaedb62ab152707a249fe56170b0073cdcd6ea))
* **security:** add startup-time env validation with Zod schema ([32f220e](https://github.com/ngc-shj/passwd-sso/commit/32f220e01e57e9f9288e78249e396e8bd31083c0))
* **security:** master password re-prompt & clipboard clear fix ([1bec68d](https://github.com/ngc-shj/passwd-sso/commit/1bec68db64c7644489be32f31fecc55f4a54e9a4))
* **security:** startup-time env validation with Zod schema ([aa7bbf0](https://github.com/ngc-shj/passwd-sso/commit/aa7bbf040df22dfa9df0eaa353c025e784415ee2))
* **send:** add Bitwarden Send-like text/file sharing ([#73](https://github.com/ngc-shj/passwd-sso/issues/73)) ([cd5f4a1](https://github.com/ngc-shj/passwd-sso/commit/cd5f4a1e47ce5c567a06755a42ee052d4988e6c9))
* **send:** add Bitwarden Send-like text/file sharing ([#73](https://github.com/ngc-shj/passwd-sso/issues/73)) ([112f4c2](https://github.com/ngc-shj/passwd-sso/commit/112f4c262cf05aacdc84645647b6e7e22acc8180))
* server-side master key rotation ([#108](https://github.com/ngc-shj/passwd-sso/issues/108)) ([4c5a5e5](https://github.com/ngc-shj/passwd-sso/commit/4c5a5e5b27a74305edd48057ff9551ceb29d227a))
* show folder/tag context in dashboard title and new item defaults ([#128](https://github.com/ngc-shj/passwd-sso/issues/128)) ([9b27a58](https://github.com/ngc-shj/passwd-sso/commit/9b27a587ecf595353327d2d9f9fd17cb90bc9085))
* split i18n files per namespace and optimize client bundle ([76dfbba](https://github.com/ngc-shj/passwd-sso/commit/76dfbba66ca6f81ad0aef8df7f19ba1dd39bd6ca))
* split i18n namespaces and rename import/export components ([e2cef25](https://github.com/ngc-shj/passwd-sso/commit/e2cef25f7932e811b4aec2a157cd1c25cb158451))
* **storage:** add cloud blob adapters and backend routing ([f8fd9ff](https://github.com/ngc-shj/passwd-sso/commit/f8fd9ff1bfa04a74ef5b47651aef2f09fd360f5c))
* **storage:** prepare provider-agnostic blob backend selection ([2050d21](https://github.com/ngc-shj/passwd-sso/commit/2050d217ab6769be2789d973f39cd5e85ddd3e91))
* **storage:** validate cloud backend configuration at runtime ([a154d81](https://github.com/ngc-shj/passwd-sso/commit/a154d81793123ef9ec9810aff2d82d461e0a43bd))
* **storage:** wire attachment routes to cloud object backends ([bf3778a](https://github.com/ngc-shj/passwd-sso/commit/bf3778ab729696fed01815c09f3f33f9ff5855c8))
* support multiple Google Workspace domains (GOOGLE_WORKSPACE_DOMAINS) ([#167](https://github.com/ngc-shj/passwd-sso/issues/167)) ([33790fd](https://github.com/ngc-shj/passwd-sso/commit/33790fd4ddb53629297af1496e3bdcfce45af068))
* **tenant:** org→team rename, tenant RLS, SCIM scoping, security hardening ([#119](https://github.com/ngc-shj/passwd-sso/issues/119)) ([07a18d9](https://github.com/ngc-shj/passwd-sso/commit/07a18d91838c1b29cd69c9276e88fecf4fd56bbf))
* **test:** add k6 load testing suite with 6 scenarios ([#63](https://github.com/ngc-shj/passwd-sso/issues/63)) ([f8a284e](https://github.com/ngc-shj/passwd-sso/commit/f8a284e493fb60752f39b8d9f7ccd92d6838ee81))
* **ui:** add org folder navigation, CRUD, and filtering in sidebar ([9d610f4](https://github.com/ngc-shj/passwd-sso/commit/9d610f42645b24eadfe451fd0b790676295a08b6))
* **ui:** add tag creation from sidebar organize section dropdown ([f487451](https://github.com/ngc-shj/passwd-sso/commit/f4874515ec3cafce55a18887c93c252fb6a42660))
* **ui:** align entry form UX across personal and org flows ([1f0b32f](https://github.com/ngc-shj/passwd-sso/commit/1f0b32fb2dd59335b1ea22336f76e93ea842f348))
* **ui:** align org password form with modern personal UX ([05b0c3c](https://github.com/ngc-shj/passwd-sso/commit/05b0c3c9c3e465787f11d2e62cd7dabc7365fa7c))
* **ui:** display account lockout status on vault lock screen ([bf7c528](https://github.com/ngc-shj/passwd-sso/commit/bf7c528bbe742698054f1863808ae756e9fc4a45))
* **ui:** improve export dialog defaults and copy ([6b8e186](https://github.com/ngc-shj/passwd-sso/commit/6b8e186d5bdec0e42032520426b6e5e634196c5c))
* **ui:** modernize password edit generator experience ([bace156](https://github.com/ngc-shj/passwd-sso/commit/bace156111a87838543b1813f8b6027de23c8807))
* **ui:** modernize share link dialog layout and cards ([a052b3c](https://github.com/ngc-shj/passwd-sso/commit/a052b3c05812458bded2a9e86a277245d12f8652))
* **ui:** selection mode toggle & sidebar hover interactions ([cbd9466](https://github.com/ngc-shj/passwd-sso/commit/cbd9466cb568731742af08ca93aa6a7b70f5507b))
* **vault:** add passphrase recovery flow (Recovery Key + Vault Reset) ([03b8cd7](https://github.com/ngc-shj/passwd-sso/commit/03b8cd7cc2d2e90c92400e5ef922cf14210b6df8))
* **vault:** add passphrase recovery flow (Recovery Key + Vault Reset) ([d1e9ac5](https://github.com/ngc-shj/passwd-sso/commit/d1e9ac5eb70740e0fef3d6d198b791624300ad00))
* **watchtower:** add duplicate detection, entry expiration, and password change reminders ([9ed2d2a](https://github.com/ngc-shj/passwd-sso/commit/9ed2d2a552febc67a9c8f88848089ea29f4bbcb5))
* **watchtower:** add duplicate detection, entry expiration, and timezone fix ([56d445f](https://github.com/ngc-shj/passwd-sso/commit/56d445fe37c6131bc9d31c3267668b838bae2748))
* **watchtower:** add manual scan flow with cooldown and safer leave UX ([bd3099c](https://github.com/ngc-shj/passwd-sso/commit/bd3099cc81fd3711685d1a4b16ca7c09c3278029))
* WebAuthn passkey + magic link sign-in for individual users ([#147](https://github.com/ngc-shj/passwd-sso/issues/147)) ([9de1c64](https://github.com/ngc-shj/passwd-sso/commit/9de1c64de340661b6f6f4d4abd3eb72e89dcf1a5))


### Bug Fixes

* **a11y:** add visually hidden SheetTitle to mobile sidebar ([dc90aeb](https://github.com/ngc-shj/passwd-sso/commit/dc90aeb9954b7b6361bfb3b1260e6070f834f354))
* add IP/UA to audit log events and fix OIDC re-auth spinner ([#185](https://github.com/ngc-shj/passwd-sso/issues/185)) ([eccd256](https://github.com/ngc-shj/passwd-sso/commit/eccd2561085a2e9d28cb92b329e0537f6b705e5d))
* add rate limiting to purge-history and add tests ([d5c53da](https://github.com/ngc-shj/passwd-sso/commit/d5c53dad00cfa19d2ed76662dbbd314912fa25c8))
* add TEAM scope support to watchtower alert endpoint ([#150](https://github.com/ngc-shj/passwd-sso/issues/150)) ([2c058f4](https://github.com/ngc-shj/passwd-sso/commit/2c058f42835a302428076c16a4d76c7b3eeaf012))
* align share-link validation flow and add regression tests ([57144fd](https://github.com/ngc-shj/passwd-sso/commit/57144fd82ff944896e7fb6fa4e51ce5775d4da32))
* align share-link validation flow and tests ([17610df](https://github.com/ngc-shj/passwd-sso/commit/17610df8afc9db9b9cbc9fac027d8b787829e1ea))
* allow Cmd+W on extension connect completion screen ([70c9756](https://github.com/ngc-shj/passwd-sso/commit/70c97563b507873b4183e43f0534512421e7816c))
* **api:** resolve unique constraint violation on folder delete with same-name children ([0cbff3c](https://github.com/ngc-shj/passwd-sso/commit/0cbff3c48bc4bdb406265c470145b2db8eff9588))
* **audit:** test actual createAuditLogger instances and add TLS defaults ([1c280bc](https://github.com/ngc-shj/passwd-sso/commit/1c280bc666d3d400e588966b17e6a59a50b22f33))
* **auth:** address review findings for account lockout ([c059d24](https://github.com/ngc-shj/passwd-sso/commit/c059d24c857e67fdcb41230ef11260acb133a7bf))
* **auth:** notify server on client-side decrypt failure for lockout tracking ([17fac24](https://github.com/ngc-shj/passwd-sso/commit/17fac244a69558aa0bbca53bbd5b2ee07868c11e))
* **backup:** scope EventBridge rules to vault and validate backup window ([bae41d7](https://github.com/ngc-shj/passwd-sso/commit/bae41d7eaedc34896c8333b84c09d2972aecf737))
* **backup:** use sourceBackupVaultName for Copy Job and strict time validation ([adb1670](https://github.com/ngc-shj/passwd-sso/commit/adb16701223031ff1476ec2e2dec3484bc5a92c2))
* **blob-store:** defer cloud SDK resolution and add lazy-load tests ([cd3001e](https://github.com/ngc-shj/passwd-sso/commit/cd3001ec03d14166dbdeb9d3e1736dbf47c20fd2))
* **ci:** add explicit permissions to workflow ([#21](https://github.com/ngc-shj/passwd-sso/issues/21)) ([ffc476a](https://github.com/ngc-shj/passwd-sso/commit/ffc476a5e57cd60d25e92759a4115f123bc99dc5))
* **ci:** add jsdom env to context-menu test and bump hono override ([47ae236](https://github.com/ngc-shj/passwd-sso/commit/47ae236b74175480564cdbc9f0f8592013a29376))
* **ci:** add Redis service to app-ci, fix pExpire precision, add jsdom ([#29](https://github.com/ngc-shj/passwd-sso/issues/29)) ([2faf635](https://github.com/ngc-shj/passwd-sso/commit/2faf635a38691eda13eb37721d9625637cd4584b))
* **ci:** make SAML Jackson provider conditional on JACKSON_URL ([#30](https://github.com/ngc-shj/passwd-sso/issues/30)) ([b2f1699](https://github.com/ngc-shj/passwd-sso/commit/b2f1699ad397edd8b2dd210a0ebb091eb0cddb0b))
* **ci:** rename ORG_MASTER_KEY to SHARE_MASTER_KEY in CI and .env.example ([fccbe40](https://github.com/ngc-shj/passwd-sso/commit/fccbe40f0c1b13b682482aeee59db5d1f3ce58cd))
* cross-tenant RLS and emergency vault UI improvements ([#198](https://github.com/ngc-shj/passwd-sso/issues/198)) ([a88d0e4](https://github.com/ngc-shj/passwd-sso/commit/a88d0e467548fc3049a010ae87f3e5ca33679fed))
* **db:** backfill missing schema artifacts and document verifier pepper ([88746af](https://github.com/ngc-shj/passwd-sso/commit/88746af4c65c63331c154aaac4c7fdc26ec3ffb0))
* **db:** resolve prisma migrate reset failure on org_folders_pkey ([c59f814](https://github.com/ngc-shj/passwd-sso/commit/c59f8141e7b1c8a977648aae841252a53e00934f))
* **db:** resolve prisma migrate reset failure on org_folders_pkey ([47ebc25](https://github.com/ngc-shj/passwd-sso/commit/47ebc256e6091ceae9603b407629eda8d4d97c68))
* **deploy:** clarify compose docs and reject unknown deploy options ([700f811](https://github.com/ngc-shj/passwd-sso/commit/700f81112ef34292448835aa437b74d0c6bdf695))
* **deps:** patch rollup vulnerability in extension ([8f9cc35](https://github.com/ngc-shj/passwd-sso/commit/8f9cc35a937291a2f27d38b98ecbf8730b5ab709))
* **deps:** patch rollup vulnerability in extension (CVE-2026-27606) ([46cae15](https://github.com/ngc-shj/passwd-sso/commit/46cae15b873148280dfa36112fb409073193a421))
* **edit-dialog:** load expiresAt from API response into edit form ([51fdc70](https://github.com/ngc-shj/passwd-sso/commit/51fdc70e9e94c5fc972f65b4df8a1cbdc89d7112))
* enable search filtering across all list views ([#161](https://github.com/ngc-shj/passwd-sso/issues/161)) ([17a8b3d](https://github.com/ngc-shj/passwd-sso/commit/17a8b3d715b2aa75125ade7deab6c15234f11c26))
* **env:** trim whitespace on AUTH_URL before URL validation ([0faf301](https://github.com/ngc-shj/passwd-sso/commit/0faf30141beb0ccd84cea785f33e29345550312e))
* **env:** trim whitespace on nonEmpty and validate AUTH_URL format ([5b8921f](https://github.com/ngc-shj/passwd-sso/commit/5b8921f32e828420224713765cacf4faf440d7c0))
* exclude deactivated admins from lockout notifications ([#219](https://github.com/ngc-shj/passwd-sso/issues/219)) ([0cd6a08](https://github.com/ngc-shj/passwd-sso/commit/0cd6a0837f1d2670824322cc27ff93a7259004aa))
* **expiration:** use date-only comparison to avoid timezone issues ([d14f970](https://github.com/ngc-shj/passwd-sso/commit/d14f97014263210a4722dbcba6107e4b282d40e3))
* **ext:** add security hardening and form-detector injection guard ([374af10](https://github.com/ngc-shj/passwd-sso/commit/374af1090165e1e34fb9b8f2c4ad403396a99174))
* **ext:** await hydration before handling messages to prevent vault lock on reload ([68eb358](https://github.com/ngc-shj/passwd-sso/commit/68eb358c9bca0d4fa02d909614b69381de598cb0))
* **extension:** harden inline autofill UI against clickjacking ([5d1daee](https://github.com/ngc-shj/passwd-sso/commit/5d1daeeae16095d9fa45f4e661cf0124c5a97cac))
* **extension:** harden vault secret lifetime and add security review doc ([a077203](https://github.com/ngc-shj/passwd-sso/commit/a077203195fd9a1324458c0cb4400857248a006c))
* **ext:** honor top URL for inline suppression and add tests ([40cd1fd](https://github.com/ngc-shj/passwd-sso/commit/40cd1fd6ba2bef99a408de51474166a80abd9c8d))
* **ext:** improve login detection, autofill UX, and disconnected state display ([17fcd78](https://github.com/ngc-shj/passwd-sso/commit/17fcd78e253f1ae4b3b6f48e4d7b8a0dd76bb1d1))
* **ext:** improve login-id detection and persist vault key across SW restarts ([c7cfda6](https://github.com/ngc-shj/passwd-sso/commit/c7cfda6c6871703f121cca822e9017ca1b499ab3))
* **ext:** notify content script on vault unlock for immediate dropdown ([860ae2b](https://github.com/ngc-shj/passwd-sso/commit/860ae2bc14efcffea2c7830d0b6169e869b4a912))
* **ext:** retry direct autofill injection on unserializable args ([836f60a](https://github.com/ngc-shj/passwd-sso/commit/836f60ab5f1a088549937322ec8ad06be3da5bb2))
* **ext:** sanitize autofill script args for executeScript ([685f2ea](https://github.com/ngc-shj/passwd-sso/commit/685f2ea93579b571bd28797648464db7de946fb4))
* **ext:** stabilize inline autofill target selection ([df00732](https://github.com/ngc-shj/passwd-sso/commit/df007328ed99a653340b3b341dc55118ff2c95a3))
* **ext:** support iframe login overlays for inline detection ([15512ce](https://github.com/ngc-shj/passwd-sso/commit/15512ce57d702c70af08a5310572f150d50c590f))
* **ext:** suppress inline suggestions on passwd-sso app pages ([f8827eb](https://github.com/ngc-shj/passwd-sso/commit/f8827eb271be0a786abc280aadbb535e1c3e0d7f))
* **ext:** suppress inline suggestions on server origin ([245baf4](https://github.com/ngc-shj/passwd-sso/commit/245baf4e2231c0e1b47242f0e0fd4436b8a3c0ee))
* **ext:** use dynamic min-height for popup based on vault state ([e068e12](https://github.com/ngc-shj/passwd-sso/commit/e068e125c7a0724984aaad2065cff57eea446bd8))
* **ext:** use Offscreen API for clipboard, add i18n and popup sync ([9e4b966](https://github.com/ngc-shj/passwd-sso/commit/9e4b9665161ebad8fce9a58042b985d84d8e34cb))
* **ext:** use space character for clipboard clear in offscreen document ([a3e36ce](https://github.com/ngc-shj/passwd-sso/commit/a3e36ce2b5a44e4e2cad7c911f808da843b9d016))
* filter share dialog fields by entry type & add reverse proxy docs ([#165](https://github.com/ngc-shj/passwd-sso/issues/165)) ([3f8d72c](https://github.com/ngc-shj/passwd-sso/commit/3f8d72cec5e3a11f14002a67df11d59d0bc32ccc))
* **health:** SNS policy for CloudWatch Alarms, Redis required null check ([b6b4563](https://github.com/ngc-shj/passwd-sso/commit/b6b4563e1eb66dd983b4978cbfa8a171f6124747))
* **i18n:** replace hardcoded strings and add component tests ([6715201](https://github.com/ngc-shj/passwd-sso/commit/67152012544be94c981abe7f7b033d0f654ca1ea))
* **i18n:** replace hardcoded strings with i18n keys and configurable app name ([60c1247](https://github.com/ngc-shj/passwd-sso/commit/60c1247fdda1015071f40b8545f88f152ef0e974))
* **i18n:** update sharing page title and description ([eea1142](https://github.com/ngc-shj/passwd-sso/commit/eea1142cdafc576f86fe86b5040c47e4d17435f4))
* import fetch, bulk selection limit, session expiry detection ([#152](https://github.com/ngc-shj/passwd-sso/issues/152)) ([5301603](https://github.com/ngc-shj/passwd-sso/commit/5301603ae32ec8b2a0c258f3762664657aa0edf6))
* **import:** create and map missing tags during import ([fcaf3fb](https://github.com/ngc-shj/passwd-sso/commit/fcaf3fb6e3f46289523504641d47de21af8de4d0))
* improve Magic Link invitation UX for new users ([#197](https://github.com/ngc-shj/passwd-sso/issues/197)) ([85179f6](https://github.com/ngc-shj/passwd-sso/commit/85179f6b3f4930049f56a765abb83b50749ba148))
* **lint:** resolve all 49 ESLint warnings ([4aee77c](https://github.com/ngc-shj/passwd-sso/commit/4aee77c427a42e03940b907960ef8afa72493247))
* **lint:** resolve all 49 ESLint warnings and restore error-level rules ([0079d72](https://github.com/ngc-shj/passwd-sso/commit/0079d7256b19a70215cfc664ff432fbf507a8f92))
* normalize extension network errors and add CORS preflight support ([#173](https://github.com/ngc-shj/passwd-sso/issues/173)) ([c32ccad](https://github.com/ngc-shj/passwd-sso/commit/c32ccad39d64987b27deaeee1c7652f74cc32834))
* org settings UX improvements and import tag creation bug ([2df6fed](https://github.com/ngc-shj/passwd-sso/commit/2df6fedcfde90ce8e1377440bc7d6e96a9cc10dc))
* patch npm-bundled tar to 7.5.11 (CVE-2026-31802) ([#176](https://github.com/ngc-shj/passwd-sso/issues/176)) ([f9ef76c](https://github.com/ngc-shj/passwd-sso/commit/f9ef76c9d6396746b4c572752b127aaaf1d70aa5))
* place new SSO users directly into SSO tenant on first sign-in ([bafb06b](https://github.com/ngc-shj/passwd-sso/commit/bafb06b7e10f6135c1b4a69a0a1cdc8011fce75f))
* place new SSO users directly into SSO tenant on first sign-in ([#172](https://github.com/ngc-shj/passwd-sso/issues/172)) ([bafb06b](https://github.com/ngc-shj/passwd-sso/commit/bafb06b7e10f6135c1b4a69a0a1cdc8011fce75f))
* **proxy:** clear stale auth session cookies on signin redirect ([2b93d67](https://github.com/ngc-shj/passwd-sso/commit/2b93d672723619d6d8385fc807996b7961162e26))
* recovery key banner hidden behind header & immutable header error ([28c51a8](https://github.com/ngc-shj/passwd-sso/commit/28c51a8c7bb8f6b2f2119a784750082025bb67c6))
* recovery key banner hidden behind header & immutable header error ([9d4d94f](https://github.com/ngc-shj/passwd-sso/commit/9d4d94fa9efaf09020cc1075204d8a461174d81e))
* recovery key banner, immutable headers, selection mode, tag creation, UI polish ([1593b37](https://github.com/ngc-shj/passwd-sso/commit/1593b3710644e9abbc4e431590140e53286e761b))
* remove unused imports and bump vulnerable dependencies ([#199](https://github.com/ngc-shj/passwd-sso/issues/199)) ([8496ebc](https://github.com/ngc-shj/passwd-sso/commit/8496ebc35cc71d34f3139fdeec90787cf940ef1b))
* replace global beforeunload guard with dirty-state guards ([#178](https://github.com/ngc-shj/passwd-sso/issues/178)) ([4668c3c](https://github.com/ngc-shj/passwd-sso/commit/4668c3cb52ebf84f175fb971acbf7ef23ee1e98e))
* resolve 16 type errors (NODE_ENV read-only, GET handler signatures) ([dbfaba4](https://github.com/ngc-shj/passwd-sso/commit/dbfaba4d1a5d5b4a3c5036b71b9eb20453797698))
* resolve 28 CodeQL code scanning alerts ([#163](https://github.com/ngc-shj/passwd-sso/issues/163)) ([64edff1](https://github.com/ngc-shj/passwd-sso/commit/64edff152420fb4a98dee02cbc6390d739e74afa))
* resolve container vulnerabilities (zlib, cross-spawn, npm bundled CVEs) ([#154](https://github.com/ngc-shj/passwd-sso/issues/154)) ([6cbd571](https://github.com/ngc-shj/passwd-sso/commit/6cbd57152922e3979a0c3073e8dc5d8351359a52))
* resolve Dependabot security alerts for file-type and hono ([#180](https://github.com/ngc-shj/passwd-sso/issues/180)) ([74a74db](https://github.com/ngc-shj/passwd-sso/commit/74a74dbd20bbfe62ed8e368492404b604375c671))
* resolve lint errors in check-auth tests and team settings page ([#193](https://github.com/ngc-shj/passwd-sso/issues/193)) ([b481338](https://github.com/ngc-shj/passwd-sso/commit/b481338031ccdd3afe77a0f138cb47d918f912b4))
* resolve lint errors in share-e2e-entry-view and share-dialog ([263ff3e](https://github.com/ngc-shj/passwd-sso/commit/263ff3e20348f09d2570d61e47bff98ea1d4d747))
* resolve sidebar folder count mismatch and centralize team mutations ([#184](https://github.com/ngc-shj/passwd-sso/issues/184)) ([cff4142](https://github.com/ngc-shj/passwd-sso/commit/cff4142c2360392eabd4dcc170d899e01438d898))
* resolve team import missing favorites and hierarchical folders ([#135](https://github.com/ngc-shj/passwd-sso/issues/135)) ([cf66851](https://github.com/ngc-shj/passwd-sso/commit/cf66851095e7784dc01408d111c67a033be9bf51))
* **security:** add fallback writeText on clipboard clear failure ([67796f1](https://github.com/ngc-shj/passwd-sso/commit/67796f1fead0500ea10959dce85aa2f20d66037e)), closes [#99](https://github.com/ngc-shj/passwd-sso/issues/99)
* **security:** add reprompt guards to inline detail and improve clipboard clearing ([23e96a6](https://github.com/ngc-shj/passwd-sso/commit/23e96a61ed04f8879d088b970f5ad9d975f1a070))
* **security:** allow Bearer bypass for extension token routes and sanitize import filename ([b026748](https://github.com/ngc-shj/passwd-sso/commit/b0267486e37fd449d284a5ec4d4033831d33e25e))
* **security:** mask sensitive fields in history View dialog and add reprompt guard ([0e2fef3](https://github.com/ngc-shj/passwd-sso/commit/0e2fef39580a61aff3808ab6f192c6223ef01dba))
* **security:** patch reprompt guard gaps found in code review ([5a4e5e9](https://github.com/ngc-shj/passwd-sso/commit/5a4e5e942d4c2d58e2f85da45835cabaad947ab4))
* **security:** proxy Bearer bypass for extension tokens + import filename sanitization ([22495ac](https://github.com/ngc-shj/passwd-sso/commit/22495ac75fa19365b40f85df7dfe665834cd34c6))
* **security:** resolve CodeQL code scanning alerts ([2bf7435](https://github.com/ngc-shj/passwd-sso/commit/2bf743511f4d4d48cb98ba1f956971b089b0d3b7))
* **security:** resolve CodeQL code scanning alerts ([72c5911](https://github.com/ngc-shj/passwd-sso/commit/72c5911123db66b586cd64329f1e9dea42420b83))
* **security:** use AUTH_URL for CSRF origin check, eliminate as any ([#42](https://github.com/ngc-shj/passwd-sso/issues/42)) ([108818f](https://github.com/ngc-shj/passwd-sso/commit/108818fd4fc09f80c4bd11da9d44bb7442d79c67))
* **security:** validate orgFolderId belongs to same org in POST/PUT APIs ([52b09cb](https://github.com/ngc-shj/passwd-sso/commit/52b09cb2af861823159f3b65714163bb84b6f1be))
* **security:** validate parentId ownership in folder APIs and add Org Folder tests ([ddbcfdd](https://github.com/ngc-shj/passwd-sso/commit/ddbcfdd3e9f962904a7d42d9ed1bf15eff4effbd))
* **security:** zero secretKey in finally and preserve locale on redirect ([122884a](https://github.com/ngc-shj/passwd-sso/commit/122884ac0ffc9b9fa0245052ed19d4d538773290))
* sidebar emergency access visibility + docs update ([#148](https://github.com/ngc-shj/passwd-sso/issues/148)) ([b8cf389](https://github.com/ngc-shj/passwd-sso/commit/b8cf389c12f6a5aefa59e706e77d4f933146000e))
* standardize audit log metadata and UI display policy ([#149](https://github.com/ngc-shj/passwd-sso/issues/149)) ([947c0a7](https://github.com/ngc-shj/passwd-sso/commit/947c0a7a6bb10e201fd0deca1e7573510677a087))
* **tags:** accept null color in createOrgTagSchema ([919f170](https://github.com/ngc-shj/passwd-sso/commit/919f170649b335be85920a633b207dc4ca7ed62f))
* **tags:** accept null color in updateTagSchema ([1391a67](https://github.com/ngc-shj/passwd-sso/commit/1391a672164a26f403d1513af5bef0a7769e0185))
* team RLS cross-tenant access and UI improvements ([#130](https://github.com/ngc-shj/passwd-sso/issues/130)) ([6664ccd](https://github.com/ngc-shj/passwd-sso/commit/6664ccdfe91c676714d4f9ba7d2380c30509d4cf))
* **test:** apply bit-flip tampering to all crypto tests ([d92170e](https://github.com/ngc-shj/passwd-sso/commit/d92170e06a573608e98838f4b00c6219a3387fbb))
* **test:** strip asChild prop from Button mock to suppress React DOM warning ([18c5ea6](https://github.com/ngc-shj/passwd-sso/commit/18c5ea6a5b81b99f4d3591e4d8c7a2f8ca397c07))
* **test:** use bit-flip instead of fixed byte for ciphertext tampering ([cea6d81](https://github.com/ngc-shj/passwd-sso/commit/cea6d81b3fafa7ca0c9bc2803516ef00213d13ee))
* **test:** wrap async state updates in act() to suppress React warnings ([ee976b1](https://github.com/ngc-shj/passwd-sso/commit/ee976b15cd50839ad984170e90ec0a04daad490c))
* **totp:** sync input value on display → input mode switch ([d3a0f32](https://github.com/ngc-shj/passwd-sso/commit/d3a0f32e4a785f3333c639a88d68cdbd4b15323e))
* **ui:** add API error toasts for folder operations and add FolderDialog tests ([b638947](https://github.com/ngc-shj/passwd-sso/commit/b6389472ea933fb94837c35b2ae7b42078744a6c))
* **ui:** add back button to recovery and vault-reset pages ([d036af6](https://github.com/ngc-shj/passwd-sso/commit/d036af64017dbd3dccb03a6079cae0a0bf1595d3))
* **ui:** add consistent header icons across all dashboard pages ([5ae7c82](https://github.com/ngc-shj/passwd-sso/commit/5ae7c82af034822c47318b1c10d8faceb9f9891f))
* **ui:** add consistent header icons across dashboard pages ([c1c3133](https://github.com/ngc-shj/passwd-sso/commit/c1c313385ee386217a2d15c001ae7e618055df51))
* **ui:** add expand/collapse toggle to sidebar folder tree ([89672a6](https://github.com/ngc-shj/passwd-sso/commit/89672a6286f8e2610251293b3e4175a1a9b784d8))
* **ui:** add folder create/edit/delete UI to sidebar and fix i18n ([4545a7c](https://github.com/ngc-shj/passwd-sso/commit/4545a7c0919197a8cd590cbf04a1ba1b400494ae))
* **ui:** add folder hierarchy indentation and folder selector to password form ([bc5adb8](https://github.com/ngc-shj/passwd-sso/commit/bc5adb8e4d79b9402d821376711399fb0e59569f))
* **ui:** add org history display and View button to entry history section ([369c9ce](https://github.com/ngc-shj/passwd-sso/commit/369c9cea5258ce40781700f604fe663100aeb22b))
* **ui:** improve layout consistency across dashboard pages ([89bdef8](https://github.com/ngc-shj/passwd-sso/commit/89bdef8267fd87b65eda3f7f2e3393b3462ca4f9))
* **ui:** improve layout consistency across dashboard pages ([28ac497](https://github.com/ngc-shj/passwd-sso/commit/28ac497b39eb9df5ea5600bd1aa4b0d32dea8356))
* **ui:** make new item action context-aware by category ([94f2263](https://github.com/ngc-shj/passwd-sso/commit/94f2263de573b5f439ec85a360bad341a061c8ab))
* **ui:** move org folder navigation into org submenu for discoverability ([da16dc9](https://github.com/ngc-shj/passwd-sso/commit/da16dc9937071e4fd199ef3513c31d1f6fedffed))
* **ui:** normalize export/create dialog widths ([47015b9](https://github.com/ngc-shj/passwd-sso/commit/47015b9e8fa7dbacc345673ad412ccb5a0210b57))
* **ui:** pass requireReprompt to dialog edit path and use shadcn Checkbox ([f4d28a8](https://github.com/ngc-shj/passwd-sso/commit/f4d28a8af999eb1e4fbcade1d519d45a125658ff))
* **ui:** prevent cancel race condition in RepromptDialog ([c054ebf](https://github.com/ngc-shj/passwd-sso/commit/c054ebf9213d3b0dc80b27af5ca2571a9f100c88))
* **ui:** prevent IME composition Enter from triggering form submission ([23bfcc2](https://github.com/ngc-shj/passwd-sso/commit/23bfcc2f307950ca5224ec8898abe92c530c5106))
* **ui:** prevent password card overflow on narrow viewports ([b2ca7db](https://github.com/ngc-shj/passwd-sso/commit/b2ca7db0b0356499966320c2f6b4dcfa8ccac998))
* **ui:** remove org name from audit log page title ([d66b555](https://github.com/ngc-shj/passwd-sso/commit/d66b55526d660ca4bbfbccac0e023a8f13cd234e))
* **ui:** scope hover trigger for tag/folder menu to count area only ([6b01c2b](https://github.com/ngc-shj/passwd-sso/commit/6b01c2bd94ab11b5857547bcb02892f6cce8714c))
* **ui:** show org category in subtitle and improve org catalog label ([dfba24e](https://github.com/ngc-shj/passwd-sso/commit/dfba24ef9a0ecec4f8290cfb55b402d83c321a25))
* **ui:** show org folder create button even when org has zero folders ([8a254c5](https://github.com/ngc-shj/passwd-sso/commit/8a254c5e4c729879d798db83d181e27231ac2e3b))
* **ui:** simplify extension connect success toast text ([2c03228](https://github.com/ngc-shj/passwd-sso/commit/2c03228e8567b4246da3a3c2b018041ec5320d23))
* **ui:** static org settings title, Watchtower description, mobile vault indicator ([964ce7d](https://github.com/ngc-shj/passwd-sso/commit/964ce7d0b8df89f81d31fc68bffc9b51b368d7ff))
* **ui:** swallow network errors in notifyFailure and add frontend tests ([b3139fa](https://github.com/ngc-shj/passwd-sso/commit/b3139fa20343b22c30c1b41766fb62da04a2f22c))
* unify callbackUrl handling for browser extension connection flow ([#204](https://github.com/ngc-shj/passwd-sso/issues/204)) ([2ed1701](https://github.com/ngc-shj/passwd-sso/commit/2ed1701d1fe9a629f592118ae645102dab6dc782))
* use AUTH_URL protocol to determine session cookie prefix ([6a870cf](https://github.com/ngc-shj/passwd-sso/commit/6a870cfd054aa167b5d277b21b233cc4d106254c))
* **vault:** allow extension close-tab flow without unload prompt ([76d895f](https://github.com/ngc-shj/passwd-sso/commit/76d895fde870bdbd7c4f65017f8a9f093dc181d1))
* **vault:** allow SETUP_REQUIRED to override UNLOCKED state after vault reset ([4239095](https://github.com/ngc-shj/passwd-sso/commit/42390950db5d9a6fd884a72cf76a9bfb4e349a5d))
* **vault:** store secretKey in memory after setup and fix i18n/navigation bugs ([b5e46de](https://github.com/ngc-shj/passwd-sso/commit/b5e46dedc29d22262d84a2e927151290400f77cc))
* **vault:** zero secretKey copy in recovery dialog and add UI tests ([0b9f130](https://github.com/ngc-shj/passwd-sso/commit/0b9f1306765fc12e3309792679e27e1605509dbd))
* verify user exists in DB before tenant membership upsert ([#166](https://github.com/ngc-shj/passwd-sso/issues/166)) ([ab64503](https://github.com/ngc-shj/passwd-sso/commit/ab6450398be98abae1d3ee648df90cf9e4845bb8))


### Performance Improvements

* codebase-wide performance audit — 21 optimizations ([#210](https://github.com/ngc-shj/passwd-sso/issues/210)) ([342b96e](https://github.com/ngc-shj/passwd-sso/commit/342b96e4f555817bfa678d222e5d659704e357dd))
* optimize DB access loops — eliminate N+1 queries and redundant fetches ([#209](https://github.com/ngc-shj/passwd-sso/issues/209)) ([75eee7e](https://github.com/ngc-shj/passwd-sso/commit/75eee7e34547d932d4d9f0808f1c35446fb82118))
* optimize DB indexes to match actual query patterns ([#206](https://github.com/ngc-shj/passwd-sso/issues/206)) ([098ed5b](https://github.com/ngc-shj/passwd-sso/commit/098ed5b5a34f083bb19b4876f6a6b0a1af8a5f1a))
