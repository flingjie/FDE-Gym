# FDE Gym — learner flow

The learner moves through a fixed, gated pipeline. The Skill maps each step to
one CLI command; the CLI enforces the phase order and returns a failure envelope
with `nextActions` if a step is attempted out of order.

## Scenario → Review

1. **Scenario** — `start` reveals the public scenario (opening request, visible
   context and constraints, deliverables, learner rules, question budget).
   Phase becomes `DISCOVERY`.
2. **Discovery** — `ask` questions to the customer; `hint` for a laddered hint;
   `status` to see how much has been disclosed. When the learner is ready,
   `frame` moves to `PROBLEM_FRAMING`.
3. **Problem framing** — `submit-brief` submits a problem brief. If it does not
   pass, `clarify` returns to `DISCOVERY` for more questioning, then `frame`
   and `submit-brief` again.
4. **Solution design** — `submit-design` submits a solution proposal; the
   scenario injects challenges as interruptions.
5. **Challenge** — `respond-challenge` answers each injected challenge.
6. **Pitch** — `submit-pitch` submits the executive pitch. Phase becomes
   `REVIEW`.
7. **Review** — `review` runs the final review and returns the score breakdown.
   `replay` projects the learner-safe replay showing where reasoning improved
   or drifted.

## Retry

After a completed review, `retry` starts a clean child run linked to the parent.
It requires 2–3 focus summaries (from the review's `nextFocus`, or supplied by
the learner) and starts the child back in `DISCOVERY` with no prior transcript,
graph, or disclosure ledger.

## Locale

Runs start in `zh-CN` by default. Pass `--locale en-US` (or start the run with
`--locale en-US`) to switch all learner-safe output to English.
