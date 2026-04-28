# Review Report: Batch 3 — Active + Sensors + IO/Mem + Flipflops (2.B.* part 2)

## Summary

| Metric | Value |
|--------|-------|
| Task groups reviewed | 7 |
| Files reviewed (source) | 25 |
| Files reviewed (tests) | 14 |
| Violations — critical | 0 |
| Violations — major | 4 |
| Violations — minor | 1 |
| Gaps | 2 |
| Weak tests | 0 |
| Legacy references | 0 |
| Verdict | **has-violations** |

Task groups reviewed: `2.B.opamps`, `2.B.timer-opto`, `2.B.adc-dac`, `2.B.controlled`, `2.B.sensors-io`, `2.B.io-mem`, `2.B.flipflops`.

---

## Violations

### V1 — C14: `withNodeIds` import in vccs.test.ts (major)

**File:** `src/components/active/__tests__/vccs.test.ts`
**Line:** 16
**Rule violated:** C14 — `withNodeIds\s*\(` forbidden in test files; helper was deleted in A.19.

**Evidence:**
```ts
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
```
and at line 50:
```ts
  return withNodeIds(
    getFactory(VCCSDefinition.modelRegistry!["behavioral"]!)(
      new Map([["ctrl+", nCtrlP], ["ctrl-", nCtrlN], ["out+", nOutP], ["out-", nOutN]]),
      props,
      () => 0,
    ),
    [nCtrlP, nCtrlN, nOutP, nOutN],
  );
```

**Assessment:** `withNodeIds` was deleted from `test-helpers.ts` as part of A.19. The import refers to a symbol that no longer exists. The `makeVCCSElement` helper inside the test still wraps the factory return value with the deleted `withNodeIds` call, meaning the entire helper function body depends on a removed API. The test was not rewritten to use `makeTestSetupContext` + `setupAll` as required by A.19. This is an incomplete migration of `2.B.controlled` (vccs.test.ts).

---

### V2 — C15: `makeVoltageSource` (4-arg form) import in vccs.test.ts (major)

**File:** `src/components/active/__tests__/vccs.test.ts`
**Lines:** 16, 103, 121, 139, 157
**Rule violated:** C15 — `makeVoltageSource\s*\(` forbidden; 4-arg helper was deleted in A.19.

**Evidence:**
```ts
// Line 16
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";

// Lines 103, 121, 139, 157 (representative):
const vs   = makeVoltageSource(1, 0, vsBranch, 1.0);
```

**Assessment:** `makeVoltageSource` (4-arg form) was deleted from `test-helpers.ts` in A.19. Four call sites remain. These tests cannot compile or run. The rewrite to `makeDcVoltageSource(Map, V)` + `setupAll` was not performed.

---

### V3 — C14: `withNodeIds` import in vcvs.test.ts (major)

**File:** `src/components/active/__tests__/vcvs.test.ts`
**Line:** 15
**Rule violated:** C14 — `withNodeIds\s*\(` forbidden in test files; helper was deleted in A.19.

**Evidence:**
```ts
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
```
and at line 49:
```ts
  return withNodeIds(
    getFactory(VCVSDefinition.modelRegistry!["behavioral"]!)(
      new Map([["ctrl+", nCtrlP], ["ctrl-", nCtrlN], ["out+", nOutP], ["out-", nOutN]]),
      props,
      () => 0,
    ),
    [nCtrlP, nCtrlN, nOutP, nOutN],
  );
```

**Assessment:** Same pattern as vccs.test.ts. The `makeVCVSElement` test helper wraps the factory return with the deleted `withNodeIds`. Test was not rewritten to use `makeTestSetupContext` + `setupAll`.

---

### V4 — C15: `makeVoltageSource` (4-arg form) import in vcvs.test.ts (major)

**File:** `src/components/active/__tests__/vcvs.test.ts`
**Lines:** 15, 98, 113, 129, 146, 163
**Rule violated:** C15 — `makeVoltageSource\s*\(` forbidden; 4-arg helper was deleted in A.19.

