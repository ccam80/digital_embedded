# Review Report: setup-load-cleanup Batch 6 (4.D.*- all task_groups)

## Summary

- **Tasks reviewed**: 46 task_group entries across all 4.D.* groups
- **Violations**: 14 (4 critical, 5 major, 5 minor)
- **Gaps**: 3
- **Weak tests**: 6
- **Legacy references**: 7
- **Verdict**: has-violations

---

## Violations

### V-01- CRITICAL
**File**: `src/components/passives/__tests__/transformer.test.ts`, line 37  
**Rule**: ssC.1 C15- 4-arg `makeVoltageSource` is a forbidden pattern; must be deleted from test-helpers and replaced by `makeDcVoltageSource(Map, V)`.  
**Evidence**:
```typescript
import { makeVoltageSource, makeResistor, makeLoadCtx, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
```
`makeVoltageSource` is no longer exported from test-helpers.ts (it was deleted as part of the migration). This is a broken import of a forbidden deleted symbol. The function is called 4-arg at lines 207 (comment), 296 (comment), 394 (comment), 448 (comment), 483 with actual call `makeVoltageSource(...)`.  
**Progress.md claim**: "Forbidden-pattern greps (Section C.1): all clean"- false.  
**Severity**: critical

---

### V-02- CRITICAL
**File**: `src/components/passives/__tests__/transformer.test.ts`, lines 147–167  
**Rule**: ssC.1 C14 + ssA.19 factory+setupAll pattern; also constructor API mismatch against production `AnalogTransformerElement`.  
**Evidence** (makeTransformerElement helper):
```typescript
function makeTransformerElement(opts: { pinNodeIds: number[]; branch1: number; ... }) {
  ...
  return new AnalogTransformerElement(opts.pinNodeIds, opts.branch1, opts.lPrimary ?? 10e-3, ...);
}
```
The production constructor signature (transformer.ts) is:
```typescript
constructor(pinNodes: ReadonlyMap<string, number>, lPrimary: number, ...)
```
The old `branch1` parameter was eliminated and the first arg changed from `number[]` to `ReadonlyMap<string,number>`. The test helper passes a raw `number[]` as the first arg and a `number` (branch1) as the second arg- both wrong types. Every test in this file that calls `makeTransformerElement` constructs an element via a stale API that no longer matches production.  
**Severity**: critical

---

### V-03- CRITICAL
**File**: `src/components/passives/__tests__/tapped-transformer.test.ts`, line 30  
**Rule**: ssC.1 C15- 4-arg `makeVoltageSource` forbidden pattern; deleted from test-helpers.  
**Evidence**:
```typescript
import { makeVoltageSource, makeResistor, makeDiode, makeCapacitor, makeAcVoltageSource, allocateStatePool, loadCtxFromFields } from "../../../solver/analog/__tests__/test-helpers.js";
```
`makeVoltageSource`, `makeResistor`, `makeDiode`, `makeCapacitor`, `makeAcVoltageSource` are all NOT exported from test-helpers.ts (confirmed by exhaustive export scan). This is a multi-symbol broken import.  
`makeVoltageSource` is called 4-arg at line 54: `const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);`  
**Progress.md claim**: "Forbidden-pattern greps (Section C.1): all clean"- false.  
**Severity**: critical

---

### V-04- CRITICAL
**File**: `src/components/passives/__tests__/tapped-transformer.test.ts`, lines 130–148  
**Rule**: ssA.19- constructor API mismatch against production `AnalogTappedTransformerElement`.  
**Evidence** (makeTappedTransformer helper):
```typescript
function makeTappedTransformer(opts: { pinNodeIds: number[]; branch1: number; ... }) {
  return new AnalogTappedTransformerElement(opts.pinNodeIds, opts.branch1, opts.lPrimary, opts.turnsRatio, opts.couplingCoeff, opts.rPri, opts.rSec);
}
```
Production constructor signature (tapped-transformer.ts):
```typescript
constructor(nodeIds: number[], label: string, primaryInductance: number, turnsRatio: number, couplingCoefficient: number)
```
The test passes `opts.branch1: number` as the second argument (`label: string`)- type mismatch. The test also passes two additional arguments `rPri` and `rSec` (args 6–7) that do not exist in the 5-parameter production constructor.  
**Severity**: critical

