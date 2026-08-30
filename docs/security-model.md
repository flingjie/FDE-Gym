# Security Model

FDE Gym's safety guarantee is a **partition**: the learner (and the learner's
Codex conversation, via the repo-local Skill in `.codex/skills/fde-gym/`) only
ever sees learner-safe envelopes, while hidden scenario content and raw role
behavior stay inside the CLI's role runtime (a single no-tools model call). This document states
the threat model, the exact mechanisms, and — just as important — the boundary
the product does **not** claim to cross.

## Threat model

The attacker we defend against is the **model pipeline itself** and an
**accidental leak**: a role echoing ground truth, the learner's prompt
injecting the Customer, a canary surfacing in stdout, or hidden text reaching a
public channel. We do **not** model a learner who can read their own filesystem
or attach a debugger to their own machine — see the local-MVP boundary below.

## Role allowlists (exact per-role exclusions)

`src/security/context-firewall.ts` builds every role input **field-by-field
from an explicit allowlist** — it never spreads the aggregate or a capsule. The
exact exclusions:

| Role | Allowed input | Structurally excluded |
|---|---|---|
| `customer` | `locale`, `question`, `stakeholderId`, `stakeholders`, `disclosureUnits`, `disclosedDisclosureUnitIds`, `responsePolicies` | The **evaluator capsule** (rubric, expected evidence, hint ladders, pass gates, critical contradictions), the evaluator canary, the learner's score/profile, the evidence graph, hints, and the learner's brief/proposal/pitch. |
| `evidence_tracker` | `locale`, the latest public transcript `turn`, the public `graph` | **Any** capsule — passing one throws `FIREWALL_CAPSULE_FORBIDDEN`. It therefore cannot see ground truth, expected evidence, disclosure units, rubrics, hint ladders, or canaries. |
| `coach_evaluator` | `locale` + the public brief/proposal/pitch/challenge-responses/graph/transcript/hint-ledger, plus the **evaluator capsule** (task-scoped: hint → `hintLadders`; brief-validation → brief+graph+transcript; final-review → brief+proposal+pitch+responses+graph+transcript+hint-ledger + the **`capabilityScoringRubric`** from `src/scoring/rubric.ts`) | The **customer capsule** (hidden facts, stakeholders, disclosure units, response policies), the customer canary, the **hidden `scenarioDeliverableRubric`** (`evaluator.rubric`), and the learner's score/profile/ground truth. |

The **`capabilityScoringRubric`** the Coach receives in `final-review` is the
public, learner-safe scoring-dimension table (`src/scoring/rubric.ts`) — never
the scenario's hidden **`scenarioDeliverableRubric`** (`evaluator.rubric`,
ground-truth deliverable criteria).
It exists only so the Coach can assign per-criterion 0–100 scores; the numeric
weights stay in the deterministic `computeStageScore` and never depend on the
Coach's model.

Fail-closed properties:

- Role input schemas are `.strict()` — extra keys are rejected.
- An unrecognized aggregate field throws `FIREWALL_UNRECOGNIZED_FIELD`
  (never silently dropped).
- Handing a role the wrong capsule throws `FIREWALL_CAPSULE_FORBIDDEN`
  (customer↔evaluator capsules are discriminated structurally).

## Context firewall

The firewall (`buildRoleInput`) is the single construction point for role
inputs. `src/integrations/direct/direct-runtime.ts` re-validates the input
against `roleInputSchema(role)` **before** calling the model, so a caller that
hands a role a foreign input fails closed with no model invocation.

## Output sanitizer + leak guard

`src/security/sanitizer.ts` is the last line of defense on raw model output,
in order:

1. **Strip prohibited keys** recursively (`analysis`, `reasoning`,
   `chainOfThought`, `systemPrompt`, `rawPrompt`) and record their JSON paths.
2. **Leak-guard scan** the values for any hidden canary; a match returns
   `LEAK_GUARD_TRIGGERED` (with paths, never the matched text).
3. **Strict schema validation** of the remainder against the role's output
   schema.

Raw model output, chain-of-thought, and prompt text are never retained — only
the validated `output` and its `invocationId` survive.

## Public projection fail-safe

`src/security/public-projection.ts` maps internal `RunEvent`s to a
learner-safe `PublicEvent` **field-by-field** (never spreading the event). Any
event type not explicitly mapped returns `null` — the fail-safe default for
future internal events — so hidden fields are structurally incapable of
surfacing. `projectReplay` reuses the same discipline for the learner replay.

## Canary isolation

The compiler injects a deterministic, content-independent canary (SHA-256 of a
seed + role tag) into each hidden capsule. Roles run through `DirectModelRuntime`
— a single structured chat-completions call with **no tools, no MCP, and no
session** — so there is no filesystem/shell surface for a canary to leak through.
Raw model output is scanned for canaries and sanitized before it is validated
against the role's strict output schema; chain-of-thought, prompt text, and raw
output are never retained.

## Skill boundary (repo-local)

The learner-facing Skill installs **repo-locally** to
`<repo>/.codex/skills/fde-gym/` (never `~/.codex`) and is a thin translator: it
maps intent to exactly one safe CLI command and renders only the returned
envelope. It never role-plays, extracts evidence, scores, or reads/writes state
files (see `skills/fde-gym/references/security-boundaries.md`).

## Local-MVP boundary (not certification-grade anti-cheating)

This is a **local training product**, not a remote proctored exam:

- All scenario partitions, run events, and the learner profile live in
  **plain files** on the learner's own machine (`$FDE_GYM_HOME` / `<repo>/.fde-gym`,
  `scenarios/compiled/`, `scenarios/source/`).
- A learner who can read their own disk — or attach a debugger, or set
  `FDE_GYM_HOME` to a directory they control — can see every hidden fact,
  canary, and evaluator criterion.
- The role runtime is a single no-tools model call, so the **model** has no filesystem surface — but it cannot prevent the **human operator** from reading files.

Therefore: local hidden files are **NOT certification-grade anti-cheating**.
The isolation is real and makes accidental leakage hard, but it is a
filesystem-side boundary, not a trust boundary against the operator. A remote
capsule/evaluation service would be required before any high-trust or
certification use case.
