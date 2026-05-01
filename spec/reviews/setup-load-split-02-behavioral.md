# Spec Review: Phase 02- Behavioral Elements (02-behavioral.md)

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 2 | 2 |
| major    | 0 | 4 | 4 |
| minor    | 1 | 2 | 3 |
| info     | 0 | 1 | 1 |

## Plan Coverage

The plan (`plan.md`) does not assign discrete task IDs to behavioral items.
Behavioral work is described as part of W2 (stub `setup()` for every component)
and W3 (per-component spec files `PB-BEHAV-*.md`). The `02-behavioral.md` file
is referenced in the W2 reading guide as the cross-reference for "pin-model
setup interface." Coverage is evaluated against those W2/W3 obligations.

| Plan Obligation | In Spec? | Notes |
|-----------------|----------|-------|
| Pin-model setup() interface (W2 cross-reference) | partial | Shape rules 1–2 present but use wrong field names vs. source |
| Composite behavioral forward rule (W2 cross-reference) | partial | Shape rule 3 describes class-style fields that don't exist in factory-closure elements |
| PB-BEHAV-SEVENSEGHEX open blocker reflected | partial | ssShape rule 7 table says "same as SevenSeg" without addressing the 2-pin vs 8-pin mismatch noted in plan.md |
| Per-task W3 verification gate for behaviorals | yes | ssPer-task verification gate present |
| ngspice-anchor-status justification | yes | ssngspice-anchor status: NONE present |
| No setup-stamp-order row for behaviorals | yes | Explicitly stated |
| Pin-map field: behaviorals do not populate ngspiceNodeMap | yes | ssPin-map field section present |

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | ssShape rule 1 code block, line `if (this._inputCap)` | Field name `_inputCap` does not exist on `DigitalInputPinModel`. The actual field is `_capacitorChild` (private). The spec code block accesses a private field by name that differs from the source. | Replace `this._inputCap` with `this._capacitorChild` throughout the Shape rule 1 code block. Same rename for the forwarding call: `this._inputCap.setup(ctx)` → `this._capacitorChild.setup(ctx)`. |

---

### Decision-Required Items

#### D1- Shape rule 2 accesses non-existent field names (critical)

- **Location**: `02-behavioral.md` ssShape rule 2, code block for `DigitalOutputPinModel.setup(ctx)`
- **Problem**: The spec code reads:
  ```ts
  if (this._branchIndex <= 0 || this._nodeId <= 0) return;
  this._hBranchNode   = ctx.solver.allocElement(this._branchIndex, this._nodeId);
  this._hBranchBranch = ctx.solver.allocElement(this._branchIndex, this._branchIndex);
  this._hNodeBranch   = ctx.solver.allocElement(this._nodeId,      this._branchIndex);
  if (this._loaded) {
    this._hNodeDiag   = ctx.solver.allocElement(this._nodeId,      this._nodeId);
  }
  ```
  and later:
  ```ts
  if (this._outputCap) {
    this._outputCap.setup(ctx);
  }
  ```
  The actual `DigitalOutputPinModel` source (`src/solver/analog/digital-pin-model.ts`) uses:
  - `_branchIdx` (not `_branchIndex`)- lines 56, 93, 155, 210
  - `_capacitorChild` (not `_outputCap`)- lines 65, 98–100, 129–130

  An implementer copying this code verbatim will get TypeScript compile errors on private field access. Worse, because the fields are `private`, the TypeScript compiler will refuse the assignment `this._branchIndex = ...` inside the same class, so the spec code cannot be applied without first deciding which name wins.

- **Why decision-required**: The implementer could rename the private field in source to match the spec (`_branchIdx` → `_branchIndex`, `_capacitorChild` → `_outputCap`), or update the spec to match the source. Both are valid but each has different blast-radius implications (renaming the field ripples to every call-site in `digital-pin-model.ts`, `behavioral-gate.ts`, `behavioral-remaining.ts`, and tests).

