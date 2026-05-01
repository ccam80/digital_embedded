# Spec Review: Batch 2- Component Specs: Sources, Switches & Subckt

## Verdict: needs-revision

## Tally

| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 2 | 2 |
| major    | 3 | 5 | 8 |
| minor    | 4 | 3 | 7 |
| info     | 3 | 0 | 3 |

---

## Plan Coverage

| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| PB-VSRC-DC (W3 per-component) | yes | Complete |
| PB-VSRC-AC (W3 per-component) | yes | Complete |
| PB-VSRC-VAR (W3 per-component) | yes | Complete |
| PB-ISRC (W3 per-component) | yes | Complete |
| PB-VCCS (W3 per-component) | yes | Complete |
| PB-VCVS (W3 per-component) | yes | Complete |
| PB-CCCS (W3 per-component) | yes | Complete |
| PB-CCVS (W3 per-component) | yes | Complete |
| PB-SW (W3 per-component) | yes | Complete |
| PB-SW-DT (W3 per-component) | yes | Complete |
| PB-RELAY (W3 per-component) | yes | Complete |
| PB-RELAY-DT (W3 per-component) | yes | Complete |
| PB-ANALOG_SWITCH (W3 per-component) | yes | Complete |
| PB-TRANSGATE (W3 per-component) | yes | Complete |
| PB-SUBCKT (W3 per-component) | yes | Complete |

All 15 tasks from the W3 plan are represented. Plan verification measures (setup-stamp-order.test.ts row green; component test file green) are reflected in each file's acceptance criteria.

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FVSRC-DC-M1 | minor | PB-VSRC-DC ss"Verification gate", item 3 | "No banned closing verdicts." appears in every spec file verbatim but is a rule reminder, not a verifiable acceptance criterion. It adds no implementer-facing contract. | Delete the line from all 15 spec files |
| FVSRC-AC-M1 | minor | PB-VSRC-AC ss"Factory cleanup" | `mayCreateInternalNodes: false` (omit- default) appears in PB-VSRC-DC but is absent from PB-VSRC-AC's Factory cleanup section. Inconsistency within the VSRC family that could confuse an implementer checking against PB-VSRC-DC. | Add `Add \`mayCreateInternalNodes: false\` (omit- default).` to PB-VSRC-AC ss"Factory cleanup" (mirroring PB-VSRC-DC) |
| FCCCS-M1 | major | PB-CCCS ss"Factory cleanup" | States `Drop \`branchCount: 1\` from MnaModel registration (CCCS has NO own branch row; the existing \`branchCount: 1\` in the current code is wrong- it referred to the sense branch which belongs to the controlling VSRC, not to CCCS itself).`- This is a historical-provenance comment inside a spec file. The spec is a current-state contract; "the existing branchCount: 1 in the current code is wrong" is analysis of what the old code did and should not appear in an implementation-facing spec. | Delete the parenthetical `(CCCS has NO own branch row; the existing \`branchCount: 1\` in the current code is wrong- it referred to the sense branch which belongs to the controlling VSRC, not to CCCS itself)`. Retain only: `Drop \`branchCount: 1\` from MnaModel registration.` |
| FCCVS-M1 | minor | PB-CCVS ss"Sense-source resolution (CCCS, CCVS only)", last two paragraphs | The paragraph beginning "The current digiTS implementation uses a different mechanism..." is historical-provenance commentary (describes what the old code did with `branchIdx + 1`, `_senseBranch`, `_outBranch`). Under `rules.md`, historical-provenance commentary is a dead-code marker signal; in a spec it is noise that directs the implementer toward the old pattern. | Delete the entire paragraph block from "The current digiTS implementation..." through "...with: [bullet list]". The two bullet points already appear correctly in the setup() body code listing above them. |

(Mechanical fixes: 4 total)

---

### Decision-Required Items

---

#### FVSRC-DC-D1- VCVS `branchIndex` guard inconsistency with VSRC family (major)

- **Location**: PB-VCVS ss"setup() body- alloc only"
- **Problem**: The VSRC-family specs (PB-VSRC-DC, PB-VSRC-AC, PB-VSRC-VAR) all use an explicit idempotent guard in setup():
  ```typescript
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this.label, "branch");
  }
  ```
  PB-VCVS instead calls `ctx.makeCur` unconditionally without the guard:
  ```typescript
  this.branchIndex = ctx.makeCur(this.label, "branch");
  const branch = this.branchIndex;
  ```
  The spec text says `ctx.makeCur` is "idempotent for the same (label, suffix) pair (per 00-engine.md ssA2)" to justify this, but 00-engine.md ssA2 does NOT state that `makeCur` is idempotent- `makeCur` is defined as calling `engine._makeNode` which always increments `_maxEqNum`. The idempotent guard in VSRC specs is on the *element* (`if (this.branchIndex === -1)`), not on `ctx.makeCur`. The cross-reference to "00-engine.md ssA2" as authority for `ctx.makeCur` idempotency is incorrect.

  Meanwhile ngspice `vcvsset.c:41-44` uses the same `if(here->VCVSbranch == 0)` guard as `vsrcset.c:40-43`. The VCVS spec violates the "line-for-line port" requirement by dropping the element-level guard.

