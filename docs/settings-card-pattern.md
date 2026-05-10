# Settings Card Layout Pattern

**Scope:** developer-tools cards under `src/components/settings/developer/`
and tenant-scoped security cards under `src/components/team/security/`.

After the `unify-settings-page-layout` refactor (2026-05), every card in
this scope shares the same skeleton. New cards in this scope MUST follow
the pattern; deviations require explicit justification in the PR
description.

The pattern is enforced mechanically by
`scripts/checks/check-settings-card-layout.sh` (run as part of
`scripts/pre-pr.sh`). The script catches the most common drift modes —
raw `<Collapsible>` for inactive sections, bespoke chevron buttons,
and `border-t pt-4` divider classes. Patterns the script cannot
detect (e.g., omitted `<Separator />`, missing `<h3>` label) rely on
this document and PR review.

---

## Skeleton

```tsx
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { InactiveItemsSection } from "@/components/settings/shared/inactive-items-section";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export function MyThingCard() {
  const t = useTranslations("MyThing");
  const [showInactive, setShowInactive] = useState(false);
  const activeItems = items.filter((i) => i.isActive);
  const inactiveItems = items.filter((i) => !i.isActive);

  return (
    <Card>
      <SectionCardHeader
        icon={MyIcon}
        title={t("title")}
        description={t("description")}
      />
      <CardContent className="space-y-6">
        {/* Optional context row (scope notes, endpoint URLs) */}

        <section className="space-y-3">
          {/* Primary CTA — usually a button or dialog trigger */}
          <Button size="sm" onClick={...}>
            <Plus className="mr-1 h-4 w-4" />
            {t("createMyThing")}
          </Button>
        </section>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-medium">
            {t("registeredMyThings")}
            {/* OR `t("issuedMyThings")` for token-class data */}
          </h3>

          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noMyThings")}</p>
          ) : (
            <div className="space-y-2">
              {activeItems.map(renderItemRow)}

              {inactiveItems.length > 0 && (
                <InactiveItemsSection
                  open={showInactive}
                  onOpenChange={setShowInactive}
                  triggerLabel={t("inactiveMyThings", {
                    count: inactiveItems.length,
                  })}
                >
                  {inactiveItems.map(renderItemRow)}
                </InactiveItemsSection>
              )}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
```

---

## Conventions

### 1. Header

- Use `SectionCardHeader`, not raw `CardHeader`.
- `description` is a complete sentence ending in `。` (ja) / `.` (en).
  Avoid 体言止め.

### 2. Primary CTA placement

- Below `SectionCardHeader`, in its own `<section>` block.
- Left-aligned (default `<Button>`); do NOT put the create CTA in
  `SectionCardHeader.action`. (Header-right is reserved for secondary
  actions only.)
- Use `<Dialog>` for creation (per the `unify-new-creation-ui` PR `#456`).

### 3. Separator

- A `<Separator />` between the create row and the list section is
  REQUIRED. Do NOT use `border-t pt-4` on the list section instead —
  that drift mode is rejected by the static check.
- Only one separator per card by default. Multi-section cards
  (e.g., `team-scim-token-manager.tsx` has endpoint URL + create + list)
  may use two.

### 4. List label

- `<h3 className="text-sm font-medium">` placed at the top of the list
  `<section>`.
- Verb selection by data semantics:
  - **発行済み** / **Issued** for credentials the system mints
    (`ApiKey.issuedKeys`, `OperatorToken.issuedTokens`,
    `Team.scimIssuedTokens`).
  - **登録済み** / **Registered** for entities the user enrolls
    (`MachineIdentity.mcpRegisteredClients`,
    `MachineIdentity.saRegisteredAccounts`,
    `TenantWebhook.registeredWebhooks`,
    `AuditDeliveryTarget.registeredTargets`).
- Do NOT use plain "XXX" (e.g., `t("title")`) — it's ambiguous between
  card title and list label.

### 5. Inactive items

- Always wrap in `<InactiveItemsSection>` from
  `@/components/settings/shared/inactive-items-section`.
- The helper is **controlled** — caller owns `showInactive` state and
  passes it as `open`. Closed by default.
- `triggerLabel` includes the count: `t("inactiveX", { count: N })` (ICU)
  OR `` `${t("inactive")} (${N})` `` (string template). Both accepted;
  ICU preferred for languages with complex pluralization.
- The helper uses real shadcn `Collapsible` internally — do NOT wrap
  with another `<Collapsible>`.
- Caller-side guard `inactiveItems.length > 0` is required (the helper
  does not short-circuit on zero count by design).

### 6. i18n namespace

- One namespace per card (or per logical card group).
- Keys live at `messages/{en,ja}/<Namespace>.json`. There is no
  cross-namespace dotted hierarchy.
- New keys must appear in BOTH `en` and `ja` — verified by
  `src/i18n/messages-consistency.test.ts` (vitest).
- Avoid internal jargon in user-facing strings (per
  `feedback_no_internal_jargon_in_user_strings` memory).
- ja translation must use 漢字/ひらがな domain language; never カタカナ
  for tokens like 「ボルト」 (use 「保管庫」).

---

## Documented exceptions

These cards intentionally diverge from parts of the pattern. Each has
a reason recorded here so future contributors don't "fix" them.

### `service-account-card.tsx` — inner per-account Collapsible

Each active service account row contains a nested `<Collapsible>` for
detail expansion (showing the account's token list). The OUTER
inactive-section wrapper uses `InactiveItemsSection`; the INNER
per-account Collapsibles remain raw because they represent
detail-expansion semantics (open by user click, not active/inactive
lifecycle), which the helper does not model.

### `base-webhook-card.tsx` — auto-expand on quota saturation

A `useEffect` sets `setShowInactive(true)` when the active webhook
count saturates `MAX_WEBHOOKS` and `inactiveWebhooks.length > 0`. This
is an admin operational signal: "quota is full; review revoked items
first." Preserved as part of the migration; the helper's controlled
`open` prop receives the auto-set value transparently.

### `access-request-card.tsx` — 4-state status filter, not active/inactive

JIT access requests have four states (PENDING / APPROVED / DENIED /
EXPIRED), not a binary active/inactive lifecycle. The card uses a
`<Select>` status filter inline with the `<h3>` heading instead of
`<InactiveItemsSection>`. The other layout conventions (header,
Separator, h3, create button placement) still apply.

### `passkey-credentials-card.tsx`, `sessions-card.tsx` — inline `<Badge>` instead of collapse

These cards display every item including revoked / expired in a single
list with a status `<Badge>`, not behind an inactive collapse. The
rationale (per the plan): for personal-vault discoverability with
mixed authenticator names (passkey) and current-vs-prior session
context (sessions), the inactive item's continued visibility is a
feature, not noise. These cards are out of scope for the developer-
tools pattern.

---

## When to add a new card

1. Copy the skeleton above.
2. Add per-namespace JSON entries for `title`, `description`,
   `createMyThing`, `registeredMyThings` (or `issuedMyThings`),
   `inactiveMyThings`, `noMyThings`, etc., in both `messages/en/` and
   `messages/ja/`.
3. Run `scripts/pre-pr.sh` — `Static: settings-card-layout` will catch
   any drift the static check covers.
4. If your card needs an exception (like the four documented above),
   add a section here in the same PR explaining why.
