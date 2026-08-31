import type { RecordedEvent, RunEvent } from "../core/domain.js";
import type { RunState } from "../core/reducer.js";

/** Structural port over the concrete `src/core/event-store.ts` functions. */
export interface EventStorePort {
  loadRun(runId: string, options?: { baseDir?: string }): Promise<RunState>;
  loadEvents(runId: string, options?: { baseDir?: string }): Promise<RecordedEvent[]>;
  appendEvents(runId: string, events: RunEvent[], options?: { baseDir?: string }): Promise<void>;
  readHead(runId: string, options?: { baseDir?: string }): Promise<{ seq: number; hash: string } | null>;
}
