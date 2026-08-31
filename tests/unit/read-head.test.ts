import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendEvents, readHead } from "../../src/core/event-store";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readHead", () => {
  it("returns null for a run with no events and the last { seq, hash } after append", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "fde-head-"));
    cleanupDirs.push(baseDir);

    expect(await readHead("run-1", { baseDir })).toBeNull();

    await appendEvents(
      "run-1",
      [
        {
          type: "run.started",
          runId: "run-1",
          commandId: "start",
          scenarioId: "s",
          locale: "zh-CN",
        },
      ],
      { baseDir },
    );

    const head = await readHead("run-1", { baseDir });
    expect(head).not.toBeNull();
    expect(head!.seq).toBe(1);
    expect(head!.hash).toHaveLength(64);
  });
});