**Evidence:**
```ts
// Line 15
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";

// Lines 98, 113, 129, 146, 163 (representative):
const vs   = makeVoltageSource(1, 0, nodeCount + 1, 3.3);
```

**Assessment:** Five call sites in vcvs.test.ts. The rewrite to `makeDcVoltageSource(Map, V)` + `setupAll` was not performed.

---

### V5 — A.5/A.6: clock.ts `setup()` does not call `ctx.makeCur()` and has no `findBranchFor` (minor)

**File:** `src/components/io/clock.ts`
**Lines:** 251–279 (factory), 400–413 (modelRegistry)
**Rule violated:** A.5 — `setup()` is the sole allocation site for branch rows via `ctx.makeCur()`; A.6 — VSRC-topology elements must carry `findBranchFor` on the element.

**Evidence:**
```ts
// makeAnalogClockElement takes branchIdx as a constructor parameter:
export function makeAnalogClockElement(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,   // <-- branch row injected at construction, not allocated in setup()
  frequency: number,
  vdd: number,
  getTime: () => number,
): AnalogClockElement & ...

// Element literal initializes branchIndex from the param:
const element = {
  label: "",
  branchIndex: branchIdx,   // hard-set at construction, not via ctx.makeCur()
  ...
  setup(ctx: SetupContext): void {
    const k = branchIdx;   // uses closure param, never calls ctx.makeCur()
    if (nodePos !== 0) _hPosBranch = ctx.solver.allocElement(nodePos, k);
    ...
  },
  // No findBranchFor method
```

```ts
// modelRegistry factory passes branchIdx: -1
factory(pinNodes, props, getTime): AnalogElement {
  const nodePos = pinNodes.get("out")!;
  const nodeNeg = 0;
  return makeAnalogClockElement(nodePos, nodeNeg, -1, frequency, vdd, getTime);
}
```

**Assessment:** The progress note acknowledged this as "a pre-existing architectural choice where the clock element is constructed by the ClockManager path as well as the factory path" and classified it out-of-band. This is precisely the kind of justification comment that reviewer posture treats as confirmation of a known violation. The fact that the element serves dual construction paths does not exempt it from the A.5/A.6 contract. When constructed via the modelRegistry factory path, `branchIdx = -1` and `setup()` never allocates a branch row, so `branchIndex` remains -1 throughout simulation. Additionally, `_pinNodes` only maps "out" — it omits the implicit ground/neg node that the element stamps against. The violation is marked minor rather than critical only because the out-of-band acknowledgment is explicit and the ClockManager path does provide a branchIdx at construction for that specific consumer. However, it is a contract violation that must be reported.

---

## Gaps

### G1 — vccs.test.ts not rewritten to A.19 factory + setupAll pattern

**Spec requirement:** A.19 — test call sites must drop `withNodeIds` and 4-arg `makeVoltageSource`; construct elements via production factory + `makeTestSetupContext` / `setupAll`. B.14 lists `src/components/active/__tests__/cccs.test.ts` and implicitly `vccs.test.ts` in the active/mixed test batch.

**What was found:** `vccs.test.ts` still imports and calls `withNodeIds` (deleted) and `makeVoltageSource` 4-arg form (deleted). The task_group 2.B.controlled progress entry reports "all clean" for C.1 forbidden-pattern greps and marks status complete, but the test files for vccs were not rewritten.

**File:** `src/components/active/__tests__/vccs.test.ts`

---

### G2 — vcvs.test.ts not rewritten to A.19 factory + setupAll pattern

**Spec requirement:** Same as G1 — A.19 test rewrite mandate applies to all test files touching controlled-source elements.

**What was found:** `vcvs.test.ts` still imports and calls `withNodeIds` (deleted) and `makeVoltageSource` 4-arg form (deleted). The task_group 2.B.controlled progress entry marks vcvs.ts complete without addressing the test file.

**File:** `src/components/active/__tests__/vcvs.test.ts`

---

## Weak Tests

None found. All test files examined use concrete numeric assertions with specific voltage/current values where applicable.

---

## Legacy References

