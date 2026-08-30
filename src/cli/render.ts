import type { Locale, RunPhase } from "../core/domain.js";

/**
 * FDE Gym — CLI rendering and error localization (Task 11).
 *
 * The strict learner-safe envelope is the contract for every successful
 * command; failures return a stable `code`, a LOCALIZED `message`, and
 * recoverable `nextActions`. Raw agent/model output is never serialized here —
 * `code`/`message`/`nextActions` are the only fields a failure ever carries.
 */

// ---------------------------------------------------------------------------
// Envelope contract
// ---------------------------------------------------------------------------

export interface CliEnvelope<T> {
  ok: true;
  runId: string;
  phase: RunPhase;
  locale: Locale;
  data: T;
}

export interface CliFailure {
  ok: false;
  /** Stable machine-readable error code. */
  code: string;
  /** Localized human-readable message. */
  message: string;
  /** Localized recoverable next actions. */
  nextActions: string[];
}

export type CliResult<T> = CliEnvelope<T> | CliFailure;

// ---------------------------------------------------------------------------
// Localization table
// ---------------------------------------------------------------------------

interface LocalizedError {
  code: string;
  "zh-CN": { message: string; nextActions: string[] };
  "en-US": { message: string; nextActions: string[] };
}

const ERROR_TABLE: LocalizedError[] = [
  {
    code: "UNKNOWN_COMMAND",
    "zh-CN": {
      message: "未知命令。",
      nextActions: ["运行 `fde-gym --help` 查看可用命令。", "检查命令名拼写。"],
    },
    "en-US": {
      message: "Unknown command.",
      nextActions: ["Run `fde-gym --help` to see available commands.", "Check the command name."],
    },
  },
  {
    code: "MISSING_ARGUMENT",
    "zh-CN": {
      message: "缺少必需参数。",
      nextActions: ["补全该命令所需的全部参数后重试。", "使用 `fde-gym <command> --help` 查看参数。"],
    },
    "en-US": {
      message: "A required argument is missing.",
      nextActions: ["Provide all required arguments and retry.", "Use `fde-gym <command> --help`."],
    },
  },
  {
    code: "INVALID_LOCALE",
    "zh-CN": {
      message: "无效的语言代码。",
      nextActions: ["使用 `zh-CN` 或 `en-US`。"],
    },
    "en-US": {
      message: "Invalid locale.",
      nextActions: ["Use `zh-CN` or `en-US`."],
    },
  },
  {
    code: "INVALID_JSON_STDIN",
    "zh-CN": {
      message: "标准输入中的 JSON 无效。",
      nextActions: ["通过标准输入发送合法 JSON，或使用 `--json` 参数。"],
    },
    "en-US": {
      message: "The JSON on stdin is invalid.",
      nextActions: ["Send valid JSON on stdin, or use the `--json` flag."],
    },
  },
  {
    code: "INVALID_ARTIFACT",
    "zh-CN": {
      message: "提交的产物未通过结构校验。",
      nextActions: ["检查产物的必填字段和证据引用。", "参考问题定义/方案/挑战响应/方案表达的结构要求。"],
    },
    "en-US": {
      message: "The submitted artifact failed structural validation.",
      nextActions: ["Check the artifact's required fields and evidence references."],
    },
  },
  {
    code: "RUN_NOT_FOUND",
    "zh-CN": {
      message: "找不到该运行。",
      nextActions: ["使用 `list` 查看现有运行。", "使用 `start` 创建新运行。"],
    },
    "en-US": {
      message: "Run not found.",
      nextActions: ["Use `list` to see existing runs.", "Use `start` to create a new run."],
    },
  },
  {
    code: "RUN_ALREADY_EXISTS",
    "zh-CN": {
      message: "该运行已开始。",
      nextActions: ["使用 `status` 查看运行状态。", "选择一个新运行 ID。"],
    },
    "en-US": {
      message: "This run has already started.",
      nextActions: ["Use `status` to inspect the run.", "Choose a new run id."],
    },
  },
  {
    code: "EVENT_CHAIN_INVALID",
    "zh-CN": {
      message: "运行事件链校验失败（可能被篡改或损坏）。",
      nextActions: ["删除损坏的运行并重新开始。"],
    },
    "en-US": {
      message: "The run's event chain failed verification (tampered or corrupted).",
      nextActions: ["Delete the corrupted run and start over."],
    },
  },
  {
    code: "UNSUPPORTED_SCHEMA_VERSION",
    "zh-CN": {
      message: "该资源携带了不受支持的 schemaVersion（仅支持 v1），无法迁移。",
      nextActions: ["使用当前 v1 构建重新编译场景。", "删除旧的 profile 或 run 并重建。"],
    },
    "en-US": {
      message: "This resource carries an unsupported schemaVersion (only v1 is supported) and cannot be migrated.",
      nextActions: ["Recompile the scenario with a current v1 build.", "Delete the old profile or run and recreate it."],
    },
  },
  {
    code: "INVALID_PHASE_COMMAND",
    "zh-CN": {
      message: "该命令在当前阶段不可用。",
      nextActions: ["使用 `status` 查看当前阶段。", "按阶段顺序推进运行。"],
    },
    "en-US": {
      message: "This command is not valid in the current phase.",
      nextActions: ["Use `status` to see the current phase.", "Advance the run in phase order."],
    },
  },
  {
    code: "FRAME_BLOCKED",
    "zh-CN": {
      message: "存在未完成的证据提取，暂时无法进入问题定义阶段。",
      nextActions: ["继续提问或重试以完成证据提取。"],
    },
    "en-US": {
      message: "Evidence extraction is pending; framing is blocked.",
      nextActions: ["Ask further questions or retry to complete evidence extraction."],
    },
  },
  {
    code: "EVIDENCE_EXTRACTION_FAILED",
    "zh-CN": {
      message: "证据提取失败，但客户回复已保留。",
      nextActions: ["再次提问以重新触发证据提取。"],
    },
    "en-US": {
      message: "Evidence extraction failed, but the customer reply was kept.",
      nextActions: ["Ask again to re-trigger evidence extraction."],
    },
  },
  {
    code: "CLARIFICATION_BUDGET_EXCEEDED",
    "zh-CN": {
      message: "澄清预算已用尽。",
      nextActions: ["基于现有信息提交问题定义。"],
    },
    "en-US": {
      message: "The clarification budget is exhausted.",
      nextActions: ["Submit the problem brief with the information you have."],
    },
  },
  {
    code: "NOTHING_TO_REPAIR",
    "zh-CN": {
      message: "当前没有待修复的证据提取。",
      nextActions: ["检查运行状态后重试，或继续提问。"],
    },
    "en-US": {
      message: "There is no pending evidence extraction to repair.",
      nextActions: ["Check the run status and retry, or ask a question."],
    },
  },
  {
    code: "INVALID_RETRY_FOCUS",
    "zh-CN": {
      message: "重试需要 2 或 3 条重点总结。",
      nextActions: ["提供 2 到 3 条重点总结后重试。"],
    },
    "en-US": {
      message: "A retry requires 2 or 3 focus summaries.",
      nextActions: ["Provide 2 to 3 focus summaries and retry."],
    },
  },
  {
    code: "HINT_UNKNOWN_TOPIC",
    "zh-CN": {
      message: "该主题没有提示阶梯。",
      nextActions: ["换一个主题，或使用 `status` 查看可用线索。"],
    },
    "en-US": {
      message: "No hint ladder exists for that topic.",
      nextActions: ["Choose another topic."],
    },
  },
  {
    code: "HINT_NO_DOWNGRADE",
    "zh-CN": {
      message: "不能重复或降低已授予的提示级别。",
      nextActions: ["请求更高的提示级别，或继续自主探索。"],
    },
    "en-US": {
      message: "Cannot repeat or downgrade an already-granted hint level.",
      nextActions: ["Request a higher level, or continue exploring."],
    },
  },
  {
    code: "HINT_EXHAUSTED",
    "zh-CN": {
      message: "该主题的提示阶梯已用尽。",
      nextActions: ["换一个主题，或继续自主探索。"],
    },
    "en-US": {
      message: "The hint ladder for this topic is exhausted.",
      nextActions: ["Choose another topic, or continue exploring."],
    },
  },
  {
    code: "SCENARIO_NOT_FOUND",
    "zh-CN": {
      message: "找不到该场景。",
      nextActions: ["使用已编译的场景 ID。"],
    },
    "en-US": {
      message: "Scenario not found.",
      nextActions: ["Use a compiled scenario id."],
    },
  },
  {
    code: "LEAK_GUARD_TRIGGERED",
    "zh-CN": {
      message: "角色输出未通过防泄露检查。",
      nextActions: ["重试该命令。"],
    },
    "en-US": {
      message: "A role output failed the leak guard.",
      nextActions: ["Retry the command."],
    },
  },
  {
    code: "JOURNAL_CANARY_LEAK",
    "zh-CN": {
      message: "命令日志包含泄露值，已拒绝写入。",
      nextActions: ["重试该命令。"],
    },
    "en-US": {
      message: "The command journal contained a canary value and was rejected.",
      nextActions: ["Retry the command."],
    },
  },
  {
    code: "AGENT_TIMEOUT",
    "zh-CN": {
      message: "角色调用超时。",
      nextActions: ["重试该命令。"],
    },
    "en-US": {
      message: "A role invocation timed out.",
      nextActions: ["Retry the command."],
    },
  },
  {
    code: "AGENT_SPAWN_ERROR",
    "zh-CN": {
      message: "无法启动角色运行时。",
      nextActions: ["检查模型端点配置后重试。"],
    },
    "en-US": {
      message: "Could not start the role runtime.",
      nextActions: ["Check the model endpoint configuration and retry."],
    },
  },
  {
    code: "AGENT_OUTPUT_INVALID",
    "zh-CN": {
      message: "角色输出未通过结构校验。",
      nextActions: ["重试该命令。"],
    },
    "en-US": {
      message: "A role output failed schema validation.",
      nextActions: ["Retry the command."],
    },
  },
  {
    code: "AGENT_OUTPUT_MALFORMED",
    "zh-CN": {
      message: "角色输出格式损坏。",
      nextActions: ["重试该命令。"],
    },
    "en-US": {
      message: "A role output was malformed.",
      nextActions: ["Retry the command."],
    },
  },
  {
    code: "AGENT_INPUT_INVALID",
    "zh-CN": {
      message: "角色输入无效。",
      nextActions: ["检查命令参数后重试。"],
    },
    "en-US": {
      message: "A role input was invalid.",
      nextActions: ["Check the command arguments and retry."],
    },
  },
  {
    code: "COACH_OUTPUT_REJECTED",
    "zh-CN": {
      message: "教练输出被拒绝。",
      nextActions: ["重试该命令。"],
    },
    "en-US": {
      message: "The Coach output was rejected.",
      nextActions: ["Retry the command."],
    },
  },
  {
    code: "CUSTOMER_OUTPUT_REJECTED",
    "zh-CN": {
      message: "客户输出被拒绝。",
      nextActions: ["重试该命令。"],
    },
    "en-US": {
      message: "The Customer output was rejected.",
      nextActions: ["Retry the command."],
    },
  },
  {
    code: "SKILL_EXISTS_UNRELATED",
    "zh-CN": {
      message: "目标位置已存在一个非 FDE Gym 的 Skill，已拒绝覆盖。",
      nextActions: ["移除或改名该 Skill 后重试。", "确认目标 `.codex/skills/fde-gym` 目录是否正确。"],
    },
    "en-US": {
      message: "A non-FDE-Gym Skill already exists at the target; refusing to overwrite.",
      nextActions: ["Remove or rename the existing Skill and retry.", "Confirm the target `.codex/skills/fde-gym` directory is correct."],
    },
  },
  {
    code: "SKILL_SOURCE_MISSING",
    "zh-CN": {
      message: "找不到要安装的 Skill 源文件。",
      nextActions: ["先构建 CLI（npm run build）后重试。", "确认从已安装的 FDE Gym 包目录运行。"],
    },
    "en-US": {
      message: "The Skill source files were not found.",
      nextActions: ["Build the CLI (npm run build) and retry.", "Run from the installed FDE Gym package."],
    },
  },
  {
    code: "EVIDENCE_OUTPUT_REJECTED",
    "zh-CN": {
      message: "证据追踪器输出被拒绝。",
      nextActions: ["重试该命令。"],
    },
    "en-US": {
      message: "The Evidence Tracker output was rejected.",
      nextActions: ["Retry the command."],
    },
  },
  {
    code: "MODEL_ENDPOINT_REQUIRED",
    "zh-CN": {
      message: "未配置模型端点。",
      nextActions: [
        "设置 FDE_GYM_MODEL_BASE_URL 与 FDE_GYM_MODEL（或在 ~/.codex/config.toml 中配置 model + base_url）。",
      ],
    },
    "en-US": {
      message: "No model endpoint is configured.",
      nextActions: [
        "Set FDE_GYM_MODEL_BASE_URL and FDE_GYM_MODEL (or configure model + base_url in ~/.codex/config.toml).",
      ],
    },
  },
];

