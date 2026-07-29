import { z } from "zod";
import { MAX_TENANT_CLAIM_LENGTH } from "@/lib/validations/common.server";
import { asciiPrintable } from "@/lib/validations/common";

/**
 * Normalise a raw IdP/operator-supplied claim string to its canonical
 * stored/lookup form: trim, then lowercase. This is the SOLE producer of the
 * stored form — the C1 migration's `tenant_claims_claim_normalized` CHECK is
 * its postcondition. A second `.toLowerCase()` anywhere in
 * `tenant-management.ts` is a forbidden pattern: it would let the stored
 * spelling and the looked-up spelling drift apart.
 */
export function normalizeTenantClaim(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * The POSIX character class for "not printable ASCII", in the exact spelling
 * the SQL side uses. It is the SINGLE source for that predicate outside the
 * committed `.sql` files: `scripts/tenant-domain.ts`'s pre-flight queries bind
 * it as a query PARAMETER rather than spelling it again.
 *
 * Why it is a constant and not another literal: the pre-flight report exists to
 * tell an operator which rows the C1 CHECK constraint will reject *before* they
 * run the migration. A second, independently-maintained copy of the predicate
 * is a report that goes quietly wrong at exactly the moment it is relied on.
 * The two `.sql` copies (the CHECK and the backfill) cannot import this, so
 * `tenant-claim-registry.test.ts` pins them against it by reading the files.
 */
export const NON_PRINTABLE_ASCII_SQL_CLASS = "[^\\x20-\\x7E]";

// The JS mirror of the same predicate. `asciiPrintable` is the repo's existing
// shared constant for this character class (used by the generator-prefs
// validators); it is `*`-quantified, and `storableClaimSchema`'s `.min(1)`
// below supplies the non-empty half.
//
// Restricting the stored form to printable ASCII is what makes Postgres's
// `lower(x COLLATE "C")` and JS's `.toLowerCase()` agree by construction
// (round-5 D3) — under some ctypes the two fold differently for non-ASCII
// input, which would let two distinct spellings of one claim occupy two rows.
const PRINTABLE_ASCII_RE = asciiPrintable;

/**
 * Storage floor — what `resolveTenantByClaim` / `findOrCreateTenantForClaim`
 * accept as a claim to look up or create. Deliberately does NOT require a
 * hostname shape: `parseTenantClaimKeys()` defaults include `organization`
 * and `company`, so a deployment configured that way legitimately produces
 * claims like `acmecorp`, and rejecting them would be an NF2 regression.
 * The printable-ASCII predicate is carried explicitly here (round-5 D3) —
 * it must not be inferred from the CHECK constraint alone.
 */
export const storableClaimSchema = z
  .string()
  .min(1)
  .max(MAX_TENANT_CLAIM_LENGTH)
  .refine((v) => v === normalizeTenantClaim(v), {
    message: "claim must already be normalized (trim + lowercase)",
  })
  .refine((v) => PRINTABLE_ASCII_RE.test(v), {
    message: "claim must be printable ASCII",
  });

// LDH (letters/digits/hyphen) label, no leading/trailing hyphen — the shape
// a single domain label may take.
const DOMAIN_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Operator-input guard for the CLI's `--domain` flag ONLY (C7). Strictly
 * narrower than `storableClaimSchema`: LDH labels, at least one dot, no
 * scheme, no path, no leading or trailing dot, no empty label. This is an
 * input-quality guard for a human typing a domain — NOT a storage invariant.
 * Do not tighten `storableClaimSchema` (or the C1 CHECK) to match it: a
 * non-domain claim key (`organization`/`company`) is a legitimate stored
 * shape this schema would wrongly reject.
 */
export const operatorDomainSchema = storableClaimSchema.refine(
  (v) => {
    if (!v.includes(".")) return false;
    const labels = v.split(".");
    return labels.every((label) => label.length > 0 && DOMAIN_LABEL_RE.test(label));
  },
  { message: "must be a valid domain (dot-separated LDH labels, no scheme/path)" },
);
