# Review Report: Batch 1- P1 source code (1.A.* task_groups)

Spec: `spec/setup-load-cleanup.md` (Sections A and C)
Reviewed: 2026-04-29

---

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 11 task_groups (1.A.engine, 1.A.compiler, 1.A.engine-misc, 1.A.solver-core, 1.A.behav-gates, 1.A.behav-rest, 1.A.ff-vsrc, 1.A.sources-passives-1, 1.A.passives-2, 1.A.passives-3, 1.A.passives-4) |
| Violations- critical | 4 |
| Violations- major | 3 |
| Violations- minor | 3 |
| Gaps | 2 |
| Weak tests | 0 |
| Legacy references | 3 |

**Verdict: has-violations**

---

## Violations

### V-01- C16 stateBaseOffset survives in shared.ts (critical)

**File:** `src/solver/analog/behavioral-flipflop/shared.ts`
**Lines:** 88, 89, 98
**Rule violated:** ssA.1 / C16- `stateBaseOffset` is forbidden everywhere; renamed to `_stateBase`.

**Evidence:**
```ts
// line 88-89 (JSDoc for initChildState):
 * Assigns consecutive stateBaseOffsets to each child starting from the
 * element's own stateBaseOffset, then calls each child's initState.

// line 98 (production code- assigns banned field):
    child.stateBaseOffset = offset;
```

`shared.ts` is in the direct dependency chain of `1.A.behav-gates` files `d-async.ts` and `jk.ts`, and of `behavioral-flipflop.ts` (all part of `1.A.behav-gates`). The `initChildState` function writes `child.stateBaseOffset`- the banned field name- onto live `AnalogCapacitorElement` children. At runtime, post-wave, `AnalogCapacitorElement.initState()` reads `this._stateBase` (the new field), not `stateBaseOffset`. The `initChildState` assignment writes to the wrong field name, leaving `_stateBase` as `-1` on all child capacitors. This is a functional correctness bug, not just a naming issue.

The JSDoc comment on lines 88-89 is a historical-provenance comment describing the old field name- a further rule violation (rules.md "No commented-out code / No `# previously this was...` comments").

**Severity: critical**

---

### V-02- d-async.ts and jk.ts override load() using legacy `loadChildren` helper instead of `super.load(ctx)` (critical)

**Files:**
- `src/solver/analog/behavioral-flipflop/d-async.ts` lines 19-20, 108-121
- `src/solver/analog/behavioral-flipflop/jk.ts` lines 19-20, 105-117

**Rule violated:** ssA.15- subclasses of `CompositeElement` must rely on the base-class `load()` forwarder (or call `super.load(ctx)` after class-specific stamps). They must not hand-roll `loadChildren(this._childElements, ctx)` using the old shared helper.

**Evidence (d-async.ts):**
```ts
import {
  // ...
  loadChildren,
  checkChildConvergence,
} from "./shared.js";

// load() override- hand-rolls child loading using the legacy helper:
load(ctx: LoadContext): void {
  this._setPin.load(ctx);
  // ... other pin loads ...
  loadChildren(this._childElements, ctx);   // ← should be super.load(ctx)
}
```

The `CompositeElement.load()` base method forwards to all elements returned by `getSubElements()`. Since `getSubElements()` already returns all pin models plus `_childElements`, calling `loadChildren(this._childElements, ctx)` inside an overridden `load()` that also explicitly calls each pin's `load()` results in the pin models being loaded once (explicitly) while children are loaded once via the helper- but the `super.load(ctx)` path is never called at all. This means any future additions to `getSubElements()` will be silently skipped.

More critically, the progress report for `1.A.behav-gates` (d-async.ts) states "No forbidden fields present" and claims `getSubElements()` and `super.load()` are in use, but the actual file uses the legacy `loadChildren` helper and does NOT call `super.load(ctx)`. The progress report is inaccurate.

Same pattern in jk.ts (lines 105-117 and import at lines 19-20).

**Severity: critical**

---

