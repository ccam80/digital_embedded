# Spec Review: Batch 5 — Behavioral Elements (PB-BEHAV-*)

## Verdict: needs-revision

---

## Tally

| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 1 | 1 |
| major    | 2 | 3 | 5 |
| minor    | 3 | 1 | 4 |
| info     | 2 | 0 | 2 |

---

## Plan Coverage

The plan lists behavioral elements under "behavioral-gates+combinational, behavioral-remaining" as the final W3 subgroup. All 17 files in the assignment exist. Plan coverage for this batch:

| Plan Component Group | In Spec? | Notes |
|---|---|---|
| Gates: NOT, AND, NAND, OR, NOR, XOR, XNOR | yes | 7 files, all present |
| Combinational: Mux, Demux, Decoder | yes | 3 files, all present |
| Drivers: Driver, DriverInv | yes | 2 files, all present |
| Bus: Splitter | yes | 1 file present |
| Visual: SevenSeg, SevenSegHex | yes | 2 files present |
| ButtonLED | yes | 1 file present |
| Ground | yes | 1 file present |
| W3 verification: no setup-stamp-order.test.ts row for behaviorals | yes | Stated in 02-behavioral.md §Per-task verification gate; confirmed in each spec |

All 17 planned W3 behavioral components have corresponding spec files. No plan tasks are missing.

---

## Summary Table (per file)

| File | Findings |
|---|---|
| PB-BEHAV-AND | BATCH5-M1 (shared method note), BATCH5-D1 (shared method concreteness) |
| PB-BEHAV-NAND | BATCH5-M1, BATCH5-D1 |
| PB-BEHAV-OR | BATCH5-M1, BATCH5-D1 |
| PB-BEHAV-NOR | BATCH5-M1, BATCH5-D1 |
| PB-BEHAV-XOR | BATCH5-M1, BATCH5-D1 |
| PB-BEHAV-XNOR | BATCH5-M1, BATCH5-D1 |
| PB-BEHAV-NOT | BATCH5-M1, BATCH5-D1 |
| PB-BEHAV-MUX | FBEHAV-MUX-D1 (stateSize schema name) |
| PB-BEHAV-DEMUX | (no additional findings) |
| PB-BEHAV-DECODER | FBEHAV-DECODER-M1 (stateSize schema name typo) |
| PB-BEHAV-SPLITTER | FBEHAV-SPLITTER-D1 (load() body shows internal fields not in interface) |
| PB-BEHAV-DRIVER | FBEHAV-DRIVER-M1 (forward order label inconsistency) |
| PB-BEHAV-DRIVERINV | FBEHAV-DRIVERINV-M1 (forward order label inconsistency) |
| PB-BEHAV-BUTTONLED | FBEHAV-BUTTONLED-D1 (inter-task dependency with no ordering gate), FBEHAV-BUTTONLED-D2 (cathode=0 claim needs verification) |
| PB-BEHAV-GROUND | FBEHAV-GROUND-M1 (historical comment reference), FBEHAV-GROUND-INFO1 |
| PB-BEHAV-SEVENSEG | FBEHAV-SEVENSEG-D1 (stampG survival rule ambiguous) |
| PB-BEHAV-SEVENSEGHEX | FBEHAV-SEVENSEGHEX-D1 (critical: pin-label mismatch unresolved) |

---

## Per-File Findings

### PB-BEHAV-AND, PB-BEHAV-NAND, PB-BEHAV-OR, PB-BEHAV-NOR, PB-BEHAV-XOR, PB-BEHAV-XNOR, PB-BEHAV-NOT

These seven files are near-identical in structure (Shape rule 3 forwarding, same verification gate, same factory cleanup instructions). This is correct per 02-behavioral.md. Findings for this family are reported as batch-wide findings BATCH5-M1 and BATCH5-D1.

Individual difference noted in PB-BEHAV-XOR: the spec correctly distinguishes the XOR truth function (`xorTruth` counts odd-HIGH inputs), confirming N-input generalization. No additional per-file finding.

Individual difference in PB-BEHAV-NOT: spec hardcodes `inputCount = 1` and correctly notes `makeNotAnalogFactory` does not read `props.inputCount`. Correct.

---

### PB-BEHAV-MUX

**FBEHAV-MUX-D1** — see Decision-Required Items below.

