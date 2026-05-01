# Spec Review: Batch 4- Component Specs (Thyristors & Active Composites)

## Verdict: needs-revision

Files reviewed (13):
PB-DIAC.md, PB-SCR.md, PB-TRIAC.md, PB-SPARK.md, PB-ADC.md, PB-DAC.md,
PB-OPTO.md, PB-COMPARATOR.md, PB-OPAMP.md, PB-OTA.md, PB-REAL_OPAMP.md,
PB-SCHMITT.md, PB-TIMER555.md

---

## Tally

| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 4 | 4 |
| major    | 3 | 12 | 15 |
| minor    | 4 | 7 | 11 |
| info     | 2 | 0 | 2 |

---

## Plan Coverage

| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| W3: PB-DIAC composite setup() | yes | Sub-element ordering specified |
| W3: PB-SCR composite setup() | yes | Vint alloc + Q1/Q2 forward specified |
| W3: PB-TRIAC composite setup() | yes | Two latch nodes + Q1–Q4 specified |
| W3: PB-SPARK setup() body | yes | SW anchor specified |
| W3: PB-ADC composite setup() | yes | Behavioral pin-model forwarding |
| W3: PB-DAC composite setup() | yes | VCVS + pin models |
| W3: PB-OPTO composite setup() | yes | DIO + BJT + coupling allocs |
| W3: PB-COMPARATOR composite setup() | partial | Architecture change (Norton→VCVS) not flagged as a current-behavior change that may break existing tests |
| W3: PB-OPAMP composite setup() | partial | Architecture change (Norton→VCVS) same issue; rOut=0 vs rOut>0 branching underspecified |
| W3: PB-OTA composite setup() | yes | VCCS forwarding specified |
| W3: PB-REAL_OPAMP composite setup() | yes | 5 sub-elements specified |
| W3: PB-SCHMITT composite setup() | yes | Behavioral pin models |
| W3: PB-TIMER555 composite setup() | partial | RS-FF glue handle allocation order and pool reference in load() unresolved |
| Factory signature cleanup (all files) | yes | All files address internalNodeIds/branchIdx drop |
| setup-stamp-order.test.ts row per component | yes | All verification gates reference it |
| MnaModel hasBranchRow / mayCreateInternalNodes | yes | All files cover field changes |

---

## Summary Table

| File | Critical | Major | Minor | Info | Verdict |
|------|----------|-------|-------|------|---------|
| PB-DIAC | 0 | 1 | 1 | 0 | needs-revision |
| PB-SCR | 0 | 2 | 1 | 0 | needs-revision |
| PB-TRIAC | 0 | 1 | 1 | 1 | needs-revision |
| PB-SPARK | 0 | 0 | 1 | 0 | ready |
| PB-ADC | 1 | 2 | 1 | 0 | needs-revision |
| PB-DAC | 1 | 1 | 1 | 0 | needs-revision |
| PB-OPTO | 0 | 2 | 1 | 0 | needs-revision |
| PB-COMPARATOR | 1 | 2 | 1 | 1 | needs-revision |
| PB-OPAMP | 1 | 2 | 1 | 0 | needs-revision |
| PB-OTA | 0 | 0 | 0 | 0 | ready |
| PB-REAL_OPAMP | 0 | 3 | 1 | 0 | needs-revision |
| PB-SCHMITT | 0 | 1 | 0 | 0 | needs-revision |
| PB-TIMER555 | 0 | 3 | 1 | 0 | needs-revision |
| Batch-wide | 0 | 2 | 2 | 0 |- |

---

## Per-File Findings

---

### PB-DIAC

#### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FDIAC-M1 | minor | PB-DIAC ss"Sub-element 1: DIO D_fwd" ngspiceNodeMap | Map reads `{ A: "pos", K: "neg" }` with key `K` but DIAC has no pin labelled `K`- the parent pin is `B` (cathode of D_fwd). The description text says "A=anode maps to pos, B=cathode maps to neg" which is correct, but the map key is wrong. | Replace `{ A: "pos", K: "neg" }` with `{ A: "pos", B: "neg" }` for D_fwd; similarly for D_rev replace `{ A: "pos", K: "neg" }` with `{ B: "pos", A: "neg" }` (posNode=B, negNode=A for the antiparallel diode). |

#### Decision-Required Items

##### FDIAC-D1- posPrimeNode identity when RS=0 is not specified (major)

- **Location**: PB-DIAC ss"Internal nodes"
- **Problem**: Spec states "Each sub-element may create one internal node when its `RS ≠ 0`". When `RS = 0`, `diosetup.c:203-209` sets `posPrimeNode = posNode` (no makeVolt call). The TSTALLOC table in the spec shows `posPrime_fwd` as a variable and says entries (1)-(4) use it, but never explicitly states: "when RS=0, posPrimeNode aliases posNode, so entries 1–4 collapse to posNode." An implementer reading only this spec will not know whether to special-case the zero-RS path or always call makeVolt.
- **Why decision-required**: Could be resolved by (A) adding explicit text about the alias or (B) referencing the diosetup.c:203-209 lines directly with their conditional guard.
- **Options**:
  - **Option A- Add conditional text**: Add a sentence: "When RS=0, `posPrimeNode` aliases `posNode` (no `ctx.makeVolt` call) per `diosetup.c:203`; entries 1–3 then degenerate to `(A, A)`, `(B, A)`, `(A, A)`, `(A, B)`. The `DIOposPosPrimePtr` and `DIOposPrimePosPtr` rows/cols resolve to the same external node."
    - Pros: Self-contained; implementer can proceed without reading ngspice source.
    - Cons: Verbose; duplicates information already in PB-DIO spec (if PB-DIO covers this).
  - **Option B- Cross-reference PB-DIO**: Add: "RS=0 alias rule: identical to PB-DIO ss'Internal nodes'- implementer must read PB-DIO before implementing D_fwd/D_rev setup bodies."
    - Pros: DRY; single source of truth in PB-DIO.
    - Cons: Violates the W3 spec's self-containment requirement; implementer must hold two files simultaneously.

---

### PB-SCR

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FSCR-D1- setPinNode API does not exist in current element classes (major)

