import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// esbuild bundles the worker entrypoints as CommonJS (Dockerfile `--platform=node`
// default). CJS conversion replaces `import.meta.url` with `undefined`, which makes
// `createRequire(import.meta.url)` throw ERR_INVALID_ARG_VALUE at module load —
// crashing the retention-gc worker on boot before it can resolve any blob backend.
// Fall back to a cwd-anchored base URL when `import.meta.url` is unavailable so the
// same source works under ESM (tsx/vitest) and inside a CJS bundle. The worker's
// WORKDIR holds node_modules, so resolving optional SDKs from cwd is correct.
const requireBase =
  typeof import.meta.url === "string"
    ? import.meta.url
    : pathToFileURL(`${process.cwd()}/`).href;

const requireModule = createRequire(requireBase);

export function requireOptionalModule<T = unknown>(moduleName: string): T {
  try {
    return requireModule(moduleName) as T;
  } catch (error) {
    throw new Error(
      `Missing optional dependency "${moduleName}". Install it for the selected blob backend.`,
      { cause: error as Error },
    );
  }
}
