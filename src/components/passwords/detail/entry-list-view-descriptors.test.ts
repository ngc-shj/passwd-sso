import { describe, it, expect } from "vitest";
import {
  NORMAL_VIEW,
  FAVORITES_VIEW,
  ARCHIVE_VIEW,
  TRASH_VIEW,
} from "./entry-list-view-descriptors";
import type { ListViewDescriptor } from "./entry-list-view-descriptors";

// Shorthand: all four canonical descriptors in iteration order.
const ALL_DESCRIPTORS: ListViewDescriptor[] = [
  NORMAL_VIEW,
  FAVORITES_VIEW,
  ARCHIVE_VIEW,
  TRASH_VIEW,
];

// Non-trash descriptors that allow editing / are not read-only.
const EDITABLE_DESCRIPTORS: ListViewDescriptor[] = [
  NORMAL_VIEW,
  FAVORITES_VIEW,
  ARCHIVE_VIEW,
];

describe("ListViewDescriptor — invariant: edit and archive flags are always coupled (INV-C2.1)", () => {
  // Security-review dependency: these two must stay coupled so the UI never
  // shows "archive" without "edit" or vice-versa.
  for (const descriptor of ALL_DESCRIPTORS) {
    it(`${descriptor.kind}: rowActions.edit === rowActions.archive`, () => {
      expect(descriptor.rowActions.edit).toBe(descriptor.rowActions.archive);
    });
  }
});

describe("ListViewDescriptor — invariant: trash affordances (INV-C2.2)", () => {
  it("NORMAL_VIEW: trash=true when editing is allowed", () => {
    expect(NORMAL_VIEW.rowActions.trash).toBe(true);
    expect(NORMAL_VIEW.rowActions.edit).toBe(true);
  });

  it("FAVORITES_VIEW: trash=true when editing is allowed", () => {
    expect(FAVORITES_VIEW.rowActions.trash).toBe(true);
    expect(FAVORITES_VIEW.rowActions.edit).toBe(true);
  });

  it("ARCHIVE_VIEW: trash=true when editing is allowed", () => {
    expect(ARCHIVE_VIEW.rowActions.trash).toBe(true);
    expect(ARCHIVE_VIEW.rowActions.edit).toBe(true);
  });

  it("TRASH_VIEW: edit=false, archive=false, trash=false", () => {
    expect(TRASH_VIEW.rowActions.edit).toBe(false);
    expect(TRASH_VIEW.rowActions.archive).toBe(false);
    expect(TRASH_VIEW.rowActions.trash).toBe(false);
  });

  it("TRASH_VIEW: restore=true and deletePermanently=true", () => {
    expect(TRASH_VIEW.rowActions.restore).toBe(true);
    expect(TRASH_VIEW.rowActions.deletePermanently).toBe(true);
  });

  it("non-trash views: restore=false and deletePermanently=false", () => {
    for (const descriptor of EDITABLE_DESCRIPTORS) {
      expect(descriptor.rowActions.restore).toBe(false);
      expect(descriptor.rowActions.deletePermanently).toBe(false);
    }
  });
});

describe("ListViewDescriptor — invariant: detailReadOnly (INV-C2.2 / S6)", () => {
  it("TRASH_VIEW: detailReadOnly=true (trash is always read-only, including for OWNER)", () => {
    expect(TRASH_VIEW.detailReadOnly).toBe(true);
  });

  it("NORMAL_VIEW: detailReadOnly=false", () => {
    expect(NORMAL_VIEW.detailReadOnly).toBe(false);
  });

  it("FAVORITES_VIEW: detailReadOnly=false", () => {
    expect(FAVORITES_VIEW.detailReadOnly).toBe(false);
  });

  it("ARCHIVE_VIEW: detailReadOnly=false (archive is editable per F3)", () => {
    expect(ARCHIVE_VIEW.detailReadOnly).toBe(false);
  });
});

describe("ListViewDescriptor — invariant: showEmptyTrashButton (F4)", () => {
  it("TRASH_VIEW: showEmptyTrashButton=true", () => {
    expect(TRASH_VIEW.showEmptyTrashButton).toBe(true);
  });

  it("non-trash views: showEmptyTrashButton=false", () => {
    for (const descriptor of EDITABLE_DESCRIPTORS) {
      expect(descriptor.showEmptyTrashButton).toBe(false);
    }
  });
});

