/**
 * Whether a web_accessible_resources entry covers `path`, as Chrome reads the
 * entry: a path relative to the extension root (a leading "/" is optional)
 * where "*" matches any run of characters, "/" included.
 *
 * @param {string} resource
 * @param {string} path
 * @returns {boolean}
 */
export function resourceCovers(resource, path) {
  const pattern = String(resource).replace(/^\/+/, "");
  const regex = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return regex.test(path);
}

/**
 * The web_accessible_resources entries of a built manifest that expose `path`:
 * by a resource naming it (or containing "auth-prompt"), or by a glob that
 * covers it.
 *
 * @param {{ web_accessible_resources?: Array<{ resources?: string[] }> }} manifest
 * @param {string} path
 * @returns {string[]}
 */
export function exposedPromptResources(manifest, path) {
  return (manifest.web_accessible_resources ?? [])
    .flatMap((entry) => entry.resources ?? [])
    .filter((resource) => String(resource).includes("auth-prompt") || resourceCovers(resource, path));
}
