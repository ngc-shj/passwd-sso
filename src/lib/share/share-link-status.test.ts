import { describe, it, expect } from "vitest";
import { SHARE_LINK_STATUS, shareLinkStatus, type ShareLinkStatusInput } from "./share-link-status";

const active: ShareLinkStatusInput = { isActive: true, revokedAt: null, maxViews: null, viewCount: 0 };

describe("shareLinkStatus", () => {
  it("is active for an active link", () => {
    expect(shareLinkStatus(active)).toBe(SHARE_LINK_STATUS.ACTIVE);
  });

  it("treats an absent creatorAdmitted as admitted", () => {
    expect("creatorAdmitted" in active).toBe(false);
    expect(shareLinkStatus(active)).toBe(SHARE_LINK_STATUS.ACTIVE);
  });

  it("is active for an admitted creator", () => {
    expect(shareLinkStatus({ ...active, creatorAdmitted: true })).toBe(SHARE_LINK_STATUS.ACTIVE);
  });

  it("reports creatorNotInTeam ahead of an otherwise active state", () => {
    expect(shareLinkStatus({ ...active, creatorAdmitted: false })).toBe(SHARE_LINK_STATUS.CREATOR_NOT_IN_TEAM);
  });

  it("reports creatorNotInTeam ahead of revoked", () => {
    expect(
      shareLinkStatus({ ...active, isActive: false, revokedAt: "2026-01-01T00:00:00Z", creatorAdmitted: false }),
    ).toBe(SHARE_LINK_STATUS.CREATOR_NOT_IN_TEAM);
  });

  it("is revoked when revoked", () => {
    expect(shareLinkStatus({ ...active, isActive: false, revokedAt: "2026-01-01T00:00:00Z" })).toBe(
      SHARE_LINK_STATUS.REVOKED,
    );
  });

  it("is maxViewsReached when the views are used up", () => {
    expect(shareLinkStatus({ ...active, isActive: false, maxViews: 3, viewCount: 3 })).toBe(
      SHARE_LINK_STATUS.MAX_VIEWS_REACHED,
    );
  });

  it("is expired otherwise", () => {
    expect(shareLinkStatus({ ...active, isActive: false, maxViews: 3, viewCount: 1 })).toBe(SHARE_LINK_STATUS.EXPIRED);
  });
});