---

### PB-BEHAV-DEMUX

No per-file findings beyond batch-wide issues. The composition table, setup() body, TSTALLOC formula, and verification gate are internally consistent. The note that each selector-bit pin model independently calls `allocElement(selNodeId, selNodeId)` and `SparseSolver.allocElement` returns the existing handle on duplicate calls is consistent with 02-behavioral.md.

---

### PB-BEHAV-DECODER

**FBEHAV-DECODER-M1** — see Mechanical Fixes below.

---

### PB-BEHAV-SPLITTER

**FBEHAV-SPLITTER-D1** — see Decision-Required Items below.

---

### PB-BEHAV-DRIVER

**FBEHAV-DRIVER-M1** — see Mechanical Fixes below.

---

### PB-BEHAV-DRIVERINV

**FBEHAV-DRIVERINV-M1** — see Mechanical Fixes below.

---

### PB-BEHAV-BUTTONLED

**FBEHAV-BUTTONLED-D1** and **FBEHAV-BUTTONLED-D2** — see Decision-Required Items below.

The spec's pin layout claim (`out` at position 0, `in` at position 1) matches the actual source at `behavioral-remaining.ts:863-865`. The assertion that `createSegmentDiodeElement` is shared with SevenSeg is confirmed at `behavioral-remaining.ts:885`. The claim that `ledDiode` uses cathode = 0 is confirmed at `behavioral-remaining.ts:885`: `createSegmentDiodeElement(nodeLedIn, 0)`. These facts are correct.

---

### PB-BEHAV-GROUND

**FBEHAV-GROUND-M1** — see Mechanical Fixes below.
**FBEHAV-GROUND-INFO1** — see Info Items below.

The spec claim that `ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES` is correct (confirmed at `ground.ts:119`). The claim that the existing load() body is already empty is plausible but not directly verified here; no finding raised.

---

### PB-BEHAV-SEVENSEG

**FBEHAV-SEVENSEG-D1** — see Decision-Required Items below.

The spec correctly identifies that `createSevenSegAnalogElement` uses `segLabels = ["a","b","c","d","e","f","g","dp"]` and maps them to `pinNodes.get(lbl)!`. This is confirmed at `behavioral-remaining.ts:557-558`. The composition (8 SegmentDiodeElements, cathode=0 for all) is correct. The TSTALLOC pattern matches Shape rule 7.

---

### PB-BEHAV-SEVENSEGHEX

**FBEHAV-SEVENSEGHEX-D1** — critical, see Decision-Required Items below.

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FBEHAV-DRIVER-M1 | minor | PB-BEHAV-DRIVER §setup() body, heading comment "Forward order: inputs → sel → output → children" | The heading says "inputs → sel → output → children" but `selPin` is an input pin (DigitalInputPinModel), not a separate category. The actual code correctly calls `inputPin.setup(ctx)` then `selPin.setup(ctx)` then `outputPin.setup(ctx)`. The description is misleading — there is no "sel" category distinct from "inputs" in Shape rule 3. | Replace "inputs → sel → output → children" with "inputs (data, enable) → output → children" to match the actual ordering in the code. |
| FBEHAV-DRIVERINV-M1 | minor | PB-BEHAV-DRIVERINV §setup() body, heading comment "Forward order: inputs → sel → output → children" | Same issue as FBEHAV-DRIVER-M1 — sel is an input pin; the heading category split is misleading. | Replace "inputs → sel → output → children" with "inputs (data, enable) → output → children". |
| FBEHAV-DECODER-M1 | minor | PB-BEHAV-DECODER §State pool | Text references `COMBINATIONAL_COMPOSITE_SCHEMA` — the same schema name as MUX and DEMUX. If Decoder uses a distinct schema constant it should be named. If it genuinely shares `COMBINATIONAL_COMPOSITE_SCHEMA`, the name is correct. This cannot be verified without reading source, but the same name is used in PB-BEHAV-MUX and PB-BEHAV-DEMUX without explanation of whether these are three references to one constant or to three separate constants. | Confirm whether `BehavioralDecoderElement` uses `COMBINATIONAL_COMPOSITE_SCHEMA` (the same object as Mux/Demux) or its own schema constant. If the same, add a parenthetical: "(shared with Mux/Demux)". If different, rename to `DECODER_COMPOSITE_SCHEMA`. |
| FBEHAV-GROUND-M1 | minor | PB-BEHAV-GROUND §Notes on no-op status, last paragraph | The text reads: "The `ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES` declaration is intentional (documented in the existing source comment at `ground.ts:117-119`)" — this is a reference to a historical/explanatory comment in source, which per the code-hygiene rules is a dead-code marker. The spec should not pin its justification to a source comment that the rules say must be deleted. | Remove the parenthetical "(documented in the existing source comment at `ground.ts:117-119`)" and replace with a self-contained justification: "Every `AnalogElementCore` must declare an ordinal; RES is the lowest-priority bucket, correct for a no-op element." |

