// Shared browser utility for triggering file downloads from fetch responses

/**
 * Reads a fetch Response as a Blob, creates a temporary object URL,
 * triggers a browser download with the given filename, then revokes the URL.
 */
export async function downloadBlob(response: Response, filename: string): Promise<void> {
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
