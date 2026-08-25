import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INVALID_RESOURCE_ID, RUN_LOCKED } from "../../src/core/errors";
import { withRunLock } from "../../src/storage/run-lock";

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "fde-gym-lock-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function lockPath(runId: string): string {
  return join(baseDir, "runs", ".locks", `${runId}.lock`);
}

/** A pid that is guaranteed dead: a child process that has already exited. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", () => {
      if (child.pid === undefined) {
        reject(new Error("spawned child had no pid"));
      } else {
        resolve(child.pid);
      }
    });
  });
}

describe("run lock", () => {
  it("rejects an unsafe runId with INVALID_RESOURCE_ID", async () => {
    for (const id of ["../outside", "/absolute"]) {
      await expect(withRunLock(id, { baseDir }, async () => {})).rejects.toMatchObject({
        code: INVALID_RESOURCE_ID,
      });
    }
  });

  it("recovers a dead-owner lock", async () => {
    const path = lockPath("run-lock-a");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ pid: await deadPid(), hostname: hostname(), token: "stale" }) + "\n",
      "utf8",
    );

    let ran = false;
    await withRunLock("run-lock-a", { baseDir }, async (lock) => {
      ran = true;
      expect(lock.runId).toBe("run-lock-a");
      expect(lock.lockPath).toBe(path);
    });
    expect(ran).toBe(true);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns RUN_LOCKED for a live owner without deleting its lock", async () => {
    const path = lockPath("run-lock-b");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, hostname: hostname(), token: "owner-token" }) + "\n",
      "utf8",
    );

    await expect(withRunLock("run-lock-b", { baseDir }, async () => {})).rejects.toMatchObject({
      code: RUN_LOCKED,
    });

    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ token: "owner-token" });
  });
});
