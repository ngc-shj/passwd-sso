# Shared

Planned shared Swift code for `PasswdSSOApp` and `PasswdSSOAutofillExtension`.

Expected contents:

- API client
- auth/session state
- secure storage adapters
- vault models
- crypto helpers
- TOTP generation
- URL matching
- app/extension bridge contracts

Design rule:

- put cross-target logic here only when it is platform-neutral within iOS
- keep UI code out of this directory
