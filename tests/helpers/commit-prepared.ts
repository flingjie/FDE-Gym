import {
  executeCommandTransaction,
  type CommandEffect,
  type JsonValue,
} from "../../src/core/command-transaction";
import type { RunEvent } from "../../src/core/domain";
import type { StoreOptions } from "../../src/core/event-store";

/** Journal + append a pre-built plan (tests only). prepare* stays pure of durable I/O. */
export async function commitPrepared<T extends JsonValue>(options: {
  runId: string;
  commandId: string;
  request: JsonValue;
  events: RunEvent[];
  result: T;
  store?: StoreOptions;
  canaries?: readonly string[];
  effects?: CommandEffect[];
}): Promise<T> {
  const { events, result, effects, runId, commandId, request, store, canaries } = options;
  return executeCommandTransaction({
    runId,
    commandId,
    request,
    store,
    canaries,
    prepare: async () => ({ events, result, effects }),
  });
}