const FALLBACK: Omit<LocalizedError, "code"> = {
  "zh-CN": {
    message: "命令执行失败。",
    nextActions: ["检查输入后重试。", "使用 `fde-gym --help` 查看用法。"],
  },
  "en-US": {
    message: "The command failed.",
    nextActions: ["Check the input and retry.", "Use `fde-gym --help` for usage."],
  },
};

/** Localize a stable error code into a learner-safe message + next actions. */
export function localize(code: string, locale: Locale): { message: string; nextActions: string[] } {
  const entry = ERROR_TABLE.find((row) => row.code === code);
  const localized = entry ? entry[locale] : FALLBACK[locale];
  return { message: localized.message, nextActions: localized.nextActions };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a success envelope or failure to a stable JSON string. */
export function renderJson(result: CliResult<unknown>): string {
  return JSON.stringify(result, null, 2);
}

/** Render a success envelope as human-readable text (locale-aware). */
export function renderHuman<T>(result: CliEnvelope<T>): string {
  const data = JSON.stringify(result.data, null, 2);
  return [
    `ok:      true`,
    `runId:   ${result.runId || "(global)"}`,
    `phase:   ${result.phase}`,
    `locale:  ${result.locale}`,
    `data:`,
    indent(data),
  ].join("\n");
}

/** Render a failure as human-readable text. */
export function renderHumanFailure(failure: CliFailure): string {
  const lines = [`ok:          false`, `code:        ${failure.code}`, `message:     ${failure.message}`];
  if (failure.nextActions.length > 0) {
    lines.push("next actions:");
    for (const action of failure.nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
