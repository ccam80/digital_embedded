# Remaining Work — Post-Review Cleanup

Generated 2026-03-31 from review of spec/bridge-and-hot-loadable-params.md waves 1–3.

## Status Key
- FIXED: resolved this session
- OPEN: needs work
- RESOLVED: investigated and closed (no action needed)
- BLOCKED: depends on external factor

---

## Cross-Reference: All Review Findings

### Wave 1 — Bridge Architecture (phase-wave1.md)

| ID | Severity | Finding | Status | Notes |
|----|----------|---------|--------|-------|
| V1 | critical | stampOutput() Norton backdoor for behavioral elements | RESOLVED | Architecturally valid: behavioral elements need Norton for NR iteration; bridges use ideal source. Dual path is correct. |
| V2 | major | DigitalInputPinModel `loaded=true` default | OPEN | Backwards-compat shim. Spec says `loaded: boolean` with no default. Changing to no default requires updating all behavioral element constructors that omit the arg. |
| V3 | major | Coordinator tests don't exercise `_stepMixed()` | OPEN | Tests only exercise adapter API directly. Need integration tests that call `coordinator.step()`. |
| V4 | minor | Historical comment in digital-pin-model.ts:116 | FIXED | Removed by mechanicals agent. |
| V5 | minor | Historical comment in extract-connectivity.ts:86 | FIXED | Removed by mechanicals agent. |
| V6 | minor | Backward-compat comment in element.ts:11 | FIXED | Removed by mechanicals agent. |
| G1 | gap | Mid-simulation hot-load test missing | OPEN | Spec requires: compile → step → setParam("vOH",5.0) → step → verify voltage change. |
| G2 | gap | E2E surface tests missing | BLOCKED | E2E infrastructure broken. |
| G3 | gap | Coordinator integration tests missing | OPEN | Same as V3 — need tests through coordinator.step(). |
| G4 | gap | Task 1.8 test rewrite completeness | OPEN | digital-bridge-path.test.ts doesn't exist. pin-loading-menu.test.ts needs audit. |
| WT1–WT8 | weak | 8 weak tests in coordinator-bridge.test.ts | OPEN | not.toThrow, toBeDefined, typeof checks. Need real behavioral assertions. |
| LR1 | legacy | Legacy comment in extract-connectivity.ts | FIXED | Removed by mechanicals agent. |
| LR2 | legacy | Backward-compat re-export in element.ts | FIXED | Removed by mechanicals agent. |

### Wave 2 — Component Sweep (phase-wave2.md)

| ID | Severity | Finding | Status | Notes |
|----|----------|---------|--------|-------|
| V-01–V-04 | critical | Split factory pattern in all 11 passives | FIXED | Old factories deleted, FromModelParams renamed, mnaModels removed. |
| V-05 | critical | mnaModels dead code in 47+ component files | FIXED | All 59 files cleaned. `grep mnaModels src/` returns zero hits. |
| V-06–V-11 | critical | setParam missing from 25+ factories | PARTIAL | No-op `setParam` added to behavioral, IO, switching factories (correct — these have no hot-loadable params). **6 passive classes got wrong no-op** — need real implementations. See task R1 below. |
| V-12 | major | Test fixture missing setParam | FIXED | Added to model-fixtures.ts by mechanicals agent. |
| V-13 | minor | Legacy comment in spice-model-overrides-prop.test.ts | OPEN | Low priority. |
| V-14 | major | Split factory documented as intentional | FIXED | Factories consolidated, split pattern deleted. |
| G-01 | gap | Tasks 2.4–2.9 not tracked in progress.md | INVESTIGATED | Gates (7), flipflops (8), sources (4), sensors (3) fully migrated. IO/memory/switching/wiring had residual mnaModels — now cleaned. |
| G-02 | gap | Task 2.10 test file not created | OPEN | spec requires src/core/__tests__/analog-types-setparam.test.ts |
| G-03–G-05 | gap | setParam missing from IO/switching/behavioral | FIXED | No-op setParam added (correct for these categories). |
| G-06 | gap | mnaModels not removed from component definitions | FIXED | Zero hits. |
| G-07 | gap | TypeScript errors (was 1101) | PARTIAL | Now 928. See task R2 below. |
| WT-01 | weak | Trivially true assertion in spice-model-overrides-prop.test.ts | OPEN | Low priority. |
| LR-01–LR-26 | legacy | 26 "Ported from" comments | FIXED | Removed by mechanicals agent. |