### Decision-Required Items

#### BATCH5-D1 — Shared setup() method: which file is the implementation site? (major)

- **Location**: PB-BEHAV-AND, PB-BEHAV-NAND, PB-BEHAV-OR, PB-BEHAV-NOR, PB-BEHAV-XOR, PB-BEHAV-XNOR, PB-BEHAV-NOT §Factory cleanup
- **Problem**: All seven gate specs contain the note: "BehavioralGateElement adds a `setup(ctx: SetupContext): void` method per Shape rule 3. This method is shared by all gate variants (NOT, AND, NAND, OR, NOR, XOR, XNOR) since they all use `BehavioralGateElement`." This is stated identically in every file. The spec never designates which of the seven W3 tasks is responsible for writing the actual method on the class. An implementer reading PB-BEHAV-AND will write the method; an implementer reading PB-BEHAV-NAND in a parallel W3 agent will also attempt to write the same method on the same class in the same file (`behavioral-gate.ts`). Both will pass verification (the method will exist), but parallel agents will write conflicting edits to `behavioral-gate.ts`.
- **Why decision-required**: Seven parallel implementer agents targeting the same class in the same file is a parallel-write race condition. The solution is to designate exactly one of the seven tasks as the owner of the `BehavioralGateElement.setup()` method, and have the other six specs say "this method was added by [designated task] — confirm it exists before marking GREEN." Which task is the canonical owner is a human decision.
- **Options**:
  - **Option A — Designate PB-BEHAV-NOT as owner**: NOT is the simplest gate (fixed-1-input). The method it adds handles N inputs via the for-loop, so AND/NAND/etc. work automatically. The other six specs replace their method-writing instruction with: "Verify `BehavioralGateElement.setup()` exists (added by PB-BEHAV-NOT task)."
    - Pros: Simplest gate owns the shared method; other tasks become trivially verifiable.
    - Cons: NOT agent must know it is the canonical owner; other agents must check rather than write.
  - **Option B — Designate PB-BEHAV-AND as owner**: AND is the canonical "first" N-input gate.
    - Pros: AND is typically the reference gate; natural first-implement order.
    - Cons: Same race risk if NOT agent also tries to write the method before AND finishes.
  - **Option C — Extract shared setup() into a separate W2 task**: Add `BehavioralGateElement.setup()` to the W2 stub wave (it would be the real body, not a throwing stub). All seven W3 gate specs then only verify it exists and confirm their factory cleanup.
    - Pros: Eliminates the parallel-write race entirely. The method is in place before any W3 agent starts.
    - Cons: Changes W2 scope, requires spec amendment to 00-engine.md or a new task.

---

#### BATCH5-M1 — Verification gate test file name is imprecise for the gate family (minor)

- **Location**: PB-BEHAV-AND through PB-BEHAV-NOT §Verification gate, item 1
- **Problem**: Each gate spec says "1. `src/solver/analog/__tests__/behavioral-gate.test.ts` (or equivalent test file for gates) is GREEN after the migration." The parenthetical "or equivalent" is vague. The actual file `src/solver/analog/__tests__/behavioral-gate.test.ts` exists (confirmed by glob). The "or equivalent" clause gives an implementer license to declare a different test file green and skip the canonical one.
- **Why decision-required**: Removing "or equivalent" makes the gate unambiguous, but someone added the hedge for a reason that isn't documented. It is possible there is a secondary gate test in `behavioral-integration.test.ts` or `behavioral-sequential.test.ts` that should also be cited. Whether to keep the hedge or remove it and enumerate the additional files is a human choice.
- **Options**:
  - **Option A — Remove the hedge**: Replace "(or equivalent test file for gates)" with nothing, leaving the exact path only.
    - Pros: Unambiguous; implementer cannot bypass the canonical file.
    - Cons: If a gate-related test was deliberately split into a second file, that file would not be required green.
  - **Option B — Enumerate all relevant test files**: Replace "(or equivalent test file for gates)" with "and `src/solver/analog/__tests__/behavioral-integration.test.ts`" (or whichever additional files contain gate tests).
    - Pros: Complete coverage with no ambiguity.
    - Cons: Requires auditing all behavioral test files to confirm which contain gate cases — if not done carefully, the list may be incomplete.

