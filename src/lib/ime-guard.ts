/**
 * Prevents Enter key from triggering form submission during IME composition.
 *
 * When typing with an IME (e.g. Japanese, Chinese, Korean), pressing Enter
 * confirms the composition but should NOT submit the form. This handler
 * checks `event.nativeEvent.isComposing` and calls `preventDefault()`.
 *
 * Usage:
 *   <form onKeyDown={preventIMESubmit} onSubmit={handleSubmit}>
 *
 * For individual onKeyDown handlers, use the guard check directly:
 *   if (e.key === "Enter" && !e.nativeEvent.isComposing) { ... }
 */
export function preventIMESubmit(e: React.KeyboardEvent) {
  if (e.key === "Enter" && e.nativeEvent.isComposing) {
    e.preventDefault();
  }
}
