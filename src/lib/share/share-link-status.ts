/**
 * Display status of a share link in the lists (dashboard page and share dialog).
 * Dependency-free so both client components can import it. `creatorAdmitted`
 * false (the link no longer serves because its creator left the entry's team or
 * the entry was trashed or removed, #990) is shown only on an otherwise active
 * link: revoked, used-up and expired are final, while a link not admitted can
 * serve again (the creator's membership is reactivated, the entry restored).
 */

export const SHARE_LINK_STATUS = {
  NOT_ADMITTED: "notAdmitted",
  ACTIVE: "active",
  REVOKED: "revoked",
  MAX_VIEWS_REACHED: "maxViewsReached",
  EXPIRED: "expired",
} as const;

export type ShareLinkStatus = (typeof SHARE_LINK_STATUS)[keyof typeof SHARE_LINK_STATUS];

export interface ShareLinkStatusInput {
  isActive: boolean;
  revokedAt: string | null;
  maxViews: number | null;
  viewCount: number;
  /** Absent for lists that predate the field: treated as admitted. */
  creatorAdmitted?: boolean;
}

export function shareLinkStatus(link: ShareLinkStatusInput): ShareLinkStatus {
  if (link.isActive) {
    return link.creatorAdmitted === false ? SHARE_LINK_STATUS.NOT_ADMITTED : SHARE_LINK_STATUS.ACTIVE;
  }
  if (link.revokedAt) return SHARE_LINK_STATUS.REVOKED;
  if (link.maxViews !== null && link.viewCount >= link.maxViews) return SHARE_LINK_STATUS.MAX_VIEWS_REACHED;
  return SHARE_LINK_STATUS.EXPIRED;
}
