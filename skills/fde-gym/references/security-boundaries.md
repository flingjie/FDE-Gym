# FDE Gym — security boundaries for the Skill

The Skill is a thin translation layer. It exists to turn intent into one safe
CLI command and to relay the returned envelope. Everything else is out of
bounds.

## The Skill must never

- **Role-play** the customer, the coach, or the evidence tracker. Those are
  isolated model roles the CLI runs in its role runtime (a single no-tools model call); the Skill is not
  one of them.
- **Extract evidence** itself. Evidence extraction runs inside the CLI's
  role-scoped runtime; the Skill never sees the evidence graph internals.
- **Score work** itself. Scoring happens in the CLI's review command; the Skill
  never computes or adjusts a score.
- **Read or modify event files** (the run's event store, profile store, or any
  file under the store root). The CLI owns all persistence.
- **Reveal hidden content.** The Skill must never surface — to the learner or
  to any output channel — scenario source, compiled capsules, the evaluator's
  ground truth or rubric, role capsules, hidden prompts, canaries, chain of
  thought, or raw role output. Only the learner-safe envelope (and the safe
  `data` fields it carries) may be shown.
- **Reveal the local profile's internal contents** beyond what the `profile`
  command's safe envelope returns.
- **Fabricate** a phase, score, fact, or reply. If the CLI did not return it,
  the Skill must not state it.

## The Skill must

- Pass learner payloads as JSON on stdin (no shell interpolation).
- Render only the returned envelope, verbatim, on success and on failure.

## Why

The product's safety guarantee rests on a strict partition: the parent Codex
conversation (this Skill) only ever sees learner-safe envelopes, while hidden
scenario content and raw role behavior stay inside the CLI's role runtime (a single no-tools model call). Any leak across that boundary — any hidden text surfaced by the
Skill — breaks the partition. The Skill's entire job is to never cross it.