### V-03- behavioral-flipflop.ts uses `loadChildren` instead of `super.load(ctx)` (critical)

**File:** `src/solver/analog/behavioral-flipflop.ts`
**Lines:** 29, 162

**Rule violated:** ssA.15- same issue as V-02. `BehavioralDFlipflopElement extends CompositeElement` but its `load()` override calls `loadChildren(this._childElements, ctx)` from the legacy shared helper rather than `super.load(ctx)`.

**Evidence:**
```ts
import {
  loadChildren,
  // ...
} from "./behavioral-flipflop/shared.js";    // line 29- legacy helper import

// line 162 in load() override:
    loadChildren(this._childElements, ctx);   // ← should be super.load(ctx)
```

This is a member of `1.A.behav-gates` task_group. The progress report for this file claims all edits were completed and all greps are clean, yet the file retains the legacy forwarding pattern.

**Severity: critical**

---

### V-04- potentiometer.test.ts uses `withNodeIds` and `allNodeIds`/`pinNodeIds` dead fields (major)

**File:** `src/components/passives/__tests__/potentiometer.test.ts`
**Lines:** 73, 105, 135, 237

**Rule violated:** ssA.1 / C6 / C7 / C14- `withNodeIds` helper is deleted; `allNodeIds` and `pinNodeIds` field-decl forms are forbidden.

**Evidence:**
```ts
// lines 73, 105, 135- field-decl forms (C6 and C7 violations):
const analogElement = Object.assign(core, {
  pinNodeIds: [1, 2, 3] as readonly number[],
  allNodeIds: [1, 2, 3] as readonly number[]
}) as unknown as AnalogElement;

// line 237- deleted helper (C14 violation):
const analogElement = withNodeIds(core, [1, 2, 3]);
```

The potentiometer is in `1.A.passives-4` which is marked `complete`, yet the test file retains three Object.assign calls writing forbidden field names onto elements and one direct `withNodeIds` call. These are the exact patterns ssA.1 and C6/C7/C14 prohibit.

**Severity: major**

---

### V-05- transformer.test.ts uses `pinNodeIds` field-decl form (major)

**File:** `src/components/passives/__tests__/transformer.test.ts`
**Lines:** 148, 215, 302, 401, 488, 582, 620

**Rule violated:** ssA.1 / C7- `pinNodeIds` field-decl form is forbidden.

**Evidence (representative):**
```ts
// line 148- type declaration:
  pinNodeIds: number[];

// line 215- field assignment:
      pinNodeIds: [1, 0, 2, 0],
```

The transformer task_group (`1.A.passives-2`) is marked `complete`. The progress report for `transformer.ts` explicitly signals "Any test calling `new AnalogTransformerElement([p1,p2,s1,s2], ...)` (positional array form) must be updated to pass a Map- callers in transformer.test.ts will need updating (B.14 test agent)." However, the test file has not been updated: it still declares and assigns `pinNodeIds` as a plain field on its test fixture objects (C7 field-decl form). Seven occurrences.

**Severity: major**

---

### V-06- tapped-transformer.test.ts uses `pinNodeIds` field-decl form (major)

**File:** `src/components/passives/__tests__/tapped-transformer.test.ts`
**Lines:** 131, 190, 266, 356

**Rule violated:** ssA.1 / C7- `pinNodeIds` field-decl form is forbidden.

**Evidence (representative):**
```ts
// line 131- type declaration:
  pinNodeIds: number[];

// line 190- field assignment:
      pinNodeIds: [1, 0, 2, 3, 4],
```

The tapped-transformer task_group (`1.A.passives-3`) is marked `complete`. The test file retains `pinNodeIds` as a field name in test fixtures. Four occurrences.

**Severity: major**

---

### V-07- current-source-kcl.test.ts uses banned `withNodeIds` helper (minor)

**File:** `src/components/sources/__tests__/current-source-kcl.test.ts`
**Lines:** 33, 68

**Rule violated:** ssA.1 / C14- `withNodeIds` helper is deleted.