- **Location**: PB-SCR ss"setup() body" code block
- **Problem**: The spec shows `this._q1.setPinNode("B", this._gNode)` etc. as the mechanism to rebind sub-element pin nodes after `ctx.makeVolt` creates `_vintNode`. No such `setPinNode` method is declared anywhere in `00-engine.md`, `02-behavioral.md`, or the existing `AnalogElementCore` interface. The implementer has to invent this API or use a different rebinding mechanism.
- **Why decision-required**: Multiple approaches are valid- direct field write (`this._q1.pinNodeIds[1] = _vintNode`), a named setter, or redesigning construction so internal node values are passed as arguments at setup time. Each has different implications for type safety and the `AnalogElementCore` contract.
- **Options**:
  - **Option A- Specify direct pinNodeIds array write**: Change all `setPinNode("X", n)` calls in the spec to indexed writes: `this._q1.pinNodeIds = [G, _vintNode, K]` (setting the full array in one assignment, consistent with how PB-OPTO and PB-DAC do it: `this._ledSub.pinNodeIds = [nAnode, nCathode]`).
    - Pros: Consistent with the pattern used in PB-OPTO, PB-DAC, PB-OPAMP, PB-TIMER555 (all use `pinNodeIds =` not `setPinNode`). No new API needed.
    - Cons: Loses the readability of named pins; array indices must match pinLayout order exactly.
  - **Option B- Declare setPinNode on AnalogElementCore**: Add `setPinNode(pinLabel: string, nodeId: number): void` to the `AnalogElementCore` interface in `00-engine.md` ssA3 and implement it on all element classes.
    - Pros: Clearer intent; self-documenting.
    - Cons: Larger blast radius across all element implementations; not present in ngspice (ngspice uses struct fields directly).

##### FSCR-D2- no test assertions specified for scr.test.ts (major)

- **Location**: PB-SCR ss"Verification gate"
- **Problem**: Gate says "`src/components/semiconductors/__tests__/scr.test.ts` is GREEN" but does not specify what assertions the test must contain. The test file already exists. The spec gives no guidance on what the migrated test should assert about the new setup() contract- it only says "is GREEN," which a test that was green before the migration and remains green trivially satisfies, even if the setup() body is never actually exercised.
- **Why decision-required**: Different valid options exist for what the test should assert.
- **Options**:
  - **Option A- Assert stamp sequence**: Require `scr.test.ts` to include a test that runs `init()` + `_setup()` and asserts `solver._getInsertionOrder()` returns the expected sequence (Vint alloc → Q1 23 entries → Q2 23 entries).
    - Pros: Tests the actual new behavior; consistent with setup-stamp-order.test.ts intent.
    - Cons: Requires test modification, which may be more work than the W3 implementer expects.
  - **Option B- Only stamp-order test counts**: Explicitly state that the stamp-order test row is the sufficient test; `scr.test.ts` must not regress (functional tests remain green), but no new assertions are required.
    - Pros: Less work; cleaner separation of concerns.
    - Cons: scr.test.ts may not exercise setup() at all, leaving a coverage gap.

---

### PB-TRIAC

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FTRIAC-D1- setPinNode same issue as SCR (major)

- **Location**: PB-TRIAC ss"setup() body" code block
- **Problem**: Same `setPinNode` method used for Q1–Q4 rebinding that does not exist on the element API. See FSCR-D1.
- **Why decision-required**: Same as FSCR-D1- this is a cross-file inconsistency. PB-OPTO and PB-OPAMP use `pinNodeIds = [...]` for the same purpose.
- **Options**: Same two options as FSCR-D1.

#### Info

##### FTRIAC-I1- gate node coupling between SCR1 and SCR2 is not verified (info)

- **Location**: PB-TRIAC ss"Four-transistor latch"
- **Observation**: Both SCR1 and SCR2 share the same Gate node `G`. The spec correctly assigns `B=G` for Q1 (NPN-SCR1) and `B=G` for Q3 (NPN-SCR2). However, the spec does not address whether positive feedback through G causes numerical convergence issues when both SCRs are simultaneously near threshold (both are driven from the same gate node). This is an architectural risk worth flagging, though it does not block implementation.
- **Recommendation**: Flag as a convergence-log monitoring item in the verification gate.

---

### PB-SPARK

#### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FSPARK-M1 | minor | PB-SPARK ss"State slots" | First line reads "2." (a numbered list item starting at 2)- the section has no item "1." This appears to be a formatting artifact where the section header and numbered list collided. | Remove the stray "2." prefix from the state slots section opener. |

**Verdict: ready** (one minor mechanical fix; no Decision-Required items).

---

### PB-ADC

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FADC-D1- accept() references undefined variable `pool` (critical)