describe("ListViewDescriptor — kind fields are correct", () => {
  it("NORMAL_VIEW.kind === 'normal'", () => {
    expect(NORMAL_VIEW.kind).toBe("normal");
  });

  it("FAVORITES_VIEW.kind === 'favorites'", () => {
    expect(FAVORITES_VIEW.kind).toBe("favorites");
  });

  it("ARCHIVE_VIEW.kind === 'archive'", () => {
    expect(ARCHIVE_VIEW.kind).toBe("archive");
  });

  it("TRASH_VIEW.kind === 'trash'", () => {
    expect(TRASH_VIEW.kind).toBe("trash");
  });
});

describe("ListViewDescriptor — apiQuery flags", () => {
  it("NORMAL_VIEW: empty apiQuery (no archived or trash flag)", () => {
    expect(NORMAL_VIEW.apiQuery).toEqual({});
  });

  it("FAVORITES_VIEW: empty apiQuery (same as NORMAL_VIEW)", () => {
    expect(FAVORITES_VIEW.apiQuery).toEqual({});
  });

  it("ARCHIVE_VIEW: apiQuery.archived=true", () => {
    expect(ARCHIVE_VIEW.apiQuery.archived).toBe(true);
    expect(ARCHIVE_VIEW.apiQuery.trash).toBeUndefined();
  });

  it("TRASH_VIEW: apiQuery.trash=true", () => {
    expect(TRASH_VIEW.apiQuery.trash).toBe(true);
    expect(TRASH_VIEW.apiQuery.archived).toBeUndefined();
  });
});

describe("ListViewDescriptor — bulkActions", () => {
  it("NORMAL_VIEW: bulkActions includes archive and trash", () => {
    expect(NORMAL_VIEW.bulkActions).toContain("archive");
    expect(NORMAL_VIEW.bulkActions).toContain("trash");
  });

  it("ARCHIVE_VIEW: bulkActions includes unarchive and trash", () => {
    expect(ARCHIVE_VIEW.bulkActions).toContain("unarchive");
    expect(ARCHIVE_VIEW.bulkActions).toContain("trash");
  });

  it("TRASH_VIEW: bulkActions includes restore and deletePermanently", () => {
    expect(TRASH_VIEW.bulkActions).toContain("restore");
    expect(TRASH_VIEW.bulkActions).toContain("deletePermanently");
  });

  it("TRASH_VIEW: bulkActions does NOT include archive or trash", () => {
    expect(TRASH_VIEW.bulkActions).not.toContain("archive");
    expect(TRASH_VIEW.bulkActions).not.toContain("trash");
  });
});

describe("ListViewDescriptor — sort strategies", () => {
  it("TRASH_VIEW: sort='deletedAt'", () => {
    expect(TRASH_VIEW.sort).toBe("deletedAt");
  });

  it("non-trash views: sort='favoriteThenUpdated'", () => {
    for (const descriptor of EDITABLE_DESCRIPTORS) {
      expect(descriptor.sort).toBe("favoriteThenUpdated");
    }
  });
});

describe("ListViewDescriptor — removeOnUnfavorite (F8)", () => {
  it("FAVORITES_VIEW: removeOnUnfavorite=true", () => {
    expect(FAVORITES_VIEW.removeOnUnfavorite).toBe(true);
  });

  it("non-favorites views: removeOnUnfavorite=false", () => {
    for (const descriptor of [NORMAL_VIEW, ARCHIVE_VIEW, TRASH_VIEW]) {
      expect(descriptor.removeOnUnfavorite).toBe(false);
    }
  });
});

describe("ListViewDescriptor — emptyStateKey values", () => {
  it("NORMAL_VIEW: emptyStateKey='noPasswords'", () => {
    expect(NORMAL_VIEW.emptyStateKey).toBe("noPasswords");
  });

  it("FAVORITES_VIEW: emptyStateKey='noFavorites'", () => {
    expect(FAVORITES_VIEW.emptyStateKey).toBe("noFavorites");
  });

  it("ARCHIVE_VIEW: emptyStateKey='noArchive'", () => {
    expect(ARCHIVE_VIEW.emptyStateKey).toBe("noArchive");
  });

  it("TRASH_VIEW: emptyStateKey='noTrash'", () => {
    expect(TRASH_VIEW.emptyStateKey).toBe("noTrash");
  });
});