**Evidence:**
```ts
// line 33:
const src = withNodeIds(srcCore, [0, 1]); // pinNodeIds: [neg=node0, pos=node1]

// line 68:
const src = withNodeIds(srcCore, [0, 1]);
```

The `1.A.sources-passives-1` task_group is marked `complete`. The test file retains two calls to the deleted `withNodeIds` helper. The inline comment on line 33 ("// pinNodeIds: [neg=node0, pos=node1]") is also a historical-provenance comment describing the old positional array field.

**Severity: minor**

---

### V-08- controlled-source-base.test.ts declares `allNodeIds` and `pinNodeIds` field-decl forms (minor)

**File:** `src/solver/analog/__tests__/controlled-source-base.test.ts`
**Lines:** 29, 30

**Rule violated:** ssA.1 / C6 / C7- field-decl forms of `pinNodeIds` and `allNodeIds` are forbidden.

**Evidence:**
```ts
// lines 29-30:
  readonly pinNodeIds: readonly number[] = [1, 0];
  readonly allNodeIds: readonly number[] = [1, 0];
```

The `1.A.engine-misc` task_group owns `controlled-source-base.ts` and is marked `complete`. The associated test file retains the banned field declarations in a test stub class. These are field-decl forms (C6/C7), not data-record fields.

**Severity: minor**

---

### V-09- behavioral-flipflop.test.ts writes `pinNodeIds`/`allNodeIds` via Object.assign (minor)

**File:** `src/solver/analog/__tests__/behavioral-flipflop.test.ts`
**Line:** 327

**Rule violated:** ssA.1 / C6 / C7- field-decl / field-assignment forms of `pinNodeIds` and `allNodeIds` are forbidden.

**Evidence:**
```ts
// line 327:
    Object.assign(element, { pinNodeIds: [1, 2, 3, 4], allNodeIds: [1, 2, 3, 4] });
```

This test is in the `1.A.behav-gates` group. The element is a live `BehavioralDFlipflopElement` (which extends `CompositeElement`). Writing forbidden field names onto it post-construction is both a C6/C7 violation and semantically incorrect- the element now carries dead fields that the engine will never read.

**Severity: minor**

---

## Gaps

### G-01- 1.A.passives-3 marked complete but task_group status is `failed`

**Spec requirement:** ssB.5- `tapped-transformer.ts` and `transmission-line.ts` must be fully compliant with ssA.

**What was found:** The assignment explicitly marks `1.A.passives-3` as `group_status: failed`. The progress.md entries for both files show `Status: complete`, which is inconsistent with the group-level failure status. The forbidden-pattern grep results for both source files return zero hits (source files appear clean), but no explanation is given for the group failure. The reviewer cannot determine from available evidence whether the failure is in a test file, a compilation error, a runtime failure, or a reporting inconsistency.

The `1.A.passives-3 (fix-r2)` entry in progress.md (at line 3622) indicates a second-round fix to `transmission-line.ts` was applied but only the transmission-line.ts file is listed, not tapped-transformer.ts. This suggests the group failed after initial completion and was re-attempted for transmission-line.ts only.

**File path:** `src/components/passives/tapped-transformer.ts`, `src/components/passives/transmission-line.ts`

---

### G-02- shared.ts `initChildState` function is orphaned dead code after CompositeElement refactor

**Spec requirement:** ssA.15- all 18 composite classes extend `CompositeElement`; the base class `initState()` handles child state allocation. The `initChildState` helper in `shared.ts` is no longer needed.

**What was found:** After the `CompositeElement` refactor, the `initChildState` function in `src/solver/analog/behavioral-flipflop/shared.ts` (lines 91-102) is exported but never called by any file in the codebase. A grep for `initChildState` across all of `src/solver/analog` shows zero call sites outside `shared.ts` itself. The function also writes the banned `stateBaseOffset` field (V-01 above). The spec does not explicitly list `shared.ts` in the B.3 work list, but the wave's "all replaced/edited code is removed entirely- scorched earth" rule requires dead helpers to be deleted.

