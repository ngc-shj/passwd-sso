import { z } from "zod";

// ─── Member containment (#1016) ───────────────────────────

/** Ids of one kind an admin may name in one containment request. */
export const MEMBER_CONTAINMENT_MAX_IDS = 100;

const containmentIds = z.array(z.string().uuid()).max(MEMBER_CONTAINMENT_MAX_IDS);

/**
 * The optional body of DELETE /api/tenant/members/[userId]/passkeys: what to
 * contain beyond the passkeys and sessions. The ids are only a selection — the
 * server re-derives that each row is the member's, in the admin's tenant, and
 * live. Unknown keys are refused, so a misspelled kind is a 400 rather than a
 * silent no-op.
 */
export const memberContainmentSchema = z
  .object({
    unlinkAccountIds: containmentIds.optional(),
    revoke: z
      .object({
        scimTokenIds: containmentIds.optional(),
        serviceAccountIds: containmentIds.optional(),
        serviceAccountTokenIds: containmentIds.optional(),
        mcpClientIds: containmentIds.optional(),
        breakglassGrantIds: containmentIds.optional(),
        emergencyAccessGrantIds: containmentIds.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type MemberContainmentInput = z.infer<typeof memberContainmentSchema>;