- **Options**:
  - **Option A- Update spec to match source field names**: Change `_branchIndex` → `_branchIdx` and `_outputCap` → `_capacitorChild` in the Shape rule 2 code block. Also update the guard `if (this._branchIndex <= 0 ...)` → `if (this._branchIdx <= 0 ...)`.
    - Pros: Zero blast radius. Implementer can apply the setup() body without touching existing field declarations.
    - Cons: Spec uses a less readable name than `_branchIndex`.
  - **Option B- Rename source fields to match spec**: Rename `_branchIdx` → `_branchIndex` and `_capacitorChild` → `_outputCap` in `digital-pin-model.ts`, updating all call sites.
    - Pros: Spec becomes a clean forward-looking contract. `_branchIndex` is more consistent with the public getter `branchIndex`.
    - Cons: Wider blast radius- affects every file that reads `_capacitorChild` or `_branchIdx` directly (they are private, but the class implementation must be updated). Higher risk of merge conflicts with parallel W3 work.

---

#### D2- Shape rule 3 assumes class-instance field layout that does not exist (critical)

- **Location**: `02-behavioral.md` ssShape rule 3, code block for composite `setup(ctx)`
- **Problem**: The spec presents this generic forward body:
  ```ts
  setup(ctx: SetupContext): void {
    for (const pin of this._inputPins) pin.setup(ctx);
    for (const pin of this._outputPins) pin.setup(ctx);
    for (const child of this._childElements) child.setup(ctx);
    for (const sub of this._subElements ?? []) sub.setup(ctx);
  }
  ```
  and applies it to: `BehavioralGateElement, BehavioralMuxElement, BehavioralDemuxElement, BehavioralDecoderElement, Driver, DriverInv, Splitter, SevenSeg, ButtonLED, RelayElement, RelayDTElement, TransGateElement, NFETElement, PFETElement, FGNFETElement, FGPFETElement`.

  Of these, the following are **not classes**- they are factory functions returning plain object literals (closures):
  - `Driver` → `createDriverAnalogElement` (factory closure, `behavioral-remaining.ts:105`)
  - `DriverInv` → `createDriverInvAnalogElement` (factory closure, `behavioral-remaining.ts:222`)
  - `Splitter` → `createSplitterAnalogElement` (factory closure, `behavioral-remaining.ts:345`)
  - `SevenSeg` → `createSevenSegAnalogElement` (factory closure, `behavioral-remaining.ts:549`)
  - `Relay` → `createRelayAnalogElement` (factory closure, `behavioral-remaining.ts:612`)
  - `RelayDT` → `createRelayDTAnalogElement` (factory closure, `behavioral-remaining.ts:743`)
  - `ButtonLED` → `createButtonLEDAnalogElement` (factory closure, `behavioral-remaining.ts:871`)
  - `TransGate`, `NFET`, `PFET`, `FGNFET`, `FGPFET` → switching factories in `src/components/switching/`

  None of these have `this._inputPins`, `this._outputPins`, `this._subElements`, or `this._childElements` fields. The generic `for (const pin of this._inputPins)` loop cannot be applied to a closure that stores its pin models as local variables. The only class matching the `this._*Pins` pattern in the source is `BehavioralGateElement` (`behavioral-gate.ts:76–80`), which has `_inputs`, `_output`, and `_childElements`- but not `_inputPins` or `_outputPins`.

  Implementer agents for W3 behavioral factory closures will have no class body to add `setup()` to. The spec does not describe the actual implementation pattern for closures (adding a `setup` property to the returned object literal).

- **Why decision-required**: Two fundamentally different implementation strategies exist. The choice determines whether the implementation requires refactoring the factory closures into classes, or whether the spec's code snippet must be replaced with the closure-appropriate equivalent for each factory.

