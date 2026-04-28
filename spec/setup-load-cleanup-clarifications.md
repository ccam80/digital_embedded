# Setup-Load Cleanup — Clarifications Sink

Spec: `spec/setup-load-cleanup.md`
State: `spec/.hybrid-state.json`
Coordinator playbook: `spec/setup-load-cleanup-batches.md` (steps 3 + 8 reference this file)

This file is the dedicated sink for genuine spec ambiguities surfaced during the
wave. It is the **only** place a coordinator records `CLARIFICATION NEEDED`
entries from implementer `stop-for-clarification.sh` exits — `spec/progress.md`
also receives the original entry, but that file is also being written to by
implementers' per-file §C.4 reports and gets noisy fast. This file is curated.

## Format

For each clarification, append a section with this exact shape:

```markdown
## <task_group_id>

- **Affected files:** <list>
- **Spec sections in question:** <e.g. §A.7 internal-node labels, §A.15 composite mandate>
- **Implementer's question (verbatim from `spec/progress.md`):**
  > <quoted text>
- **Coordinator note (optional):** <e.g. "5 dependent groups parked behind this">
- **Status:** open | resolved
- **Resolution (if resolved):** <user-supplied wording>
- **Date filed:** YYYY-MM-DD
- **Date resolved:** YYYY-MM-DD or empty
```

The task_group_id already encodes priority via its prefix (`1.A.*`, `2.B.*`,
`3.C.*`, `4.D.*`), so no separate sub-wave heading is needed.

## Coordinator workflow

1. **On each implementer return** with `stop-for-clarification.sh` exit: scan
   `spec/progress.md` for the matching `CLARIFICATION NEEDED` entry, copy the
   verbatim text into a new section here under the `## <task_group_id>` heading,
   set status `open`. **Do NOT claim the `stops_for_clarification` retry slot
   during the wave** — clarifications need user input to resolve.
2. **Continue dispatching the next implementer / verifier** per the continuous
   job-pool algorithm in `setup-load-cleanup-batches.md`. The parked group does
   NOT block any other group; the wave runs to completion around it.
3. **At end-of-wave** (or whenever the user halts the run to handle pending
   clarifications), surface every `open` entry to the user along with the
   failed-group list (per the end-of-wave summary in
   `setup-load-cleanup-batches.md`).
4. **On user "go for clarification re-do"** for a given entry:
   - Edit `spec/setup-load-cleanup.md` with the user's clarified wording.
   - Update the corresponding entry here: status → `resolved`, fill in
     resolution + date.
   - Spawn a fresh implementer for the affected task_group; the
     `stops_for_clarification` retry slot is still open, so the gate accepts.
   - The new implementer feeds back into the standard continuous-flow scheduler
     (its return triggers a verifier eligibility check in the normal way).

---

## Open clarifications

(none yet — populated as the wave runs)

---

## Resolved clarifications

(none yet)