**File path:** `src/solver/analog/behavioral-flipflop/shared.ts` lines 86-102

---

## Weak Tests

None found.

---

## Legacy References

### L-01- shared.ts JSDoc comment uses "stateBaseOffset" as if it is current API

**File:** `src/solver/analog/behavioral-flipflop/shared.ts`
**Lines:** 88-89

**Evidence:**
```ts
 * Assigns consecutive stateBaseOffsets to each child starting from the
 * element's own stateBaseOffset, then calls each child's initState.
```

This is a historical-provenance comment describing the old field name in present tense. Per rules.md, comments must never describe what was changed or historical behaviour. The comment is directly associated with the dead-code `initChildState` function (which also writes the banned field- see V-01). Both must be deleted.

---

### L-02- current-source-kcl.test.ts inline comment describes deleted positional API

**File:** `src/components/sources/__tests__/current-source-kcl.test.ts`
**Line:** 33

**Evidence:**
```ts
const src = withNodeIds(srcCore, [0, 1]); // pinNodeIds: [neg=node0, pos=node1]
```

The comment "// pinNodeIds: [neg=node0, pos=node1]" describes the now-deleted `pinNodeIds` positional array field. This is a historical-provenance comment that must be removed together with the `withNodeIds` call (V-07).

---

### L-03- transformer.test.ts comment describes pin-positional array mapping

**File:** `src/components/passives/__tests__/transformer.test.ts`
**Line:** 582

**Evidence:**
```ts
      pinNodeIds: [2, 0, 3, 0], // P1=node2, P2=gnd, S1=node3, S2=gnd
```

The comment "// P1=node2, P2=gnd, S1=node3, S2=gnd" describes positional index semantics for the deleted `pinNodeIds` array. This is a historical-provenance comment decorating a dead field assignment (V-05).

---

## Detailed Notes by Task Group

### 1.A.engine- analog-engine.ts
Source file: clean. No forbidden patterns found. `el._pinNodes.values()` used correctly in power-calc loop.

### 1.A.compiler- compiler.ts
Source file: clean. ssA.21 all four changes verified in source: (1) no `allNodeIds`/`nodeIds` in Object.assign at line 1326; (2) `typeof element.getLteTimestep === "function"` discriminator at line 1360; (3) anonymous `extends CompositeElement` class at line 442 with `this._pinNodes = new Map(pinNodes)` in constructor, `getSubElements()`, `super.setup(ctx)` pattern; (4) no `isReactive`/`isNonlinear` writes. Note: `pinNodeIds` at line 1357 is a local variable (`const pinNodeIds = resolveElementNodes(...)`) feeding into a `topologyInfo.push({ nodeIds: [...pinNodeIds] })` data record- this is a function-local const, not a field-decl form; permitted under A.1's explicit carve-out.

### 1.A.engine-misc- bridge-adapter.ts
Source file: clean per grep. Both `BridgeOutputAdapter` and `BridgeInputAdapter` extend `CompositeElement`.

### 1.A.engine-misc- controlled-source-base.ts
Source file: clean per grep. `findBranchFor` on base class per ssA.6. Associated test file `controlled-source-base.test.ts` has violations (V-08).

### 1.A.engine-misc- analog-engine-interface.ts
Source file: clean. `temp`, `nomTemp`, `copyNodesets` added to params per spec.

### 1.A.engine-misc- viewer-controller.ts
Source file: clean. Uses `._pinNodes.values().next().value` pattern at lines 463, 808, 852. Comment at line 445 mentions "pinNodeIds" in passing but is a code comment explaining why NOT to use positional indexing- not a historical-provenance comment (explains current logic, does not describe what was removed). Acceptable.

### 1.A.solver-core- newton-raphson.ts
Source file: clean. `isNonlinear` guard deleted; blame loop iterates unconditionally.

### 1.A.solver-core- timestep.ts
Source file: clean. Both `isReactive` guards deleted.