- **Why decision-required**: The fix could be (A) add the element-level guard to VCVS matching the VSRC pattern; (B) remove the incorrect "idempotent" text from VCVS and restate the design as a deliberate difference; or (C) add `makeCur` idempotency to the 00-engine.md ssA2 interface contract and remove element-level guards everywhere. Each has different blast-radius implications.
- **Options**:
  - **Option A- Add element guard to VCVS (matches VSRC family and ngspice anchor)**:
    Replace unconditional `this.branchIndex = ctx.makeCur(this.label, "branch");` with:
    ```typescript
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const branch = this.branchIndex;
    ```
    - Pros: Consistent with VSRC-DC/AC/VAR; matches `vcvsset.c:41-44` guard exactly; `findBranchFor` already has the idempotent guard so setup() running twice is safe.
    - Cons: Small diff to apply.
  - **Option B- Declare `makeCur` idempotent in 00-engine.md and propagate**:
    Amend 00-engine.md ssA2 `makeCur` contract to state "returns same number if called with same (deviceLabel, suffix)"; remove element-level guards from all VSRC specs too; leave VCVS as-is.
    - Pros: Cleaner API- callers don't need `branchIndex === -1` guard.
    - Cons: Requires changing 00-engine.md and re-speccing PB-VSRC-DC/AC/VAR; `_makeNode` implementation would need to track previously-allocated (label, suffix) pairs- currently it does not.

---

#### FVCVS-D1- `findBranchFor` uses `NGSPICE_LOAD_ORDER.VCVS` type-narrowing (major)

- **Location**: PB-VCVS ss"findBranchFor", code snippet
- **Problem**: The `findBranchFor` implementation shown uses:
  ```typescript
  if (!el || el.ngspiceLoadOrder !== NGSPICE_LOAD_ORDER.VCVS) return 0;
  const vcvs = el as VCVSAnalogElement;
  ```
  Two issues:
  1. `NGSPICE_LOAD_ORDER.VCVS` (value `47`) is also used by behavioral flip-flop elements (`behavioral-flipflop/rs.ts`, `t.ts`, `jk.ts`, `jk-async.ts`, `d-async.ts`, `rs-async.ts`) and `behavioral-combinational.ts`. These non-VCVS elements share load-order bucket 47. A CCCS trying to find a branch for label `"rs1"` would reach a `BehavioralFlipFlopElement` with `ngspiceLoadOrder === 47`, pass the guard, and then the `as VCVSAnalogElement` cast would succeed silently (TypeScript structural subtyping), causing `vcvs.branchIndex` to read an unrelated field.
  2. The spec does not state that behavioral elements at load order 47 will NOT have a `branchIndex` field- the base class `AnalogElementCore` has `branchIndex: number = -1` which is inherited by all analog elements.
  The type-narrowing approach via `ngspiceLoadOrder` is insufficient when multiple element types share the same bucket.
- **Why decision-required**: The fix requires picking an alternative narrowing strategy, and there are several:
  - **Option A- Use a type discriminator property**:
    Add a boolean `readonly isVCVS: true` to `VCVSAnalogElement` and check `(el as any).isVCVS === true` in `findBranchFor`.
    - Pros: Unambiguous; not confused by behavioral elements sharing load order 47.
    - Cons: Adds a discriminator field that isn't in ngspice; implementer must add it.
  - **Option B- Use `instanceof VCVSAnalogElement`**:
    Replace `el.ngspiceLoadOrder !== NGSPICE_LOAD_ORDER.VCVS` with `!(el instanceof VCVSAnalogElement)`.
    - Pros: Correct TypeScript narrowing; no false positives from behavioral elements.
    - Cons: Creates a module import dependency in the MnaModel's `findBranchFor` callback on `VCVSAnalogElement`; circular import risk.
  - **Option C- Remove the load-order check entirely; rely on `branchIndex` value**:
    The `findBranchFor` callback is already registered only on the VCVS's MnaModel. `ctx.findDevice(name)` may return any device, but `findBranchFor` already checks `el` exists. If `el.branchIndex` is `-1` it allocates; if `!== -1` it returns it. For non-VCVS elements that happen to have `branchIndex` set for other reasons (e.g. VSRC), they won't be in the VCVS `findBranchFor` lookup path since the VCVS model only registers one `findBranchFor`. The real guard is whether the element was added to `_registeredMnaModels` for VCVS- not a per-call check.
    - Pros: Simpler; consistent with how CCVS spec handles its own `findBranchFor`.
    - Cons: Trusts that the MnaModel dispatch in `_findBranch` walks only models with registered `findBranchFor`- a non-VCVS element returned by `findDevice` for a VCVS label lookup would still get checked, but that scenario means a label collision which is a user error.

---

#### FCCVS-D1- CCVS `findBranchFor` has same load-order type-narrowing issue (major)