---

#### FBEHAV-MUX-D1 — State pool schema constant name unverifiable (minor)

- **Location**: PB-BEHAV-MUX §State pool
- **Problem**: The spec states "`BehavioralMuxElement.stateSize` aggregates `_childElements[].stateSize` (capacitor children only; `COMBINATIONAL_COMPOSITE_SCHEMA` is empty)." The constant name `COMBINATIONAL_COMPOSITE_SCHEMA` is cited for all three combinational elements (Mux, Demux, Decoder). An implementer cannot verify this name without reading source (which the rules forbid for W3 agents). If the actual constant is named differently, the implementer will define a new constant with this name and break existing code.
- **Why decision-required**: The spec could either (a) confirm the exact constant name by citing the source line, (b) drop the citation entirely and say "the composite schema is empty", or (c) note that the implementer should not create a new constant but find the existing one. Each changes the implementer's action.
- **Options**:
  - **Option A — Add source line citation**: Add: "Constant name confirmed at `src/solver/analog/behavioral-combinational.ts` — implementer reads this line before proceeding."
    - Pros: Implementer has a precise anchor.
    - Cons: W3 agents are forbidden from reading existing source; contradicts plan.md §Wave-by-wave reading guide.
  - **Option B — Remove the constant name, describe behavior only**: Replace "`COMBINATIONAL_COMPOSITE_SCHEMA` is empty" with "the composite-element schema declares no state slots".
    - Pros: Spec is correct regardless of the constant's actual name. Implementer looks up the existing pattern rather than using a name from the spec.
    - Cons: Slightly less precise.

---

#### FBEHAV-SPLITTER-D1 — load() body pseudocode exposes internal field names not in the public interface (major)

- **Location**: PB-BEHAV-SPLITTER §load() body — value writes only
- **Problem**: The spec provides a concrete load() body pseudocode that references `inputPins[i].nodeId`, `inputPins[i].readLogicLevel(voltage)`, `readMnaVoltage(nodeId, v)`, `outputPins[i].setLogicLevel(...)`, and `latchedLevels[i]`. These are internal field and helper names from the current source implementation. The plan explicitly forbids W3 implementer agents from reading digiTS component source. An implementer relying solely on this spec will write code referencing `nodeId`, `readLogicLevel`, and `readMnaVoltage` — but if those names differ from the actual current implementation, the code will fail to compile. The spec is providing a pseudocode contract anchored in current source names without citing them as such.
- **Why decision-required**: The spec must either (a) cite the source lines from which these names are derived, acknowledging that the implementer will need to verify them, (b) replace the pseudocode with a higher-level description that doesn't depend on specific field names, or (c) explicitly grant the Splitter implementer permission to read the existing source. Each is a different approach.
- **Options**:
  - **Option A — Add source-line citations for each field name used**: Annotate `nodeId`, `readLogicLevel`, `readMnaVoltage`, and `latchedLevels` with their location in the current source.
    - Pros: Implementer can verify without broad source-reading permission.
    - Cons: Adds many citations; spec becomes brittle if source is refactored before W3 lands.
  - **Option B — Replace pseudocode with behavioral description**: Remove the concrete load() pseudocode and replace with: "The existing load() body reads each input pin's node voltage, converts to logic level, latches the result, and drives each output pin. Remove any `allocElement` call; retain the latch-and-drive loop unchanged."
    - Pros: Spec is implementation-agnostic. Works regardless of exact field names.
    - Cons: Less guidance for a fresh implementer; relies on implementer finding the existing body.
  - **Option C — Grant Splitter implementer explicit source-read permission**: Add a note: "The Splitter implementer is granted permission to read `src/solver/analog/behavioral-remaining.ts` to confirm field names used in the load() body before writing setup()."
    - Pros: Consistent with what the implementer needs to do anyway; makes it explicit rather than implicit.
    - Cons: Inconsistent with the W3 plan-level rule that forbids reading existing source.