### 1.A.solver-core- ckt-context.ts
Source file: clean. Four cached-list fields deleted. `_poolBackedElements` and `elementsWithConvergence` retained.

### 1.A.behav-gates- behavioral-gate.ts
Source file: clean per grep. `BehavioralGateElement extends CompositeElement`. Progress report accurate.

### 1.A.behav-gates- behavioral-combinational.ts
Source file: clean per grep. All 3 classes extend `CompositeElement`.

### 1.A.behav-gates- behavioral-flipflop.ts
Source file has violation V-03: uses `loadChildren` legacy helper instead of `super.load(ctx)`. Progress report inaccurate.

### 1.A.behav-gates- behavioral-flipflop/d-async.ts
Source file has violation V-02: uses `loadChildren` legacy helper instead of `super.load(ctx)`. Progress report inaccurate.

### 1.A.behav-gates- behavioral-flipflop/jk.ts
Source file has violation V-02: uses `loadChildren` legacy helper instead of `super.load(ctx)`. Progress report inaccurate.

### 1.A.behav-rest- behavioral-sequential.ts
Source file: clean per grep. All 3 classes extend `CompositeElement`.

### 1.A.behav-rest- behavioral-remaining.ts
Source file: clean per grep. 5 classes extend `CompositeElement` (spec says 6; progress report acknowledges only 5 classes found in file- consistent).

### 1.A.behav-rest- behavioral-flipflop/jk-async.ts
Source file: clean per grep. Extends `CompositeElement`.

### 1.A.ff-vsrc- rs.ts
Source file: clean. Extends `CompositeElement`. Progress report accurately signals `shared.ts` C16 violation as flow-on (which is now confirmed as V-01 above).

### 1.A.ff-vsrc- rs-async.ts
Source file: clean. Same as rs.ts.

### 1.A.ff-vsrc- t.ts
Source file: clean. Extends `CompositeElement`.

### 1.A.ff-vsrc- dc-voltage-source.ts
Source file: clean. Canonical ssA.13 pattern. `findBranchFor` on element return literal per ssA.6. `label: ""`, `_pinNodes: new Map(pinNodes)`, `_stateBase: -1`, `branchIndex: -1` all present.

### 1.A.ff-vsrc- ac-voltage-source.ts
Source file: clean. Same pattern as dc-voltage-source.ts.

### 1.A.sources-passives-1- current-source.ts
Source file: clean. Associated test `current-source-kcl.test.ts` has V-07 and L-02 violations.

### 1.A.sources-passives-1- variable-rail.ts
Source file: clean. `findBranchFor` on element return literal per ssA.6.

### 1.A.sources-passives-1- ground.ts
Source file: clean. 3-arg factory per ssA.13. No `setup()` stamps (correct- ground stamps nothing).

### 1.A.sources-passives-1- resistor.ts
Source file: clean. `label: string = ""` added; `isNonlinear`/`isReactive` removed.

### 1.A.sources-passives-1- capacitor.ts
Source file: clean. Constructor takes `pinNodes`; `this._pinNodes = new Map(pinNodes)`. All `stateBaseOffset` renamed to `_stateBase`.

### 1.A.sources-passives-1- inductor.ts
Source file: clean. `findBranchFor` on class per ssA.6. Progress report notes the `name !== this.label` guard in `findBranchFor` differs from the canonical pattern that ignores name- this is a minor deviation from ssA.6 but does not introduce a forbidden pattern. The spec's canonical body shows `_name` (unused), the implementation uses `name` with a guard. Flagged for user review rather than reported as a violation because it is conservative and functionally safe.

### 1.A.passives-2- polarized-cap.ts
Source file: clean. `implements PoolBackedAnalogElement`. `getInternalNodeLabels()` per ssA.7. `_internalLabels` reset in `setup()`.

### 1.A.passives-2- transformer.ts
Source file: clean. Associated test `transformer.test.ts` has V-05 and L-03 violations.

