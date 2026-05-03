# PR2 Skip Log

Tests deferred from PR2's component coverage with rationale.

## C1 — passwords/{shared,entry,detail,detail/sections}

| file | rationale | decision-rule | evidence | date |
|---|---|---|---|---|
| `src/components/passwords/shared/folder-like.ts` | pure-types | §Skip decision tree (pure types skip rule) | exports `FolderLike` interface only — no runtime code | 2026-05-04 |
