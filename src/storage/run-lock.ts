import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { resolveBaseDir } from "../base-dir.js";
import { SAFE_RESOURCE_ID } from "../core/domain.js";
import { InvalidResourceIdError, RunLockedError } from "../core/errors.js";
import type { StoreOptions } from "../core/event-store.js";

/**
 * Cross-process exclusive writer lock for a run, keyed by runId and held under
 * `<baseDir>/runs/.locks/<runId>.lock`. The on-disk owner is JSON carrying
 * `pid`, `hostname`, and `token`; a lock is released only when the on-disk token
 * matches the holder's token, so a lock can never be dropped out from under a
 * live writer by another process.
 */

export interface RunLock {
  runId: string;
  token: string;
  lockPath: string;
}

interface LockOwner {
  pid: number;
  hostname: string;
  token: string;
}

/**
 * Run `work` while holding the run's exclusive lock. If `options.lock` is
 * already held by the caller (a transaction spanning several appends), it is
 * reused verbatim; otherwise a fresh lock is acquired and released in `finally`.
 */
export async function withRunLock<T>(
  runId: string,
  options: StoreOptions,
  work: (lock: RunLock) => Promise<T>,
): Promise<T> {
  // Self-validate before any path is constructed: `withRunLock` is a public
  // interface and must never turn a runId into a filename component unchecked.
  if (!SAFE_RESOURCE_ID.test(runId)) {
    throw new InvalidResourceIdError("run", runId);
  }
  if (options.lock) {
    return work(options.lock);
  }
  const baseDir = options.baseDir ?? resolveBaseDir();
  const lock: RunLock = {
    runId,
    token: randomUUID(),
    lockPath: join(baseDir, "runs", ".locks", `${runId}.lock`),
  };
  await acquire(lock);
  try {
    return await work(lock);
  } finally {
    await release(lock);
  }
}

/**
 * Acquire a set of run locks in a single, globally-consistent (lexicographic)
 * order and run `work` with the held locks. Acquiring every multi-lock site in
 * the same order prevents two writers from deadlocking when they need the same
 * two run locks in opposite orders.
 *
 * An already-held lock supplied via `options.lock` is reused verbatim and is
 * NEVER released here (its owner releases it); only the freshly acquired locks
 * are released in reverse acquisition order.
 */
export async function withSortedRunLocks<T>(
  runIds: readonly string[],
  options: StoreOptions,
  work: (locks: Map<string, RunLock>) => Promise<T>,
): Promise<T> {
  const sorted = [...new Set(runIds)].sort();
  for (const runId of sorted) {
    if (!SAFE_RESOURCE_ID.test(runId)) {
      throw new InvalidResourceIdError("run", runId);
    }
  }

  const baseDir = options.baseDir ?? resolveBaseDir();
  const provided = options.lock;
  const held = new Map<string, RunLock>();

  try {
    for (const runId of sorted) {
      if (provided !== undefined && provided.runId === runId) {
        held.set(runId, provided);
        continue;
      }
      const lock: RunLock = {
        runId,
        token: randomUUID(),
        lockPath: join(baseDir, "runs", ".locks", `${runId}.lock`),
      };
      await acquire(lock);
      held.set(runId, lock);
    }
    return await work(held);
  } finally {
    for (const runId of [...sorted].reverse()) {
      const lock = held.get(runId);
      if (lock !== undefined && lock !== provided) {
        await release(lock);
      }
    }
  }
}

/**
 * Acquire with `open(path, "wx")`. On `EEXIST`, if the existing owner is on this
 * host and its PID is dead (`ESRCH`), remove the stale lock and retry ONCE. A
 * live owner (or an owner on another host) fails closed with `RUN_LOCKED` and is
 * never deleted. No time-based expiry of a live PID.
 */
async function acquire(lock: RunLock): Promise<void> {
  await mkdir(dirname(lock.lockPath), { recursive: true });
  const owner: LockOwner = { pid: process.pid, hostname: hostname(), token: lock.token };

  let recovered = false;
  for (;;) {
    try {
      const handle = await open(lock.lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(owner) + "\n", "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readOwner(lock.lockPath);
    if (
      existing !== null &&
      !recovered &&
      existing.hostname === owner.hostname &&
      isDeadPid(existing.pid)
    ) {
      recovered = true;
      await rm(lock.lockPath, { force: true });
      continue;
    }
    throw new RunLockedError(lock.runId);
  }
}

/** Remove the lock only when the on-disk token still belongs to this holder. */
async function release(lock: RunLock): Promise<void> {
  const existing = await readOwner(lock.lockPath);
  if (existing !== null && existing.token === lock.token) {
    await rm(lock.lockPath, { force: true });
  }
}

/** Parse the lock's owner JSON; `null` when missing or malformed (fail closed). */
async function readOwner(lockPath: string): Promise<LockOwner | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const owner = parsed as Record<string, unknown>;
      if (
        typeof owner.pid === "number" &&
        typeof owner.hostname === "string" &&
        typeof owner.token === "string"
      ) {
        return { pid: owner.pid, hostname: owner.hostname, token: owner.token };
      }
    }
  } catch {
    // Fall through to null.
  }
  return null;
}

/** A PID is dead when `process.kill(pid, 0)` reports `ESRCH`. */
function isDeadPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
