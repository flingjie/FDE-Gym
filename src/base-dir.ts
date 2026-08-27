import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * FDE Gym - shared store-root resolution.
 *
 * The default store root is project-local: `<packageRoot>/.fde-gym`. The
 * package root is derived from this module's own URL (never `process.cwd()`),
 * so it resolves the same from `src/` under Vitest and from `dist/` under the
 * built CLI.
 */

export function resolvePackageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

/**
 * Resolve the store root: `$FDE_GYM_HOME` when set (non-empty), otherwise the
 * project-local `.fde-gym` directory.
 */
export function resolveBaseDir(): string {
  return process.env.FDE_GYM_HOME || join(resolvePackageRoot(), ".fde-gym");
}