- **Location**: PB-CCVS ss"findBranchFor", code snippet
- **Problem**: Identical structural problem to FVCVS-D1. The CCVS `findBranchFor` uses:
  ```typescript
  if (!el || el.ngspiceLoadOrder !== NGSPICE_LOAD_ORDER.CCVS) return 0;
  const ccvs = el as CCVSAnalogElement;
  ```
  `NGSPICE_LOAD_ORDER.CCVS` = 19. The CCVS type-narrowing check via load order 19 is unlikely to be ambiguous today (no other elements use CCVS bucket), but the pattern is structurally inconsistent with the VSRC-family's approach (which does NOT use load-order narrowing in `findBranchFor`- it simply walks all instances of that model, which is how ngspice's `CCVSfindBr` and `VSRCfindBr` work: `for(model...) for(here...) if(name == match)`). The ngspice anchor `ccvsfbr.c:16-37` does a model-instance walk, not a type discriminator.
- **Why decision-required**: The CCVS approach works today but diverges from the ngspice pattern; whether to align it with VSRC family pattern or accept the load-order check is a design decision.
- **Options**:
  - **Option A- Align with VSRC/VCVS family pattern using model-instance walk**:
    Remove `ctx.findDevice` + type-narrowing entirely. The MnaModel's `findBranchFor` already implicitly "owns" only CCVS elements because it's registered on the CCVS MnaModel. The callback receives `name`; it should walk its own known CCVS instances (the same loop that ngspice uses). Requires the callback to have access to the CCVS instance list (e.g., closure over a `ccvsInstances` array built at compile time).
    - Pros: Mirrors ngspice `CCVSfindBr` structure exactly; no type-narrowing hacks.
    - Cons: Requires the MnaModel factory to close over the instance list, which is not currently specified.
  - **Option B- Accept `ctx.findDevice` + `instanceof` narrowing (matches VCVS fix if Option B there)**:
    Replace `el.ngspiceLoadOrder !== NGSPICE_LOAD_ORDER.CCVS` with `!(el instanceof CCVSAnalogElement)`.
    - Pros: Correct TypeScript narrowing; consistent if VCVS uses the same approach.
    - Cons: Same circular import risk as FVCVS-D1 Option B.
  - **Option C- Accept load-order narrowing as-is for CCVS (low ambiguity risk)**:
    No change. The load order 19 bucket is currently CCVS-only.
    - Pros: No change needed.
    - Cons: Inconsistent with VSRC/VCVS approach if FVCVS-D1 is fixed; fragile if load order sharing is introduced later.

---

#### FANALOG_SWITCH-D1- `setCtrlVoltage` method not specified; does not exist in current codebase (critical)

- **Location**: PB-ANALOG_SWITCH ss"load() body- read ctrl, delegate to SW sub-elements"
- **Problem**: The spec relies on `this._sw1.setCtrlVoltage(vCtrl)` and `this._swNO.setCtrlVoltage(vCtrl)` / `this._swNC.setCtrlVoltage(-vCtrl)` to pass the control voltage to each SW sub-element before `sw1.load(ctx)`. However:
  1. `setCtrlVoltage` is not defined anywhere in the codebase (Grep for `setCtrlVoltage` across all `src/components` returns no matches).
  2. PB-SW does not specify a `setCtrlVoltage` method. PB-SW's `load()` spec only says "Implementer ports value-side from swload.c line-for-line" without defining how the SW element receives the control voltage.
  3. The SW analog element's `load()` body is not shown in PB-SW (only key matrix stamps are listed), so the mechanism for passing `vCtrl` into `sw1.load()` is undefined from PB-SW alone.
  An implementer reading only PB-ANALOG_SWITCH (as W3 agents are instructed to) cannot implement this without guessing the `SWElement` API.
- **Why decision-required**: Several approaches are possible for how AnalogSwitch passes control voltage to SW sub-element, and the choice affects PB-SW's spec:
  - **Option A- Add `setCtrlVoltage(v: number): void` to SWElement API and specify it in PB-SW**:
    Specify in PB-SW that `SWElement` has a `setCtrlVoltage(v: number): void` method that stores `v` and `load()` reads it. Add this method to PB-SW's spec section.
    - Pros: Clean encapsulation; `SWElement` is self-contained.
    - Cons: Adds a new public method to `SWElement` that PB-SW must now spec.
  - **Option B- Pass `nCtrl` into the composite; `load()` reads `ctx.rhsOld[nCtrl]` directly and calls `sw1.setSwState(on: boolean)` based on threshold comparison**:
    The composite computes ON/OFF itself from `vCtrl` vs threshold, then calls a simpler `setSwState(bool)` method on each sub-element.
    - Pros: SW sub-element stays purely passive (no control voltage concept).
    - Cons: Threshold/hysteresis logic must be replicated in the composite, not in the SW sub-element.
  - **Option C- The composite's `load()` sets a field on sw1 directly (e.g., `sw1._ctrlVoltage = vCtrl`) before calling `sw1.load(ctx)`**:
    This is an implementation detail; the spec should state the field name if so.
    - Pros: No new public method needed.
    - Cons: Breaks encapsulation; exposes internal state.

---

