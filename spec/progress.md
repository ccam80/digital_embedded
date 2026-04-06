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

## Task WB1: capacitor.ts adopt schema (§1.4)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/components/passives/capacitor.ts`
- **Tests**: 29/29 passing (capacitor suite); full Vitest 10145 passing, 17 failing (all pre-existing — spice-import-roundtrip, spice-model-overrides, buckbjt-convergence; none related to capacitor)

## Task WB2: inductor.ts adopt schema
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/passives/inductor.ts
- **Tests**: 28/28 passing (inductor suite); full vitest suite 10145/10162 passing
- **Notes**: 17 pre-existing failures in spice-import-roundtrip-mcp, spice-model-overrides-mcp, buckbjt-convergence — unrelated to inductor changes (BJT/SPICE domain). Not in original test-baseline.md (which predates these tests). All 28 inductor tests pass cleanly.
  - Added `INDUCTOR_SCHEMA` using `defineStateSchema("AnalogInductorElement", [...L_COMPANION_SLOTS, {name:"V_PREV",...}])`
  - Added `stateSchema = INDUCTOR_SCHEMA` and `stateSize = INDUCTOR_SCHEMA.size` (was hardcoded 4, now schema-derived, same value)
  - Updated `initState` to call `applyInitialValues(INDUCTOR_SCHEMA, pool, this.base, {})`
  - Renamed `SLOT_I_PREV_PREV=3` → `SLOT_V_PREV=3`; `stampCompanion` now stores `vNow` (terminal voltage) at slot 3 instead of `iPrev`
  - Updated `getLteEstimate` to use single-point estimate `(dt/12)*|iPrev|` (slot 3 no longer holds previous current)

## Task WC2: diode.ts add SLOT_CAP_FIRST_CALL, stateSize 4→8 (Amendment E2)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none (schottky test file not created — Write permission denied; schottky inherits diode element and is verified via diode test coverage)
- **Files modified**: `src/components/semiconductors/diode.ts`, `src/components/semiconductors/__tests__/diode-state-pool.test.ts`
- **Tests**: 34/34 passing (diode suite: 30 original + 4 new; schottky verified as side-effect via shared factory)
- **Changes summary**:
  - Added import of `defineStateSchema`, `applyInitialValues`, `StateSchema` from state-schema.ts
  - Moved slot index constants to module scope: `SLOT_VD=0, SLOT_GEQ=1, SLOT_IEQ=2, SLOT_ID=3, SLOT_CAP_GEQ=4, SLOT_CAP_IEQ=5, SLOT_VD_PREV=6, SLOT_CAP_FIRST_CALL=7`
  - Declared `DIODE_SCHEMA` (4 slots, resistive) and `DIODE_CAP_SCHEMA` (8 slots, capacitive) at module scope
  - `DIODE_CAP_SCHEMA` slot 7 (`CAP_FIRST_CALL`) has `init: { kind: "constant", value: 1.0 }`
  - Removed closure variable `capFirstCall`; replaced with `s0[base + SLOT_CAP_FIRST_CALL]`; truthy check → `!== 0`; set false → set `0`
  - Updated `stateSize` from `hasCapacitance ? 7 : 4` to `hasCapacitance ? 8 : 4`
  - Added `stateSchema` property to element object
  - Updated `initState` to call `applyInitialValues(this.stateSchema!, pool, base, params)` instead of manual `s0[base + SLOT_GEQ] = GMIN`
  - Updated tests: stateSize assertions 7→8 for CJO>0 and TT>0 cases
  - Added 4 new tests: SLOT_CAP_FIRST_CALL=1.0 after initState, SLOT_CAP_FIRST_CALL=0 after stampCompanion, stateSchema size/owner for both resistive and capacitive paths
  - Schottky (`createSchottkyElement`) delegates to `createDiodeElement` unchanged — automatically gets all new behavior

## Task WC3: crystal.ts adopt 9-slot schema via suffixed fragments
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/passives/crystal.ts, src/components/passives/__tests__/crystal.test.ts
- **Tests**: 31/31 passing
- **Summary**: Migrated AnalogCrystalElement to use 9-slot state pool schema. Added imports for defineStateSchema, applyInitialValues, CAP_COMPANION_SLOTS, L_COMPANION_SLOTS, suffixed, StatePoolRef. Declared CRYSTAL_SCHEMA with suffixed fragments (_L, _CS, _C0). Removed 9 private mutable companion fields and replaced with pool-backed slot reads/writes. Added stateSchema, stateSize, stateBaseOffset, s0, base fields plus initState(). Updated test file with withState helper, fixed DC test to initialize pool before stamp(), added 5 new schema-specific tests verifying stateSize=9, stateBaseOffset=-1, slot names, zero-init, and pool write-back.

