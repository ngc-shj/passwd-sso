# Coding Deviation Log: webhook-card-shared-component
Created: 2026-03-31

## Deviations from Plan

### D1: Card structure uses main branch pattern, not SectionCardHeader
- **Plan description**: Plan referenced `SectionCardHeader` usage in both original files
- **Actual implementation**: `BaseWebhookCard` uses the `<div>` + two `<Card>` structure from `main` branch, not the `<Card>` + `<SectionCardHeader>` + `<CardContent>` + `<Separator>` pattern from `refactor/card-structure-unification` branch
- **Reason**: `SectionCardHeader` component only exists on `refactor/card-structure-unification` branch, not on `main`. This refactoring branch was created from `main`.
- **Impact scope**: Visual structure matches current `main` branch exactly. When `refactor/card-structure-unification` is merged, a follow-up will be needed to update `BaseWebhookCard` to use `SectionCardHeader`.

### D2: `fetchDeps` not used in useCallback dependency array
- **Plan description**: `fetchWebhooks` useCallback depends on `[listEndpoint, ...(fetchDeps ?? [])]`
- **Actual implementation**: `fetchWebhooks` depends only on `[listEndpoint]`. `fetchDeps` is declared in the interface but not consumed.
- **Reason**: `listEndpoint` already encodes all dynamic identifiers (e.g., `apiPath.teamWebhooks(teamId)` bakes `teamId` into the string). When `teamId` changes, `listEndpoint` changes, which triggers `useCallback` re-creation. `fetchDeps` is redundant.
- **Impact scope**: No functional difference. `fetchDeps` kept in interface for documentation/future use.

### D3: Test factory splits mock registration
- **Plan description**: `setupWebhookCardMocks()` would register all shared mocks
- **Actual implementation**: `setupWebhookCardMocks()` excludes `sonner` and `@/lib/url-helpers` mocks. Each test file registers these separately using `vi.hoisted()` references.
- **Reason**: `vi.mock()` inside `setupWebhookCardMocks()` cannot reference `mockFetch`/`mockToast` created by `vi.hoisted()` in the calling file. The references would be disconnected, causing tests to timeout.
- **Impact scope**: Slight duplication (~5 lines per test file for sonner + url-helpers mocks), but ensures correct mock wiring.

---