- **Location**: PB-ADC ss"load() body" `accept()` method, line `const s0 = pool.states[0];`
- **Problem**: The `accept()` code body references `pool` as a free variable, but there is no declaration of `pool` in the method's scope, no `this._pool`, and no parameter. The spec does not say how the element accesses the `StatePool`- whether it holds a direct reference set during `setup()`, reads it from `ctx`, or uses some other mechanism. An implementer cannot write this code without inventing the access path.
- **Why decision-required**: Two main patterns exist in the codebase- direct field reference (`this._pool`) vs. context access (`ctx.statePool`). The choice affects the element's constructor and setup() body.
- **Options**:
  - **Option A- this._pool field**: The element stores a reference to the StatePool set at the end of setup() (after `ctx.allocateStateBuffers` has run): `this._pool = ctx.pool` (or however it's accessed). Replace `pool.states[0]` with `this._pool.states[0]` throughout.
    - Pros: Consistent with how PB-SCHMITT and PB-TIMER555 imply pool access (they reference `this._pool.states[0]` and `pool.states[0]` respectively).
    - Cons: `ctx.allocateStateBuffers` is called AFTER setup() per A5.1, so pool is not available during setup; must be injected later (e.g., via an `initState(pool)` method).
  - **Option B- ctx.statePool in load/accept**: Accept takes a `LoadContext`; if `LoadContext` exposes `statePool`, use `ctx.statePool.states[0]`.
    - Pros: No extra field on the element; matches how some existing elements work.
    - Cons: `LoadContext` type must be verified to expose `statePool`- this is not established by any of the reviewed specs.

##### FADC-D2- EOC logic uses wrong variable nEoc in load() body (major)

- **Location**: PB-ADC ss"load() body" `load()` method, line `if (nEoc > 0) this._eocModel.load(ctx);`
- **Problem**: The `load()` body declares `nEoc` is not computed in the `load()` scope- the method only pulls `nVin`, `nVref`, `nGnd`, `nClk` from `_pinNodes`. The `if (nEoc > 0)` check references a variable that has no assignment in the `load()` function body shown.
- **Why decision-required**: Could be an omitted line (trivially add `const nEoc = this._pinNodes.get("EOC")!;`) or could indicate that `nEoc` is meant to be cached as a field at construction time.
- **Options**:
  - **Option A- Add missing const line**: Insert `const nEoc = this._pinNodes.get("EOC")!;` at the top of `load()` alongside the other node lookups.
    - Pros: Minimal change; consistent with surrounding code pattern.
    - Cons: Repeated lookup on every load() call (minor perf issue).
  - **Option B- Cache as field**: At construction/setup time, cache `this._nEoc = this._pinNodes.get("EOC")!` and reference `this._nEoc` in `load()`.
    - Pros: Avoids repeated map lookups.
    - Cons: More changes to spec; inconsistent with how the spec shows other nodes being looked up inline.

##### FADC-D3- quantization stage location ambiguous for the batch-wide concern (minor)

- **Location**: PB-ADC ss"Sub-element decomposition" and ss"load() body"
- **Problem**: The spec states "Conversion logic is NOT done here- only in accept()." This is correct for clock-edge-triggered ADCs, but the spec does not address what happens if `CLK` is wired to ground (always-low) or always-high: does the ADC ever produce output? The edge-detection logic in `accept()` would never fire a rising edge if CLK is permanently high. This is an edge case that should be addressed (either "works as expected- no conversion" or "detect at construction time and warn").
- **Options**:
  - **Option A- Document the no-edge case**: Add a note: "If CLK is wired to a constant-high source, no rising edges occur and EOC never fires. This is correct behavior- the ADC is clock-driven."
    - Pros: Clarifies intent; implementer won't add workarounds.
    - Cons: Minor doc addition only.
  - **Option B- Add a DC operating mode**: Spec a second conversion path that fires unconditionally in `load()` when CLK is not connected. More complex, may not match actual component behavior.

---

### PB-DAC

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FDAC-D1- hasBranchRow declared false on composite but VCVS sub-element creates a branch (critical)

- **Location**: PB-DAC ss"Factory cleanup"
- **Problem**: Spec states `hasBranchRow: false` on the composite's `MnaModel`. However, per `00-engine.md` ssA3.1, `hasBranchRow` is used by `detectVoltageSourceLoops` and `detectInductorLoops` to correctly size worst-case topology. The DAC composite contains a VCVSElement sub-element (`vcvs1`) which **does** create a branch row. If the composite declares `hasBranchRow: false`, the topology validators may under-count branch rows for circuits containing DACs, potentially missing voltage-source loops.
- **Why decision-required**: The spec's own rule says `hasBranchRow` applies to the composite's MnaModel registration. But the wording in `00-engine.md` ssA3.1 is "True for models that allocate a branch row in setup()." The composite's `setup()` calls `vcvs1.setup(ctx)` which allocates a branch row. Does the composite count?
- **Options**:
  - **Option A- hasBranchRow: true on composite**: The composite's own setup() indirectly allocates a branch row (via vcvs1). Mark `hasBranchRow: true` to keep topology validators accurate.
    - Pros: Correct from a circuit-topology perspective; matches how PB-COMPARATOR handles the same situation (also VCVS inside, also says `hasBranchRow: false`- so this would make them consistent differently).
    - Cons: Requires revising the rule in `00-engine.md` to clarify "direct vs indirect" branch row; could affect comparator, opamp, real-opamp, timer555 specs too.
  - **Option B- hasBranchRow: false on composite (keep as-is)**: The composite itself does not *directly* call `ctx.makeCur`- only its sub-elements do. The topology validator should walk sub-elements to discover branch rows.
    - Pros: Consistent with the pattern used across all composite specs in this batch.
    - Cons: Topology validators in `00-engine.md` ssA6.5 that use `model.hasBranchRow` would need to know to recurse into composites, which is not specified.
  - **Option C- Document the convention explicitly**: Add a note to `00-engine.md` ssA3.1 (or to the composite specs) stating: "For composites, `hasBranchRow` refers only to direct `ctx.makeCur()` calls in the composite's own `setup()` body, not to sub-element calls. Topology validators that need to count all branch rows must walk the sub-element tree."
    - Pros: Resolves the ambiguity for all composites simultaneously.
    - Cons: Requires touching `00-engine.md` and potentially the topology validator code.

##### FDAC-D2- VCVS out- is GND (node 0) but allocElement(0, branch) behavior is not verified (major)

- **Location**: PB-DAC ss"VCVS TSTALLOC sequence"
- **Problem**: The spec shows entries (2), (4), (6) using `nGnd` (which may be 0 when GND is circuit ground). The spec says: "entries where node = 0 (ground) are no-ops in `allocElement`. When `nGnd = 0`, entries (2), (4), (6) are skipped by the VCVSElement's `setup()` body." However, the `VCVSElement.setup()` body is not specified in this file (it lives in PB-VCVS.md which is not in this batch). The implementer must assume VCVSElement correctly skips ground entries, but this is an assumption, not a verified spec claim. If VCVSElement does NOT skip ground rows, the stamp-order test will fail in a confusing way.
- **Options**:
  - **Option A- Add cross-reference**: Add: "VCVSElement.setup() skips allocElement calls where row or col is 0- see PB-VCVS ss'Internal nodes: ground handling'. The stamp-order assertion for PB-DAC counts only non-zero-row entries."
    - Pros: Explicit; implementer knows where to look.
    - Cons: Requires reading PB-VCVS.
  - **Option B- Add inline assertion**: State explicitly how many TSTALLOC entries are expected in the stamp-order test for `nGnd=0` case vs `nGnd>0` case.
    - Pros: Self-contained.
    - Cons: More text; duplicates content from PB-VCVS.

##### FDAC-D3- DAC_COMPOSITE_SCHEMA described as "empty" but VCVS branch needs hasBranchRow reconciliation (minor)

- **Location**: PB-DAC ss"State slots"
- **Problem**: Spec says "DAC_COMPOSITE_SCHEMA (empty in source) remains empty." But the existing source has an `ADC_COMPOSITE_SCHEMA` that "currently empty" gains 2 slots (per PB-ADC). For DAC it explicitly remains empty. This is fine for state, but the spec does not address whether the schema needs updating to declare the VCVS's branch row for any schema-based branch tracking.
- **Options**:
  - **Option A- Explicitly confirm schema stays empty**: Add "No schema changes- VCVS branch is tracked by vcvs1's own MnaModel, not the composite schema."
    - Pros: Removes ambiguity.
  - **Option B- No change needed**: If implementers understand schema is state-only, this is a non-issue.

---

### PB-OPTO

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FOPTO-D1- pool reference in load() undefined (major)

- **Location**: PB-OPTO ss"load() body", line `const s0 = pool.states[0];`
- **Problem**: Identical to FADC-D1- `pool` is a free variable with no declared scope. The spec does not establish how the optocoupler element accesses the StatePool in `load()`. The state offsets (`diodeBase + DIODE_SLOT_ID`, `diodeBase + DIODE_SLOT_GEQ`) also reference `diodeBase` which is not defined in the spec.
- **Why decision-required**: Same as FADC-D1. `diodeBase` is also undefined- it may be `this._ledSub.stateBaseOffset` or some other accessor.
- **Options**:
  - **Option A- Define diodeBase and pool explicitly**: Add: "In `load()`, `pool = this._pool` (set during state initialization), `diodeBase = this._ledSub.stateBaseOffset`. The DIODE_SLOT_ID and DIODE_SLOT_GEQ constants are the existing slot indices from dioload.c."
    - Pros: Implementer can write the code without guessing.
    - Cons: Requires knowing what `DIODE_SLOT_ID` and `DIODE_SLOT_GEQ` are named in digiTS source.
  - **Option B- Cross-reference PB-DIO**: Add: "See PB-DIO ss'State slot names' for DIODE_SLOT_ID and DIODE_SLOT_GEQ constants. Access pattern: `ledSub.stateBaseOffset + DIODE_SLOT_GEQ`."
    - Pros: DRY.
    - Cons: Requires holding PB-DIO simultaneously.

##### FOPTO-D2- CCCS coupling model is a Jacobian approximation not matching a named ngspice anchor (major)

- **Location**: PB-OPTO ss"setup() body" ss"Setup order" steps 4–5 and ss"load() body"
- **Problem**: The spec introduces a custom CCCS Jacobian coupling (`_hBaseAnode`, `_hBaseCathode`) for the photo-current transfer. This coupling is a digiTS-internal behavioral approximation- it has no ngspice `*setup.c` anchor. The spec does not acknowledge this as an architectural divergence or explain why the approximation is sufficient. Specifically:
  - The coupling stamps `G[nBase, nAnode] += CTR * geqLed`- this is a Norton linearisation of `I_base = CTR * I_LED`. The correctness of this linearisation depends on `geqLed` being the correct NR companion conductance from the diode, but the spec doesn't verify this against any reference.
  - The `setup-stamp-order.test.ts` row will include these coupling entries in positions 4–5 after the sub-element TSTALLOCs. But since this has no ngspice anchor, what does the test assert them against?
- **Why decision-required**: The spec must either (a) accept this as an architectural divergence and document it per CLAUDE.md rules, or (b) change the coupling model to use an existing supported mechanism (e.g., CCCS sub-element) that has a known anchor.
- **Options**:
  - **Option A- Accept as architectural divergence, add to spec/architectural-alignment.md**: The composite CCCS coupling is a digiTS behavioral approximation with no ngspice equivalent (ngspice has no optocoupler primitive). Add an entry to `spec/architectural-alignment.md` documenting this.
    - Pros: Honest about the divergence; doesn't block implementation.
    - Cons: Requires user action (per CLAUDE.md, agents cannot add architectural-alignment.md entries).
  - **Option B- Replace coupling allocs with a CCCS sub-element**: Instead of ad-hoc coupling handles, model the photo-current as a formal CCCS sub-element with `senseSourceLabel` pointing to ledSub's branch. But DIO has no branch row (`hasBranchRow: false` for diodes), so CCCS cannot sense it directly.
    - Pros: Uses existing infrastructure.
    - Cons: DIO has no branch; CCCS requires a branch to sense. Would require adding a VSRC in series with the LED, significantly changing the topology.
  - **Option C- Keep custom coupling, explicitly document it as behavioral in the spec**: Add a note: "These two allocElement calls at steps 4–5 are digiTS-internal- they have no ngspice TSTALLOC equivalent. The stamp-order test asserts only positions and not a ngspice line-for-line match for these entries."
    - Pros: Honest; implementable without architectural-alignment.md change.
    - Cons: Weakens the ngspice-parity guarantee for this component.

---

### PB-COMPARATOR

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FCOMP-D1- Architecture change from Norton to VCVS is a breaking behavioral change not flagged (critical)

- **Location**: PB-COMPARATOR ss"Sub-element decomposition" and ss"Construction"
- **Problem**: The spec states: "The current open-collector and push-pull implementations use a conductance-only stamp (no VCVS branch). After migration, the VCVS sub-element provides the branch row for the stamp-order test." This is an architectural change- the existing comparator.ts does NOT use a VCVS and the spec is requiring a rewrite. However:
  1. The existing `comparator.test.ts` tests the current conductance-only behavior. The spec does not say which assertions in that test will need to change.
  2. The VCVS model has fundamentally different convergence behavior (branch current variable added to KCL). The spec does not address how the saturation clamp interacts with the VCVS branch current during NR iteration.
  3. "The saturation behavior is preserved" is an assertion without a verification criterion. What voltage/current tolerance is "preserved"?
- **Why decision-required**: This is not a migration of an existing implementation- it is a replacement architecture. The spec must either specify how the old test assertions change, or explicitly acknowledge this as a behavioral difference.
- **Options**:
  - **Option A- Keep conductance-only model, skip VCVS**: If the current comparator works correctly with conductance stamps, keep it. Replace the `setup()` body with the conductance alloc pattern (analogous to SW TSTALLOC), not a VCVS. The stamp-order test row asserts the conductance entries, not VCVS entries.
    - Pros: No behavioral regression; simpler migration.
    - Cons: stamp-order test cannot compare against a ngspice anchor (VCVS anchor referenced in spec becomes irrelevant).
  - **Option B- Use VCVS, explicitly list test assertion changes**: Specify which assertions in comparator.test.ts change, and what the VCVS-based saturation approximation error bound is relative to the old conductance model.
    - Pros: Thorough; enables verification.
    - Cons: Large additional spec work.
  - **Option C- Keep VCVS spec but add explicit behavioral preservation criterion**: Add: "The migrated comparator output voltage error vs. the current implementation must be < 1 mV at steady state for all test circuits in comparator.test.ts. If any test fails this criterion, report it as a regression for user decision."
    - Pros: Gives implementer an actionable criterion.
    - Cons: Defining 1 mV may itself be a decision.

##### FCOMP-D2- load() body references undefined _latchActive and _p.rSat (major)

- **Location**: PB-COMPARATOR ss"load() body" code block
- **Problem**: The `load()` body references `this._latchActive` (a boolean field not declared anywhere in the spec) and `this._p.rSat` (a saturation resistance parameter not mentioned in any property spec). An implementer cannot implement this without knowing how `_latchActive` is computed/stored and where `rSat` comes from.
- **Why decision-required**: `_latchActive` could be derived from the pool state slot `OUTPUT_LATCH` (in which case the spec should say `const latchActive = pool.states[0][this._stateOffset] >= 0.5`) or it could be a cached field updated in an `accept()` body not shown. `rSat` is either a fixed value or a user-settable parameter.
- **Options**:
  - **Option A- Define _latchActive via pool state**: Replace `this._latchActive` with `const latchActive = this._pool.states[0][this._stateOffset] >= 0.5` and replace `this._p.rSat` with a fixed value (e.g., 1Ω) or a named param.
    - Pros: Consistent with the declared state slot.
    - Cons: Adds pool access requirement (same as FADC-D1).
  - **Option B- Add _latchActive and _p.rSat to the spec**: Declare `_latchActive: boolean` as a field updated in `accept()`, and add `rSat` to the parameter table.
    - Pros: Complete spec; implementer has everything needed.
    - Cons: Need to spec the `accept()` body too.

#### Info

##### FCOMP-I1- pin ordering noted but not cross-checked against ComponentDefinition (info)

- **Location**: PB-COMPARATOR ss"Pin mapping" "IMPORTANT" note
- **Observation**: The spec correctly flags that comparator `in+` is at y=-1 and `in-` at y=+1 (opposite from opamp). This is a useful warning. However, the spec doesn't cross-reference whether the `buildComparatorPinDeclarations()` function in source actually enforces this. An implementer only reading this spec file will implement correctly, but a reviewer cannot verify without also reading the source. Not a blocker, but worth a cross-reference.

---

### PB-OPAMP

#### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FOPAMP-M1 | major | PB-OPAMP ss"Sub-element decomposition" (simplified model row) | The "Simplified model" row says `vcvs1` has Pin assignment `in+`→`ctrl+`, `in-`→`ctrl-`, `out`→`out+`, `ground(0)`→`out-`. But the "Extended decomposition with rOut" section uses `vint` as the VCVS out+ and `out` as res1's output. The simple table above the extended decomposition shows `out` directly as VCVS out+, but the `setup()` body always checks `if (this._rOut > 0)`- there is no code path for `rOut=0`. The spec says "Simplified model (rOut == 0): `vint` collapses to `out`; `res1` omitted" but this is listed as a note after the extended table, not as a separate code branch. The `setup()` body has the correct branch (`else { vcvs1.pinNodeIds = [inP, inN, nOut, 0]; }`), so the code is right but the first table is misleading. | Clarify the first sub-element table to note "this table applies only when rOut=0"; or remove the standalone first table and keep only the extended decomposition table which is parameterised by rOut. |

#### Decision-Required Items

##### FOPAMP-D1- Architecture change Norton→VCVS same issue as COMPARATOR (critical)

- **Location**: PB-OPAMP ss"Sub-element decomposition"
- **Problem**: The spec states "The current implementation uses a Norton approximation (conductance + current source). After migration, the output stage switches to a true VCVS stamp matching vcvsset.c:53-58." This is the same breaking behavioral change as PB-COMPARATOR. Existing `opamp.test.ts` tests the Norton behavior. The spec does not say which tests change or how to verify behavioral preservation.
- **Why decision-required**: Same as FCOMP-D1.
- **Options**:
  - **Option A- Keep Norton model**: Spec a Norton-based setup() body (two conductance allocations) and keep existing test behavior. The stamp-order test row uses the conductance TSTALLOC, not VCVS.
    - Pros: No regression; simpler.
    - Cons: stamp-order test row references vcvsset.c which would be incorrect.
  - **Option B- Switch to VCVS, list behavioral tolerance criterion**: Add explicit criteria for what constitutes behavioral preservation.
    - Pros: Enables full ngspice-parity.
    - Cons: Large spec addition; opamp.test.ts assertions need revision.

##### FOPAMP-D2- defaultModel comment in Factory cleanup is spec-prohibited content (minor)

- **Location**: PB-OPAMP ss"Factory cleanup"
- **Problem**: The line "`defaultModel: 'behavioral'` remains for initial placement only" is a reminder about the CLAUDE.md hard rule ("The `defaultModel` property is ONLY meaningful for selecting the initial model in the property bag when a component is first placed"). This is correctly stated but it reads as rationale/history prose rather than a spec contract. Per `rules.md`, specs are current-state contracts and should not contain rationale prose.
- **Options**:
  - **Option A- Delete the line**: It adds nothing actionable- `defaultModel` behavior is defined by CLAUDE.md, not by the component spec.
    - Pros: Cleaner spec.
    - Cons: Loss of reminder for implementer.
  - **Option B- Rephrase as a constraint**: "Do not use `defaultModel` as a lookup key in setup() or load(). The `model` property on the element is the single source of truth."
    - Pros: Actionable; states what the implementer must NOT do.
    - Cons: Redundant with CLAUDE.md.

##### FOPAMP-D3- rOut=75 default undocumented as to whether it changes existing behavior (major)

- **Location**: PB-OPAMP ss"Construction" factory body, `const rOut = props.getModelParam<number>("rOut") ?? 75;`
- **Problem**: The default `rOut = 75` means the "simplified" path (rOut=0, direct VCVS to out) will NEVER be taken for default-constructed opamps. Every default opamp will have an extra internal node `vint` and a series resistor `res1`. This is a behavioral change from the current implementation (which has no explicit rOut resistor in the matrix). The spec does not flag this as a behavioral change or specify how existing opamp test circuits behave with this added series resistance.
- **Options**:
  - **Option A- Change default to rOut=0 (no series resistor)**: Default opamps have no output resistance; `rOut > 0` is only triggered by explicit parameter setting.
    - Pros: No behavioral regression.
    - Cons: Loses the rOut modeling capability for default placements.
  - **Option B- Keep rOut=75, flag as behavioral change**: Add a note: "Default rOut=75Ω adds a series output resistance not present in the current implementation. Existing tests that check output voltage at the `out` pin with a load may see ~75Ω·I_load voltage drop. Verify opamp.test.ts assertions remain valid."
    - Pros: Honest; lets implementer and reviewer know.
    - Cons: Does not resolve the issue, just documents it.

---

### PB-OTA

**Verdict: ready.**

No findings. The spec is self-contained, the VCCS forwarding pattern is consistent with PB-DAC and PB-COMPARATOR, state slot count is zero (correctly), and the Iabc handling is clearly specified. The `load()` body references only `ctx.rhsOld` and `ctx.rhs` which are established fields. No architecture change from current implementation is implied.

---

### PB-REAL_OPAMP

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FREALOP-D1- setup() ordering contradicts 01-pin-mapping.md composite rule (major)

- **Location**: PB-REAL_OPAMP ss"setup() body" and ss"Setup ordering rationale"
- **Problem**: The spec sets up sub-elements in the order: RES → CAP → DIO → DIO → VCVS. The rationale section says this follows "ascending `ngspiceLoadOrder` buckets." However, `00-engine.md` ssA4.2 states `_setup()` walks elements "in NGSPICE_LOAD_ORDER bucket order (matching cktsetup.c:72-81)." The composite's setup() must also follow this ordering when forwarding to sub-elements- and the spec correctly does so. However, `01-pin-mapping.md` ss"Subcircuit composition rule" says "Composite's `setup(ctx)` forwards to each sub-element's `setup(ctx)`" but does NOT specify the ordering rule for composites. The PB-REAL_OPAMP spec assumes NGSPICE_LOAD_ORDER but this is not confirmed by the engine spec for composite-level forwarding. A different composite (e.g., PB-OPAMP with rOut>0) sets up VCVS first then RES- which would be VCVS before RES (backwards from NGSPICE_LOAD_ORDER).
- **Why decision-required**: PB-OPAMP's setup() runs vcvs1 before res1 (VCVS bucket comes after RES in ngspice order- so PB-OPAMP violates the ordering PB-REAL_OPAMP describes). One of them must be wrong, or the ordering rule for composites needs clarification.
- **Options**:
  - **Option A- Enforce NGSPICE_LOAD_ORDER for all composites**: PB-OPAMP's setup() must set up res1 before vcvs1. Fix PB-OPAMP and confirm PB-REAL_OPAMP is correct.
    - Pros: Consistent with cktsetup.c logic.
    - Cons: Requires fixing PB-OPAMP spec.
  - **Option B- Composites may use any order**: The composite's sub-element setup order does not need to match NGSPICE_LOAD_ORDER; only the top-level engine walk (across components, not within a composite) needs to match. Composites can use any internally consistent order.
    - Pros: More flexible; neither spec is "wrong."
    - Cons: The stamp-order test for REAL_OPAMP and OPAMP will then assert different orderings for no principled reason.
  - **Option C- Declare ordering as "internal to composite, not constrained by NGSPICE_LOAD_ORDER"**: Update `00-engine.md` ssA6.4 to explicitly say sub-element ordering within a composite is at the composite's discretion, and the stamp-order test for composites only verifies each sub-element's own internal TSTALLOC order, not the inter-sub-element ordering.
    - Pros: Principled; resolves the contradiction.
    - Cons: Requires touching the engine spec.

##### FREALOP-D2- capComp pin assignment `0` as neg-node creates allocation ambiguity (major)

- **Location**: PB-REAL_OPAMP ss"Sub-element decomposition", capComp row
- **Problem**: `capComp` is assigned `nVint→pos`, `0→neg`. In `setup()`, `this._capComp.pinNodeIds = [this._nVint, 0]`. The `CAPElement.setup()` body (per PB-CAP spec, not in this batch) must handle a neg-node of 0 (ground) by skipping `allocElement` calls for that node per ngspice's `capsetup.c:114-117`. However, this spec does not verify whether PB-CAP correctly handles the zero-node case. The stamp-order verification row ("capComp 4×CAP") may be wrong if some of the 4 CAP entries are skipped.
- **Options**:
  - **Option A- Specify exact non-zero entries**: Replace "4×CAP" in the verification gate with the exact entries: "2 entries (nVint,nVint) and (nVint,0 skipped)- actually 2 entries not 4" if neg=0 entries are skipped.
    - Pros: Accurate stamp-order test.
    - Cons: Requires knowing PB-CAP's zero-node handling.
  - **Option B- Cross-reference PB-CAP**: Add "capComp node-0 handling follows PB-CAP ss'Ground node skipping'." and verify the stamp-order count from that spec.
    - Pros: DRY.
    - Cons: PB-CAP not in this batch; may create a review dependency.

##### FREALOP-D3- slew-rate load() references undefined _pinNodes.get in closure (major)

- **Location**: PB-REAL_OPAMP ss"load() body", slew-rate section
- **Problem**: The `load()` body repeatedly calls `this._pinNodes.get("in+")!` and `this._pinNodes.get("in-")!` inline during slew computation, inside the `if (dt > 0 && this._p.slewRate > 0)` block. These values were already resolved as `inP` and `inN` in `setup()` and at construction, but the `load()` body does not cache them as fields- it calls `_pinNodes.get()` inline every iteration. This is a performance and correctness issue because Map lookups on every NR iteration are unnecessary, and the pattern is inconsistent with how other composites cache node IDs as fields at construction.
- **Why decision-required**: Could be a spec inconsistency (should use `this._inP` / `this._inN` fields) or could be intentional (spec author chose inline lookups). Either way an implementer needs to know which pattern to follow.
- **Options**:
  - **Option A- Cache as fields**: Replace inline `this._pinNodes.get("in+")!` calls with `this._inP` and `this._inN` fields (set at construction like PB-OPAMP does with `{ vcvs1, res1, inP, inN, nOut, ... }`).
    - Pros: Consistent with PB-OPAMP; avoids repeated Map lookups.
    - Cons: Minor refactor of load() body.
  - **Option B- Keep inline lookups, document as intentional**: Add a comment: "inline lookup; pinNodes Map is small and constant after construction."
    - Pros: Minimal spec change.
    - Cons: Inconsistent with PB-OPAMP and other composites; likely to confuse implementer.

---

### PB-SCHMITT

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FSCHMITT-D1- pool access in load() undefined (major)

- **Location**: PB-SCHMITT ss"load() body", line `const outputHigh = this._pool.states[0][this._stateOffset] >= 0.5;`
- **Problem**: Unlike PB-ADC and PB-OPTO which used the bare name `pool`, PB-SCHMITT uses `this._pool`- but `_pool` is never declared as a field in the spec. It is not established in the factory body sketch, in `setup()`, or in the state slots section. An implementer does not know when or how `_pool` is assigned.
- **Why decision-required**: Same pattern as FADC-D1 and FOPTO-D1- pool access mechanism is a cross-cutting concern that needs a definitive answer.
- **Options**: Same as FADC-D1 Options A and B.

---

### PB-TIMER555

#### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FTIMER-M1 | minor | PB-TIMER555 ss"load() body", line `const s0 = pool.states[0];` | Same undefined `pool` variable as PB-ADC and PB-OPTO- `pool` is a free variable. PB-SCHMITT at least uses `this._pool`; PB-TIMER555 uses neither `this._pool` nor `ctx.pool`. | See FADC-D1 Decision-Required- not mechanical since the pool access mechanism is a decision. Escalated to FTIMER-D1. |

(The above is escalated- the entry is listed for visibility but the resolution is Decision-Required.)

#### Decision-Required Items

##### FTIMER-D1- pool reference in load() undefined (major)

- **Location**: PB-TIMER555 ss"load() body", line `const s0 = pool.states[0];`
- **Problem**: Same as FADC-D1, FOPTO-D1, FSCHMITT-D1. The pool access pattern is inconsistent across all four files: PB-ADC uses `pool`, PB-OPTO uses `pool`, PB-SCHMITT uses `this._pool`, PB-TIMER555 uses `pool`. This batch-wide inconsistency needs a single resolved pattern.
- **Options**: See FADC-D1 Options A and B. The resolution applies to all four files.

##### FTIMER-D2- RS-FF glue handle allocated after outModel setup() violates NGSPICE_LOAD_ORDER (major)

- **Location**: PB-TIMER555 ss"setup() body", last lines before CAP children
- **Problem**: The spec allocates `_hDisBaseDisBase` (the base-drive stamp handle) AFTER `outModel.setup(ctx)`. The setup ordering rationale says: RES → VCVS → BJT → Behavioral (outModel). The glue handle `allocElement(nDisBase, nDisBase)` does not belong to any named sub-element type; it is a composite-level direct call. But it is placed AFTER the behavioral outModel, which means it comes after the BJT and behavioral elements in the insertion order. This means the stamp-order test row must account for the glue handle appearing AFTER the 23-entry BJT sequence and AFTER the outModel entries. However, the verification gate says "rDiv1 4×RES, rDiv2 4×RES, rDiv3 4×RES, comp1 6×VCVS, comp2 6×VCVS, bjtDis 23×BJT, then RS-FF glue handle, then outModel"- but in the spec code, `outModel.setup(ctx)` comes BEFORE the glue handle. These two are inconsistent.
- **Why decision-required**: Either the code block is wrong (glue handle should come before outModel) or the verification gate description is wrong (outModel then glue handle, not glue then outModel).
- **Options**:
  - **Option A- Move glue handle before outModel**: In setup() code block, move `this._hDisBaseDisBase = ctx.solver.allocElement(...)` to just after `bjtDis.setup(ctx)` and before `outModel.setup(ctx)`. Update verification gate to match.
    - Pros: Matches the stated NGSPICE_LOAD_ORDER (non-behavioral before behavioral).
    - Cons: Minor reorder only.
  - **Option B- Keep glue handle after outModel, fix verification gate**: Update the verification gate to say "...then outModel, then RS-FF glue handle, then CAP children."
    - Pros: Matches the actual code block as written.
    - Cons: Puts a non-behavioral stamp after a behavioral one, which is harder to justify.

##### FTIMER-D3- outModel.setOutputVoltage() API does not exist in spec (major)

- **Location**: PB-TIMER555 ss"load() body", line `this._outModel.setOutputVoltage(vOut);`
- **Problem**: `DigitalOutputPinModel.setOutputVoltage(v)` is called in the Timer555 load() body, but `DigitalOutputPinModel` is specified in `02-behavioral.md` where it only declares `setLogicLevel(high: boolean)`. There is no `setOutputVoltage` method specified anywhere in the engine spec or behavioral spec. An implementer writing the Timer555 will not know whether to add this method to `DigitalOutputPinModel`, implement an alternative mechanism, or compute an equivalent logic level.
- **Why decision-required**: Could be resolved by (A) adding `setOutputVoltage` to the `DigitalOutputPinModel` spec in `02-behavioral.md`, or (B) replacing the call with `setLogicLevel(q)` and deriving the voltage from the logic level within the pin model.
- **Options**:
  - **Option A- Add setOutputVoltage to DigitalOutputPinModel spec**: Extend `02-behavioral.md` shape rules to include `setOutputVoltage(v: number): void` which bypasses the vOH/vOL thresholds and stamps a specific voltage.
    - Pros: Expressive; Timer555 output voltage tracks VCC dynamically.
    - Cons: Changes `02-behavioral.md`, which is outside this file's scope; requires coordinating with the behavioral spec.
  - **Option B- Use setLogicLevel only**: Replace `this._outModel.setOutputVoltage(vOut)` with `this._outModel.setLogicLevel(q)` and accept that the output voltage is vOH or vOL as set by the output spec, not tracking VCC dynamically.
    - Pros: Uses existing API; no spec extension needed.
    - Cons: Timer555 output won't track VCC. For a 5V supply, if `vOH = 5V` this is fine; but if VCC varies, this is wrong.

---

## Batch-Wide Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH4-M1 | major | PB-ADC, PB-OPTO, PB-SCHMITT, PB-TIMER555 ss"load() body" | `pool` / `this._pool` used as a free or undeclared variable across four files. Each file independently introduces this undefined reference. The pattern is a systematic omission. | Resolve via FADC-D1 decision, then apply the same fix to all four files. The result should be a single sentence added to each file's "Construction" or "setup() body" section establishing how the pool reference is obtained. |
| BATCH4-M2 | minor | PB-SCR ss"setup() body", PB-TRIAC ss"setup() body" | Both files use `setPinNode()` API which is absent from the engine spec, while PB-OPTO, PB-DAC, PB-OPAMP, and PB-TIMER555 all use `pinNodeIds = [...]` for the same purpose. This is a systematic inconsistency within the batch. | Resolve via FSCR-D1, then apply the same fix to TRIAC. The mechanical fix is: replace `setPinNode("X", n)` calls in both files with full `pinNodeIds = [...]` assignments matching the pinLayout order. |

### Decision-Required Items

#### BATCH4-D1- hasBranchRow semantics for composites containing branch-allocating sub-elements (critical)

- **Location**: PB-DAC, PB-COMPARATOR, PB-OPAMP, PB-REAL_OPAMP, PB-TIMER555 ss"Factory cleanup"
- **Problem**: All five specs declare `hasBranchRow: false` on the composite's own `MnaModel`, despite their sub-elements (VCVS for all five) allocating branch rows via `ctx.makeCur`. Per `00-engine.md` ssA3.1: "`hasBranchRow: true` for models that allocate a branch row in setup()." The composite's `setup()` does allocate a branch row- indirectly, via sub-element forwarding. The spec does not define whether "allocate" means direct or transitive. `detectVoltageSourceLoops` uses this flag to size topology validation.
- **Why decision-required**: The correct value of `hasBranchRow` on composites is ambiguous from the engine spec. This affects topology correctness for all five component types.
- **Options**:
  - **Option A- hasBranchRow: true on composites with VCVS sub-elements**: Update all five specs. Update `00-engine.md` ssA3.1 to clarify "direct or transitive."
    - Pros: Topology validators see all branch rows correctly.
    - Cons: Five files change; engine spec changes.
  - **Option B- hasBranchRow: false on composites, topology validators walk sub-elements**: Keep all five specs as-is. Update topology validator code to also check sub-elements.
    - Pros: Consistent with current batch spec; no spec file edits.
    - Cons: Requires topology validator code changes not covered by any spec in this plan.
  - **Option C- Clarify in engine spec that hasBranchRow applies to registration-level models only, not to composites**: Composites are exempt from the topology-validator check because the compiler resolves composites to their sub-elements before topology validation. Verify this claim against `compiler.ts`.
    - Pros: Principled; may already be how the code works.
    - Cons: Requires verifying compiler behavior against spec; may need a code cross-check.

#### BATCH4-D2- No test assertions specified for migrated behavioral composites (major)

- **Location**: PB-SCHMITT, PB-COMPARATOR, PB-OPAMP, PB-REAL_OPAMP, PB-TIMER555 ss"Verification gate"
- **Problem**: All five verification gates say only "[test file] is GREEN" with no specification of what assertions the test must contain post-migration. For COMPARATOR and OPAMP, where the architecture changes from Norton to VCVS, the existing test assertions may themselves be wrong (they test the Norton outputs). For SCHMITT, REAL_OPAMP, and TIMER555, the existing tests may not exercise `setup()` at all. "Is GREEN" is a trivially satisfiable criterion if the tests don't call the new code paths.
- **Options**:
  - **Option A- Add minimum assertion requirements**: For each of these five files, add a specific assertion that must be present in the test file: e.g., "test must include a case that calls `_setup()` and verifies `solver._getInsertionOrder().length > 0`."
    - Pros: Ensures the new code path is exercised.
    - Cons: May require changing existing test files.
  - **Option B- Treat stamp-order test as sufficient**: For all behavioral composites, the `setup-stamp-order.test.ts` row IS the setup() test. The existing test files only need to not regress. Document this explicitly in each verification gate.
    - Pros: Minimal change to test files; clear responsibility separation.
    - Cons: setup-stamp-order.test.ts may not test all error paths (e.g., what if nVin=0 for ADC?).

---

## Notes on PB-SPARK (passing)

PB-SPARK is the cleanest spec in this batch. The SW anchor is unambiguous, the TSTALLOC sequence is complete and matches `swsetup.c:59-62` line-for-line, the state slots are correctly specified with the `SW_NUM_STATES = 2` constant cited. The only issue is a minor formatting artifact (FSPARK-M1). The composite→direct-element transition is handled correctly by noting "Because the current implementation is a single flat element, its setup() body acts as the SW setup directly." The `ngspiceNodeMap` is correctly placed on the sub-element (not the composite). **Verdict: ready after M1 fix.**

---

## Notes on PB-OTA (passing)

PB-OTA is the second cleanest spec. The VCCS anchor is correctly cited, the 4-entry TSTALLOC sequence matches `vccsset.c:43-46`, no internal nodes are needed, no state slots are allocated (VCCS has `NG_IGNORE(states)`), and the bias-current scaling logic in `load()` uses only `ctx.rhsOld` and `ctx.rhs`- no undefined pool references. The `Iabc` pin is correctly treated as a pure voltage-read node. **Verdict: ready.**

---

Full report written to: C:/local_working_projects/digital_in_browser/spec/reviews/setup-load-split-batch-4-actives.md
