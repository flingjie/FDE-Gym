import { join } from "node:path";

import {
  appendEvents, loadEvents, loadRun, readHead,
} from "../core/event-store.js";
import type { EventStorePort } from "../ports/event-store.js";
import { SqliteEventStore } from "../storage/sqlite-event-store.js";

/**
 * Resolve the concrete event store for `buildDeps`.
 *
 * When `FDE_GYM_STORE === "sqlite"`, route event append/read through a
 * `SqliteEventStore` at `<baseDir>/store.sqlite`; otherwise (unset) return the
 * file store's functions (`.fde-gym/runs/<runId>/events.jsonl`). This is a
 * storage-adapter selection, not a feature flag: a single env-var check picks
 * the adapter, and the unset default is byte-identical to the file store.
 */
export function resolveEventStore(baseDir: string): EventStorePort {
  if (process.env.FDE_GYM_STORE === "sqlite") {
    return new SqliteEventStore({ dbPath: join(baseDir, "store.sqlite") });
  }
  return { loadRun, loadEvents, appendEvents, readHead };
}
