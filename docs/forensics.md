# Forensics: navigating refactor-moved files

## Purpose

During the directory-split refactor, files are moved in bulk commits. When running
`git blame` on a moved file, every line will be attributed to the refactor author
rather than the original author. This makes it difficult to identify who introduced
a given line during a security incident or audit.

This document explains how to recover accurate authorship and history for files
that have been moved across refactor phases.

## Setup

Configure git to skip refactor commits when running `git blame`:

```
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

This setting is local to your clone. Apply it once after checkout. It causes
`git blame` to step through ignored SHAs as if they did not exist.

## Usage

**Trace history across renames** (recommended first step):

```
git log --follow -M90% --find-renames <path>
```

The `-M90%` threshold accepts a file as renamed if 90% or more of its content
matches. Lower the threshold if rename detection fails.

**Exhaustive search including merge commits**:

```
git log --all --full-history -- <path>
```

Use this when the file may have been moved through a merge rather than a direct
commit on the branch.

**String-based search when rename detection fails**:

```
git log -S "<string>"
```

Searches for commits that added or removed the given string. Useful when the file
was substantially rewritten during the move.

## Maintenance

Each refactor phase PR **must** append its move-commit SHA to
`.git-blame-ignore-revs` in the same commit that performs the move. Do not defer
this to a follow-up commit.

Expected format — one SHA per line, with an optional comment suffix:

```
a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  # Phase 0 Batch A: split src/lib
b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3  # Phase 0 Batch B: split src/app/api
```

Only include the SHA of the move commit itself. Do not include commits that edit
file content; those must remain visible to `git blame`.

## Audit preparation

Before running `git blame` during a post-incident investigation:

1. Confirm `.git-blame-ignore-revs` is present at the repository root.
2. Confirm `blame.ignoreRevsFile` is configured (`git config blame.ignoreRevsFile`).
3. If the setting is absent, apply it as shown in the Setup section above before
   proceeding — otherwise every line will be attributed to the refactor author,
   which will mislead the investigation.
4. Cross-check findings with `git log --follow` to ensure rename detection did not
   silently drop part of the history.