#### FANALOG_SWITCH-D2- SPDT inverted polarity via `setCtrlVoltage(-vCtrl)` is architecturally unspecified (critical)

- **Location**: PB-ANALOG_SWITCH ss"load() body- SPDT", line `this._swNC.setCtrlVoltage(-vCtrl);`
- **Problem**: The spec achieves SPDT "normally-closed" behavior by passing `-vCtrl` (negated control voltage) to `swNC.setCtrlVoltage`. This means the SW sub-element for `swNC` sees `V(ctrlN)` negated, which would make it turn ON when `-vCtrl > vThreshold`, i.e., when `vCtrl < -vThreshold`. But the SPDT description says:
  > `swNC` is ON when `V(ctrl) < vThreshold - vHysteresis/2` (inverted polarity- complementary)

  These two expressions are not equivalent unless `vThreshold = 0` and `vHysteresis = 0`. For non-zero threshold: negating the voltage and using the same positive threshold gives `ON when vCtrl < -vThreshold`, not `ON when vCtrl < vThreshold - vHysteresis/2`.

  Also, pin `ctrlN` appears in the external pin list ("External pins: `in`, `out`, `ctrl` (gate-enable), `ctrlN` (inverted gate-enable for PFET)") for TransGate but the ANALOG_SWITCH SPDT external pins are `com`, `no`, `nc`, `ctrl`- no `ctrlN`. So PFET's inverted gate is a TransGate concept, not an ANALOG_SWITCH concept. Yet PB-ANALOG_SWITCH's SPDT load() uses `swNC.setCtrlVoltage(-vCtrl)` with the single `ctrl` node, implying software inversion- not a hardware `ctrlN` pin. This is internally contradictory.
- **Why decision-required**: The correct complementary-switch behavior requires a design decision:
  - **Option A- Software inversion via threshold negation**: Keep single `ctrl` pin; pass `vThreshold` negated (or `swNC` uses `-vThreshold` internally). This requires SW sub-element to support a "polarity flip" parameter.
  - **Option B- Physical inverted pin `ctrlN`**: Add `ctrlN` to SPDT pin layout; `swNC` reads `V(ctrlN)` directly like TransGate's PFET. Hardware complement generation is external to the component.
  - **Option C- Separate hysteresis logic in composite**: Composite's `load()` evaluates `vCtrl` against threshold/hysteresis directly (not delegating to SW state machine) and calls `sw1.setSwState(bool)` on each sub-element with the correct on/off decision. No voltage negation needed.

---

#### FRELAY-D1- Coil label convention `${relayLabel}_coil` is asserted but not specified in MnaModel registration (major)

