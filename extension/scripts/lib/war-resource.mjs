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
