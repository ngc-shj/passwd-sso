/**
 * Limited-subset parser for docker-compose*.yml environment sections.
 *
 * Extracts only HOST-ENV REFERENCES — vars that Docker Compose pulls from
 * the host environment via ${VAR}, ${VAR:?...}, ${VAR:-default}, or bare
 * pass-through syntax. Container-internal literal assignments (VAR: value,
 * - VAR=value) are NOT flagged because they do not depend on host env.
 *
 * Handles the two forms used in this repo:
 *   List form (extracted):
 *               - VAR=${VAR:?msg}   — inner ${VAR} extracted
 *               - VAR=${VAR:-default}
 *               - VAR=${VAR}
 *               - VAR               (bare pass-through — outer VAR extracted)
 *   List form (skipped):
 *               - VAR=literal       — no ${...}, container-local only
 *   Map form (extracted):
 *               VAR: "${HOST_VAR:?}" — inner ${HOST_VAR} extracted
 *   Map form (skipped):
 *               VAR: literal        — no ${...}, container-local only
 *
 * LIMITATIONS (fail-closed):
 *   - YAML anchors (&anchor, *alias) inside environment: are detected and
 *     cause Error("unsupported compose form").
 *   - Multi-line folded scalars (| or >) in environment values are not supported.
 *   - This is NOT a general YAML parser. It covers the stable, limited subset
 *     used by docker-compose files in this repository.
 *
 * Usage:
 *   import { scanComposeFile } from "./compose-env-scan.js";
 *   const hostEnvRefs = scanComposeFile(yamlText);
 */

// Matches the outer VAR name from list-form entries.
// - VAR=value           → VAR
// - VAR=${INNER:?msg}   → VAR (outer), INNER (inner, may be different)
// - VAR=${INNER}        → VAR, INNER
// - VAR                 → VAR (bare)
const LIST_ENTRY_RE = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)(?:=.*)?$/;

// Matches the inner ${VAR...} substitution in the value part.
const INNER_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-?][^}]*)?\}/g;

// Matches map-form entries: VAR: anything
const MAP_ENTRY_RE = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/;

// Detects YAML anchors and aliases inside an environment: block (unsupported).
// Top-level anchors (e.g. x-* extension fields) are NOT in scope and are allowed.
const ANCHOR_IN_VALUE_RE = /&\w+|\*\w+/;

export function scanComposeFile(yamlText: string): Set<string> {
  const lines = yamlText.split("\n");
  const vars = new Set<string>();

  let inEnvironment = false;
  let environmentIndent = -1;
  let isListForm: boolean | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect "environment:" key under any service.
    // Matches "    environment:" at any indent level.
    const envKeyMatch = line.match(/^(\s*)environment\s*:/);
    if (envKeyMatch) {
      inEnvironment = true;
      environmentIndent = envKeyMatch[1].length;
      isListForm = null; // reset; determine from first entry
      continue;
    }

    if (!inEnvironment) continue;

    // A non-empty, non-comment line at or below the environment key indent
    // signals the end of the environment block.
    const stripped = line.trimStart();
    if (stripped === "" || stripped.startsWith("#")) continue;

    const currentIndent = line.length - stripped.length;

    // If indentation returns to the environment-key level or above, the block ended.
    if (currentIndent <= environmentIndent && stripped !== "") {
      inEnvironment = false;
      environmentIndent = -1;
      isListForm = null;
      // Re-process this line in case it starts a new environment block.
      i--;
      continue;
    }

    // Determine list vs map form from the first entry.
    if (isListForm === null) {
      isListForm = stripped.startsWith("- ");
    }

    // Fail-closed if anchors/aliases appear inside an environment: block.
    if (ANCHOR_IN_VALUE_RE.test(stripped)) {
      throw new Error(
        "unsupported compose form: YAML anchors/aliases found inside environment: block — use a full YAML parser",
      );
    }

    if (isListForm) {
      const m = LIST_ENTRY_RE.exec(line);
      if (m) {
        const valueStart = line.indexOf("=");
        if (valueStart === -1) {
          // Bare `- VAR` — pure host-env pass-through.
          vars.add(m[1]);
        } else {
          // Only extract inner ${VAR} substitutions. A literal assignment
          // (- VAR=plain-value) is container-internal and NOT a host-env ref.
          const valuePart = line.slice(valueStart + 1);
          let inner: RegExpExecArray | null;
          INNER_VAR_RE.lastIndex = 0;
          while ((inner = INNER_VAR_RE.exec(valuePart)) !== null) {
            vars.add(inner[1]);
          }
        }
      }
    } else {
      // Map form — only extract when the value contains ${...}.
      // Map-form keys with literal values are container-internal.
      const m = MAP_ENTRY_RE.exec(line);
      if (m) {
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
          const valuePart = line.slice(colonIdx + 1);
          let inner: RegExpExecArray | null;
          INNER_VAR_RE.lastIndex = 0;
          while ((inner = INNER_VAR_RE.exec(valuePart)) !== null) {
            vars.add(inner[1]);
          }
        }
      }
    }
  }

  return vars;
}