- **Location**: PB-RELAY ss"Branch rows" and ss"findBranchFor"
- **Problem**: The spec states the coil IND branch is allocated via `ctx.makeCur(this.label + "_coil", "branch")` and the `findBranchFor` callback matches using `coilInstance.label === name`. But the `findBranchFor` is registered on the `Relay` MnaModel (not on a standalone `IND` MnaModel). The callback uses the coil sub-element's label, not the relay's label. The spec does not define:
  1. How `coilInstance.label` is set- the relay label? the `"${relayLabel}_coil"` convention? The branch allocation uses `this.label + "_coil"` (relay's label + suffix), but `ctx.makeCur` takes `(deviceLabel, suffix)`, so the branch name would be `"${relayLabel}_coil#branch"`. The sub-element label needs to match this for `findBranch` to resolve correctly.
  2. The `findBranchFor` callback shown references `coilInstance` without defining what `coilInstance` is- it appears to be a closure variable but its source is unspecified. In ngspice, `INDfindBr` is registered as a device-level function that walks all IND instances. The relay spec should clarify whether the relay's `findBranchFor` closure is over `this._coil` or walks a broader list.
- **Why decision-required**: The label convention for the coil sub-element (`${relayLabel}_coil` vs `${relayLabel}` vs other) determines whether `ctx.findBranch("myRelay_coil")` works and must be pinned down exactly. Two options:
  - **Option A- Coil sub-element label is `${relayLabel}_coil`; `findBranchFor` matches on `coilInstance.label === name`**:
    Spec states `coil_IND.label = \`${relay.label}_coil\``. Explicitly document the label assignment in the Factory section. `ctx.makeCur(\`${relay.label}_coil\`, "branch")` and `findBranchFor` matching `coilInstance.label === name` is self-consistent.
    - Pros: Internally consistent; `findBranch("myRelay_coil")` works.
    - Cons: External CCCS/CCVS sensors would need to know the `_coil` label convention.
  - **Option B- The relay's `findBranchFor` matches on relay label directly**:
    `ctx.makeCur(relay.label, "branch")` (no `_coil` suffix); `findBranchFor` matches `name === relayLabel`. Simpler but inconsistent with the spec's current `this.label + "_coil"` text.
    - Pros: Caller uses relay label, not coil sub-label.
    - Cons: Contradicts the current spec text in "Branch rows" section.

---

#### FSUBCKT-D1- `_deviceMap` population for sub-elements is underspecified for nested subcircuits (major)

- **Location**: PB-SUBCKT ss"findDevice usage", `_deviceMap` population paragraph
- **Problem**: The spec states:
  > "For subcircuit sub-elements, their labels are set by `compileSubcircuitToMnaModel` as `${subcktLabel}_${innerLabel}` (namespaced). The `findDevice` lookup uses the namespaced label."
  
  But 00-engine.md ssA4.1 states:
  > "Build `this._deviceMap: Map<string, AnalogElement>` from `compiled.elements` keyed by element label."
  
  `compiled.elements` is the top-level compiled element list returned by the compiler. For a subcircuit, the sub-elements inside it are NOT in `compiled.elements`- they are inside the `SubcircuitCompositeElement._subElements` array. The top-level `compiled.elements` contains the composite as one entry, not its sub-elements. This means `ctx.findDevice("mySubckt_innerVSRC")` would return `null` for any sub-element of a subcircuit- the `_deviceMap` as specified in 00-engine.md does not include namespaced sub-elements.

  This creates a real problem: if a CCCS inside a subcircuit calls `ctx.findBranch(senseSourceLabel)` where the controlling VSRC is also inside the subcircuit, `_deviceMap` won't contain it, `findDevice` returns null, and CCCS setup throws.
- **Why decision-required**: Resolving this requires a choice about how sub-elements are exposed for `findDevice`:
  - **Option A- `_deviceMap` is populated recursively from the composite's `_subElements`**:
    After `compileSubcircuitToMnaModel` builds the composite, the engine recursively walks `composite._subElements` (and their sub-elements) to add all inner elements to `_deviceMap` with namespaced labels.
    - Pros: `findDevice` works for cross-element CCCS/CCVS/MUT lookup within subcircuits.
    - Cons: Requires the engine's `init()` to understand composite structure; or the compiler must flatten the element list with namespaced labels.
  - **Option B- Sub-elements register themselves during their own `setup()` call**:
    Each sub-element's `setup()` calls a new `ctx.registerDevice(label, this)` method that adds itself to `_deviceMap`. Called before TSTALLOC so cross-references can resolve.
    - Pros: No compiler changes; works recursively naturally.
    - Cons: Changes the `SetupContext` interface (adds `registerDevice`); not in 00-engine.md ssA2.
  - **Option C- Document that CCCS/CCVS/MUT inside subcircuits must reference controlling sources outside the subcircuit boundary**:
    Accept the limitation. Update PB-SUBCKT to state that cross-device `findDevice` only works for top-level elements; internal cross-references inside a subcircuit are unsupported.
    - Pros: No implementation change.
    - Cons: Real circuits commonly have CCCS referencing a VSRC inside the same subcircuit; would silently fail.

---

### Batch-Wide Findings

#### BATCH2-D1- `findBranchFor` callback structure inconsistent across voltage-source family (major)

- **Applies to**: PB-VSRC-DC, PB-VSRC-AC, PB-VSRC-VAR, PB-VCVS, PB-CCVS
- **Problem**: All five specs show `findBranchFor` implementations but use two different internal patterns:

  **VSRC family (DC/AC/VAR)**- pseudo-code that references a free variable `instance`:
  ```typescript
  findBranchFor(name: string, ctx: SetupContext): number {
    if (instance.label === name) { ... }
    return 0;
  }
  ```
  There is no definition of `instance` in the callback. ngspice's `VSRCfindBr` walks ALL VSRC model instances (`for(model) for(here)`) to find the matching one. The spec pseudocode omits the walk and leaves `instance` as an undefined placeholder, giving an implementer no guidance on how to iterate registered instances.

  **VCVS/CCVS**- uses `ctx.findDevice(name)` which is the correct single-lookup approach consistent with 00-engine.md ssA4.2's `_deviceMap`.

  These are two different mechanisms for solving the same problem: "given a label, find the element with that label and return its branch number." The VSRC family specs are incomplete (broken pseudocode) while VCVS/CCVS specs are correct but have the load-order narrowing issue (FVCVS-D1, FCCVS-D1).

- **Why decision-required**: Which pattern should all five specs use?
  - **Option A- All five use `ctx.findDevice(name)` (VCVS/CCVS pattern)**:
    Replace VSRC family's `instance` placeholder with `ctx.findDevice(name)` + appropriate narrowing. This is consistent and correct if the load-order narrowing issue is also resolved (see FVCVS-D1 and FCCVS-D1).
    - Pros: Uniform approach; uses the spec'd `findDevice` mechanism.
    - Cons: Load-order narrowing issue must be resolved separately (see those findings).
  - **Option B- All five use a model-instance walk (ngspice pattern)**:
    Each MnaModel's `findBranchFor` closure captures an array of its instances (built at compile time). Walk: `for (const inst of instances) { if (inst.label === name) { ... } }`.
    - Pros: Mirrors ngspice `VSRCfindBr`/`CCVSfindBr` structure exactly; no type-narrowing needed.
    - Cons: Factory must collect instances into a closure array; requires 00-engine.md ssA4 to specify how the instance list is passed into the MnaModel at compile time.
  - **Option C- Mix is intentional; fix only the VSRC family pseudocode**:
    Accept VCVS/CCVS using `ctx.findDevice` and fix only the VSRC family pseudocode by replacing `instance` with a clearly-marked "TODO: walk instances" note or by defining the closure variable explicitly.
    - Pros: Minimal change.
    - Cons: Inconsistency remains; "TODO" violates rules.md banned-concept list.

---

#### BATCH2-M1- Verification gate test file names inconsistent in switch family (minor)

- **Applies to**: PB-SW, PB-SW-DT, PB-RELAY, PB-RELAY-DT, PB-TRANSGATE
- **Problem**:
  - PB-SW verification gate 2 references `src/components/switching/__tests__/switches.test.ts`
  - PB-SW-DT verification gate 2 references `src/components/switching/__tests__/switches.test.ts`
  - PB-RELAY verification gate 2 references `src/components/switching/__tests__/relay.test.ts`
  - PB-RELAY-DT verification gate 2 references `src/components/switching/__tests__/relay.test.ts`
  - PB-TRANSGATE verification gate 2 references `src/components/switching/__tests__/switches.test.ts`
  
  The convention is inconsistent: relay has its own test file while switch/switch-dt/transgate share `switches.test.ts`. An implementer cannot know whether TransGate tests will be in `switches.test.ts` or `trans-gate.test.ts` or a different file. This needs a single canonical source.
- **Proposed fix**: Verify the actual test file names exist via the codebase. If `switches.test.ts` covers SW/SW-DT/TransGate, state that explicitly. If not, provide the correct file names. This is mechanical only if the actual file names are unambiguous from the filesystem- otherwise it is decision-required.

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH2-M1 | minor | PB-SW/PB-SW-DT/PB-TRANSGATE ss"Verification gate" item 2 | References `switches.test.ts` without confirming TransGate is tested there vs a dedicated file | Verify filesystem; if `switches.test.ts` covers all three, add a note "(covers SW, SW-DT, TransGate)" |

---

#### BATCH2-M2- `pinNodeIds` vs `pinNodes.get()` inconsistency across controlled-source specs (minor)

- **Applies to**: PB-VCCS, PB-VCVS, PB-CCCS, PB-CCVS
- **Problem**: The VCCS, VCVS, CCCS, and CCVS specs use `this.pinNodeIds[n]` with hardcoded index offsets in setup() bodies:
  ```typescript
  const posNode     = this.pinNodeIds[2]; // pinNodes.get("out+")
  const negNode     = this.pinNodeIds[3]; // pinNodes.get("out-")
  const ctrlPosNode = this.pinNodeIds[0]; // pinNodes.get("ctrl+")
  ```
  But the VSRC family uses `this.pinNodes.get("pos")!` (Map lookup by label). Both approaches reference the same pin data, but they use different APIs. The spec does not define whether `pinNodeIds` is a stable array field on `AnalogElementCore` or an implementation detail that implementers should use, and does not state whether the indices are guaranteed to match `buildVCCSPinDeclarations()` pin declaration order.

  The comment "pinNodeIds index ordering matches `buildVCCSPinDeclarations()`" is correct but appears only as a comment in the code block, not as a formal specification of the field contract.
- **Proposed fix**: Either (a) add a sentence to the spec formally stating "`pinNodeIds[n]` maps to the nth entry of `buildVCCSPinDeclarations()` in declaration order" and cross-reference the relevant base class field, or (b) use `pinNodes.get("label")!` uniformly across all specs (as VSRC family does) for readability.

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH2-M2 | minor | PB-VCCS/VCVS/CCCS/CCVS ss"setup() body" | `pinNodeIds[n]` used without formal field contract; VSRC family uses `pinNodes.get()` instead | Add one sentence above the code block: "`pinNodeIds` is the ordered array of resolved pin MNA indices matching `build*PinDeclarations()` declaration order; `pinNodeIds[0]` = first declared pin, etc." |

---

#### BATCH2-M3- VCVS spec line references do not match actual ngspice vcvsset.c (info)

- **Applies to**: PB-VCVS
- **Problem**: PB-VCVS ss"TSTALLOC sequence" states the anchor is `vcvsset.c:53-58`. The actual ngspice file `ref/ngspice/src/spicelib/devices/vcvs/vcvsset.c` has the 6 TSTALLOC calls at lines 53-58. This is correct. However the spec says:
  > "The idempotent guard (`if (branch == 0)`) is mirrored by `ctx.makeCur` being idempotent for the same (label, suffix) pair (per 00-engine.md ssA2)."
  
  This claim is factually wrong- `ctx.makeCur` per 00-engine.md ssA2 simply delegates to `engine._makeNode` which always increments `_maxEqNum`. Idempotency in ngspice comes from the `if(here->VCVSbranch == 0)` guard in the element, not from `CKTmkCur`. This is a documentation error (not a code error) that could mislead an implementer who reads this spec before implementing `makeCur`.

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH2-M3 | info | PB-VCVS ss"Branch rows" | Claims "ctx.makeCur being idempotent for the same (label, suffix) pair (per 00-engine.md ssA2)"- 00-engine.md ssA2 does not state this; idempotency is via the element-level `if (branchIndex === -1)` guard | Delete the parenthetical "(per 00-engine.md ssA2)" and replace with "The idempotent guard must be replicated in setup() as `if (this.branchIndex === -1)` (mirroring vcvsset.c:41-44)." |

---

#### BATCH2-D2- RELAY/RELAY-DT coil-resistance TSTALLOC is not anchored to any ngspice source (major)

- **Applies to**: PB-RELAY, PB-RELAY-DT
- **Problem**: Both relay specs state that the coil has a series resistance modelled as "4 additional matrix handles inside the IND coil's setup, using the same `(INDposNode, INDnegNode)` node pair, exactly mirroring ressetup.c:46-49." However:
  1. The actual ngspice `indsetup.c` (lines 96-100) allocates EXACTLY 5 TSTALLOC calls (INDposNode×INDbrEq, INDnegNode×INDbrEq, INDbrEq×INDnegNode, INDbrEq×INDposNode, INDbrEq×INDbrEq)- there is NO coil-resistance TSTALLOC in ngspice's `indsetup.c`. The series resistance in ngspice inductors is handled as a separate RES element in some models, not as extra stamps inside INDsetup.
  2. The coil-resistance TSTALLOC at positions 6-9 in PB-RELAY is a digiTS-specific extension that has no ngspice anchor. This means the `setup-stamp-order.test.ts` assertion for PB-RELAY will necessarily diverge from ngspice's `indsetup.c` TSTALLOC sequence if the test compares against the ngspice anchor.
  3. The spec is silent on whether this is an accepted architectural divergence or whether the coil resistance will be handled differently for ngspice parity.
- **Why decision-required**:
  - **Option A- Document coil resistance as an architectural divergence; test only IND's 5 stamps (+ SW's 4) against ngspice; document the extra 4 coil-R handles as digiTS-only**:
    The setup-stamp-order test for PB-RELAY asserts only the 9 stamps that correspond to ngspice anchors (5 IND + 4 SW), with a comment that 4 coil-R handles are digiTS-only and not part of the parity assertion.
    - Pros: Honest about the divergence; parity test remains valid for the anchored stamps.
    - Cons: `spec/architectural-alignment.md` entry may be needed (user action per CLAUDE.md).
  - **Option B- Model coil resistance as a separate RES sub-element within the relay composite**:
    The coil IND does 5 TSTALLOC, a separate RES does 4 TSTALLOC. Total stays 13 for PB-RELAY; the parity test can assert both sub-elements separately.
    - Pros: Each sub-element matches its ngspice anchor exactly.
    - Cons: Requires relay composite to have 3 sub-elements (IND + RES + SW); more complex.
  - **Option C- Keep current spec; add a note that the coil-R stamps are digiTS-internal and the parity test rows verify only ngspice-anchored stamps**:
    Amend the setup-stamp-order assertion in the spec to say "The test asserts positions 1-5 (IND) and 10-13 (SW) against ngspice anchors; positions 6-9 (coil-R) are digiTS-only additions verified only for existence, not position parity."
    - Pros: Minimal change; honest about what's being tested.
    - Cons: Weakens the parity guarantee for relays.