---

### V-05- MAJOR
**File**: `src/components/passives/__tests__/resistor.test.ts`, line 198  
**Rule**: ssC.1 C15- import of the deleted 4-arg `makeVoltageSource` from test-helpers (aliased as `makeVoltageSourceLoadCtx`).  
**Evidence**:
```typescript
import {
  makeResistor as makeResistorLoadCtx,
  makeVoltageSource as makeVoltageSourceLoadCtx,
} from "../../../solver/analog/__tests__/test-helpers.js";
```
Called 4-arg at line 227: `const vs = makeVoltageSourceLoadCtx(1, 0, branchRow, 5.0);`  
Neither `makeVoltageSource` nor `makeResistor` are exported from test-helpers.ts- both are deleted symbols. Renaming via `as` alias does not make the C15 pattern compliant.  
**Progress.md claim**: "Forbidden-pattern greps (Section C.1): all clean"- false (alias evaded the grep).  
**Severity**: major

---

### V-06- MAJOR
**File**: `src/components/passives/__tests__/potentiometer.test.ts`, line 20  
**Rule**: ssC.1 C14- `withNodeIds` is a forbidden pattern that must be deleted.  
**Evidence**:
```typescript
import { makeSimpleCtx, makeLoadCtx, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
```
`withNodeIds` is not exported from test-helpers.ts (confirmed by export scan). Called at line 237:
```typescript
const analogElement = withNodeIds(core, [1, 2, 3]);
```
Note: potentiometer.test.ts does not appear in any 4.D.* task_group entry- the file was not migrated as part of this batch. Reported here as an out-of-band finding within the passives `__tests__` directory that is covered by the wave scope.  
**Severity**: major

---

### V-07- MAJOR
**File**: `src/components/passives/__tests__/tx_trace.test.ts`, line 5  
**Rule**: ssC.1 C15- import of the deleted 4-arg `makeVoltageSource` from test-helpers.  
**Evidence**:
```typescript
import { allocateStatePool, makeVoltageSource, makeResistor, loadCtxFromFields } from "../../../solver/analog/__tests__/test-helpers.js";
```
Called 4-arg at line 54: `const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);`  
Neither `makeVoltageSource` nor `makeResistor` are exported from test-helpers.ts. `tx_trace.test.ts` has no 4.D.* task_group entry- it was not migrated as part of this batch. Reported as an out-of-band finding within the passives `__tests__` directory covered by the wave scope.  
**Severity**: major

---

### V-08- MAJOR
**File**: `src/components/passives/__tests__/tx_trace.test.ts`, line 6  
**Rule**: ssC.1- import of `AnalogElementCore` which is a removed/renamed type.  
**Evidence**:
```typescript
import type { AnalogElementCore } from "../../../solver/analog/element.js";
```
`AnalogElementCore` was renamed/replaced by `AnalogElement` as part of Phase 4 migration. The fix passes for transformer.test.ts and tapped-transformer.test.ts specifically deleted this import. The tx_trace.test.ts file was never migrated.  
**Severity**: major

---

### V-09- MINOR
**File**: `src/components/semiconductors/__tests__/bjt.test.ts`, line 2018  
**Rule**: Code Hygiene- historical-provenance comment ban. Comments describing what code "previously" did or what "replaced" what are dead-code markers.  
**Evidence**:
```typescript
// SUBS was previously declared as an instance param; it is now expressed as ...
```
**Severity**: minor

---

### V-10- MINOR
**File**: `src/components/semiconductors/__tests__/tunnel-diode.test.ts`, line 604  
**Rule**: Code Hygiene- historical-provenance comment ban.  
**Evidence**:
```typescript
// Step 3a: IBEQ/IBSW/NB migrated from plain Diode into TunnelDiode's secondary group.
```
Word "migrated" is an explicit trigger for this rule.  
**Severity**: minor

