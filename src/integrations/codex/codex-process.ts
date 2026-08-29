import { spawn } from "node:child_process";

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexInvocationResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
  events: CodexEvent[];
  threadId: string | null;
  agentMessage: string | null;
}

export interface CodexRunOptions {
  args: string[];
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const KEPT_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
  "item.updated",
]);

export function codexInvocationCompleted(result: CodexInvocationResult): boolean {
  return result.spawnError === null && !result.timedOut && result.exitCode === 0;
}

/**
 * Parse stdout as JSONL. Skips non-JSON lines, drops unknown event types, and
 * NEVER stores `reasoning` (chain-of-thought) events.
 */
export function parseJsonlEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : null;
    if (type === null) continue;
    if (type === "reasoning") continue; // chain-of-thought must never be retained
    if (!KEPT_EVENT_TYPES.has(type)) continue;
    // Codex v0.149 also emits CoT nested inside item.completed events as
    // `item.type === "reasoning"`; drop those too so only structured output survives.
    if (type === "item.completed" || type === "item.updated") {
      const item = record.item;
      if (typeof item === "object" && item !== null) {
        const itemType = (item as Record<string, unknown>).type;
        if (itemType === "reasoning") continue;
      }
    }
    events.push(record as unknown as CodexEvent);
  }
  return events;
}

export function extractThreadId(events: CodexEvent[]): string | null {
  for (const event of events) {
    if (event.type === "thread.started") {
      const id = (event as { thread_id?: unknown }).thread_id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  return null;
}

export function extractAgentMessage(events: CodexEvent[]): string | null {
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = (event as { item?: unknown }).item;
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "agent_message" && typeof record.text === "string") {
      return record.text;
    }
  }
  return null;
}

export function runCodex(
  executable: string,
  options: CodexRunOptions,
): Promise<CodexInvocationResult> {
  return new Promise((resolve) => {
    const result: CodexInvocationResult = {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnError: null,
      events: [],
      threadId: null,
      agentMessage: null,
    };

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      result.events = parseJsonlEvents(result.stdout);
      result.threadId = extractThreadId(result.events);
      result.agentMessage = extractAgentMessage(result.events);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      result.spawnError = error instanceof Error ? error.message : String(error);
      finish();
      return;
    }

    timer = setTimeout(() => {
      result.timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish();
    }, options.timeoutMs ?? 90_000);

    child.on("error", (error) => {
      result.spawnError = error.message;
      finish();
    });

    child.stdout?.on("data", (chunk) => {
      result.stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      result.stderr += chunk.toString();
    });

    child.on("close", (code) => {
      result.exitCode = code;
      finish();
    });

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}
