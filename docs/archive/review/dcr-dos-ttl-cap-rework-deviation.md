# Coding Deviation Log: dcr-dos-ttl-cap-rework

## Approach pivot (recorded)

- PR-B started as a per-IP unclaimed-DCR cap with a stored keyed IP hash (schema change). After the plan-review security analysis showed per-source caps are defeated by IPv6 /64 rotation (a /48 = 65536 /64s) at a privacy cost, and per the user's "本質は?" steer, the approach was pivoted to a root-cause, no-schema, no-IP-storage fix: shorten the unclaimed TTL (1h→15min) + raise the global cap (100→1000, reframed as a bloat backstop). Branch renamed feat/dcr-per-ip-unclaimed-cap → fix/dcr-dos-ttl-cap-rework; the IP-hash plan/review docs were removed.

## Phase 2 implementation deviations

- T2 bulk-insert refactor of the integration cap seed initially had a column/value mismatch (11 columns, 10 values — the `client_secret_hash` literal `'hash'` was dropped from the multi-row VALUES tuple), causing Postgres 42601. Fixed by restoring the `'hash'` literal in both seed tuples; the 3 integration tests pass in 1.48s (bulk insert keeps the 1000-row seed fast).
- No schema migration, no IP storage (the rejected approach's cost). Honest residual recorded in C3 docs + SC1: a large SUSTAINED IPv6 botnet can still pressure the pool; this raises the cost ~10× and forces a sustained (not one-shot) attack while keeping legit registrations clear of the ceiling.
