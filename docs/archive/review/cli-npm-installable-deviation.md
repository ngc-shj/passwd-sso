# Coding Deviation Log: cli-npm-installable
Created: 2026-03-30T01:16:00+09:00

## Deviations from Plan

No deviations.

Code review findings led to two minor improvements (not deviations):
- `files` field narrowed from `["dist"]` to `["dist/**/*.js", "dist/**/*.d.ts"]` to exclude source maps
- CI grep pattern tightened and negative check for .map files added
