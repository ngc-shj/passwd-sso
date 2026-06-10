import { SEC_PER_MINUTE } from "@/lib/constants/time";

// Single source of truth for the magic-link token lifetime: the Auth.js
// provider maxAge AND the email copy both derive from this value, so the
// stated validity can never drift from the enforced one.
export const MAGIC_LINK_TTL_MINUTES = 15;
export const MAGIC_LINK_TTL_SEC = MAGIC_LINK_TTL_MINUTES * SEC_PER_MINUTE;
