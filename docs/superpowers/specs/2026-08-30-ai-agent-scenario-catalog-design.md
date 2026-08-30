# Design: Replace the training catalog with five AI-agent scenarios

- **Date:** 2026-08-30
- **Status:** Accepted (D1 catalog implemented 2026-08-30)
- **Implementation plan:** [plan](../plans/2026-08-30-ai-agent-scenario-catalog.md)
- **Follows:** scenario authoring contract (`docs/scenario-authoring.md`),
  Socratic hint ladders (ADR-0003)

## Context

FDE Gym trains a learner to discover, frame, design, and pitch a customer
solution. The **current catalog is four YAML sources**:

| id | What the customer is buying | Agent bar (tools + HITL + fail) |
|---|---|---|
| `support-automation` | Support automation / AI replies | Closest — HITL and fabrication exist, but it is still “AI replies”, not a named tool-using agent |
| `manufacturing-alert-triage` | Factory alert efficiency | Classifier / ops AI, not a tool loop |
| `data-migration` | Legacy DB → new platform | ETL / cutover. AI is only a future analytics consumer |
| `export-freight-forwarding` | Documentation + customs AI | Document fill + screening, not an explicit agent/tool protocol |

The product decision: a production scenario is in catalog **only if** the thing
the FDE is selling is an **agent system** — it calls tools, has a human-in-the-loop
red line, and has a signature failure mode. Pure ETL and pure classification
are out.

The learner still does **not** run those tools. Gym remains a discovery/pitch
simulator. Tools, OCR, SQL, Git, and sandboxes exist only as **authored facts**
the Customer can disclose and the Coach can score.

## Goal

Delete the four current production scenarios (source + compiled). Ship **five
new** bilingual scenarios that meet the existing authoring + hint-discipline
contract and the agent bar. Retarget golden replay off `manufacturing-*`
filenames onto one of the new ids.

## Non-goals

- Do **not** add schema fields for tools, MCP, sandboxes, or VLM. Tools stay in
  prose (`public`, `disclosureUnits`, `expectedEvidence`).
- Do **not** change `requestHint`, hint-discipline rules, the phase loop, or
  scoring formulas.
- Do **not** edit `docs/mvp-acceptance.md`.
- Do **not** make Gym execute CRM/SQL/Git/OCR.
- Do **not** keep old scenario ids as aliases.

## Catalog (frozen)

New ids are kebab-case and **must not reuse** the deleted ids.

### 1. `enterprise-knowledge-agent`

- **Opening:** employees should get internal business answers from an agent.
- **Tools (authored):** document index, ACL/permission directory, wiki/ticket
  lookup. Retrieval must respect ACL; citations required.
- **HITL:** content the employee is not entitled to must not be quoted; anything
  that becomes external customer-facing copy needs a human.
- **Signature failure:** fabricated citations; retrieval that ignores ACL.
- **Stakeholders (minimum):** Head of Knowledge / IT, Security / IAM, a
  frontline business user who today lives in tribal Slack.
- **Pedagogy:** RAG evaluation, permissioned retrieval, “the wiki is stale”.

### 2. `customer-support-agent`

- **Opening:** the agent should auto-handle about seventy percent of support
  requests (the “70%” is a **hidden** disclosure-unit quantity, not public copy
  and not a hint token).
- **Tools:** CRM, order lookup, refund/shipping APIs.
- **HITL:** payment, refund, and account-change actions require a human.
- **Signature failure:** policy hallucination; peak tool-timeout floods the
  human queue.
- **Stakeholders:** Support Director, Compliance, a frontline agent who bypasses
  the bot.
- **Pedagogy:** tool-calling CX agent, not a rules engine with a chatbot skin.
  This is the **golden-replay** scenario (densest HITL + tool failure).

### 3. `data-analysis-agent`

- **Opening:** business users want to ask the warehouse in natural language.
- **Tools:** read-only SQL, BI semantic layer, row-level security.
- **HITL / hard stop:** the agent must not write the warehouse; cross-department
  wide tables need approval.
- **Signature failure:** a wrong JOIN or a dropped filter that returns PII.
- **Stakeholders:** Analytics lead, Data-platform / DBA, a business requester
  who will paste results into slides.
- **Pedagogy:** text-to-SQL guardrails, not “we will migrate the database”.

### 4. `document-review-agent`

- **Opening:** automatically review contracts / reports / PDFs.
- **Tools (authored, not executed):** parse/OCR-or-VLM, clause extraction,
  rule checks, master-data match.
- **HITL:** seal / commitment / “this is binding” conclusions need counsel or
  the business owner.
- **Signature failure:** missing a material clause; inventing a term that is
  not in the document.
