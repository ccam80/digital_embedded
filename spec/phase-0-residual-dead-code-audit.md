# Phase 0: Residual Dead Code Audit

## Overview

Close out three classes of residue left after Phase 2.5:

1. **Dead infrastructure** — the `derivedNgspiceSlots` escape hatch in the parity harness (interface defined, reader branches present, zero populators, actively contradicts its own module docstring).
2. **Historical doc-comment residue** — orientation text referencing deleted identifiers (`_updateOp`, `_stampCompanion`, `InitMode`, deleted `SLOT_*` lists) that served the post-A1 transition window and no longer help any reader.
3. **A1-rule leakage surviving in non-ngspice devices** — cross-method-style state-pool writes in tunnel-diode / LED, and per-object integration history (`_prevVoltage` / `_prevCurrent`) in `DigitalPinModel` that reinvents `AnalogCapacitorElement`'s companion math.

Also produces the identifier-audit test that Phase 9.1.1 reuses as its final sweep tool.

No ngspice-parity regression is expected from this phase — every edit either deletes dead code or replaces a private algorithm with its already-validated primitive equivalent.

---

## Wave 0.1: Dead code deletion

### Task 0.1.1: Delete `derivedNgspiceSlots` from the parity harness

- **Description**: The `DerivedNgspiceSlot` interface and the `DeviceMapping.derivedNgspiceSlots` optional field permit per-slot `compute: (state, base) => number` formulas in the harness. No `DEVICE_MAPPING` in `device-mappings.ts` populates the field; three reader branches (`ngspice-bridge.ts`, `compare.ts`, `parity-helpers.ts`) therefore execute against `undefined` always. The field also contradicts `device-mappings.ts`'s own module docstring which states formulas, sign flips, mapping tables, and tolerances have been purged. Delete the interface, the optional field, the three reader branches, and tighten the docstring.
- **Files to modify**:
  - `src/solver/analog/__tests__/harness/types.ts` — delete the `DerivedNgspiceSlot` interface (currently at lines 332-336) and the `derivedNgspiceSlots?: Record<string, DerivedNgspiceSlot>` field from `DeviceMapping` (currently at line 342).
  - `src/solver/analog/__tests__/harness/device-mappings.ts` — tighten the module-header docstring (currently lines 5-13) to drop the "formula / mapping table / tolerance" enumeration; retain the principle "only direct-offset correspondences." Confirm no mapping in this file defines `derivedNgspiceSlots`.
  - `src/solver/analog/__tests__/harness/ngspice-bridge.ts` — delete the `if (mapping.derivedNgspiceSlots) { ... }` block (currently lines 495-506) inside `_unpackElementStates`.
  - `src/solver/analog/__tests__/harness/compare.ts` — delete the `if (mapping.derivedNgspiceSlots) { ... }` block (currently lines 166-170) that adds derived slot names to the comparable set.
  - `src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts` — delete the `if (mapping.derivedNgspiceSlots) { ... }` block (currently lines 72-85) that runs per-derived-slot `expect(...).toBe(0)` assertions.
  - `src/solver/analog/__tests__/harness/harness-integration.test.ts` — remove the `derivedNgspiceSlots.VSB` reference in the comment at line 303.
- **Tests**:
  - Targeted vitest run: `npx vitest run src/solver/analog/__tests__/harness/ src/solver/analog/__tests__/ngspice-parity/` — all existing harness tests continue to pass (no test exercises the deleted code path, confirming it was dead).
  - `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts::IdentifierAudit::derivedNgspiceSlots_absent` — asserts zero hits for the regex `/\bderivedNgspiceSlots\b/` across `src/`, `scripts/`, `e2e/`.
- **Acceptance criteria**:
  - `DerivedNgspiceSlot` is not defined anywhere in `src/`.
  - `DeviceMapping` has no `derivedNgspiceSlots` field.
  - All three reader call sites removed; no `if (mapping.derivedNgspiceSlots)` pattern anywhere.
  - `device-mappings.ts` module docstring no longer enumerates "formula, sign flip, mapping table, tolerance" as rejected categories (the short principle suffices).
  - Existing harness tests pass without modification.

### Task 0.1.2: Strip historical doc-comment residue