---

#### FBEHAV-BUTTONLED-D1 — Inter-task dependency on SEVENSEG with no ordering gate (major)

- **Location**: PB-BEHAV-BUTTONLED §Dependency on SEVENSEG migration
- **Problem**: The spec states: "The SEVENSEG migration task adds that method. ButtonLED uses the same helper, so the SEVENSEG agent's work on `createSegmentDiodeElement` covers ButtonLED's LED diode automatically. The ButtonLED agent must confirm `createSegmentDiodeElement` has a `setup(ctx)` method before marking GREEN." This creates a hard dependency between two W3 agents that are supposed to be independent and parallel. The ButtonLED agent is blocked until the SEVENSEG agent completes. There is no wave-ordering mechanism in the plan for intra-W3 dependencies, and the verification gate ("confirm `createSegmentDiodeElement` has a `setup(ctx)` method") cannot pass until SEVENSEG lands.
- **Why decision-required**: Options include giving BUTTONLED ownership of `createSegmentDiodeElement.setup()`, requiring SEVENSEG to land first (contradicting parallel W3), or splitting `createSegmentDiodeElement` into its own pre-step. Human decides.
- **Options**:
  - **Option A — Assign `createSegmentDiodeElement.setup()` ownership to PB-BEHAV-BUTTONLED**: ButtonLED adds the method to the shared helper. SEVENSEG verifies the method exists (was added by BUTTONLED).
    - Pros: Mirrors the mirrored-dependency but assigns it cleanly to one owner. SEVENSEG and BUTTONLED tasks remain independently runnable if BUTTONLED lands first.
    - Cons: Reverses which task writes the critical method; reviewers must know BUTTONLED is canonical, not SEVENSEG.
  - **Option B — Require SEVENSEG to land before BUTTONLED (sequential ordering)**: Add BUTTONLED to a sub-wave within W3 that gates on SEVENSEG completing.
    - Pros: Clear sequencing; no race.
    - Cons: Reduces W3 parallelism. Contradicts plan's "W3 can land in any order".
  - **Option C — Extract `createSegmentDiodeElement.setup()` into a W2 sub-task**: Add it to the W2 wave alongside the stub setup() additions. Both SEVENSEG and BUTTONLED then depend on W2 (which they already do) and can run fully in parallel.
    - Pros: Eliminates the intra-W3 dependency entirely. Most architecturally clean.
    - Cons: Requires modifying W2 scope and 00-engine.md or adding a new pre-W3 sub-task spec.

---

#### FBEHAV-BUTTONLED-D2 — Spec asserts cathode=0 for ButtonLED LED diode without a caveat for future variants (minor)

- **Location**: PB-BEHAV-BUTTONLED §setup() body and §Pin model TSTALLOCs
- **Problem**: The spec states: "`_hCC = allocElement(0, 0)` — skipped because `nodeCathode = 0` and the guard `if (nodeCathode > 0)` fires false". This is correct for the current implementation (confirmed: `createSegmentDiodeElement(nodeLedIn, 0)` at `behavioral-remaining.ts:885`). The spec then says "the guards must remain in the helper for correctness in other contexts (e.g. ButtonLED where cathode could be non-zero in future variants)." This is internally contradictory: the text says cathode = 0 for ButtonLED (current), then cites ButtonLED as the example for a future non-zero cathode. An implementer reading this may remove the guard thinking the ButtonLED case itself is the only caller, or may misunderstand which component drives the guard retention.
- **Why decision-required**: The example should either cite a different component or be removed. The choice of example affects what the implementer understands about the guard's purpose.
- **Options**:
  - **Option A — Replace the ButtonLED example with a generic forward-reference**: Change "e.g. ButtonLED where cathode could be non-zero in future variants" to "e.g. a future component that reuses `createSegmentDiodeElement` with a non-ground cathode."
    - Pros: Accurate; avoids contradicting the current cathode=0 fact.
    - Cons: Loses specificity; implementer may not understand why the guard matters.
  - **Option B — Remove the justification clause entirely**: The guard remains for correctness reasons that are self-evident from the code. No example needed.
    - Pros: Shorter spec; no contradiction.
    - Cons: Less explanatory for a fresh implementer.

