import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);

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