None found. No comments containing "legacy", "fallback", "workaround", "temporary", "previously", "backwards compatible", "shim", "migrated from", or "replaced" were found in the reviewed source files.

---

## Per-file findings detail

### 2.B.opamps

**opamp.ts** — Clean. C.1 forbidden patterns: all zero. R1 present (`_pinNodes: new Map(pinNodes)` line 201), R2 present (`label: ""` line 197), R3 present (3-arg factory line 158–162), R4 present (`getInternalNodeLabels()` line 250, `ctx.makeVolt` line 215). No C19 violation (not a CompositeElement subclass). A.9 TSTALLOC handles are closure-locals. Note: `hVcvsNegIbr` and `hVcvsIbrNeg` are deliberately set to -1 rather than allocated (ground row/col skip) — flagged as out-of-band per progress note, not a C.1 violation.

**real-opamp.ts** — Clean. C.1 forbidden patterns: all zero. R1 present (line 438), R2 present (line 434), R3 present (line 332–336). R4 not applicable (no ctx.makeVolt calls). A.9 TSTALLOC handles are closure-locals per progress note.

**ota.ts** — Clean. C.1 forbidden patterns: all zero. R1 present (`_pinNodes: new Map(pinNodes)` line 185), R2 present (`label: ""` line 181), R3 present (3-arg factory line 148–152). TSTALLOC handles confirmed as closure-locals (`let _hPCP = -1` etc., lines 171–174). A.9 migration confirmed complete. R4 not applicable.

**comparator.ts** — Clean. C.1 forbidden patterns: all zero. R1 present (lines 244, 396), R2 present (lines 240, 392), R3 present (lines 200–204, 351–355). R4 not applicable. Out-of-band: capacitor.ts flow-on noted in progress record; not a violation in comparator.ts itself.

### 2.B.timer-opto

**schmitt-trigger.ts** — Clean. C.1 forbidden patterns: all zero. R1 present (line 172), R2 present (line 168), R3 present (3-arg modelRegistry lambda).

**timer-555.ts** — Clean of C.1 forbidden patterns. R1 present (`this._pinNodes = new Map(opts.pinNodes)` in constructor), R2 present (lines 135 and 685), R3 present (line 692), R4 present (`getInternalNodeLabels()` line 448). C19 NOT applicable: `Timer555CompositeElement implements PoolBackedAnalogElement` directly, does not extend `CompositeElement` — confirmed not in the A.15 mandate list per progress note. `ctx.makeVolt` calls in its `setup()` are on a hand-rolled composite and are therefore not subject to the composite-class restriction. Out-of-band: stateSchema uses inline `as any` object; `_hComp1OutComp1Out`/`_hComp2OutComp2Out` handles unused in setup() — both latent-stamp-gap items per A.20.

**optocoupler.ts** — Clean of C.1 forbidden patterns. R1 present (`this._pinNodes = new Map(pinNodes)` in constructor), R2 present on all three sub-element classes and composite, R3 present (3-arg factory), R4 present (`getInternalNodeLabels()` on OptocouplerCompositeElement). Out-of-band (confirmed from progress note): `OptocouplerCompositeElement implements AnalogElement` (not `PoolBackedAnalogElement`), contains pool-backed BJT sub-element whose `initState` is never called — state pool uninitialized. This is a pre-existing architectural gap explicitly signaled in the progress record as requiring a follow-on pass.

### 2.B.adc-dac

**analog-switch.ts** — Clean. C.1 forbidden patterns: all zero. R1, R2 present. TSTALLOC handles confirmed as closure-locals. A.15 composite mandate does not apply (leaf element, not composite).

**adc.ts** — A.15 compliant: `ADCAnalogElement extends CompositeElement` (line 194). `readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS` (line 195), `readonly stateSchema = ADC_COMPOSITE_SCHEMA` (line 196) — both required subclass fields present. R1 present (`this._pinNodes = new Map(pinNodes)` in constructor), R2 present via CompositeElement base, R6 present. No `ctx.makeVolt` calls (C19 clean). C.1 forbidden patterns: all zero.

