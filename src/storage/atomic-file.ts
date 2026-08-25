import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Crash-safe same-filesystem file replacement.
 *
 * The destination is never modified in place: contents are written to a sibling
 * temporary file in the SAME directory, fsynced, then `rename`d over the
 * destination (atomic on POSIX), after which the parent directory is fsynced so
 * the rename itself is durable. If anything fails before the rename completes,
 * the temporary file is removed and the previous destination is untouched.
 */
export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);

  const handle = await open(tempPath, "wx");
  let renamed = false;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    await rename(tempPath, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await handle.close();
      } catch {
        // Already closed; nothing to do.
      }
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  // Persist the rename by syncing the parent directory.
  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}