---

### V-11- MINOR
**File**: `src/components/passives/__tests__/capacitor.test.ts`, line 645  
**Rule**: Code Hygiene- old API terminology surviving in comments.  
**Evidence**:
```typescript
// Element setup: cap between node 2 (pos) and gnd (0), pinNodeIds=[2,0]
```
`pinNodeIds` was the removed field. Comments referencing removed API names are provenance comments that describe historical behaviour.  
**Severity**: minor

---

### V-12- MINOR
**File**: `src/components/passives/__tests__/inductor.test.ts`, line 487  
**Rule**: Code Hygiene- old API terminology surviving in comments.  
**Evidence**:
```typescript
// pinNodeIds=[2,0], branchIndex=3
```
**Severity**: minor

---

### V-13- MINOR
**File**: `src/components/passives/__tests__/polarized-cap.test.ts`, lines 541, 659  
**Rule**: Code Hygiene- old API terminology surviving in comments.  
**Evidence** (line 541):
```typescript
// Build element: pinNodeIds = [n_pos=1, n_neg=0, n_cap=2]
```
**Severity**: minor

---

## Gaps

### G-01
**Spec requirement**: ssA.19- transformer.test.ts must use `makeTestSetupContext({startBranch})` + `setupAll([elements], ctx)` + `makeDcVoltageSource(Map, V)` factory+setupAll pattern.  
**What was found**: File still uses the old ad-hoc `makeLoadCtx` / `makeVoltageSource` helpers that were supposed to be deleted. The `makeTransformerElement` helper still takes `opts.pinNodeIds: number[]` and `opts.branch1: number` and calls the production constructor with the pre-migration argument list.  
**File**: `src/components/passives/__tests__/transformer.test.ts`

---

### G-02
**Spec requirement**: ssA.19- tapped-transformer.test.ts must use the factory+setupAll pattern and `makeDcVoltageSource(Map, V)`.  
**What was found**: File still uses the old 4-arg `makeVoltageSource`, `makeResistor`, `makeDiode`, `makeCapacitor`, `makeAcVoltageSource` from test-helpers (all deleted). `makeTappedTransformer` helper passes `branch1: number` as the `label: string` arg and passes `rPri`/`rSec` args that don't exist in the production constructor.  
**File**: `src/components/passives/__tests__/tapped-transformer.test.ts`

---

### G-03
**Spec requirement**: ssB.14- all flag-only `it()` blocks asserting `isReactive`/`isNonlinear`/`pinNodeIds.length` must be deleted.  
**What was found**: Progress.md entry for transformer.test.ts mentions deleting `"isReactive is true"` flag-only block. No mention of `isNonlinear` block deletion. The fix entry (task_group 4.D.passive-2 (fix)) only changed type annotations (line 41 AnalogElementCore, line 135 parameter type). No confirmation that all flag-only blocks were found and removed.  
**File**: `src/components/passives/__tests__/transformer.test.ts`

---

## Weak Tests

### WT-01
**Test**: `src/components/passives/__tests__/analog-fuse.test.ts::definition_completeness::modelRegistry behavioral entry`  
**Problem**: Chain of `toBeDefined()` assertions that verify object existence, not behaviour. The final `.factory` check only confirms a property exists, not that calling it produces a correctly-behaving element.  
**Evidence**:
```typescript
expect(FuseDefinition.modelRegistry?.behavioral).toBeDefined();
expect((FuseDefinition.modelRegistry?.behavioral as {...}|undefined)?.factory).toBeDefined();
```

---