---

#### BATCH2-I1- ISRC load() body spec is underspecified for the `m` multiplicity parameter (info)

- **Applies to**: PB-ISRC ss"load() body"
- **Problem**: The load() body says:
  > "`m` is the multiplicity parameter (`ISRCmValue`, default 1.0)"
  
  But `m` (multiplicity) is not a listed parameter in the ISRC `setParam` contract or the Factory cleanup section. The spec does not state whether `ISRCmValue` is an existing ISRC property, a new one to add, or what `setParam` key is used. An implementer following only PB-ISRC cannot determine if `this._mValue` is already present or must be added.
- **Proposed fix**: State explicitly whether `ISRCmValue` (multiplicity) is an existing property on `CurrentSourceElement` and its setParam key, or whether it must be added. This is info-severity because `m = 1.0` by default and most circuits will not use it; however the spec should be precise.

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH2-I1 | info | PB-ISRC ss"load() body" | `m` multiplicity parameter referenced without specifying whether it's an existing property or new | Add one sentence: "If `ISRCmValue` is not an existing property on `CurrentSourceElement`, add it with `setParam("m", value)` routing. Default: `1.0`." |

---

#### BATCH2-I2- SW spec omits model-level default-value processing from `swsetup.c:28-41` (info)

- **Applies to**: PB-SW ss"setup() body"
- **Problem**: ngspice `swsetup.c:28-41` performs model-level default-value initialization (SWvThreshold, SWvHysteresis, SWonConduct, SWoffConduct defaults) before the per-instance state/TSTALLOC loop. PB-SW's `setup()` body spec does not mention whether these defaults are applied at compile time (in the factory/registry), at setup time, or are already handled by the existing digiTS code. This is relevant because the spec says "port of swsetup.c:47-48- state slot allocation" and "port of swsetup.c:59-62- TSTALLOC sequence" but skips the model-level block at lines 28-41.
- **Proposed fix**: A sentence noting "Model-level defaults (SWvThreshold, SWvHysteresis, SWonConduct, SWoffConduct) are set at compile time via the existing MnaModel registration or factory defaults; `setup()` does not repeat them." would complete the correspondence.

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH2-I2 | info | PB-SW ss"setup() body" | swsetup.c:28-41 model defaults block not mentioned; implementer may wonder whether setup() needs to handle it | Add one sentence explaining model defaults are set at compile time / factory registration |

