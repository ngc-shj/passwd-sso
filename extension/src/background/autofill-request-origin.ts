// Who asked for an autofill, and what each kind of request lets the SW trust.
// Every delivery of a decrypted payload is addressed from this: a content
// request to the sender's own document, a context-menu click and a popup
// CC/Identity fill to a document probed before the first send, and a popup
// LOGIN fill to every frame, each of which checks itself.

export const AUTOFILL_REQUEST_KIND = {
  CONTENT: "content",
  CONTEXT_MENU: "contextMenu",
  POPUP: "popup",
} as const;

export type AutofillRequestOrigin =
  // documentId and senderHost both come from the browser-set MessageSender of
  // the requesting document.
  | { kind: typeof AUTOFILL_REQUEST_KIND.CONTENT; documentId: string; senderHost: string }
  // frameId is the clicked frame (top frame when OnClickData has none);
  // senderHost is the host the click resolved to.
  | { kind: typeof AUTOFILL_REQUEST_KIND.CONTEXT_MENU; frameId: number; senderHost: string }
  // expectedOrigin is the exact origin the popup showed the user.
  | { kind: typeof AUTOFILL_REQUEST_KIND.POPUP; expectedOrigin: string };