---

#### FBEHAV-SEVENSEG-D1 — stampG() survival rule is ambiguous (major)

- **Location**: PB-BEHAV-SEVENSEG §SegmentDiodeElement setup() body (Shape rule 7), final note
- **Problem**: The spec states: "The `stampG()` helper itself is left in the file (it may be used by other code), but must no longer be called from any `load()` body." The code-hygiene rules (`rules.md`) state: "No fallbacks. No backwards compatibility shims." and "All replaced or edited code is removed entirely. Scorched earth." If `stampG()` is no longer called from any `load()` body after migration, retaining it in the file is dead code — which the rules ban. The spec directly conflicts with the hygiene rules by instructing the implementer to keep a function that will have zero callers after the migration.
- **Why decision-required**: Either `stampG()` has callers that survive the migration (in which case the spec should enumerate them), or it becomes dead code (in which case the rules require deleting it). The spec says "it may be used by other code" — "may be" is not a concrete determination.
- **Options**:
  - **Option A — Audit stampG() call sites and either enumerate surviving callers or mandate deletion**: If surviving callers exist (e.g. RelayElement, RelayDTElement — confirmed present at `behavioral-remaining.ts:692,694,819-821`), list them explicitly: "stampG() is retained because it is still called by RelayElement and RelayDTElement load() bodies; it will be removed when those elements are migrated." If no surviving callers, replace the note with "Delete `stampG()` from the file."
    - Pros: Resolves the ambiguity with evidence; either instruction is implementable.
    - Cons: Requires auditing all stampG() call sites before spec can be finalized.
  - **Option B — Leave stampG() retention as an implementer concern with explicit permission**: Replace "The `stampG()` helper itself is left in the file (it may be used by other code)" with "Do not delete `stampG()` until all callers in the file are migrated. After SEVENSEG migration, grep for remaining stampG() call sites in `behavioral-remaining.ts` and remove stampG() only if zero callers remain."
    - Pros: Gives the implementer a concrete decision rule; consistent with scorched-earth once callers are gone.
    - Cons: The implementer now has to decide at implementation time, which is a spec gap.

---

#### FBEHAV-SEVENSEGHEX-D1 — Pin-label mismatch between component pins and factory expectations is unresolved (critical)

- **Location**: PB-BEHAV-SEVENSEGHEX §Pin layout and §SegmentDiodeElement setup() body (implementer note)
- **Problem**: The spec states: "If the compiler does not supply segment-labelled node entries for SevenSegHex (because its pins are `d` and `dp` only), the `pinNodes.get("a")!` calls in the factory will return `undefined` and produce `NaN` node IDs. Verify that the compiler's analog compilation path resolves SevenSegHex pin nodes to the segment channel nodes correctly before marking GREEN. This may require a component-definition change or a separate analog factory for SevenSegHex; if so, escalate — do not silently patch."

  This is confirmed by the actual source: `seven-seg-hex.ts` declares only two pins — `d` (4-bit) and `dp` (1-bit) — at lines 72 and 81. `createSevenSegAnalogElement` calls `pinNodes.get("a")`, `pinNodes.get("b")`, etc., at runtime. These will all return `undefined`, and `createSegmentDiodeElement(undefined, 0)` will produce NaN node IDs, meaning all 8 `_hAA` allocations will fail silently (allocElement on NaN row/col).

  The spec escalates this to the implementer ("verify before marking GREEN; if broken, escalate"), but provides no resolution path. A W3 implementer reading this spec cannot implement the task — there is no specification of what the correct solution is. The spec effectively says "this might be broken; if so, stop and ask." That is not an implementable specification.