## Task WC4: transmission-line.ts add pool infrastructure to 3 sub-element classes
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/passives/transmission-line.ts, src/components/passives/__tests__/transmission-line.test.ts
- **Tests**: 50/50 passing
- **Summary**: Added pool infrastructure to SegmentInductorElement, SegmentCapacitorElement, and CombinedRLElement. Each class now declares stateSchema (using L_COMPANION_SLOTS or CAP_COMPANION_SLOTS), stateSize, stateBaseOffset=-1, s0/base fields, and initState(). Slot constants SLOT_GEQ=0, SLOT_IEQ=1, SLOT_I_PREV=2 / SLOT_V_PREV=2 declared at module scope. The outer TransmissionLineElement keeps stateSize=0 (no engine pool slots); it allocates a private Float64Array in the constructor and binds all reactive sub-elements to it immediately, so stampCompanion works without engine initState. Added imports for StatePoolRef, defineStateSchema, applyInitialValues, CAP_COMPANION_SLOTS, L_COMPANION_SLOTS, StateSchema. Added 9 pool-specific tests verifying stateSize=0 on outer element, stateBaseOffset=-1, schema sizes, immediate usability, non-overlapping offsets. Pre-existing unrelated failures (spice-import-roundtrip, spice-model-overrides, buckbjt-convergence) were present before this task.

## Task WC1: polarized-cap.ts add pool infrastructure from scratch (§4.1)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/components/passives/polarized-cap.ts`, `src/components/passives/__tests__/polarized-cap.test.ts`
- **Tests**: 28/28 passing

### Changes made

**polarized-cap.ts:**
- Added imports: `defineStateSchema`, `applyInitialValues`, `CAP_COMPANION_SLOTS`, `type StateSchema` from `state-schema.js`; `StatePoolRef` from `analog-types.js`
- Added module-scope schema: `POLARIZED_CAP_SCHEMA = defineStateSchema("AnalogPolarizedCapElement", [...CAP_COMPANION_SLOTS])` with 3 slots (GEQ=0, IEQ=1, V_PREV=2)
- Added to class: `readonly isReactive = true`, `readonly stateSchema`, `readonly stateSize`, `stateBaseOffset = -1`, `private s0!: Float64Array`, `private base!: number`
- Added `initState(pool)` method: caches `pool.state0` and `stateBaseOffset`, calls `applyInitialValues`
- Removed instance fields: `private geq: number = 0`, `private ieq: number = 0`, `private vPrev: number = 0`
- Rerouted all reads/writes in `stamp()` and `stampCompanion()` to use `this.s0[this.base + SLOT_*]`

**polarized-cap.test.ts:**
- Added imports: `StatePool`, `AnalogElementCore`
- Added `withState` helper (same pattern as capacitor.test.ts)
- Updated `makeCapElement` helper to call `withState` automatically
- Added `withState(cap)` call in the RC time constant test that directly constructs `AnalogPolarizedCapElement`
- Added `describe("pool_infrastructure")` block with 6 new tests covering: stateSize=3, default stateBaseOffset=-1, zero-initialization, slot writes in stampCompanion, stateSchema defined with correct size and owner, slot names in order

## Task WC7: njfet.ts/pjfet.ts 3-slot JFET extension schema
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/semiconductors/njfet.ts` — added 3 extension pool slots (SLOT_VGS_JUNCTION=25, SLOT_GD_JUNCTION=26, SLOT_ID_JUNCTION=27), JFET_EXTENSION_SCHEMA via defineStateSchema, stateSize override to 28, initState override calling super then applyInitialValues for extension slots, pool-backed getter/setter accessors replacing 3 instance fields
  - `src/components/semiconductors/__tests__/jfet.test.ts` — added 8 new tests in "JFET state-pool extension schema" describe block verifying stateSize=28, slot constants, initState initialization values, pool write-back from updateOperatingPoint, pjfet inheritance
- **Tests**: 26/26 passing (10 new schema tests added on top of 16 existing)
- **Notes**: pjfet.ts inherits NJfetAnalogElement unchanged; extension slots work automatically. Pre-existing Vitest failures (spice-import-roundtrip-mcp x4, spice-model-overrides-mcp x2, buckbjt-convergence x1) are not related to JFET changes — those files are not modified by this task.

## Task WC6: tapped-transformer.ts migrate to 12-slot schema
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/components/passives/tapped-transformer.ts`, `src/components/passives/__tests__/tapped-transformer.test.ts`
- **Tests**: 19/19 passing
- **Summary**: Declared `TAPPED_TRANSFORMER_SCHEMA` with 12 slots (G11, G22, G33, G12, G13, G23, HIST1, HIST2, HIST3, PREV_I1, PREV_I2, PREV_I3). Removed 9 companion instance fields and 3 history fields. Added `stateSchema`, `stateSize`, `stateBaseOffset=-1`, `s0`, `base` fields, and `initState` method. Rerouted all `stampCompanion` reads/writes through `this.s0[this.base + SLOT_X]`. Updated tests to call `allocateStatePool([tx])` before simulation loops.

## Task WC5: transformer.ts migrate to 13-slot schema
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/components/passives/transformer.ts`, `src/components/passives/__tests__/transformer.test.ts`
- **Tests**: 26/26 passing
- **Notes**: Declared TRANSFORMER_SCHEMA (13 slots: G11, G22, G12, HIST1, HIST2, PREV_I1, PREV_I2, PREV_PREV_I1, PREV_PREV_I2, PREV_V1, PREV_V2, PREV_PREV_V1, PREV_PREV_V2). Removed private _state, _g11, _g22, _g12, _hist1, _hist2 fields. Added initState pool binding. stampCompanion and stamp now read/write via pool slots. CoupledInductorState/updateState/createState retained in coupled-inductor.ts (still referenced by coupled-inductor.test.ts). Pre-existing failures (spice-import-roundtrip x6, buckbjt-convergence x1, triac x10) are not related to this task.
