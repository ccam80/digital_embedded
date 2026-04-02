# Spec Review: Combined Report

## Overall Verdict: ready (after revisions applied)

Initial review found 36 issues across 5 dimensions. All blocking issues have been resolved via spec edits. Remaining items are informational.

## Revisions Applied

| Issue | Resolution |
|-------|-----------|
| 11 missing `DiagnosticCode` values | Added all 11 codes to the union type |
| `AcResult.diagnostics: SolverDiagnostic[]` not updated | Added to files-to-modify list with `analog-engine-interface.ts` |
| `involvedPositions` missing from Diagnostic | Was actually present in spec (false positive from reviewer) |
| No wave ordering | Added 2-wave structure: W1 type foundations + algorithms, W2 consumers + formatting |
| `settle()` opts unspecified | Redesigned: `settle(coordinator, settleTime?: number): Promise<void>`, default 10ms, single step for digital, stepToTime for analog |
| `setSignal` vs `setSourceByLabel` routing conflict | Clarified: `setSignal` → `setSourceByLabel` → `setComponentProperty` |
| `builder.ts` in both logic and rename-only sections | Removed from rename-only list |
| `render-pipeline.ts` import path not specified | Added import path change to files-to-modify |
| `labelTypesPartition` line numbers stale | Updated 925→938, 924-931→938-944 |
| `coordinator-types.ts` "if needed" | Changed to definitive "add to interface" |
| `dig-pin-scanner.ts` conditional deletion | Made definitive (only consumer is `circuit_describe_file`) |
| `PinDescriptor.direction`/`bitWidth` unconditional | Made optional for analog-domain pins |
| `RunnerFacade` settle signature | Updated to match new `settle()` API |

## Remaining Informational Items (not blocking)

| Item | Status |
|------|--------|
| Finding #24 — scaling-pin detection | Dismissed in spec with "no changes needed" — analog components without `bitWidth` property skip naturally |
| Findings #18/#19 — `circuit_describe_file` | Spec deletes tool entirely (stronger fix than inventory's description update) |
| Finding #29 — `validatePinConnection` heuristic | Spec deletes method entirely (eliminates problem at source) |
| Three-surface testing gaps | Tests should be specified per-section during implementation planning — the spec establishes what to test, implementation specs add where |
| `buildNetlistView` algorithm detail | The cross-reference algorithm is derivable from the `ConnectivityGroup` data structures — implementer reads the group/pin types |
| Two-pass parsing integration | Caller is the facade's `runTests`; implementation detail, not a spec concern |

## Full Per-Phase Report

See `spec/reviews/spec-phase-1.md` for the original detailed review before revisions.