- **Why decision-required**: The resolution requires choosing between architectural options that have different blast radii and different effects on the component registry. The correct option is not derivable from the spec alone.
- **Options**:
  - **Option A — Add a separate analog factory `createSevenSegHexAnalogElement` that maps `d`/`dp` to segment channels**: The new factory decodes the 4-bit `d` pin and `dp` pin into 8 segment node IDs internally, then constructs 8 SegmentDiodeElements. The SevenSegHex component definition is updated to point to this new factory.
    - Pros: Clean separation; each component has its own factory. Pin-label mismatch resolved at the factory level.
    - Cons: New file/function required; more code. The digital execution (`executeSevenSegHex`) already does BCD decoding — the analog factory would need to duplicate or re-express that mapping.
  - **Option B — Change SevenSegHex pin declarations to expose segment-labelled pins (`a`–`g`, `dp`) at the analog level**: The component's `pinLayout` is extended to include 8 segment output pins that the compiler wires internally from the decoder logic.
    - Pros: Reuses `createSevenSegAnalogElement` unchanged; no new factory.
    - Cons: Significant change to the component's public pin API; may break existing circuits using SevenSegHex.
  - **Option C — Implement a compile-time pin-alias mapping in the compiler**: The compiler, when compiling a SevenSegHex analog model, derives the 8 segment node IDs from the component's internal decoded outputs and populates `pinNodes` with `"a"`–`"g"`,`"dp"` keys before calling the factory.
    - Pros: No change to the factory or component definition. Compiler handles the translation.
    - Cons: Adds complexity to the compiler; requires understanding how the digital decoder's outputs map to analog nodes.

---

### Info Items

#### FBEHAV-GROUND-INFO1 — ngspiceLoadOrder rationale cites "load before elements that depend on node voltages" which is unclear (info)

- **Location**: PB-BEHAV-GROUND §Notes on no-op status, last sentence
- **Problem**: "ensuring Ground loads before any elements that depend on node voltages being established." Ground's load() is empty — it does nothing. Its load order is irrelevant to correctness since it doesn't stamp anything. The rationale given for `NGSPICE_LOAD_ORDER.RES` is therefore misleading. This is a stylistic issue only; the declaration itself (RES ordinal) is correct.
- **Classification**: Info — implementer will copy the correct ordinal; the prose justification is wrong but not harmful.

#### FBEHAV-BEHAV-SEVENSEG-INFO1 — Verification gate item 4 ("No banned closing verdicts") appears in multiple specs but is not an implementable test (info)

- **Location**: All gate and behavioral specs §Verification gate, item 4
- **Problem**: "No banned closing verdicts in review comments or commit messages." This is a policy rule from CLAUDE.md, not a verifiable test a W3 implementer can run. It cannot appear as a numbered verification gate item because there is nothing to check at implementation time. It belongs in project policy documentation, not in per-component verification gates.
- **Classification**: Info — does not block implementation; the policy itself is correct but its placement here is non-actionable.

---

## Batch-Wide Findings

### BATCH5-M1 — Verification gate uses "or equivalent" hedge for test file path (minor, mechanical)

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH5-M1 | minor | PB-BEHAV-AND, NAND, OR, NOR, XOR, XNOR, NOT §Verification gate item 1 | Each spec says "`src/solver/analog/__tests__/behavioral-gate.test.ts` (or equivalent test file for gates)". The file exists (confirmed). The "or equivalent" hedge creates ambiguity. | Remove "(or equivalent test file for gates)" from all seven specs. The confirmed path is sufficient. |

### BATCH5-D1 — Shared BehavioralGateElement.setup() method has no designated implementation owner (major, decision-required)

Seven parallel W3 agents will all read a note saying `BehavioralGateElement` adds one `setup()` method, but no spec designates which agent writes it. See BATCH5-D1 in Decision-Required Items above.

---

## Overall Batch Verdict

**needs-revision**

The batch has one critical finding (FBEHAV-SEVENSEGHEX-D1), five major findings (BATCH5-D1, FBEHAV-SPLITTER-D1, FBEHAV-BUTTONLED-D1, FBEHAV-SEVENSEG-D1, and the shared-method ownership gap), and four minor findings. The critical finding blocks the SEVENSEGHEX task outright — the implementer cannot proceed without a resolution. The BUTTONLED intra-W3 dependency gap blocks clean parallel execution. The shared gate method ownership gap creates a parallel-write race across all seven gate tasks. These must be resolved before W3 implementation agents are dispatched.

The 13 files not affected by the critical finding (all gates, Mux, Demux, Decoder, Splitter, Driver, DriverInv, Ground) are structurally sound and internally consistent with 02-behavioral.md. Once the major findings above are resolved, those 13 tasks are ready for implementation.
