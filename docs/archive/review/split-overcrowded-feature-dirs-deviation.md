# Coding Deviation Log: split-overcrowded-feature-dirs
### D1: Unexpected .gitignore entry

- **Plan description**: The Phase 0 checklist lists creation of `.github/CODEOWNERS`, `.git-blame-ignore-revs`, `docs/forensics.md`, and various scripts, but does not mention adding new entries to `.gitignore`.
- **Actual implementation**: `.gitignore` was modified to include a new line `+.refactor-phase-verify-baseline`.
- **Reason**: Likely added to keep a generated “baseline” file for the `refactor-phase-verify` script out of the repository, but this was not documented in the plan.
- **Impact scope**: The new ignore rule causes the file `.refactor-phase-verify-baseline` to be omitted from version control; if the file is later needed for debugging or CI it will be absent, potentially leading to confusion or missing verification data.