### Wave 3 — Runtime Features (phase-wave3.md)

| ID | Severity | Finding | Status | Notes |
|----|----------|---------|--------|-------|
| V1 | major | validateModel stub (no-op function) | FIXED | Removed by mechanicals agent. Not in spec. |
| V2 | major | isInverted used instead of isNegated | FIXED | Changed to isNegated + added kind:"signal" by mechanicals agent. |
| V3 | minor | Missing setAttribute on element stubs in test | FIXED | Added by mechanicals agent. |
| V4 | minor | Missing kind field on Pin in test | FIXED | Added by mechanicals agent. |
| G1 | gap | MCP tool tests for Task 3.1 call functions directly | OPEN | Tests should exercise MCP server tool handlers, not call applySpiceImportResult directly. |
| G2 | gap | E2E tests missing for Tasks 3.1/3.4/3.5 | BLOCKED | E2E infrastructure broken. |
| G3 | gap | ModelSwitchCommand not directly wired in canvas-popup.ts | RESOLVED | Works indirectly through PropertyPanel — acceptable architecture. |
| G4 | gap | canvas-popup.ts not listed in progress.md for Task 3.4 | RESOLVED | Tracking issue only, no code fix needed. |
| WT1 | weak | Guard assertion without content check | OPEN | Low priority. |
| WT2 | weak | not.toBeNull followed by non-null assertion | OPEN | Low priority. |
| WT3–WT4 | weak | toBeCloseTo with precision 20 | OPEN | Should use toBe() for exact match or reasonable precision. |
| WT5 | weak | Auto-detect tests don't test detectFormat() | OPEN | Tests reimplement detection logic inline. |
| WT6 | weak | StubElement naming confusion in property-panel-model.test.ts | OPEN | Low priority — naming collision with circuit-element stub pattern. |
| LR1 | legacy | isInverted field name | FIXED | Changed to isNegated. |

---

## Remaining Tasks (prioritized)

### R0: Remove "dual-model" and "analog-pins" context poison
**Priority: URGENT** — These concepts do not exist and should not exist. Dual-model components are not a real concept. `analog-pins` is not a valid simulation mode. All references are artifacts from a previous implementation attempt that were never cleaned up. They poison the compiler's understanding of component routing.

**Files with `isDualModel` / `dual.model` / `analog-pins` references (8 files):**
- `src/compile/extract-connectivity.ts` — `isDualModel` field on `ModelAssignment`, logic to set it, comments referencing it
- `src/solver/analog/__tests__/digital-pin-loading.test.ts`
- `src/compile/__tests__/pin-loading-menu.test.ts`
- `src/compile/__tests__/compile-integration.test.ts`
- `src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts`
- `src/headless/__tests__/digital-pin-loading-mcp.test.ts`
- `src/solver/analog/__tests__/compile-analog-partition.test.ts`
- `src/test-fixtures/registry-builders.ts`

**Action:**
1. Delete `isDualModel` field from `ModelAssignment` interface
2. Delete all logic that sets or reads `isDualModel`
3. Delete all test code that exercises "dual-model" or "analog-pins" scenarios
4. Grep for any remaining "analog-pins", "analog-internals", "logical" sub-mode references and delete
5. Verify bridge synthesis still works without the dual-model concept (bridges are created at domain boundaries, not by component classification)

**Also check:** The "bridge-synthesis-fix" task in progress.md explicitly added `isDualModel` to extract-connectivity.ts. This entire task's premise was wrong — it was based on the false concept that components can be dual-model.