**dac.ts** — A.15 compliant: `DACAnalogElement extends CompositeElement` (line 248). `readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS` (line 249), `readonly stateSchema = DAC_COMPOSITE_SCHEMA` (line 250) present. R1 present, R2 inherited from base, R6 present. No `ctx.makeVolt` calls (C19 clean). C.1 forbidden patterns: all zero.

### 2.B.controlled

**ccvs.ts** — Clean source file. C.1 forbidden patterns: all zero. R1 present (`el._pinNodes = new Map(pinNodes)` line 374), R2 present via ControlledSourceElement base inheritance, R5 present via base class inheritance. No redundant field re-declarations per progress note.

**vcvs.ts** — Clean source file. C.1 forbidden patterns: all zero. R1 present (`el._pinNodes = new Map(pinNodes)` line 349), R2 present via base inheritance, R5 present via base inheritance.

**vccs.ts** — Clean source file. C.1 forbidden patterns: all zero. R1 present (`el._pinNodes = new Map(pinNodes)` line 344), R2 present via base inheritance. R5 N/A (VCCS has no branch row — Norton stamp only).

**cccs.ts** — Clean source file. C.1 forbidden patterns: all zero. R1 present (`el._pinNodes = new Map(pinNodes)` line 373), R2 present via base inheritance. R5 N/A (CCCS has no own branch row).

**vccs.test.ts / vcvs.test.ts** — See Violations V1–V4 and Gaps G1–G2 above.

### 2.B.sensors-io

**ldr.ts** — Clean. C.1 forbidden patterns: all zero. R1 present (factory post-construct `this._pinNodes = new Map(pinNodes)`), R2 present (`label: string = ""`), R3 present (3-arg factory). A.18 clean (no `.getString`/`.getNumber`/`.getBoolean` calls).

**ntc-thermistor.ts** — Clean. C.1 forbidden patterns: all zero. R1, R2, R3 present. Dead flag `this.isReactive = selfHeating` in constructor removed per progress note. A.18 clean.

**spark-gap.ts** — Clean. C.1 forbidden patterns: all zero. R1, R2, R3 present. A.18 clean.

**led.ts** — Clean. Import changed to `AnalogElement` from `../../core/analog-types.js` (confirmed). `getTime` parameter is now required (not optional) in `createLedAnalogElementViaDiode` (confirmed). R1/R2/R4 not applicable (factory delegates entirely to `createDiodeElement`, owns no element literal). A.18 clean.

**clock.ts** — C.1 forbidden patterns: all zero. R2 present (`label: ""` line 267). R1 partial concern: `_pinNodes: new Map<string, number>([["out", nodePos]])` — single-entry map constructed from extracted nodePos rather than `new Map(pinNodes)`; the modelRegistry factory extracts `nodePos = pinNodes.get("out")!` and passes it to `makeAnalogClockElement`. The map content is semantically equivalent to pinNodes for a 1-pin component. See Violation V5.

### 2.B.io-mem

**probe.ts** — Clean. `branchIndex: number = -1` confirmed mutable (not `readonly`). R1 present (factory `el._pinNodes = new Map(pinNodes)`), R2 present (`label: string = ""`). No forbidden patterns.

**driver-inv.ts** — Clean. `mayCreateInternalNodes` removed. Component definition file only; no analog factory.

**register.ts, counter.ts, counter-preset.ts** — All clean. `mayCreateInternalNodes: false` removed from behavioral model registry entries. Component definition files only; analog factory compliance is the responsibility of `behavioral-sequential.ts`.

### 2.B.flipflops (component definitions)

**t.ts, rs.ts** — Clean. `mayCreateInternalNodes: false` removed. Component definition files only; analog factory compliance is the responsibility of the respective behavioral-flipflop files.

**rs-async.ts, jk.ts, jk-async.ts, d.ts, d-async.ts** — All clean. `mayCreateInternalNodes: false` removed. C.1 forbidden patterns: all zero across all five files. N/A for R1–R6 (component definition files, not analog element factories).
