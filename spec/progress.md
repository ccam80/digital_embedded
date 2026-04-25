# Phase: Instance vs Model Param Partition — Progress

Standalone phase from `spec/phase-instance-vs-model-param-partition.md`.
Started 2026-04-26.

## Batches
- batch-pivmp-w1 (Wave 1): Tasks 1.1, 1.2 — verified PASS
- batch-pivmp-w2 (Wave 2): Tasks 2.1–2.9 — verified PASS
- batch-pivmp-w3 (Wave 3): Tasks 3.1–3.3 — verified PASS (4 spec tests dropped per user directive — see Wave 3 amendment below)
- batch-pivmp-w4 (Wave 4): Tasks 4.1, 4.2 — pending

### Wave 3 amendment (2026-04-26, user directive)

The user directed: "if the models don't use them, do not add them to a schema." Per that ruling, the four Wave-3 spec tests that drove `ISW` against ZenerDiode / VaractorDiode / TunnelDiode and `IBEQ` against TunnelDiode were **removed** from `netlist-generator.test.ts` (those schemas legitimately don't declare those params, so the tests would have required schema additions that mis-represent the model). Removed tests:

- `Zener: ISW renames to JSW on model card`
- `Varactor: ISW renames to JSW on model card`
- `TunnelDiode: ISW renames to JSW on model card`
- `TunnelDiode: emits LEVEL=3 when IBEQ > 0`

The `DEVICE_NETLIST_RULES` table entries for `ZenerDiode`, `VaractorDiode`, `TunnelDiode` (renames + tunnelLevel prefix) are retained. They are inert until / unless those component schemas ever grow `ISW` / `IBEQ`, at which point the rename and prefix become live without further generator changes.

The earlier "expected-red" framing in the Task 3.1 / 3.2 / 3.3 log entries below is superseded — those four tests no longer exist. Wave 3 verifier returned `{"3.gen":"PASS"}` after the removal; 53/53 tests in `netlist-generator.test.ts` pass.

`ELEMENT_SPECS` was also updated from spec-literal `Zener` / `Varactor` to actual registered names `ZenerDiode` / `VaractorDiode` (verified via `name:` fields in `zener.ts:607` and `varactor.ts:203`); without this, `registry.get(typeId)` would have hard-failed REF-B's `if (!def) throw …` guard.

## Implementation Log

### Wave 1 — code landed, awaiting verifier (2026-04-26)

- Task 1.1 — `src/core/registry.ts`: `ParamDef.partition?: "instance" | "model"` field added at lines 33–52, exact spec block.
- Task 1.2 — `src/core/model-params.ts`: `defineModelParams` rewritten with the three-bucket `emit` helper. `primary` → `partition: "model"`, `secondary` → `partition: "model"`, `instance` → `rank: "secondary", partition: "instance"`.
- Tests added by the implementers: 3 cases in `src/core/__tests__/registry.test.ts` and 6 cases in `src/core/__tests__/model-params.test.ts` (extended existing files).
- Both implementer agents returned with the work on disk but never ran `complete-implementer.sh`. State file was rewritten by hand (see `recovery_log` for `batch-pivmp-w1`).

### Wave 2 — Task 2.4 NJFET schema partition (2026-04-26)

- **Status**: complete
- **Agent**: implementer (batch-pivmp-w2)
- **Files modified**:
  - `src/components/semiconductors/njfet.ts` — moved `AREA`, `M`, `TEMP`, `OFF` from `secondary:` block into new `instance:` block in lift order
- **Files modified**:
  - `src/components/semiconductors/__tests__/jfet.test.ts` — added partition layout tests for both NJFET and PJFET
- **Tests**: 22/23 passing
  - New tests: `NJFET_PARAM_DEFS partition layout` (2 tests passing), `PJFET_PARAM_DEFS partition layout` (2 tests passing)
  - Pre-existing failure: `NR > converges_within_10_iterations` — unrelated to partition changes, pre-existing issue under expected-red policy

### Wave 2 — Task 2.5 PJFET schema partition (2026-04-26)

- **Status**: complete
- **Agent**: implementer (batch-pivmp-w2)
- **Files modified**:
  - `src/components/semiconductors/pjfet.ts` — moved `AREA`, `M`, `TEMP`, `OFF` from `secondary:` block into new `instance:` block in lift order (identical lift to NJFET)
- **Tests**: partition layout assertions validated as part of Task 2.4 combined test run
  - `PJFET_PARAM_DEFS partition layout` tests pass (both instance and model partition checks)


## Task 2.1: Diode schema partition
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/semiconductors/diode.ts` — lifted AREA, OFF, IC, TEMP from secondary block into new instance block
  - `src/components/semiconductors/__tests__/diode.test.ts` — added 2 new test suites
- **Tests**: 48/52 passing (46 passed + 2 new tests passed; 6 pre-existing failures unrelated to this task)
- **Notes**:
  - Moved AREA, OFF, IC, TEMP from secondary to new instance block in lift order (as specified)
  - Each lifted key preserved its existing default, unit, and description verbatim
  - M (grading coefficient) correctly remained in secondary as a model parameter
  - Added test suite "DIODE_PARAM_DEFS partition layout" verifying instance params have partition="instance" and model params have partition="model"
  - Added test suite "DIODE_PARAM_DEFAULTS unchanged" verifying all default values preserved verbatim
  - No changes to element storage/access paths (props.getModelParam still works identically)

## Task 2.8: Varactor schema partition
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/components/semiconductors/__tests__/varactor.test.ts
- **Files modified**: src/components/semiconductors/varactor.ts
- **Tests**: 2/2 passing (VARACTOR_PARAM_DEFS partition layout tests)
- **Details**: Lifted AREA, OFF, IC from secondary to new instance block in defineModelParams call. Tests assert partition='instance' for these three keys and partition='model' for all other keys (CJO, VJ, M, IS, FC, TT, N, RS, BV, IBV, NBV, IKF, IKR, EG, XTI, KF, AF, TNOM).

## Task 2.9: SCR schema partition
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/components/semiconductors/scr.ts, src/components/semiconductors/__tests__/scr.test.ts
- **Tests**: 21/23 passing (SCR_PARAM_DEFS partition layout tests pass; blocks_without_gate pre-existing failure unrelated to partition schema changes)
- **Details**: Lifted TEMP, OFF from secondary to new instance block in defineModelParams call. Tests assert partition='instance' for these two keys and partition='model' for all other keys (vOn, iH, rOn, vBreakover, iS, alpha1, alpha2_0, i_ref, n).

## Task 2.6: Zener schema partition
- **Status**: complete
- **Agent**: implementer
- **Files modified**:
  - `src/components/semiconductors/zener.ts` — Call A (ZENER_PARAM_DEFS): moved `TEMP` from `secondary:` block into new `instance:` block. Call B (ZENER_SPICE_L1_PARAM_DEFS) left unchanged as specified.
  - `src/components/semiconductors/__tests__/zener.test.ts` — added 2 new test suites for partition layout
- **Tests**: 15/15 passing (all tests pass, including new partition layout assertions)
  - New tests: `"ZENER_PARAM_DEFS partition layout"` (2 assertions for TEMP=instance and model params=model), `"ZENER_SPICE_L1_PARAM_DEFS unchanged"` (1 assertion all SPICE_L1 defs=model)

## Task 2.7: Tunnel-diode schema partition
- **Status**: complete
- **Agent**: implementer
- **Files modified**:
  - `src/components/semiconductors/tunnel-diode.ts` — moved `TEMP` from `secondary:` block into new `instance:` block
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts` — added 1 new test suite for partition layout
- **Tests**: 1 new partition layout test passing
  - New test: `"TUNNEL_DIODE_PARAM_DEFS partition layout"` (2 assertions for TEMP=instance and 11 model params=model)
  - Pre-existing failures in tunnel-diode test suite are not regressions (expected-red policy); 3 pre-existing test failures in other test blocks remain

## Task 2.3: MOSFET schema partition (NMOS and PMOS)
- **Status**: complete (recovery finalization)
- **Agent**: implementer (batch-pivmp-w2, task 2.3 — recovery)
- **Files created**: none
- **Files modified**: 
  - `src/components/semiconductors/mosfet.ts` — NMOS and PMOS `defineModelParams` calls already have the correct `instance:` blocks with all eight keys (W, L, M, OFF, ICVDS, ICVGS, ICVBS, TEMP) in lift order. All defaults, units, and descriptions are preserved verbatim from HEAD.
  - `src/components/semiconductors/__tests__/mosfet.test.ts` — partition layout tests already in place at lines 2243–2293. Both NMOS and PMOS test suites verify instance keys have `partition === "instance"` and model keys have `partition === "model"`.
- **Tests**: not run per spec (solver refactor in flight; coordinator confirmed 4 partition-layout tests pass in isolation at 818ms)
- **Recovery notes**:
  - Prior implementer left work on-disk but exited before running `complete-implementer.sh`.
  - Verification: NMOS instance block (lines 169–178) contains W, L, M, OFF, ICVDS, ICVGS, ICVBS, TEMP with correct defaults and descriptions matching HEAD. PMOS instance block (lines 274–283) identical structure. Both correctly moved W and L out of primary rank (demoting from "primary" to "secondary" as rank assignment in instance bucket), which is the correct schema shape per spec.
  - Test assertions (lines 2243–2293): correct per spec. NFS and XJ in test model-key list are gracefully skipped if not declared (tests use `if (!def) continue`).
  - No further changes required.

## Task 2.2: BJT schema partition (four `defineModelParams` calls)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/semiconductors/bjt.ts, src/components/semiconductors/__tests__/bjt.test.ts
- **Tests**: 107/107 passing

## Task 3.1: Schema-driven instance / model partitioning
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: 
  - `src/solver/analog/__tests__/harness/netlist-generator.ts` — added `ComponentRegistry`/`ParamDef` import, registry parameter to `generateSpiceNetlist`, per-element registry lookup (REF-B), replaced four semiconductor branches with `instanceParamSuffix`/`modelCardSuffix` calls, deleted `NON_MODEL_KEYS`/`isSpiceModelParam`/`buildModelCard`. Updated `ELEMENT_SPECS` to use real registry names (`ZenerDiode`, `VaractorDiode`). Added `DEVICE_NETLIST_RULES` table and `tunnelLevel` helper (Tasks 3.2/3.3 also done in this file). Added `instanceParamSuffix` and `modelCardSuffix` functions.
  - `src/solver/analog/__tests__/harness/comparison-session.ts` — added `private _registry!: ComponentRegistry` field, promoted registry from local var to field in `init()` and `initSelfCompare()`, updated `generateSpiceNetlist` call at line 503 to pass `this._registry`.
  - `src/solver/analog/__tests__/harness/netlist-generator.test.ts` — added `createDefaultRegistry` import and `testRegistry`, updated all 27 `generateSpiceNetlist` call sites to insert `testRegistry` as second arg, added 23 new tests for Tasks 3.1/3.2/3.3.
- **Tests**: 53/57 passing
- **Expected-red failures (4)**: 
  1. `"Zener: ISW renames to JSW on model card"` — ZenerDiode's ZENER_SPICE_L1_PARAM_DEFS lacks ISW (Wave 2 work not applied to ZenerDiode's spice-l1 model).
  2. `"Varactor: ISW renames to JSW on model card"` — VaractorDiode's VARACTOR_PARAM_DEFS lacks ISW.
  3. `"TunnelDiode: ISW renames to JSW on model card"` — TunnelDiode's TUNNEL_DIODE_PARAM_DEFS lacks ISW.
  4. `"TunnelDiode: emits LEVEL=3 when IBEQ > 0"` — TunnelDiode's paramDefs lack IBEQ; modelCardPrefix fires but IBEQ=1e-12 not emitted after LEVEL=3, so output is `(LEVEL=3)` not `(LEVEL=3 ...)` and the `"(LEVEL=3 "` substring check fails.
  All four failures require adding ISW/IBEQ/IBSW to ZenerDiode/VaractorDiode/TunnelDiode component schemas (Wave 2 component files, outside this task's file scope).

## Task 3.2: Per-device rename table (`ISW` → `JSW`)
- **Status**: complete (rename table in same commit as 3.1)
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/__tests__/harness/netlist-generator.ts` (DEVICE_NETLIST_RULES with renames, modelCardSuffix rename logic)
- **Tests**: 6 new tests added; 4/6 pass (Zener/Varactor/TunnelDiode ISW tests are expected-red per above)

## Task 3.3: Model-card prefix rules
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/__tests__/harness/netlist-generator.ts` (extended DeviceNetlistRules, tunnelLevel helper, LEVEL=3 prefix, drop-if-zero for MOSFET NSUB/NSS)
- **Tests**: 11 new tests added; 10/11 pass (TunnelDiode LEVEL=3 test expected-red per above)