---

#### BATCH2-I3- PB-SUBCKT setup() does not address the idempotency gate (`_isSetup`) for the composite (info)

- **Applies to**: PB-SUBCKT ss"setup() body"
- **Problem**: `MNAEngine._setup()` has an early-return idempotent guard (`if (this._isSetup) return;` per 00-engine.md ssA4.2). If the engine calls `_setup()` a second time (which is valid per the spec), the per-element loop calls `el.setup(ctx)` again for every element including the subcircuit composite. The composite forwards to its sub-elements, meaning every sub-element's `setup()` is called a second time. Some sub-elements (VSRC, IND, VCVS, CCVS) have their own element-level idempotent guard (`if (this.branchIndex === -1)`), so they are safe. But the subcircuit composite itself does not specify whether it should have its own guard or rely on the engine-level `_isSetup` flag to prevent double invocation.
  
  This is info-level because the engine-level guard is the documented mechanism and it prevents double-invocation at the engine boundary. But a reader of PB-SUBCKT in isolation would not know this.
- **Proposed fix**: A cross-reference note: "The engine's `_isSetup` guard (00-engine.md ssA4.2) prevents `setup()` from being called twice; no composite-level guard is needed."

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH2-I3 | info | PB-SUBCKT ss"setup() body" | Does not explain double-invocation safety; implementer may add redundant guard | Add cross-reference to 00-engine.md ssA4.2 `_isSetup` guard |

