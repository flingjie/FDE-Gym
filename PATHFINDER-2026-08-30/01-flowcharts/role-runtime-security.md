# Flow: role-runtime-security

## Cross-cutting

- **Production hints**: pure `simulation/hints.ts` only — NOT `coach.requestHint`
- **RunAggregate**: defined `context-firewall.ts:87`; folded `projector.ts:182`; live-mutated in orchestrator

## Happy path (discovery ask)

```mermaid
flowchart TD
  Entry["resolveDefaultRuntime<br/>cli/main.ts:77"] --> ResolveCfg["resolveDirectModelConfig<br/>integrations/direct/config.ts:29"]
  ResolveCfg -->|baseUrl+model| DirectRT["DirectModelRuntime<br/>direct-runtime.ts:89"]
  ResolveCfg -->|null| Uncfg["UnconfiguredModelRuntime<br/>unconfigured-runtime.ts"]
  DirectRT --> AskPrep["prepareDiscoveryTurn<br/>orchestrator.ts:200"]
  AskPrep --> AnsCust["answerDiscoveryQuestion<br/>customer.ts:94"]
  AnsCust --> FWCust["buildRoleInput customer<br/>context-firewall.ts:247"]
  FWCust --> InvC["runtime.invoke<br/>direct-runtime.ts:104"]
  InvC --> Fetch["fetch chat/completions<br/>direct-runtime.ts:126"]
  Fetch --> SanRT["sanitizeAgentResult<br/>sanitizer.ts:74"]
  SanRT --> SanWrap["sanitize again + validate<br/>customer.ts:119"]
  SanWrap --> ExtEv["extractEvidence<br/>evidence-tracker.ts:91"]
  ExtEv --> FWEv["buildRoleInput evidence_tracker<br/>context-firewall.ts:273"]
  FWEv --> InvE["invoke + sanitize + validate"]
  InvE --> Events["acceptedEvents batch<br/>orchestrator.ts:299"]

  CoachBV["validateProblemBrief<br/>coach.ts:170"] --> FWCoach["buildRoleInput coach<br/>context-firewall.ts:295"]
  CoachFR["runFinalReview<br/>coach.ts:213"] --> FWCoach
  CoachHintDead["requestHint coach LLM<br/>coach.ts:140"] -.->|tests only| DeadEnd["no production caller"]
  SimHint["requestHint ladder<br/>simulation/hints.ts:72"] --> HintCLI["hintCommand<br/>cli/commands.ts:477"]
```

## Side effects
- HTTP POST model endpoint
- Read prompt templates (cached)
- Role wrappers themselves do no durable I/O

## External deps
- zod, fetch, env `FDE_GYM_MODEL_*`, optional ~/.codex/config.toml for endpoint discovery

## Confidence: high