- **Stakeholders:** Legal / counsel, a business owner who wants speed, an ops
  owner of the document pile.
- **Pedagogy:** document agent + review loop, not “AI will just read the PDF”.

### 5. `software-engineering-agent`

- **Opening:** the agent should fix bugs, run tests, and open PRs.
- **Tools:** Git, isolated sandbox, test runner, PR API. No production secrets,
  no push to the default branch, no privilege escalation.
- **HITL:** merge to protected branches and any production credential use.
- **Signature failure:** tests green on the wrong behavior; secrets in the PR.
- **Stakeholders:** Eng manager, Platform / security, an IC who does not trust
  the agent to touch their repo.
- **Pedagogy:** coding-agent harness and permissions, not “hire two contractors
  to migrate a database”.

## Authoring invariants (each of the five)

Unchanged from `docs/scenario-authoring.md` and ADR-0003:

- Fully bilingual `zh-CN` / `en-US`.
- `questionBudget: 12`.
- Eight hint topics: `workflow`, `pain`, `root-cause`, `business-impact`,
  `constraints`, `success-measures`, `trust`, `failure-modes` — Socratic L1/L2/L3,
  no answer banners, no hidden numeric tokens.
- ≥ 3 stakeholders with concerns and blind spots.
- ≥ 2 `criticalContradictions`.
- ≥ 3 deterministic `events`.
- 5-stage `scenarioDeliverableRubric` + ≥ 1 pass gate.
- Public partition must not contain disclosure-unit ids, canaries, or hint
  answers.
- Expected evidence covers all eight discovery categories.

**Agent-specific prose (no schema change):** each scenario’s public
`visibleConstraints` and hidden `constraints` / `failure-modes` units must name
(1) at least two **tool classes**, (2) the HITL red line, (3) one unauthorized
or failing tool path. Hints still must not state those facts.

## Delete

Remove source **and** compiled trees (do not leave empty dirs):

- `scenarios/source/{support-automation,manufacturing-alert-triage,data-migration,export-freight-forwarding}.yaml`
- `scenarios/compiled/{those four ids}/`

Old runs against deleted bundle digests already fail `SCENARIO_BUNDLE_MISMATCH`;
no migration.

## Tests and docs to retarget

| Surface | Action |
|---|---|
| `scripts/compile-scenarios.mjs` | The five new ids; same seed `test-seed-2026-08-23` |
| `tests/contracts/hint-discipline.test.ts` | Production-source list = the five ids |
| `tests/e2e/all-scenarios.test.ts` | `SCENARIOS` = all five; rewrite `ASK_PLANS` / briefs / proposals per id |
| `tests/contracts/scenario-calibration.test.ts` | Same five ids; refresh leaked-public snapshots and score floors |
| `tests/contracts/scenario-compiler.test.ts` | Compile `customer-support-agent.yaml` (or whichever is authored first) instead of `manufacturing-alert-triage.yaml` |
| `tests/golden/` | **Regenerate.** Delete `manufacturing-events.jsonl` and `manufacturing-replay.{zh-CN,en-US}.json`. New files: `customer-support-events.jsonl` and `customer-support-replay.{zh-CN,en-US}.json`. Event `scenarioId` / stakeholder ids / `du-*` / evidence node ids must match the new YAML. Projector byte-stability contract unchanged. |
| `tests/fixtures/adversarial-prompts.yaml` | Path example must not name a deleted compiled tree |
| `docs/scenario-authoring.md` | Example id → `customer-support-agent` |
| Loader / version-compatibility comments | Drop `manufacturing-alert-triage` as the running example |

`tests/contracts/domain-schema.test.ts` may keep a **fake** authoring `id`
(`manufacturing-alert-triage` or `scn-test`); it does not load production YAML.

`tests/e2e/cli-flow.test.ts` stays on its inline `scn-1` fixture.

## Implementation order (for the later plan)

1. Author all five source YAML so `collectHintDisciplineIssues` is empty and
   `ScenarioAuthoringSchema.parse` succeeds.
2. Point `compile-scenarios.mjs` at the five ids; compile committed bundles.
3. Retarget compiler / discipline / calibration / all-scenarios tests; delete
   old source+compiled.
4. Drive a fixture loop for `customer-support-agent` and freeze the new golden
   snapshots; delete manufacturing golden files.
5. Docs example ids only. No `mvp-acceptance.md`.

## ADR

When implementing, append **ADR-0004** to `docs/architecture-decisions.md`:
the production catalog is five tool-using, HITL, fail-closed agent scenarios;
non-agent ops/ETL scenarios are out of catalog; Gym still does not execute
those tools.