- **Options**:
  - **Option A- Rewrite Shape rule 3 for closure-based elements**: Replace the class-body snippet with guidance that factory-closure elements add a `setup` property to the returned object literal. Describe the pattern concretely for each factory (e.g., for `createDriverAnalogElement`, the returned object gets `setup(ctx) { inputPin.setup(ctx); selPin.setup(ctx); outputPin.setup(ctx); for (const c of childElements) c.setup(ctx); }`). Keep the class-body form for `BehavioralGateElement` only.
    - Pros: Matches existing source architecture. No refactoring required.
    - Cons: Shape rule 3 becomes longer and per-element-group. More spec text.
  - **Option B- Convert factory closures to classes before W3**: Refactor `createDriverAnalogElement`, `createSplitterAnalogElement`, `createSevenSegAnalogElement`, `createRelayAnalogElement`, `createRelayDTAnalogElement`, `createButtonLEDAnalogElement` (and the switching factories) into classes with `_inputPins`, `_outputPins`, `_childElements`, `_subElements` fields, so Shape rule 3 applies uniformly.
    - Pros: Uniform architecture across all behavioral elements. Shape rule 3 body is reusable.
    - Cons: Large blast radius- each factory refactor touches its test file and any call site. Should be a separate spec section (pre-W3 refactor wave) not embedded in the behavioral spec.

---

#### D3- Shape rule 2 guard condition mismatch with source semantics (major)

- **Location**: `02-behavioral.md` ssShape rule 2, `role === "branch"` guard
- **Problem**: The spec reads:
  ```ts
  if (this._branchIndex <= 0 || this._nodeId <= 0) return;
  ```
  In the actual source (`digital-pin-model.ts:155`), the existing guard for the branch role is:
  ```ts
  const bIdx = this._branchIdx;
  if (bIdx < 0) return;
  ```
  The spec uses `<= 0` (treating 0 as invalid) but the existing guard uses `< 0`. MNA branch indices are 1-based; `0` is indeed not a valid branch row. However, the spec also applies `<= 0` to `_nodeId`, while the existing source code for direct role does not guard on `_nodeId`- it stamps node 0 (ground) separately when `nodeId > 0`. Changing the guard to `<= 0 || _nodeId <= 0` before `allocElement` calls would skip setup for pins with ground nodes, which may or may not be correct.

- **Why decision-required**: The correct boundary condition for "is this branch index valid for allocation?" is not pinned down: `< 0` (allow 0, which is not a valid MNA row) vs `<= 0` (exclude 0). These differ only when `_branchIdx === 0`, which may be unreachable in practice, but the spec must be authoritative.

- **Options**:
  - **Option A- Align spec guard to `< 0` (match existing source)**: Change `if (this._branchIndex <= 0 ...)` to `if (this._branchIdx < 0 ...)` in Shape rule 2.
    - Pros: No semantic change from current behavior.
    - Cons: Does not document whether `branchIdx === 0` is a possible invalid state.
  - **Option B- Use `<= 0` and document why 0 is invalid**: Keep `<= 0` in the spec, add a note that MNA branch rows are 1-based so `0` is always an unallocated sentinel. Update the source guard from `< 0` to `<= 0` at the same time.
    - Pros: More explicit invariant documentation.
    - Cons: Requires changing source guard (minor blast radius).

---

#### D4- Shape rule 7 (SevenSegHex) does not address the PB-BEHAV-SEVENSEGHEX open blocker (major)

- **Location**: `02-behavioral.md` ssShape rule 7 and the component-list table row for `SevenSegHex`
- **Problem**: The plan (`plan.md` ssOpen blockers) states:

  > `SevenSegHex` reuses `createSevenSegAnalogElement` directly with 8 segment-labelled pins, while the SevenSegHex component declares only 2 pins (`d`, `dp`). The compiler must resolve pin-label mapping between the component's pin layout and the factory's segment-label addressing.

  The spec's component table row reads:
  ```
  | SevenSegHex | same as SevenSeg | same | `PB-BEHAV-SEVENSEGHEX.md` |
  ```
  And Shape rule 7 has no mention of the 2-pin vs 8-pin mismatch. The actual source (`seven-seg-hex.ts:209–214`) confirms: `SevenSegHexDefinition.modelRegistry.behavioral.factory = createSevenSegAnalogElement`, and `buildSevenSegHexPinDeclarations()` returns only `["d", "dp"]`. The `createSevenSegAnalogElement` factory attempts `pinNodes.get("a")`, `pinNodes.get("b")`, etc.- which will return `undefined` for all segment pins, producing `segNodes` array of `undefined` values (TypeScript non-null assertion `!` will not catch this at runtime).

  The spec says "Implementer verifies at W3 time. If existing tests pass, current behavior is fine."- but this verdict lives in `plan.md`, not in `02-behavioral.md`. The spec itself is silent on the mismatch, giving W3 implementer agents no guidance.

