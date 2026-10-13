// Counts CC / identity detector scans through a spy on ccClaimedFields. One
// scan is one page-wide detection plus one per <form> (so a second form's
// fields get a dropdown): 1 + document.forms.length ccClaimedFields calls, of
// which exactly one has `document` as its root.
export function documentScans(ccClaimedFields: { mock: { calls: unknown[][] } }): number {
  return ccClaimedFields.mock.calls.filter(([root]) => root === document).length;
}
