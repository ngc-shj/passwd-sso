-- Phase 2 Round 1 fix: include `updated_at` in audit_chain_anchors UPDATE grant
-- so Prisma's @updatedAt trigger does not produce a permission_denied error.
-- The publisher must update updated_at as a side-effect of touching
-- publish_paused_until / last_published_at via tx.auditChainAnchor.updateMany.
GRANT UPDATE ("updated_at") ON "audit_chain_anchors" TO passwd_anchor_publisher;