- **Why decision-required**: Whether the mismatch is a pre-existing no-op (SevenSegHex has no analog pins that carry current) or a latent crash (non-null assertions on undefined) requires a runtime analysis decision. Three resolution paths exist depending on whether the analog model should actually function.

- **Options**:
  - **Option A- Declare SevenSegHex has no functional analog model; setup() is empty**: Add a note to Shape rule 7 and the component table: "SevenSegHex's behavioral analog model receives only `d` and `dp` pin nodes. `createSevenSegAnalogElement` will map all segment pins to `undefined`; the setup() and load() of each resulting SegmentDiodeElement will be no-ops (node 0 guard). This is acceptable- SevenSegHex is digital-only in practice." Implementer verifies that the `!` non-null assertions do not throw.
    - Pros: No code change required; captures the runtime behavior accurately.
    - Cons: Leaves the `!` non-null assertions in place that could crash if called with unexpected data.
  - **Option B- Give SevenSegHex its own analog factory that accepts `d`/`dp` only**: Add `createSevenSegHexAnalogElement` to `behavioral-remaining.ts` that decodes `d` and `dp` into 8 segment states internally and forwards to 8 `SegmentDiodeElement` instances with internally allocated nodes. Update `SevenSegHexDefinition.modelRegistry.behavioral.factory` to point to this new factory.
    - Pros: Clean architecture; removes reliance on pin-label coincidence between the display and its shared factory.
    - Cons: Additional implementation work; requires new function, new test coverage.
  - **Option C- Defer to PB-BEHAV-SEVENSEGHEX.md with explicit guidance**: Add a note to Shape rule 7 directing the W3 implementer agent to PB-BEHAV-SEVENSEGHEX.md for the pin-mapping resolution, and ensure that file contains the decision. The spec is currently silent and the per-component file does not yet contain this resolution.
    - Pros: Keeps the decision localized to the per-component spec.
    - Cons: Neither file currently contains the resolution, so the implementer has no guidance.

---

#### D5- Shape rule 9 (Relay/RelayDT) uses class-field syntax for a factory closure (major)

- **Location**: `02-behavioral.md` ssShape rule 9, the presented `setup(ctx)` code block
- **Problem**: The spec presents:
  ```ts
  setup(ctx: SetupContext): void {
    this._hC1C1 = ctx.solver.allocElement(nodeCoil1, nodeCoil1);
    this._hC2C2 = ctx.solver.allocElement(nodeCoil2, nodeCoil2);
    this._hC1C2 = ctx.solver.allocElement(nodeCoil1, nodeCoil2);
    this._hC2C1 = ctx.solver.allocElement(nodeCoil2, nodeCoil1);
    this._hCAA = ctx.solver.allocElement(nodeContactA, nodeContactA);
    ...
    this._coilInductor.setup(ctx);
  }
  ```
  The actual `createRelayAnalogElement` is a factory closure (`behavioral-remaining.ts:612`). It returns a plain object literal. The `stampG` calls in `load()` use closure-captured local variables (`nodeCoil1`, `nodeCoil2`, `nodeContactA`, `nodeContactB`)- not `this._*` fields. There is no class with `this._hC1C1` etc. The spec's `this._hC1C1 = ...` syntax cannot be applied to the returned object literal without introducing new local variables in the closure scope.

  Additionally, the actual relay's `load()` currently calls `stampG(s, nodeCoil1, nodeCoil2, 1 / rCoil)` which internally calls `allocElement` four times (via `stampG` helper). The spec's `setup()` code allocates these as named handles `_hC1C1`, `_hC2C2`, `_hC1C2`, `_hC2C1`. There is no mapping shown from these handle names to the `stampG` calls they replace in `load()`.

