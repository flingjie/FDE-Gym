# fde-gym — command reference

The `fde-gym` CLI is the learner's entire tool surface. Every command returns a
strict learner-safe envelope as JSON:

- success: `{ ok: true, runId, phase, locale, data }`
- failure: `{ ok: false, code, message, nextActions }`

`message` and `nextActions` are localized (`zh-CN` default; pass `--locale en-US`
to switch). Learner prose and artifacts are always passed as JSON on stdin —
never interpolated into a shell command line. `--json` is the default output;
`--human` selects the human-readable form.

| Command | Flags | stdin | Returns |
|---|---|---|---|
| `list` | `--locale` | — | `data.runs[]` (runId, scenarioId, phase, locale) |
| `start` | `--run-id --scenario --command-id --locale` | — | the public scenario + phase `DISCOVERY` |
| `status` | `--run-id` | — | the run's phase summary + counters |
| `frame` | `--run-id --command-id` | — | phase `PROBLEM_FRAMING` |
| `ask` | `--run-id --command-id` | `{ "question": "...", "stakeholderId": "..." }` | the customer's reply + pending-evidence flag |
| `hint` | `--run-id --command-id --topic [--level 1..3]` | — | the granted hint |
| `clarify` | `--run-id --command-id` | — | phase back to `DISCOVERY` |
| `submit-brief` | `--run-id --command-id` | `{ "brief": { ... } }` | `data.passed`, `data.supportRatio`, `data.feedback` |
| `submit-design` | `--run-id --command-id [--seed n]` | `{ "proposal": { ... } }` | injected challenge ids + interruptions |
| `respond-challenge` | `--run-id --command-id` | `{ "response": { ... } }` | `data.challengesAddressed`, phase |
| `submit-pitch` | `--run-id --command-id` | `{ "pitch": { ... } }` | phase `REVIEW` |
| `review` | `--run-id --command-id` | — | the final review + score breakdown |
| `replay` | `--run-id [--locale]` | — | the learner-safe replay projection |
| `retry` | `--run-id --new-run-id --command-id [--seed n]` | `{ "focusSummaries": ["...", "..."] }` (2–3) | the new child run |
| `profile` | `--locale` | — | the learner's profile |

## Invocation rules for the Skill

- Always send learner-authored text as JSON on stdin (`ask`, `submit-brief`,
  `submit-design`, `respond-challenge`, `submit-pitch`, `retry`).
- Never quote learner text into a shell command line.
- Only ever run one command per learner intent; surface the envelope verbatim.
- On `ok: false`, relay `code`, `message`, and `nextActions` to the learner and
  offer those next actions. Do not retry silently more than once.
- `ask`, `submit-brief`, and `review` call the OpenAI-compatible model endpoint
  (`POST {baseUrl}/chat/completions`). Run them with
  `sandbox_permissions=require_escalated`. Codex's default sandbox sets
  `network_access=false`, so a probe of `127.0.0.1:15721` from inside the
  sandbox returns connection refused even when the local proxy is up. Escalate
  and retry once before treating `AGENT_SPAWN_ERROR` as a down endpoint.
