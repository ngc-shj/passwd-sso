# Code Review: ui-ux-entry-card
Date: 2026-03-12
Review round: 4 (final)

## Phase 1 — Initial Changes (Rounds 1-2)

### F1 [Major] gap-0 causes layout asymmetry between loading/detail expanded states
- **Action**: Reduced loading spinner from `py-6` to `py-3`
- **Status**: Resolved

### F2 [Minor] border-l-2 clips with rounded-xl corners
- **Action**: Added `overflow-hidden` to Card
- **Status**: Resolved

### F3 [Minor] overflow-y-auto vs overflow-auto inconsistency
- **Action**: Changed to `overflow-auto` to match desktop
- **Status**: Resolved

### F4 [Minor] space-y-1 too tight for selection mode touch targets
- **Action**: Conditional spacing: `selectionMode ? "space-y-2" : "space-y-1"`
- **Status**: Resolved

### F5 [Info] Unused `group` class
- **Action**: Removed from Card className
- **Status**: Resolved

## Phase 2 — Hover Unification (Rounds 3-4)

Unified `hover:bg-accent` → `hover:bg-accent/30` across 15+ container/row elements.
Standardized sidebar icon button hover to shadcn ghost default.

### F6 [Major] Tag dropdown selection items: accent/30 too subtle on popover background
- **Problem**: Dropdown selection items need strong hover for selection affordance
- **Action**: Reverted tag-input.tsx and team-tag-input.tsx to `hover:bg-accent`
- **Status**: Resolved

### F7 [Major] EntrySectionCard: non-clickable container had hover effect
- **Problem**: hover on a non-interactive form section sends false clickable signal
- **Action**: Removed hover from EntrySectionCard
- **Status**: Resolved

### F8 [Minor] Dark mode accent/30 visibility concern
- **Status**: Deferred — requires manual browser testing

### F9 [Minor] teams/page.tsx unused `group` class
- **Status**: Deferred — pre-existing, out of scope

## Security Findings
No findings (all rounds).

## Testing Findings
- No snapshot tests affected
- Trash component tests missing (pre-existing)
- sidebar-shared.tsx bare `hover:bg-accent` on buttons is intentional (shadcn ghost default)
- Hover pattern lint rule not enforced (improvement suggestion for future)

## Hover Pattern Summary

| Context | Pattern |
|---------|---------|
| Container/row (with nested buttons) | `hover:bg-accent/30` |
| Dropdown selection items | `hover:bg-accent` (100%) |
| Non-interactive containers | No hover |
| Buttons (shadcn ghost) | `hover:bg-accent` (framework default) |
