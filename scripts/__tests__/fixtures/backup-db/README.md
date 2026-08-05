# backup-db fixtures

Real PostgreSQL archives, not synthesised bytes — the point of C5 is that the
archive is read by the implementation that will restore it, so a fixture a
stub accepts would prove nothing.

| File | Produced by | Purpose |
| --- | --- | --- |
| `valid.pgdump` | `pg_dump -Fc --create` of the dev `jackson` database, PostgreSQL 16.12 (`postgres:16-alpine`), archive format version 1.15 | `pg_restore --list` must succeed and report a non-zero non-comment entry count |
| `truncated.pgdump` | first 2000 bytes of `valid.pgdump` | a full disk mid-write; non-empty and unreadable, which is what a byte-count check cannot detect |
| `empty.pgdump` | zero bytes | the size check's subject |
| `globals-valid.sql` | `pg_dumpall --globals-only --no-role-passwords` of the same cluster | carries the trailing completion marker and `CREATE ROLE` lines |
| `globals-truncated.sql` | first 400 bytes of `globals-valid.sql` | marker absent |

The extension is `.pgdump`, not `.dump`, because `.gitignore` excludes `*.dump`
so a dump is never committed by accident. Renaming these to `.dump` would make
them silently uncommittable and the suite would pass vacuously in CI.

`pg_restore` refuses an archive whose format version exceeds its own, so a
reader older than 16 will fail these. Group B asserts the reader's version.

Regenerate with `scripts/backup-db.sh` against a dev stack, then copy and
truncate as above.
