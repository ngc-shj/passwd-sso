# iOS Workspace Draft

This directory is the planned home for the native iOS implementation of `passwd-sso`.

The initial goal is to ship an iPhone MVP that matches the browser extension's core value using native iOS AutoFill primitives.

## Planned Layout

```text
ios/
  PasswdSSO.xcodeproj
  PasswdSSOApp/
  PasswdSSOAutofillExtension/
  Shared/
```

## Target Responsibilities

### `PasswdSSOApp/`

- server URL setup
- sign-in
- vault unlock
- vault list, search, and detail
- settings
- lock/logout flows
- debug/status surfaces useful during MVP development

### `PasswdSSOAutofillExtension/`

- AutoFill extension entrypoints
- credential lookup and matching
- password fill
- TOTP fill
- locked-vault fallback
- no-match fallback

### `Shared/`

- API client
- session state
- secure storage adapters
- vault models
- crypto helpers
- TOTP
- URL matching
- app/extension bridge types

## Initial Architecture Decisions

- Use `SwiftUI` for app UI.
- Use `AuthenticationServices` for AutoFill integration.
- Use `ASWebAuthenticationSession` for initial web-based sign-in unless a blocker appears.
- Use Keychain for secrets.
- Use App Group only for minimal shared state between app and extension.

## Scope Notes

The MVP baseline is the browser extension, not the full web admin surface.

In scope:

- sign-in
- unlock
- password AutoFill
- TOTP AutoFill
- personal vault read path
- team vault read path
- save/update login where supported

Out of scope for the first slice:

- tenant admin flows
- SCIM
- audit-log management UI
- MCP/service-account workflows
- browser-specific UI patterns

## References

- Plan: [docs/archive/review/ios-autofill-mvp-plan.md](../docs/archive/review/ios-autofill-mvp-plan.md)
- Browser extension baseline: [extension/](../extension)