### 1.A.passives-3- tapped-transformer.ts
Source file: clean. `findBranchFor` on class per ssA.6. `props.get<string>("label")` per ssA.18. `_pinNodes` re-assigned from `pinNodes` after construction- correct.

### 1.A.passives-3- transmission-line.ts
Source file: clean per grep. All sub-classes use `_pinNodes`, `_stateBase`. `typeof el.getLteTimestep === "function"` replaces `el.isReactive`. See G-01 for group-level failure investigation.

### 1.A.passives-4- crystal.ts
Source file: clean. `findBranchFor` on element class per ssA.6. `getInternalNodeLabels()` per ssA.7.

### 1.A.passives-4- memristor.ts
Source file: clean. Constructor takes `pinNodes`; `this._pinNodes = new Map(pinNodes)`.

### 1.A.passives-4- analog-fuse.ts
Source file: clean.

### 1.A.passives-4- potentiometer.ts
Source file: clean. Associated test `potentiometer.test.ts` has V-04 violations.

### 1.A.passives-4- mutual-inductor.ts
Source file: clean. `findBranchFor` on `InductorSubElement` per ssA.6. `_pinNodes = new Map([["pos", posNode], ["neg", negNode]])` in constructor.

---

## C.1 Grep Audit Results Across All In-Scope Source Files

| Pattern | Result |
|---------|--------|
| C1 `\bisReactive\b` | 0 hits in production src/ |
| C2 `\bisNonlinear\b` | 0 hits in production src/ |
| C3 `\bmayCreateInternalNodes\b` | 0 hits in production src/ |
| C4 `\bgetInternalNodeCount\b` | 0 hits in production src/ |
| C5 `\bReactiveAnalogElement(Core)?\b` | 0 hits in production src/ |
| C6 `\b(readonly\s+)?allNodeIds\s*[!?:]` | Hits in test files: potentiometer.test.ts (3×), behavioral-flipflop.test.ts (1×), controlled-source-base.test.ts (1×). Zero in source files. |
| C7 `\b(readonly\s+)?pinNodeIds\s*[!?:]` | Hits in test files: potentiometer.test.ts (3×), transformer.test.ts (7×), tapped-transformer.test.ts (4×), behavioral-flipflop.test.ts (1×), controlled-source-base.test.ts (1×), harness/types.ts (1×- data record, C.3 out-of-band), harness/netlist-generator.test.ts (1×- parameter annotation, not a field decl), harness/slice.test.ts (3×- data records, C.3 out-of-band). Zero in source files. |
| C8 `\bthis\.pinNodeIds\b` | 0 hits |
| C9 `\bthis\.allNodeIds\b` | 0 hits |
| C10 `\bel\.pinNodeIds\b` | Hits in harness files: comparison-session.ts (2×), netlist-generator.ts (1×), slice.ts (1×)- all on TopologySnapshot data-record fields, not AnalogElement. Classified C.3 out-of-band by the respective agents. |
| C11 `\bel\.allNodeIds\b` | 0 hits |
| C12 `\bel\.internalNodeLabels\b` | 0 hits |
| C13 `\b\w+\.(isReactive\|isNonlinear)\b` | 0 hits |
| C16 `\bstateBaseOffset\b` | Hits in: `behavioral-flipflop/shared.ts` (lines 88, 89, 98- production violation V-01), `state-schema.ts` (line 137- internal logic for detecting old field; not an element field assignment), `__tests__/state-schema.test.ts` (×2), `__tests__/state-pool.test.ts` (×multiple- legacy test fixtures, not in this batch's scope). |
| C17 `\binternalNodeLabels\s*[?:]` | 0 hits |
| C18 cached lists in ckt-context | 0 hits (all four lists deleted) |
| C19 composite calling ctx.makeVolt directly | 0 hits (all composites in scope are clean) |
| C20 `elementsWithLte`/`elementsWithAcceptStep` outside ckt-context | 0 hits |
| A.18 `\.(getString\|getNumber\|getBoolean)\(` | 0 hits |