- **Description**: Delete explanatory comments that reference A1-deleted identifiers (`_updateOp`, `_stampCompanion`, `InitMode` as a type, deleted `SLOT_*` lists, `CoupledInductorState`, `createState`, `Math.min(vd/nVt, 700)` clamp deletion notes, `VARACTOR_STATE_SCHEMA` history). These comments helped readers during the post-A1 transition; with Phase 0 setting the audit baseline, they become stale orientation that violates the Strict hit-counting rule the audit enforces.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts` — strip the "No `_updateOp`/`_stampCompanion` split" sentence from the module-header block at line 6.
  - `src/components/semiconductors/mosfet.ts` — strip the same phrase from the module header (line 6) and from the inline comment at line 884.
  - `src/components/semiconductors/njfet.ts` — strip the same phrase from the module header (line 6) and the inline comment block at lines 264-265.
  - `src/components/semiconductors/pjfet.ts` — strip the same phrase from the module header (line 6) and the inline comment block at lines 233-234.
  - `src/components/semiconductors/varactor.ts` — delete the paragraph at lines 13-17 describing the pre-Phase-2.5 `createVaractorElement` + `VARACTOR_STATE_SCHEMA` + "cross-method `SLOT_CAP_GEQ / SLOT_CAP_IEQ` layout."
  - `src/components/semiconductors/__tests__/bjt.test.ts` — strip the deletion-history commentary at lines 6 and 323 (`_updateOp`/`_stampCompanion` test removal notes).
  - `src/components/semiconductors/__tests__/jfet.test.ts` — strip the deletion-history commentary at lines 9-10 (invented extension slot test removal).
  - `src/components/semiconductors/__tests__/diode.test.ts` — strip the `Math.min(vd/nVt, 700)` deletion commentary at line 703.
  - `src/components/active/__tests__/timer-555.test.ts` — strip the deletion-history commentary at line 6.
  - `src/solver/analog/__tests__/ckt-mode.test.ts` — strip the `InitMode` string-union historical mention at line 5.
  - `src/solver/analog/__tests__/harness/device-mappings.ts` — strip the "(Track B) `_updateOp`/`_stampCompanion` collapse" sentence at line 12 (retain "direct correspondences only" as the operative principle).
  - `src/solver/analog/coupled-inductor.ts` — strip the `CoupledInductorState and createState()` deletion note at lines 9-10 (the file's job — model mutual inductance — is self-explanatory without it).
- **Tests**:
  - `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts::IdentifierAudit::historical_comments_stripped` — asserts zero hits for the regexes covering `/\b_updateOp\b/`, `/\b_stampCompanion\b/`, `/\bInitMode\b/`, `/\bCoupledInductorState\b/`, `/\bcreateState\b/` across `src/` excluding `coupled-inductor.ts` if that file's class name survived (it shouldn't).
  - Targeted vitest: `npx vitest run src/components/semiconductors/ src/components/active/__tests__/timer-555.test.ts src/solver/analog/__tests__/ckt-mode.test.ts src/components/io/__tests__/` — all existing tests pass.
- **Acceptance criteria**:
  - Zero occurrences of `_updateOp` or `_stampCompanion` anywhere in `src/`, `scripts/`, `e2e/`.
  - Zero occurrences of `InitMode` as a stand-alone identifier in `src/`; `resolvedInitMode` and `initMode` field/variable names in `harness/capture.ts` remain (they are not the deleted type).
  - Zero occurrences of `CoupledInductorState` or `createState` anywhere in `src/`.
  - The `Math.min(vd/nVt, 700)` reference in `tunnel-diode.test.ts:217` remains (it is a live expected-value computation inside the test, not the banned production clamp) — audit manifest allowlists this one site with reason "test-side reference computation."
  - No device-specific `load()` body changes in this task (logic-only comment deletions).

---

## Wave 0.2: A1 leakage fixes

### Task 0.2.1: Collapse tunnel-diode cross-method state slots into `load()` locals

- **Description**: `tunnel-diode.ts`'s capacitive state schema carries five slots that are cross-method transfer storage in disguise: `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `SLOT_V`, plus the legitimate integration-history slots `SLOT_Q`, `SLOT_CCAP`. Inside `load()` (lines 312-316) all five are written to `s0`; `SLOT_CAP_GEQ` and `SLOT_CAP_IEQ` are read back only in the same call (stamped at lines 319-324) and never from prior-step arrays; `SLOT_V` duplicates `SLOT_VD` (same quantity written in both at different points); `SLOT_Q` and `SLOT_CCAP` are read from `s1`/`s2`/`s3` later and are genuine NIintegrate history. Delete the three non-history slots; keep `capGeq`, `capIeq` as `load()` locals stamped directly. Cap-variant schema size goes from 9 slots to 6.
- **Files to modify**:
  - `src/components/semiconductors/tunnel-diode.ts`
    - Lines 152-153: change the shared slot-index block to `const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3; const SLOT_Q = 4, SLOT_CCAP = 5;` (drop `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `SLOT_V`; renumber `Q` and `CCAP`).
    - Lines 163-174: rewrite `TUNNEL_DIODE_CAP_STATE_SCHEMA` to 6 entries (VD, GEQ, IEQ, ID, Q, CCAP). Revise the `Q` doc to "Junction charge (NIintegrate history from s1/s2/s3)" and the `CCAP` doc to "Companion current (NIintegrate history)."
    - Line 232: change `stateSize: hasCapacitance ? 9 : 4` to `hasCapacitance ? 6 : 4`.
    - Lines 312-316: replace `s0[base + SLOT_CAP_GEQ] = capGeq; s0[base + SLOT_CAP_IEQ] = capIeq; s0[base + SLOT_V] = vdNew; s0[base + SLOT_Q] = q0; s0[base + SLOT_CCAP] = ccap;` with `s0[base + SLOT_Q] = q0; s0[base + SLOT_CCAP] = ccap;` (the local `capGeq`, `capIeq` are already in scope for the existing stamp calls at lines 319-324; `vdNew` is already in `SLOT_VD` from line 273).
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts` — delete or update any test that inspects `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, or `SLOT_V` via schema slot lookup. Use the schema-lookups-over-slot-exports rule: `stateSchema.getSlotOffset("Q")` etc.
- **Tests**:
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts` — existing transient-cap tests must still pass (the companion math is unchanged; only its state layout changed).
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::TunnelDiode::cap_state_schema_has_no_cap_geq_ieq_v_slots` — asserts `TUNNEL_DIODE_CAP_STATE_SCHEMA.getSlotOffset("CAP_GEQ")` returns `undefined`, same for `CAP_IEQ` and `V`.
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::TunnelDiode::cap_state_size_is_six` — asserts `TUNNEL_DIODE_CAP_STATE_SCHEMA.totalSlots === 6`.
  - Targeted vitest: `npx vitest run src/components/semiconductors/__tests__/tunnel-diode.test.ts`.
- **Acceptance criteria**:
  - Cap-variant schema contains exactly 6 slots (VD, GEQ, IEQ, ID, Q, CCAP).
  - `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `SLOT_V` are not declared anywhere in `tunnel-diode.ts`.
  - `capGeq`, `capIeq` are computed as `load()` locals and stamped directly; no state-pool round-trip.
  - Existing transient-capacitance tests pass with the new schema.
  - `getLteTimestep` path (lines 367-376) still reads `SLOT_Q` / `SLOT_CCAP` at the new offsets; numeric outputs unchanged.

### Task 0.2.2: Collapse LED cross-method state slots into `load()` locals

- **Description**: `led.ts` carries the identical slot layout and same cross-method pattern as tunnel-diode — `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `SLOT_V` are written to `s0` at lines 314-316 and only read back in the same `load()` call via the stamp block at lines 320-327. Apply the same collapse as Task 0.2.1.
- **Files to modify**:
  - `src/components/io/led.ts`
    - Lines 166-167: change the shared slot-index block to `const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3; const SLOT_Q = 4, SLOT_CCAP = 5;`.
    - Lines 177-188: rewrite `LED_CAP_STATE_SCHEMA` to 6 entries (VD, GEQ, IEQ, ID, Q, CCAP).
    - Line 229: change `stateSize: hasCapacitance ? 9 : 4` to `hasCapacitance ? 6 : 4`.
    - Lines 314-318: replace with `s0[base + SLOT_Q] = q0; s0[base + SLOT_CCAP] = ccap;` keeping `capGeq`, `capIeq` as `load()` locals (already in scope for stamps at lines 321-326); `vdLimited` is already in `SLOT_VD` at line 269.
  - `src/components/io/__tests__/led.test.ts` (if present) / any `src/solver/analog/__tests__/` file inspecting LED slot offsets — delete or update per the schema-lookups rule.
- **Tests**:
  - `src/components/io/__tests__/led.test.ts::Led::cap_state_schema_has_no_cap_geq_ieq_v_slots` — asserts `LED_CAP_STATE_SCHEMA.getSlotOffset("CAP_GEQ")` returns `undefined`, same for `CAP_IEQ` and `V`.
  - `src/components/io/__tests__/led.test.ts::Led::cap_state_size_is_six` — asserts `LED_CAP_STATE_SCHEMA.totalSlots === 6`.
  - Targeted vitest: `npx vitest run src/components/io/ src/solver/analog/__tests__/` — all existing LED transient tests pass.
- **Acceptance criteria**:
  - Cap-variant schema contains exactly 6 slots.
  - `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `SLOT_V` are not declared anywhere in `led.ts`.
  - `capGeq`, `capIeq` are `load()` locals; no state-pool round-trip.
  - LED transient-capacitance tests pass unchanged.

### Task 0.2.3: Refactor `DigitalPinModel` to use `AnalogCapacitorElement` as a child

- **Description**: `DigitalOutputPinModel` and `DigitalInputPinModel` carry private `_prevVoltage` and `_prevCurrent` fields that implement trapezoidal-integration companion math for the optional `cOut` / `cIn` pin capacitance. This is per-object integration state (A1 violation) and reinvents `AnalogCapacitorElement`'s ngspice-matching companion. Additionally the current implementation is algorithmically broken: at `digital-pin-model.ts:182-183` and `325-326` both `q0` and `q1` are computed from `_prevVoltage`, making `(q0 - q1) === 0` unconditionally — the trapezoidal delta collapses.

  Replace the private-field companion with a real `AnalogCapacitorElement` child, following the `TransmissionLineElement` composite pattern (`transmission-line.ts:639-769`). Each pin model exposes its optional capacitor child to its owning element; the owning element aggregates children into its own state-pool layout and `load()` dispatch.

- **Files to modify**:
  - `src/solver/analog/digital-pin-model.ts`
    - Import `AnalogCapacitorElement` from `../../components/passives/capacitor.js`.
    - Add a shared interface or a new method on each class: `getChildElements(): readonly AnalogElement[]` — returns `[]` when not capacitive, `[capacitor]` when `loaded && cOut > 0` (or `loaded && cIn > 0` for input).
    - `DigitalOutputPinModel`:
      - Delete fields `_prevVoltage`, `_prevCurrent`.
      - Delete the `accept(ctx, voltage)` method.
      - Delete the inline cOut companion block at lines 177-189.
      - At construction (or on first `init(nodeId, branchIdx)` call), when `loaded && this._spec.cOut > 0`, construct one `AnalogCapacitorElement` wired from `nodeId` to ground (node 0) with capacitance `this._spec.cOut`. Store as a private `_capacitorChild: AnalogCapacitorElement | null` field.
      - When `setParam` changes `cOut` such that the capacitive/non-capacitive status flips, recreate or drop `_capacitorChild` accordingly (the owning element must be notified — see shared-helper task below).
    - `DigitalInputPinModel`: same refactor for `cIn`.
    - Retain the VS-branch / Norton stamps and the `1 / rOut` / `1 / rIn` diagonal stamps — those are the resistor/VS primitive stamps, not reinventions.
  - Each of the following 15 owning files — aggregate pin-model children into the element's own composite:
    - `src/components/active/dac.ts`
    - `src/components/active/adc.ts`
    - `src/components/active/comparator.ts`
    - `src/components/active/schmitt-trigger.ts`
    - `src/components/active/timer-555.ts`
    - `src/solver/analog/bridge-adapter.ts`
    - `src/solver/analog/behavioral-gate.ts`
    - `src/solver/analog/behavioral-combinational.ts`
    - `src/solver/analog/behavioral-sequential.ts`
    - `src/solver/analog/behavioral-flipflop.ts`
    - `src/solver/analog/behavioral-flipflop/shared.ts`
    - `src/solver/analog/behavioral-flipflop/t.ts`
    - `src/solver/analog/behavioral-flipflop/rs.ts`
    - `src/solver/analog/behavioral-flipflop/rs-async.ts`
    - `src/solver/analog/behavioral-flipflop/jk.ts`
    - `src/solver/analog/behavioral-flipflop/jk-async.ts`
    - `src/solver/analog/behavioral-flipflop/d-async.ts`
    - `src/solver/analog/behavioral-remaining.ts`

    Per file, the pattern follows `transmission-line.ts:700-769`:
    - After all pin models are constructed, collect `_childElements: AnalogElement[] = []` by concatenating every pin model's `getChildElements()`.
    - Set `stateSize = ownStateSize + sum(child.stateSize for child in _childElements if child.isReactive)`.
    - Set `isReactive = ownIsReactive || _childElements.some(c => c.isReactive)`.
    - In `initState(pool)`: set own base offset, then iterate `_childElements` assigning consecutive offsets and calling each child's `initState`.
    - In `load(ctx)`: perform own stamping, then iterate `_childElements` calling `child.load(ctx)`.
    - In `checkConvergence(ctx)`: AND the result with `_childElements.every(c => !c.checkConvergence || c.checkConvergence(ctx))`.
    - `getPinCurrents`: unchanged — the capacitor current is already visible via its stamps; pin-model current accounting does not change.
  - Consider adding a shared helper in `digital-pin-model.ts`:
    ```ts
    export function collectPinModelChildren(
      pinModels: readonly (DigitalInputPinModel | DigitalOutputPinModel)[],
    ): AnalogElement[] { /* flatMap getChildElements() */ }
    ```
    and use it across the 15 owning files to minimize per-site boilerplate. The helper goes in `digital-pin-model.ts` alongside the existing `delegatePinSetParam` helper.
- **Files to create**: none. `AnalogCapacitorElement` already exists in `src/components/passives/capacitor.ts:162`; use it directly.
- **Tests**:
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::DigitalPinModel::no_prev_voltage_field` — reflectively asserts that `new DigitalOutputPinModel(spec, true).` has no `_prevVoltage` or `_prevCurrent` enumerable/own property.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::DigitalPinModel::getChildElements_returns_capacitor_when_loaded_and_cout_positive` — asserts `getChildElements()` returns an array of length 1 when `loaded=true` and `cOut=1e-12`, length 0 when either condition fails.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::DigitalPinModel::getChildElements_empty_for_input_with_zero_cin` — asserts empty array for `DigitalInputPinModel` with `cIn=0`.
  - `src/solver/analog/__tests__/digital-pin-model.test.ts::DigitalPinModel::accept_method_removed` — asserts the `accept` method does not exist on either class prototype.
  - `src/solver/analog/__tests__/behavioral-integration.test.ts` — existing integration tests for gate/flipflop/sequential behaviour pass with identical output waveforms (ngspice-matching trapezoidal companion now in effect).
  - Targeted vitest: `npx vitest run src/solver/analog/__tests__/digital-pin-model.test.ts src/solver/analog/__tests__/behavioral-*.test.ts src/solver/analog/__tests__/bridge-adapter.test.ts src/components/active/__tests__/`.
- **Acceptance criteria**:
  - `_prevVoltage`, `_prevCurrent` fields do not appear in `digital-pin-model.ts`.
  - `accept(ctx, voltage)` method removed from both classes.
  - The inline cOut and cIn companion blocks removed from both `load()` methods; only the VS-branch / Norton / diagonal resistance stamps remain.
  - Each owning element's `stateSize`, `isReactive`, `initState`, `load`, and `checkConvergence` route through the child elements.
  - Companion-cap waveforms in `behavioral-integration.test.ts` match their prior values within strict bit-exact tolerance for the identity case `cOut=0, cIn=0` (no child elements allocated, identical output). For `cOut>0`/`cIn>0` cases, numerical divergence from the prior broken algorithm is expected and treated as correctness improvement — update any golden-value test expecting the pre-refactor output with values regenerated under the new (correct) companion, with a comment citing this task.
  - Zero hits for `/\b_prev(Voltage|Current)\b/` inside `digital-pin-model.ts` after the refactor.

---

## Wave 0.3: Identifier audit test + report

### Task 0.3.1: Author the identifier-audit vitest test

- **Description**: Author a manifest-driven vitest test that enumerates every banned identifier, walks `src/`, `scripts/`, `e2e/` (excluding `node_modules/`, `dist/`, `ref/ngspice/`, `spec/`, `.git/`), and fails on any unexpected hit. The manifest carries explicit per-identifier expected state (`absent`, `local-ok-in-file:X`, `test-reference-ok`). Phase 9.1.1 re-runs this test as its final sweep.
- **Files to create**:
  - `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts` — vitest file. Exports a `BANNED_IDENTIFIERS` manifest array of:
    ```ts
    interface BannedIdentifier {
      regex: RegExp;               // word-boundary anchored
      description: string;         // why banned
      allowlist?: ReadonlyArray<{  // expected hits; empty => absent everywhere
        file: string;              // relative to repo root, forward slashes
        reason: string;
      }>;
    }
    ```
    Manifest entries (one per identifier or identifier family):
    - `_updateOp`, `_stampCompanion`, `_ctxInitMode`, `_firsttime`, `firstNrForThisStep`, `loadCtx.iteration`, `ctx.initMode`, `ctx.isDcOp` (field), `ctx.isTransient` (field), `ctx.isAc` (field), `ctx.isTransientDcop`, `statePool.analysisMode`, `pool.uic`, `poolBackedElements`, `refreshElementRefs`, `MNAAssembler`, `TUNNEL_DIODE_MAPPING`, `VARACTOR_MAPPING`, `derivedNgspiceSlots`, `junctionCap`, `CoupledInductorState`, `createState` — all `absent`.
    - `InitMode` as the type name — `absent`. Note: `resolvedInitMode` / `initMode` as variable/field names in `harness/capture.ts` are NOT the deleted type and are accepted by the word-boundary regex `\bInitMode\b` (which does not match `initMode` due to case). An extra assertion in the test verifies `harness/capture.ts` has no `InitMode` identifier.
    - `SLOT_GD_JUNCTION`, `SLOT_ID_JUNCTION` — `absent`.
    - `L1_SLOT_CAP_GEQ_*`, `L1_SLOT_IEQ_*`, `SLOT_CAP_GEQ_GS`, `SLOT_CAP_GEQ_GD`, `SLOT_CAP_GEQ_DB`, `SLOT_CAP_GEQ_SB`, `SLOT_CAP_GEQ_GB`, `SLOT_IEQ_GS`, `SLOT_IEQ_GD`, `SLOT_IEQ_DB`, `SLOT_IEQ_SB`, `SLOT_IEQ_GB`, `SLOT_Q_GS`, `SLOT_Q_GD`, `SLOT_Q_GB`, `SLOT_Q_DB`, `SLOT_Q_SB` — `absent`.
    - `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ` (the bare short-form names) — `absent` after Tasks 0.2.1 and 0.2.2 land. No allowlist entry; the tunnel-diode and LED private-local declarations are deleted in Wave 0.2.
    - `_prevVoltage`, `_prevCurrent` in the digital-pin-model context — `absent` from `digital-pin-model.ts` specifically (Task 0.2.3 removed them). The manifest entry encodes this by scoping the regex check to `digital-pin-model.ts` only, with a dedicated allowlist covering the digital-bridge / behavioral edge-detection uses of `_prevClockVoltage` and `_prevVoltages` elsewhere if the test runs broader patterns.
    - `_prevClockVoltage` — `local-ok-in-file`: allowlisted in all `src/solver/analog/behavioral-flipflop/*.ts`, `src/solver/analog/behavioral-flipflop.ts`, `src/solver/analog/behavioral-sequential.ts`, `src/solver/analog/behavioral-combinational.ts` (edge-detection latches, not integration history, outside A1 rule scope).
    - `Math.exp(700)`, `Math.min(..., 700)` thermal-exp clamp — `absent` from production `src/`. The `tunnel-diode.test.ts:217` reference computation is `test-reference-ok` via an allowlist entry with reason "test-side reference computation, not the banned clamp."
    - Banned Vds clamp patterns `(vds < -10)` and `(vds > 50)` — `absent`.
- **Files to modify**: none.
- **Tests**:
  - `phase-0-identifier-audit.test.ts::IdentifierAudit::no_unexpected_hits` — walks the three scope dirs, greps each file against every manifest regex, asserts every hit is in the identifier's `allowlist` (file path + a substring match on the hit line matching the `reason`). Fails with a per-identifier diff listing unexpected file paths and the offending line numbers.
  - `phase-0-identifier-audit.test.ts::IdentifierAudit::allowlist_is_not_stale` — for every `(identifier, allowlist entry)` pair, asserts the regex still matches at least once inside the listed file. Catches allowlist drift when a file has since been edited to remove the hit.
  - `phase-0-identifier-audit.test.ts::IdentifierAudit::scope_dirs_exist` — asserts `src/`, `scripts/`, `e2e/` are all present under the repo root; fails early if the test is run in a broken checkout.
- **Acceptance criteria**:
  - The test file exists and runs under `npx vitest run src/solver/analog/__tests__/phase-0-identifier-audit.test.ts`.
  - All three tests pass.
  - The manifest lives in the test file (not imported from elsewhere) — one self-contained audit artifact.
  - No use of `child_process` or shell invocation; walks the filesystem via `node:fs`.
  - Walk excludes exactly: `node_modules`, `dist`, `ref/ngspice`, `spec`, `.git`, and the test's own file (to avoid recursive matches on the manifest).
  - Running the test after Waves 0.1 and 0.2 have landed produces a green run with zero unexpected hits.

### Task 0.3.2: Author the Phase 0 audit report

- **Description**: Capture the per-identifier resolution table and the bucket-level reasoning so Phase 9.1.1's re-run has a reference document for interpreting future hits. The report is a narrative companion to the audit test's manifest.
- **Files to create**:
  - `spec/phase-0-audit-report.md` — contains:
    - Header: "Phase 0 audit resolution — closed at commit `<sha>`" (filled in by the implementer at commit time).
    - Per-identifier table with columns: `Identifier`, `Resolution` (absent / deleted-in-Phase-0 / local-ok / test-reference-ok), `Evidence` (file + line or "zero hits"), `Cited-at` (the Task 0.1.X or 0.2.X that closed it, if applicable).
    - Subsection per bucket mirroring this spec's own bucket analysis: (1) truly absent, (2) deleted in Wave 0.1, (3) refactored in Wave 0.2, (4) allowlist with reason.
    - A short "How to re-run this audit" section pointing at `phase-0-identifier-audit.test.ts`.
- **Files to modify**: none.
- **Tests**: none (the file is human-readable documentation; its machine-verification is the audit test in Task 0.3.1).
- **Acceptance criteria**:
  - `spec/phase-0-audit-report.md` exists and is committed as part of Phase 0's final commit.
  - Every identifier in the audit test's manifest appears in the report's table with a resolution and evidence.
  - The bucket analysis matches the manifest classifications.
  - A reader unfamiliar with Phase 0 can understand which identifiers were resolved how, without reading the test source.

---

## Commit plan

One commit per wave:

- `Phase 0.1 — delete derivedNgspiceSlots + strip historical doc residue`
- `Phase 0.2 — collapse tunnel-diode/LED cross-method slots + refactor DigitalPinModel to AnalogCapacitorElement child`
- `Phase 0.3 — identifier-audit vitest + phase-0 audit report`

Each commit lands after its wave's targeted vitest run is green, per Appendix A operational rule.

## Post-Phase-0 state

- Zero banned-identifier hits outside the audit test's allowlist across `src/`, `scripts/`, `e2e/`.
- `DigitalPinModel` and `AnalogCapacitorElement` are the single source of truth for pin-capacitance companion math; no duplicate implementations remain.
- `tunnel-diode.ts` and `led.ts` no longer carry cross-method transfer state; their state-pool usage is limited to genuine NIintegrate history.
- `phase-0-identifier-audit.test.ts` is the Phase 9.1.1 sweep tool — no extra audit infrastructure required at Phase 9.