- **Why decision-required**: The implementer must choose either to introduce local handle variables in the closure (matching the closure pattern) or to refactor the relay into a class. Both are coherent but neither is specified.

- **Options**:
  - **Option A- Rewrite Shape rule 9 for the closure pattern**: Replace `this._hC1C1 = ...` with local variable declarations (`let _hC1C1 = -1; ...`) in the closure, and describe the `setup` property on the returned object literal that captures them. Show the corresponding `load()` change replacing `stampG(s, nodeCoil1, nodeCoil2, ...)` with four explicit `solver.stampElement(_hC1C1, ...)` calls.
    - Pros: Matches existing source architecture. No refactoring. Consistent with D2 Option A.
    - Cons: Spec becomes more verbose; the `stampG` helper must be removed from relay's load() (breaking the current concise style).
  - **Option B- Convert relay factory to class before Shape rule 9 applies**: Refactor `createRelayAnalogElement` and `createRelayDTAnalogElement` into classes as part of a pre-W3 refactor (see D2 Option B). Then Shape rule 9's `this._*` syntax applies directly.
    - Pros: Uniform pattern. Shape rule 9 as written becomes usable.
    - Cons: Largest blast radius in the behavioral spec. Relay has complex `PoolBackedAnalogElementCore` requirements that make class refactoring non-trivial.

---

#### D6- Per-task verification gate does not specify concrete test file paths for factory-closure elements (major)

- **Location**: `02-behavioral.md` ssPer-task verification gate (W3), item 1
- **Problem**: The spec reads:
  > Component's existing test file (`src/solver/analog/__tests__/<file>.test.ts` or `src/components/<dir>/__tests__/<file>.test.ts`) is GREEN.

  This is a template path, not a concrete path. For a W3 implementer agent working on, e.g., `SevenSeg`, the relevant test file is `src/solver/analog/__tests__/behavioral-remaining.test.ts`. For `BehavioralGateElement` it is `src/solver/analog/__tests__/behavioral-gate.test.ts`. The implementer cannot unambiguously locate the test file from the spec alone- the template has two alternative path forms with wildcard `<file>` and `<dir>` placeholders.

  The rules (`spec/.context/rules.md`) require: "Every task has concrete acceptance criteria that a reviewer could verify." A path template is not concrete.

- **Why decision-required**: The spec author could either (a) enumerate the concrete test file per behavioral component, or (b) describe a deterministic lookup rule (e.g., "search for the file containing a describe block named after the component"). These produce different levels of effort and different risks of the implementer choosing the wrong file.

- **Options**:
  - **Option A- Enumerate concrete test file paths per component group**: Add a table mapping each behavioral component or group to its test file:
    - Gates → `src/solver/analog/__tests__/behavioral-gate.test.ts`
    - Mux/Demux/Decoder → `src/solver/analog/__tests__/behavioral-combinational.test.ts`
    - Driver/DriverInv/Splitter/SevenSeg/SevenSegHex/ButtonLED/Relay/RelayDT → `src/solver/analog/__tests__/behavioral-remaining.test.ts`
    - TransGate/NFET/PFET/FGNFET/FGPFET → `src/components/switching/__tests__/fets.test.ts` and `src/components/switching/__tests__/relay.test.ts`
    - Pros: Unambiguous. Implementer cannot pick the wrong file.
    - Cons: Must be kept in sync if test files are renamed.
  - **Option B- Add a lookup rule**: Change the spec to: "The component's test file is located by running `grep -rl 'createXxxAnalogElement\|BehavioralGateElement' src/solver/analog/__tests__/ src/components/`." Implementer runs the grep to find the file.
    - Pros: Self-updating if files are renamed.
    - Cons: Grep is non-deterministic if multiple test files match; adds ambiguity.

---

#### D7- Shape rule 1 guard `if (!this._loaded) return`- source does not have this guard in DigitalInputPinModel (minor)

