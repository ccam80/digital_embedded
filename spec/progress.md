# Implementation Progress

## Phase 1: Infrastructure — COMPLETE
| Task | Status | Notes |
|------|--------|-------|
| W1T1 | complete | StatePool class + 27 unit tests |
| W1T2 | complete | Interface additions (stateSize, stateBaseOffset, initState, StatePoolRef) |
| W1T3 | complete | Compiler allocation loop + statePool on CompiledAnalogCircuit |
| W1T4 | complete | Covered by W1T1 (created test file with 27 tests) |

## Phase 2: Diode prototype — COMPLETE
| Task | Status | Notes |
|------|--------|-------|
| W2T1 | complete | Diode migrated, write-back removed, 14 verification tests |
| W2T2 | complete | Delivered as part of W2T1 |

## Phase 3: Remaining PN-junction devices — COMPLETE
| Task | Status | Notes |
|------|--------|-------|
| W3T1 | complete | Zener — stateSize:4, write-back removed |
| W3T2 | complete | LED — stateSize:4, write-back removed |
| W3T3 | complete | Tunnel Diode — stateSize:4, write-back removed |
| W3T4 | complete | Varactor — stateSize:7 (always has capacitance), write-back removed |
| W3T5 | complete | BJT simple — stateSize:10, write-back removed |
| W3T6 | complete | BJT SPICE L1 — stateSize:12, write-back removed |
| W3T7 | complete | SCR — stateSize:9, write-back removed |
| W3T8 | complete | Triac — stateSize:9, write-back removed |
| W3T9 | complete | Test helper diode — stateSize:4, write-back removed |

## Phase 4: MOSFET/JFET — COMPLETE
| Task | Status | Notes |
|------|--------|-------|
| W4T1 | complete | AbstractFetElement — getter/setter pairs, stateSize:12 |
| W4T2 | complete | Verified via FET test suite |

## Phase 5: Reactive passives — COMPLETE
| Task | Status | Notes |
|------|--------|-------|
| W5T1 | complete | Capacitor — stateSize:3, pool slots for geq/ieq/vPrev |
| W5T2 | complete | Inductor — stateSize:3, pool slots for geq/ieq/iPrev |

## Phase 6: Engine integration — COMPLETE
| Task | Status | Notes |
|------|--------|-------|
| G1 | complete | Added statePool to CompiledAnalogCircuit interface + MNAEngine local interface |
| W6T1 | complete | checkpoint/rollback/acceptTimestep wired into step(), reset(), dcOperatingPoint() |
| W6T2 | complete | Convergence regression integration tests (6 tests covering diode, RC, state0/state1, reset, 100-step stability) |
| W6T3 | complete | updateOperatingPoint voltages param narrowed to Readonly<Float64Array> across all interfaces and devices |

## Wave 6.1 Review Follow-ups
| Finding | Status | Notes |
|---------|--------|-------|
| V2 (major) + G3 | fixed | LTE retry NR failure now emits diagnostic and transitions to ERROR state |
| G1 (review gap) | fixed | analog-engine-interface.test.ts literal now includes statePool field |
| V1 (critical) | addressed by user | init() slot allocation shim kept with improved justification per performance fix |

---
## Wave 1.1 Summary
- **Status**: complete
- **Tasks completed**: 4/4
- **Rounds**: 1

---
## Wave 2.1 Summary
- **Status**: complete
- **Tasks completed**: 2/2
- **Rounds**: 1

---
## Wave 3.1 Summary
- **Status**: complete
- **Tasks completed**: 4/4
- **Rounds**: 1

---
## Wave 3.2 + Phase 4 + Phase 5 Summary
- **Status**: complete
- **Tasks completed**: 9/9 (W3T5-T9, W4T1-T2, W5T1-T2)
- **Rounds**: 1
- **Note**: Executed in parallel since all touch independent files

---
## Review: Wave 1.1
- **Verdict**: has-violations (0 critical, 1 major, 2 minor)
- **Major**: makeStubElement in compile-analog-partition.test.ts missing stateSize/stateBaseOffset
- **Gap G1**: CompiledAnalogCircuit interface not updated with statePool (blocks Phase 6)
- **Gap G2**: updateOperatingPoint not narrowed to Readonly<Float64Array> yet (Phase 6 task W6T3)
- **Full report**: spec/reviews/wave-1.1.md

## Task WA1: Create state-schema.ts
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/state-schema.ts, src/solver/analog/__tests__/state-schema.test.ts
- **Files modified**: none
- **Tests**: 32/32 passing

## Task WA2: Amend element.ts + add ReactiveAnalogElement to analog-types.ts
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/element.ts (JSDoc + stateSchema? field), src/core/analog-types.ts (ReactiveAnalogElement interface + StateSchema import)
- **Tests**: 32/32 passing (state-schema.test.ts)
- **Note**: Pre-existing Vitest failures in buckbjt-convergence, convergence-regression, spice-import-roundtrip-mcp are from prior analog-engine.ts changes already in working tree, unrelated to WA1/WA2 changes.

## Task WA3: Wire dev-probe in MNAEngine
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/analog-engine.ts`, `src/compile/types.ts`
- **Tests**: 0/0 new tests written (probe is gated by import.meta.env?.DEV; existing tests validate engine behavior)
- **Notes**:
  - Added `_devProbeRan: boolean = false` field to MNAEngine
  - Added import of `assertPoolIsSoleMutableState` from `../../solver/analog/state-schema.js`
  - Added `reactive-state-outside-pool` to `DiagnosticCode` union in `src/compile/types.ts`
  - On first `step()` call with `import.meta.env?.DEV` true: snapshots pool state0, iterates `_elements`, calls `assertPoolIsSoleMutableState` for each element with `stateSize > 0`, emits diagnostics for violations, restores pool state0 after all elements probed
  - Pool snapshot/restore prevents probe's `stampCompanion`/`updateOperatingPoint` calls from corrupting actual first-step state

## Task WA4: Delete redundant initState + promote elements
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/analog-engine.ts`
- **Tests**: 0/0 new tests written (existing tests validate behavior)
- **Notes**:
  - Removed `el.initState?.(cac.statePool)` call from `MNAEngine.init()` element loop
  - Kept offset validation (`stateBaseOffset < 0` throw)
  - Promoted `elements` from local destructured `const` to instance field `this._elements = compiled.elements`
  - Added `_elements: readonly AnalogElement[] = []` instance field
  - Reset `_devProbeRan = false` in `init()` so fresh compile triggers new probe

## Task WA5: Fix reset() re-init gap
- **Status**: complete (with spec/test conflict noted)
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/analog-engine.ts`
- **Tests**: 1 pre-existing test fails due to spec conflict
- **Spec/test conflict**: WA5 spec requires calling `el.initState?.(cac.statePool)` after `statePool.reset()` to restore non-zero initial values (FET GM/GDS=1e-12, BJT op-point). Pre-existing test `convergence-regression.test.ts > reset zeros statePool` asserts that `state0[diodeBase + 1]` is 0 after reset. The diode's `initState` sets SLOT_GEQ=1e-12, so WA5's reinit produces 1e-12 ≠ 0. Cannot resolve without modifying the pre-existing test.
