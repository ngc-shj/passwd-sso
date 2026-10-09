// aria-labelledby holds element ids, not the label: a field labelled
// `aria-labelledby="accountNum_label"` reads as "口座番号" only through the text
// of the element that id names (Sony Bank login). Field-classification hints
// use the referenced text, bounded so a page cannot make every check scan a
// large subtree.

const MAX_LABEL_TEXT = 200;

export function labelledByText(el: Element): string {
  const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  return ids
    .map((id) => el.ownerDocument.getElementById(id)?.textContent?.slice(0, MAX_LABEL_TEXT) ?? "")
    .join(" ");
}