### R0b: Add behavioral factories to modelRegistry for all components that had them in mnaModels
**Priority: URGENT** — This session deleted mnaModels blocks from component files without first moving behavioral factory entries to modelRegistry. The behavioral factories (from behavioral-gate.ts, behavioral-flipflop.ts, behavioral-sequential.ts, behavioral-combinational.ts, behavioral-remaining.ts) are now unreachable by the compiler — `resolveModelEntry()` only checks `def.modelRegistry`.

**NOTE:** This task depends on R0. Once `isDualModel` and "analog-pins" are removed, the question becomes: under what modelKey do behavioral factories run? The compiler resolves `pc.modelKey` from the `ModelAssignment`. If a gate's modelKey is "behavioral", the compiler looks up `def.modelRegistry["behavioral"]` — which must exist. Clarify the intended routing BEFORE adding entries.

**Components needing behavioral entry in modelRegistry:**
- 7 gates: and.ts, or.ts, nand.ts, nor.ts, xor.ts, xnor.ts, not.ts → factory from behavioral-gate.ts
- 8 flipflops: d.ts, d-async.ts, jk.ts, jk-async.ts, rs.ts, rs-async.ts, t.ts, monoflop.ts → factory from behavioral-flipflop.ts + variants
- Components from behavioral-remaining.ts: driver.ts, driver-inv.ts, splitter.ts, seven-seg.ts, seven-seg-hex.ts, relay.ts, relay-dt.ts, switch.ts, switch-dt.ts, button-led.ts
- Components from behavioral-sequential.ts: counter.ts, counter-preset.ts, register.ts
- Components from behavioral-combinational.ts: mux.ts, demux.ts, decoder.ts, bus-splitter.ts

**Entry format:**
```typescript
modelRegistry: {
  behavioral: { kind: 'inline' as const, factory: makeFooAnalogFactory(...), paramDefs: [], params: {} },
  // ... existing entries (cmos, etc.)
}
```

### R1: Replace no-op setParam with real implementations on 6 passive classes
**Priority: HIGH** — These classes have real tunable parameters.
**Files:**
- `src/components/passives/analog-fuse.ts` — AnalogFuseElement (params: rCold, rBlown, i2tRating)
- `src/components/passives/crystal.ts` — AnalogCrystalElement (params: R_s, C_s, L_s, C_p)
- `src/components/passives/polarized-cap.ts` — AnalogPolarizedCapElement (params: C, ESR, leakage)
- `src/components/passives/tapped-transformer.ts` — AnalogTappedTransformerElement (params: rPri, coupling ratios)
- `src/components/passives/transformer.ts` — AnalogTransformerElement (params: rPri, coupling)
- `src/components/passives/transmission-line.ts` — TransmissionLineElement (params: Z0, delay)

**Pattern:** Each class has private fields read by stamp(). setParam should mutate those fields:
```typescript
setParam(key: string, value: number): void {
  if (key === 'R_s') this.G_s = 1 / value;
  // ... for each param
}
```
Reference the corresponding `FromModelParams` factory (now the only factory) for the param names — they're defined in the `defineModelParams()` call at the top of each file.

### R2: Fix TypeScript errors (928 remaining)
**Priority: HIGH** — Blocks CI.
**Categories:**
- `AnalogElement` interface has `setParam` optional vs `AnalogElementCore` required — type hierarchy mismatch in analog-types.ts
- Test stubs missing `getPinCurrents` (~15 test files)
- ac-voltage-source.ts and variable-rail.ts structural issues from mnaModels-tests agent migration
- Triage needed: which are pre-existing (baseline was ~1101) vs regressions from this session

### R3: DigitalInputPinModel `loaded=true` default
**Priority: MEDIUM** — Backwards-compat shim. Changing requires updating all behavioral element constructors that omit the `loaded` argument (they implicitly rely on `true`).
**File:** `src/solver/analog/digital-pin-model.ts:278`

