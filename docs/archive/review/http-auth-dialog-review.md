# Plan Review: http-auth-dialog
Date: 2026-10-16
Review round: 1

## Changes from Previous Round
Initial review.

## Outcome
The security review showed that silent answering after a per-site opt-in cannot tell who triggered a challenge:
- a redirect keeps `initiator` unchanged (F1, Critical);
- an http address does not identify the server (F3).

The user changed the consent model to a confirmation window on every challenge. The plan was rewritten around it.

## Functionality Findings
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F1 | Major | Permission granted before the SW validates; orphaned on failure; popup host match looser than SW origin match | C3 rollback via `releasePermissions`; action shown on exact host match |
| F2 | Major | No deadline: a slow server hangs the navigation | C4 bounded hydration wait, 10 s fetch/decrypt deadline, once-only callback guard |
| F3 | Major | A top-level `addListener` throw (partial permission, old Chrome) aborts SW start | C6 try/catch; C1 `minimum_chrome_version` |
| F4 | Major | Entry fetch/decrypt and saved-URL logic are inline; copy-paste risk | C7 `fetchAndDecryptEntry`, `savedUrlOrigins` |
| F5 | Major | Revocation can remove the server origin's permission | C5 reference-counted `releasePermissions`, server origin kept |
| F6 | Major | The popup may close during the permission prompt | C3 pending intent in `storage.session`, completed on `onAdded`; VE2 (d) |
| F7–F12 | Minor | Missing files, challenger normalization, bounded requestId set, rule-5 UX, store location and options display, in-popup dialog and gesture order | Files list; C2 `normalizeOrigin`; C4 rule 5 LRU; consent model replaced rule 5; C2 in `lib/`; C5 display; C3 dialog and call order |

## Security Findings
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F1 | Critical (escalate: false) | A redirect from a browser-initiated navigation passes the same-origin-initiator rule (`initiator` survives redirects); on http a MITM can redirect to a bound address and harvest the password | User decision: a confirmation on every challenge (C4 rule 7) |
| F2 | Major | A same-origin initiator inside a cross-site frame (clickjacking) | C4 rule 3 `frameType === "outermost_frame"` |
| F3 | Major | An http origin is a network location, not an identity; Digest can be downgraded to Basic | Confirmation shows the scheme and the http warning; registration warning reworded |
| F4 | Major/Minor | A wrong password is auto-sent once per request: lockout | The confirmation prevents silent repeats; rule 5 per requestId |
| F5 | Minor | Chrome's auth cache makes the credential ambient after the first answer | Stated in C4 |
| F6 | Minor | `storage.local` is writable by content scripts | C2: a forged binding still needs a host permission, a click and a matching entry; accepted |
| F7 | Minor | Removal can revoke permissions other features use | C5 reference counting |
| F8 | Minor | Prerender not excluded | C4 rule 3 `documentLifecycle` |
| F9 | Minor | Answering must not register activity | C4 Activity |
| Adj | — | No trail of releases | SC1: local last-answer time in options |

## Testing Findings
| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| M1 | Major | No test seam; mocks lack `webRequest` and a keyed `storage.local` | C4 `initHttpAuth(deps)` and `handleAuthRequired`; Files: mocks |
| M2 | Major | "Exactly once" has no completion point | The handler returns its promise; red-proof with a second callback |
| M3 | Major | A challenge during hydration is untested | Rule 6 pair |
| M4 | Major | Default ports never tested | Rule 4 controls on 443/80 |
| M5 | Major | Rule 5 edge cases | Superseded by the confirmation model (rule removed) |
| M6 | Major | C6 Chrome behaviour unexercised | VE2 (c); manual scenario 5; C6 unit tests |
| M7 | Major | The user gesture is not pinned | C3 call order and test |
| M8 | Major | VE2 has no observables | VE2 (a)–(d), split local/user, gated before C1 |
| M9 | Major | No auth server named; scenario 6 has no observable | go-httpbin; server log `Authorization` header; positive control |
| m1–m6 | Minor | Manifest assertion, static `cancel` check, error-code gate, C2/C3/C5 pairs, wider red-proof, test-mock guards | Testing strategy; C6 guards |

## Recurring Issue Check
The experts' per-rule checks are in their round-1 outputs. The class-invariant member sets (R42) are the C4 rules, each enumerated with a deny/allow pair.