---

## Summary Table

| File | Findings | Worst Severity |
|------|----------|----------------|
| PB-VSRC-DC | FVSRC-DC-M1 (minor), BATCH2-D1 (major, shared) | major |
| PB-VSRC-AC | FVSRC-AC-M1 (minor), BATCH2-D1 (major, shared) | major |
| PB-VSRC-VAR | BATCH2-D1 (major, shared) | major |
| PB-ISRC | BATCH2-I1 (info) | info |
| PB-VCCS | BATCH2-M2 (minor) | minor |
| PB-VCVS | FVSRC-DC-D1 (major), FVCVS-D1 (major), BATCH2-M3 (info), BATCH2-M2 (minor) | major |
| PB-CCCS | FCCCS-M1 (major/mech) | major |
| PB-CCVS | FCCVS-D1 (major), FCCVS-M1 (minor/mech) | major |
| PB-SW | BATCH2-M1 (minor), BATCH2-I2 (info) | minor |
| PB-SW-DT | BATCH2-M1 (minor) | minor |
| PB-RELAY | FRELAY-D1 (major), BATCH2-D2 (major), BATCH2-M1 (minor) | major |
| PB-RELAY-DT | BATCH2-D2 (major), BATCH2-M1 (minor) | major |
| PB-ANALOG_SWITCH | FANALOG_SWITCH-D1 (critical), FANALOG_SWITCH-D2 (critical) | critical |
| PB-TRANSGATE | BATCH2-M1 (minor) | minor |
| PB-SUBCKT | FSUBCKT-D1 (critical), BATCH2-I3 (info) | critical |

---

## Overall Batch Verdict: needs-revision

**Blockers before W3 implementation can proceed:**

1. **PB-ANALOG_SWITCH** (critical ×2): `setCtrlVoltage` does not exist in codebase and is not specified in PB-SW; the SPDT inverted-polarity logic is mathematically inconsistent with the stated threshold semantics. An implementer cannot write correct code from this spec.

2. **PB-SUBCKT** (critical ×1): `_deviceMap` is populated from `compiled.elements` (top-level only) per 00-engine.md ssA4.1, so `ctx.findDevice` will return `null` for any sub-element inside a subcircuit. Any subcircuit containing a CCCS/CCVS/MUT that references another internal element will fail at setup time.

**Non-blocking but major (should be resolved before agent assignment):**

3. **BATCH2-D1** (major): VSRC family `findBranchFor` pseudocode uses an undefined `instance` variable; VCVS/CCVS use `ctx.findDevice` with a load-order type check that may return false positives for behavioral elements. A consistent pattern must be chosen.

4. **FVSRC-DC-D1** (major): VCVS `setup()` drops the element-level idempotent guard that ngspice uses and that VSRC family specs correctly specify, citing a false claim about `ctx.makeCur` idempotency.

5. **FRELAY-D1** (major): Relay coil label convention and `findBranchFor` closure variable are undefined; implementer must guess.

6. **BATCH2-D2** (major): Relay/RelayDT coil-resistance TSTALLOC positions 6-9 have no ngspice anchor in `indsetup.c`; the parity test cannot correctly assert them against ngspice.