### R4: Coordinator bridge tests — replace weak assertions
**Priority: MEDIUM** — 8 weak tests need real behavioral assertions.
**File:** `src/solver/__tests__/coordinator-bridge.test.ts`
- Replace not.toThrow with voltage/current verification
- Replace toBeDefined with instance identity checks
- Replace typeof checks with behavioral tests
- Add tests that exercise `coordinator.step()` (not just adapter API)

### R5: Mid-simulation hot-load test
**Priority: MEDIUM** — Spec-required, currently missing.
**Pattern:** compile → step N times → setParam("vOH", 5.0) on bridge output adapter → step again → verify analog node voltage changed.

### R6: MCP surface test for bridge behavior
**Priority: MEDIUM** — Three-surface rule violation.
**File to create:** `src/headless/__tests__/digital-pin-loading-mcp.test.ts`
**Content:** Bridge counts and loading behavior across all three modes via facade API.

### R7: Weakened DC-comparison test
**Priority: MEDIUM** — Known kludge.
**File:** `src/headless/__tests__/spice-import-roundtrip-mcp.test.ts`
**Action:** Restore behavioral assertion (compile → step → verify node voltages differ between default IS and overridden IS).

### R8: Wave 3 weak tests
**Priority: LOW** — toBeCloseTo(x, 20) should be toBe(x); auto-detect tests should test detectFormat(); guard assertions should check content.
**Files:** spice-import-roundtrip-mcp.test.ts, spice-model-apply.test.ts, spice-import-dialog.test.ts

### R9: Task 2.10 test file
**Priority: LOW** — Spec requires `src/core/__tests__/analog-types-setparam.test.ts` verifying setParam is required at compile time.

### R10: MCP tool surface for Task 3.1
**Priority: LOW** — Tests call applySpiceImportResult directly instead of through MCP tool handlers.

### R11: Fix E2E test infrastructure + write E2E tests for all waves
**Priority: HIGH** — E2E infrastructure (Playwright) is broken — tests hang or take 20+ minutes. Must be diagnosed and fixed before E2E tests can be written. Once fixed, E2E tests are needed for:
- Bridge behavior: digitalPinLoading mode changes produce visible simulation differences
- Wave 3: import .MODEL → save → reload → verify params persist
- Wave 3: model dropdown, model switch in property panel
Not blocked — infra fix IS the task.

### R12: Legacy comment in spice-model-overrides-prop.test.ts
**Priority: LOW** — Minor historical-provenance comment.

---

## What Was Done This Session (setParam specifics)

### No-op setParam (correct — no hot-loadable model params)
Added `setParam(_key: string, _value: number): void {}` to:
- **behavioral-gate.ts** — BehavioralGateElement class
- **behavioral-flipflop.ts** — BehavioralDFlipflopElement class
- **behavioral-sequential.ts** — BehavioralCounterElement, BehavioralRegisterElement, BehavioralCounterPresetElement
- **behavioral-combinational.ts** — BehavioralMuxElement, BehavioralDemuxElement, BehavioralDecoderElement
- **behavioral-remaining.ts** — 7 factory return objects (driver, driverInv, splitter, sevenSeg, relay, relayDT, buttonLED)
- **io/ground.ts** — createGroundAnalogElement
- **io/led.ts** — createLedAnalogElement
- **io/probe.ts** — AnalogProbeElement class
- **switching/switch.ts** — createSwitchAnalogElement
- **switching/switch-dt.ts** — createSwitchDTAnalogElement
- **test-fixtures/model-fixtures.ts** — STUB_ANALOG_FACTORY

### No-op setParam (WRONG — these have real params, needs R1 fix)
Added `setParam(_key: string, _value: number): void {}` to:
- **passives/analog-fuse.ts** — AnalogFuseElement
- **passives/crystal.ts** — AnalogCrystalElement
- **passives/polarized-cap.ts** — AnalogPolarizedCapElement
- **passives/tapped-transformer.ts** — AnalogTappedTransformerElement
- **passives/transformer.ts** — AnalogTransformerElement
- **passives/transmission-line.ts** — TransmissionLineElement

These 6 need real setParam that mutates internal fields (task R1).