### WT-02
**Test**: `src/components/passives/__tests__/capacitor.test.ts::definition_completeness::modelRegistry behavioral entry`  
**Problem**: `toBeDefined()` on `CapacitorDefinition.modelRegistry?.behavioral` and `.factory`- trivially true existence checks with no behavioral assertion.  
**Evidence**:
```typescript
expect(CapacitorDefinition.modelRegistry?.behavioral).toBeDefined();
expect((CapacitorDefinition.modelRegistry?.behavioral as {...}|undefined)?.factory).toBeDefined();
```

---

### WT-03
**Test**: `src/components/passives/__tests__/crystal.test.ts::factory_construction::creates element with correct pin map and branch`  
**Problem**: `expect(el).toBeDefined()` and `expect(m).toBeDefined()` without checking any behavioral properties of the constructed element (no pin count, no stamp values, no load behavior).  
**Evidence**:
```typescript
expect(el).toBeDefined();
expect(m).toBeDefined();
```

---

### WT-04
**Test**: `src/components/passives/__tests__/resistor.test.ts::stamp_parity_ngspice::stamp diagonal values`  
**Problem**: The `e00`, `e11`, `e22` pattern uses `expect(e00).toBeDefined()` then `expect(e00!.value).toBe(...)`. The `toBeDefined()` line is a weak guard- if `stamps.find()` returns undefined, the test would fail with a misleading message on the next line rather than a clear assertion. The behavioral assertion `expect(e00!.value)` is sound; the preceding `toBeDefined()` is redundant but forms a weak assertion pattern.  
**Evidence**:
```typescript
const e00 = stamps.find((e) => e.row === 1 && e.col === 1);
expect(e00).toBeDefined();
expect(e00!.value).toBe(NGSPICE_G_REF);
```

---

### WT-05
**Test**: `src/components/semiconductors/__tests__/scr.test.ts`- element construction test  
**Problem**: `expect(element).toBeDefined()` at line 131 with no further behavioral assertions on the constructed element- purely a trivially-true existence check.  
**Evidence**:
```typescript
expect(element).toBeDefined();
```

---

### WT-06
**Test**: `src/components/passives/__tests__/polarized-cap.test.ts::definition_completeness::factory exists`  
**Problem**: `expect(factory).toBeDefined()` and `expect(el).toBeDefined()`- trivially-true existence checks.  
**Evidence**:
```typescript
expect(factory).toBeDefined();
expect(el).toBeDefined();
```

---

## Legacy References

### LR-01
**File**: `src/components/passives/__tests__/transformer.test.ts`, line 37  
**Reference**: `makeVoltageSource`- deleted export from test-helpers.ts; forbidden C15 pattern.

---

### LR-02
**File**: `src/components/passives/__tests__/tapped-transformer.test.ts`, line 30  
**Reference**: `makeVoltageSource`, `makeResistor`, `makeDiode`, `makeCapacitor`, `makeAcVoltageSource`- all deleted exports from test-helpers.ts.

---

### LR-03
**File**: `src/components/passives/__tests__/resistor.test.ts`, line 198  
**Reference**: `makeVoltageSource as makeVoltageSourceLoadCtx`, `makeResistor as makeResistorLoadCtx`- deleted exports from test-helpers.ts, aliased to evade grep.

---

### LR-04
**File**: `src/components/passives/__tests__/potentiometer.test.ts`, line 20  
**Reference**: `withNodeIds`- deleted export from test-helpers.ts; forbidden C14 pattern.

---

### LR-05
**File**: `src/components/passives/__tests__/tx_trace.test.ts`, line 5  
**Reference**: `makeVoltageSource`, `makeResistor`- deleted exports from test-helpers.ts.

---

### LR-06
**File**: `src/components/passives/__tests__/tx_trace.test.ts`, line 6  
**Reference**: `AnalogElementCore`- removed/renamed type, replaced by `AnalogElement`.

---

### LR-07
**File**: `src/components/passives/__tests__/transformer.test.ts`, lines 147–167  
**Reference**: `opts.pinNodeIds: number[]`, `opts.branch1: number` in `makeTransformerElement` helper- pre-migration constructor argument pattern referencing eliminated `branch1` parameter and old array-type first arg.

---
