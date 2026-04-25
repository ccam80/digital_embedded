# Phase: Instance vs Model Param Partition — Progress

Standalone phase from `spec/phase-instance-vs-model-param-partition.md`.
Started 2026-04-26.

## Batches
- batch-pivmp-w1 (Wave 1): Tasks 1.1, 1.2 — implemented, awaiting verifier
- batch-pivmp-w2 (Wave 2): Tasks 2.1–2.9 — pending
- batch-pivmp-w3 (Wave 3): Tasks 3.1–3.3 — pending
- batch-pivmp-w4 (Wave 4): Tasks 4.1, 4.2 — pending

## Implementation Log

### Wave 1 — code landed, awaiting verifier (2026-04-26)

- Task 1.1 — `src/core/registry.ts`: `ParamDef.partition?: "instance" | "model"` field added at lines 33–52, exact spec block.
- Task 1.2 — `src/core/model-params.ts`: `defineModelParams` rewritten with the three-bucket `emit` helper. `primary` → `partition: "model"`, `secondary` → `partition: "model"`, `instance` → `rank: "secondary", partition: "instance"`.
- Tests added by the implementers: 3 cases in `src/core/__tests__/registry.test.ts` and 6 cases in `src/core/__tests__/model-params.test.ts` (extended existing files).
- Both implementer agents returned with the work on disk but never ran `complete-implementer.sh`. State file was rewritten by hand (see `recovery_log` for `batch-pivmp-w1`).

