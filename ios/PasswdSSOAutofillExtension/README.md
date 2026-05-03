# PasswdSSOAutofillExtension

Planned iOS AutoFill credential provider extension target.

Expected responsibilities:

- participate in iOS Password AutoFill flows
- return matching username/password credentials
- provide TOTP values where supported
- react safely to locked, expired-session, and no-match states
- rely on `Shared/` for crypto, models, matching, and storage adapters