- **Location**: `02-behavioral.md` ssShape rule 1, first two lines of `setup()` body
- **Problem**: The spec reads:
  ```ts
  setup(ctx: SetupContext): void {
    if (!this._loaded) return;            // unloaded inputs do not stamp
    if (this._nodeId <= 0) return;        // ground or unset
    ...
  }
  ```
  In the actual `DigitalInputPinModel.load()` (`digital-pin-model.ts:324`), the existing guard is only `if (this._nodeId <= 0) return` (implied by the `node` local variable check). There is no `if (!this._loaded) return` guard in the existing load body. However, the spec comment says "unloaded inputs do not stamp"- in the existing source, an unloaded `DigitalInputPinModel` simply stamps 0 conductance (because `1 / rIn` with a very large `rIn` is near zero), or alternatively `_loaded` is set to false and the stamp is skipped.

  The spec is imposing a new early-return that the existing load path may not match. If the existing `load()` stamps even when `_loaded = false`, and the new `setup()` skips allocation when `_loaded = false`, then `load()` will call `solver.stampElement(-1, ...)` (invalid handle) for unloaded inputs.

- **Why decision-required**: Whether "unloaded DigitalInputPinModel" skips all stamping (and therefore skips all allocation) or stamps a near-zero conductance through a valid handle is a behavioral decision that affects convergence for poorly-loaded circuits.

- **Options**:
  - **Option A- Keep the `!_loaded` guard in setup()**: Accept that unloaded inputs skip setup entirely. Requires verifying that load() also skips when `_loaded = false` (add or verify the matching guard in load()). Document the invariant explicitly in the spec.
    - Pros: Consistent- unloaded pins don't touch the matrix at all.
    - Cons: Requires verifying current load() behavior for unloaded inputs and updating it if it currently stamps.
  - **Option B- Remove the `!_loaded` guard from setup(), always allocate**: Let `setup()` always allocate the diagonal handle (even for unloaded inputs), so load() always has a valid handle to stamp through. The stamp value for unloaded inputs would be `1/rIn ≈ 0` (very high resistance).
    - Pros: No risk of stampElement(-1, ...) calls. Simpler invariant.
    - Cons: Allocates a matrix entry that carries near-zero conductance- adds matrix fill for circuits where digital pins are declared but not electrically loaded.

---

#### D8- "Composite forward rule" does not address `BehavioralMuxElement`, `BehavioralDemuxElement`, `BehavioralDecoderElement` source structure (info)

- **Location**: `02-behavioral.md` ssShape rule 3, component list and ssShape rule 4
- **Problem**: Shape rule 3 lists `BehavioralMuxElement`, `BehavioralDemuxElement`, `BehavioralDecoderElement` as composites with `_inputPins` / `_outputPins` / `_childElements`. Inspecting `behavioral-combinational.ts` (which is the digiTS file for these components per the scope table) shows that `Grep "allocElement|_handlesInit|stampG"` returns no matches, meaning the combinational elements do not currently call `allocElement` from load() at all- they delegate entirely to their pin models via `DigitalInputPinModel` and `DigitalOutputPinModel`. The field names used in those elements (if they follow `BehavioralGateElement`'s pattern) may differ from `_inputPins` / `_outputPins` used in Shape rule 3.

  This is an info finding because Shape rule 3's generic forward body may still be directionally correct (forwarding to input and output pin models), but the specific field names may not match the combinational element's actual internal field layout, potentially causing the same issue as D2 but for combinational elements specifically.

- **Why decision-required**: Verification requires reading `behavioral-combinational.ts` field declarations fully- an implementer agent for W3 MUX/DEMUX/DECODER would be blocked if Shape rule 3's field names are wrong for combinational elements. Given this review did not surface a compile-blocking mismatch (allocElement is never called in combinational.ts), the finding is informational- but the spec should explicitly confirm or deny that `_inputPins`/`_outputPins` are the correct field names for the combinational element class(es).

- **Options**:
  - **Option A- Add a note confirming combinational elements follow BehavioralGateElement's field naming**: Verify `behavioral-combinational.ts` uses `_inputs[]` (or `_inputPins[]`) and document the exact field names in Shape rule 3 or the component table.
  - **Option B- Acknowledge that combinational elements may use different internal field names**: Add a per-element-class note to Shape rule 3 directing implementers to read the class definition for field names, rather than assuming `_inputPins`.
