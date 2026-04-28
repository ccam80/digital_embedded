# Phase 3.5: Component Spec Gaps

## Overview

Wave 3.5 closes spec gaps for stub-throwing components that fall outside the
current 74 PB-*.md component plan. Twelve elements across four categories were
identified during the W3 batch sweep with `setup()` bodies of the form
`throw new Error("XXX not yet migrated")` but no corresponding spec contract:

- `LedElement` analog factory (1 element) — `src/components/io/led.ts`
- 7 behavioral flip-flop classes — `src/solver/analog/behavioral-flipflop.ts`
  + `src/solver/analog/behavioral-flipflop/{d-async,jk,jk-async,rs,rs-async,t}.ts`
- 3 behavioral sequential classes — `src/solver/analog/behavioral-sequential.ts`
- 1 transmission-line composite — `src/components/passives/transmission-line.ts`

This wave also patches PB-XFMR.md and PB-TAPXFMR.md to close 5 inter-spec
class-API gaps that caused the PB-TAPXFMR implementer to stall (590 lines
edited before stream watchdog timeout at 600s; mutual-inductor.ts had public
getters appended outside spec to compensate for missing surface area). The
patches are spec-only; PB-TAPXFMR is then re-spawned with the corrected spec.

Verification gate: per CLAUDE.md "Test Policy During W3 Setup-Load-Split",
W3.5 uses spec-compliance verification only — no test runs, no
numerical-mismatch reports.

This phase spec file is ephemeral — delete after W3.5 execution.

---

## Wave 3.5.1: PB-LED — diode-subclass refactor

### Task 3.5.1.1: PB-LED.md

- **Description**: Delete `createLedAnalogElement` from `src/components/io/led.ts`. LED's analog model becomes the existing `DiodeAnalogElement` from PB-DIO with cathode wired to ground (node 0) and a `getVisibleLit()` getter exposing analog-side lit state to renderer/inspector code. Five `modelRegistry` entries (red/green/blue/yellow/white) become inline diode-factory calls with per-color IS/N parameter overrides plus diode-default zeros for RS/CJO/TT/BV/IBV/NBV/IKF/etc.
- **Files to create**:
  - `spec/setup-load-split/components/PB-LED.md` — full PB spec covering pin remap (`"in" → "A"`, `"K" → 0` injected), modelRegistry rewrite, getVisibleLit method placement and threshold table, deletion of LED_STATE_SCHEMA and LED_CAP_STATE_SCHEMA, verification gate referencing PB-DIO compliance.
- **Files to modify (during execution, by implementer)**:
  - `src/components/io/led.ts` — delete `createLedAnalogElement`, `LED_STATE_SCHEMA`, `LED_CAP_STATE_SCHEMA`, the `LED_GMIN` constant, the LED-specific `recomputeLedTp` closure, and the `getLteTimestep` attach block. Rewrite `modelRegistry` per spec. Add LED-side `getVisibleLit()` wrapper or factory adapter.
- **Tests**: per CLAUDE.md test policy, no test runs during execution. Spec-compliance gate only.
- **Acceptance criteria**:
  - PB-LED.md exists and matches the structure of PB-DIO.md (sections: Pin mapping / Internal nodes / Branch rows / State slots / TSTALLOC sequence / setup() body / load() body / Factory cleanup / Verification gate).
  - PB-LED.md explicitly states the diode-class API surface it depends on (factory signature, modelRegistry shape, state-pool participation) and confirms PB-DIO is the frozen contract.
  - PB-LED.md specifies the per-color VD lit-threshold table and the `getVisibleLit()` placement (LED-side wrapper or extension method on the diode element).

---

## Wave 3.5.2: PB-BEHAV-FF — flip-flops (4 specs covering 7 classes)

### Task 3.5.2.1: PB-BEHAV-FF-D.md

- **Description**: D flip-flop (sync, no async pins) and D flip-flop with async Set/Clear. Two element classes: `BehavioralDFlipflopElement` (in `src/solver/analog/behavioral-flipflop.ts`) and `BehavioralDAsyncFlipflopElement` (in `src/solver/analog/behavioral-flipflop/d-async.ts`). Both follow Shape rule 3 from `02-behavioral.md` (composite forwards to input pins → output pins → children).
- **Files to create**:
  - `spec/setup-load-split/components/PB-BEHAV-FF-D.md` — covers both classes; sub-tables per pin layout (D/C/Q/~Q for sync; Set/D/C/Clr/Q/~Q for async).
- **Files to modify (during execution, by implementer)**:
  - `src/solver/analog/behavioral-flipflop.ts` — replace stub `setup()` body in `BehavioralDFlipflopElement` with Shape-rule-3 forward.
  - `src/solver/analog/behavioral-flipflop/d-async.ts` — same for `BehavioralDAsyncFlipflopElement`.
- **Tests**: spec-compliance gate only.
- **Acceptance criteria**:
  - PB-BEHAV-FF-D.md exists, references Shape rule 3 by name, lists TSTALLOC counts per pin model, confirms `_pinNodes`/`_childElements` ownership on the composite class.
  - Both `setup()` bodies match the spec body block line-for-line.

### Task 3.5.2.2: PB-BEHAV-FF-JK.md

- **Description**: JK flip-flop and JK flip-flop with async Set/Clear. `BehavioralJKFlipflopElement` (`src/solver/analog/behavioral-flipflop/jk.ts`) and `BehavioralJKAsyncFlipflopElement` (`src/solver/analog/behavioral-flipflop/jk-async.ts`).
- **Files to create**:
  - `spec/setup-load-split/components/PB-BEHAV-FF-JK.md` — covers both classes; pin layouts (J/C/K/Q/~Q sync; Set/J/C/K/Clr/Q/~Q async).
- **Files to modify (during execution)**:
  - `src/solver/analog/behavioral-flipflop/jk.ts` — replace stub `setup()`.
  - `src/solver/analog/behavioral-flipflop/jk-async.ts` — replace stub `setup()`.
- **Tests**: spec-compliance gate only.
- **Acceptance criteria**:
  - PB-BEHAV-FF-JK.md exists with both pin layouts and TSTALLOC counts.
  - Both `setup()` bodies match the spec block line-for-line.

### Task 3.5.2.3: PB-BEHAV-FF-RS.md

- **Description**: RS flip-flop (clocked) and RS latch (level-sensitive, no clock — note this asymmetry). `BehavioralRSFlipflopElement` (`src/solver/analog/behavioral-flipflop/rs.ts`) and `BehavioralRSAsyncLatchElement` (`src/solver/analog/behavioral-flipflop/rs-async.ts`). The async variant is a level-sensitive latch (not a clocked flip-flop with async pins) — pin layout differs accordingly (S/R/Q/~Q only, no clock).
- **Files to create**:
  - `spec/setup-load-split/components/PB-BEHAV-FF-RS.md` — calls out the level-sensitive-latch caveat; pin layouts (S/C/R/Q/~Q clocked; S/R/Q/~Q latch).
- **Files to modify (during execution)**:
  - `src/solver/analog/behavioral-flipflop/rs.ts` — replace stub `setup()`.
  - `src/solver/analog/behavioral-flipflop/rs-async.ts` — replace stub `setup()`.
- **Tests**: spec-compliance gate only.
- **Acceptance criteria**:
  - PB-BEHAV-FF-RS.md exists, calls out the level-sensitive-latch nature of the async variant explicitly, lists both pin layouts.
  - Both `setup()` bodies match the spec block line-for-line.

### Task 3.5.2.4: PB-BEHAV-FF-T.md

- **Description**: T flip-flop with optional T-enable pin (`withEnable: boolean` prop drives 2-input vs 1-input pin layout). Single class `BehavioralTFlipflopElement` (`src/solver/analog/behavioral-flipflop/t.ts`) but two pin layouts.
- **Files to create**:
  - `spec/setup-load-split/components/PB-BEHAV-FF-T.md` — two pin-layout tables (T/C/Q/~Q with enable; C/Q/~Q without).
- **Files to modify (during execution)**:
  - `src/solver/analog/behavioral-flipflop/t.ts` — replace stub `setup()`.
- **Tests**: spec-compliance gate only.
- **Acceptance criteria**:
  - PB-BEHAV-FF-T.md exists with both pin layouts.
  - `setup()` body forwards correctly when `_tPin` is null vs present.

---

## Wave 3.5.3: PB-BEHAV-SEQUENTIAL — counters and registers (1 spec covering 3 classes)

### Task 3.5.3.1: PB-BEHAV-SEQUENTIAL.md

- **Description**: Three classes in `src/solver/analog/behavioral-sequential.ts`: `BehavioralCounterElement` (N-bit edge-triggered counter), `BehavioralRegisterElement` (N-bit parallel-load register), `BehavioralCounterPresetElement` (N-bit up/down counter with preset load and clear). All three are pool-backed composites following Shape rule 3 with bit-bus output pin models. Counter uses per-bit output pins (`out_0`..`out_{N-1}`) with a single shared MNA node for the bus; Register/CounterPreset similarly bus-share the data and output bit pins. The selector pin nodeId is shared by every per-bit pin model — `allocElement` returns the existing handle on subsequent calls to the same coordinates (no de-duplication).
- **Files to create**:
  - `spec/setup-load-split/components/PB-BEHAV-SEQUENTIAL.md` — three sub-sections, one per class. Each sub-section has its own pin-layout table and TSTALLOC formula. Covers the bus-shared-node `allocElement` idempotence rule.
- **Files to modify (during execution)**:
  - `src/solver/analog/behavioral-sequential.ts` — replace stub `setup()` in all three classes.
- **Tests**: spec-compliance gate only.
- **Acceptance criteria**:
  - PB-BEHAV-SEQUENTIAL.md exists with three sub-sections.
  - All three `setup()` bodies match their spec blocks line-for-line.
  - Bus-shared-node idempotence is documented inline in the spec body comment.

---

## Wave 3.5.4: PB-TLINE — transmission line (Option A: per-segment lumped)

### Task 3.5.4.1: PB-TLINE.md

- **Description**: Per-segment lumped RLCG transmission line. The composite `TransmissionLineElement` decomposes into 5 sub-element classes (already defined inline in `transmission-line.ts`): `SegmentResistorElement`, `SegmentInductorElement`, `SegmentShuntConductanceElement`, `SegmentCapacitorElement`, `CombinedRLElement`. The first four anchor to ngspice setup files (`ressetup.c`, `indsetup.c`, `capsetup.c`, reduced `ressetup.c`); `CombinedRLElement` is digiTS-internal with no ngspice anchor — its setup body matches the existing alloc block extracted from current `load()`. Composite `setup()` forwards to all sub-elements per segment (R → L → optional G → C → final CombinedRL). User explicitly authorizes this option per `plan.md` §Open Blockers; user adds the corresponding `architectural-alignment.md` entry separately (agents do not).
- **Files to create**:
  - `spec/setup-load-split/components/PB-TLINE.md` — full PB spec with 5 sub-element class sub-sections, branch-row management table (SegmentInductor and CombinedRL each call `ctx.makeCur` with distinct labels), composite forward order.
- **Files to modify (during execution)**:
  - `src/components/passives/transmission-line.ts` — add `setup()` to `SegmentResistorElement`, `SegmentInductorElement`, `SegmentShuntConductanceElement`, `SegmentCapacitorElement`, `CombinedRLElement`. Replace `TransmissionLineElement.setup()` stub with sub-element forward. Replace inline `solver.allocElement` calls in each segment-class `load()` with cached-handle stamps.
- **Files to modify (user, before execution)**:
  - `spec/architectural-alignment.md` — add entry for transmission-line lumped lossy model divergence from ngspice ideal-TRA. Per CLAUDE.md hard rule, agents do not add this entry.
- **Tests**: spec-compliance gate only.
- **Acceptance criteria**:
  - PB-TLINE.md exists with 5 sub-element setup body blocks.
  - All 6 `setup()` bodies (5 segment classes + 1 composite) match spec line-for-line.
  - Branch-row labels for SegmentInductor and CombinedRL are distinct per segment index.
  - User has added the architectural-alignment.md entry before implementer agents run on this task.

---

## Wave 3.5.5: PB-XFMR / PB-TAPXFMR spec patches and re-spawn

### Task 3.5.5.1: Patch PB-XFMR.md to close inter-PB class-API gaps

- **Description**: The original PB-XFMR.md introduced `InductorSubElement` and `MutualInductorElement` in `src/components/passives/mutual-inductor.ts` with `setup()` bodies but no `load()` bodies, no inductance-value handling, no `getLteTimestep` declaration, no pool-backed declaration, no `_pinNodes` ownership note. PB-TAPXFMR.md depends on this surface. The implementer for PB-TAPXFMR stalled at 600s on these gaps; the agent appended public getters to mutual-inductor.ts as a workaround. This task patches PB-XFMR.md to specify the complete external surface of both sub-element classes.
- **Files to modify**:
  - `spec/setup-load-split/components/PB-XFMR.md` — add five spec sections to the existing class definitions:
    - **Constructor signature** — add `inductance: number` parameter to `InductorSubElement` (4 args total: posNode, negNode, label, inductance). Setup uses constructor inductance for state-pool initialization; `setParam("L", value)` updates it.
    - **`load(ctx)` method** on `InductorSubElement` — full body ported from `indload.c`, stamping through the 5 cached `_hXXX` handles. No `solver.allocElement` calls. State-pool reads via the standard 2-slot ngspice INDflux/INDvolt schema.
    - **`load(ctx)` method** on `MutualInductorElement` — full body ported from `mutload.c`, stamping through the 2 cached `_hBrXBrY` handles, reading branch-current state from both sub-inductors via constructor-stored refs.
    - **`getLteTimestep(...)` method** on `InductorSubElement` — present, body matches `cktTerr` call from PB-IND. Composite forwards via `min(_l1.getLteTimestep, _l2.getLteTimestep)` (XFMR) or 3-way min (TAPXFMR).
    - **Pool-backed declaration** on `InductorSubElement` — declares `poolBacked = true as const`, `stateSchema = INDUCTOR_SUB_SCHEMA` (2 slots reusing PB-IND schema constants), `stateBaseOffset` field, `s0..s7: Float64Array<ArrayBufferLike>` typed-array slots, `initState(pool)` method. `MutualInductorElement` is NOT pool-backed (no state slots; matches mutsetup.c `NG_IGNORE(states)`).
    - **`_pinNodes` ownership** — the composite (`AnalogTransformerElement`) owns `_pinNodes: Map<string, number>` per A3 invariant; sub-elements do not store pinNodes maps.
  - The patched PB-XFMR.md remains the source of truth for `mutual-inductor.ts`. The current actual file (`src/components/passives/mutual-inductor.ts`) on disk has public getters that are out-of-spec and must be removed during PB-XFMR re-execution if the file diverges from the patched spec; otherwise the file is replaced wholesale.
- **Tests**: spec-compliance gate only (this task patches the spec, not source code).
- **Acceptance criteria**:
  - PB-XFMR.md contains all 5 surface-area sections listed above.
  - Constructor signature includes `inductance` parameter.
  - `load()` bodies are present on both sub-element classes.
  - `getLteTimestep` declared on `InductorSubElement`.
  - Pool-backed declaration present on `InductorSubElement`.
  - `_pinNodes` ownership stated explicitly.

### Task 3.5.5.2: Patch PB-TAPXFMR.md to close inter-PB class-API gaps

- **Description**: Mirror the PB-XFMR.md patches in PB-TAPXFMR.md so the consumer side references the patched contract and adds the 3-way getLteTimestep forward. Update the constructor calls (line 130-135 of current PB-TAPXFMR.md) to pass the inductance value as the 4th constructor arg. Add a `load()` body section to the composite that delegates to all 6 sub-elements (3 IND + 3 MUT) via cached handles.
- **Files to modify**:
  - `spec/setup-load-split/components/PB-TAPXFMR.md` — update constructor calls in lines 130-135 to include inductance values:
    - `_l1 = new InductorSubElement(p1Node, p2Node, label + "_L1", primaryInductance)`
    - `_l2 = new InductorSubElement(s1Node, ctNode, label + "_L2", primaryInductance × turnsRatio²)`
    - `_l3 = new InductorSubElement(ctNode, s2Node, label + "_L3", primaryInductance × turnsRatio²)`
    - `_mut12 = new MutualInductorElement(m12_coupling, _l1, _l2)`
    - `_mut13 = new MutualInductorElement(m13_coupling, _l1, _l3)`
    - `_mut23 = new MutualInductorElement(m23_coupling, _l2, _l3)`
  - Expand the composite `load()` block (current line 144-152) to confirm the delegation pattern and reference PB-XFMR's load() bodies on each sub-element.
  - Add an explicit `getLteTimestep(dt, deltaOld, order, method, lteParams)` section: composite returns `min(_l1.getLteTimestep, _l2.getLteTimestep, _l3.getLteTimestep)`.
  - Confirm `_pinNodes` ownership: `AnalogTappedTransformerElement` owns the `_pinNodes` Map.
- **Tests**: spec-compliance gate only.
- **Acceptance criteria**:
  - PB-TAPXFMR.md constructor calls include inductance values.
  - Composite `load()` body block present.
  - Composite `getLteTimestep` delegation block present.
  - `_pinNodes` ownership stated explicitly.

### Task 3.5.5.3: Re-spawn PB-TAPXFMR implementer with patched spec

- **Description**: After tasks 3.5.5.1 and 3.5.5.2 land, re-spawn an implementer for PB-TAPXFMR. The agent reads the patched PB-TAPXFMR.md and the patched PB-XFMR.md (for the sub-element class API contract). The agent does NOT salvage the prior 590-line partial edit on `tapped-transformer.ts` — that file is reverted to its W2-stub state before the re-spawn (or to whatever clean state is appropriate; user confirms before reverting).
- **Files to modify (during execution, by implementer)**:
  - `src/components/passives/tapped-transformer.ts` — clean implementation per the patched PB-TAPXFMR.md.
  - `src/components/passives/mutual-inductor.ts` — delete out-of-spec public getters (`get hPIbr()`, `get stateBase()`, etc.) added during the prior partial run, OR replace the file wholesale per the patched PB-XFMR.md.
- **Tests**: spec-compliance gate only.
- **Acceptance criteria**:
  - `tapped-transformer.ts` matches the patched PB-TAPXFMR.md spec line-for-line.
  - `mutual-inductor.ts` matches the patched PB-XFMR.md spec line-for-line (no extra getters, no out-of-spec exports).
  - The prior 590-line partial edit is fully replaced; no salvaged fragments remain.
- **Pre-condition**: tasks 3.5.5.1 and 3.5.5.2 are complete and committed before this task spawns.

---

## Wave 3.5.6: 02-behavioral.md scope extension

### Task 3.5.6.1: Extend 02-behavioral.md scope

- **Description**: The original 02-behavioral.md scope table (lines 17-27) lists gates / combinational / drivers / splitter / SevenSeg / ButtonLED / Ground but omits flip-flops and sequential composites. Extend the scope table to include all 7 flip-flop classes and all 3 sequential classes. Add corresponding rows to the "Behavioral element list with composite-shape declaration" table at the bottom of the file. LED is NOT added to the behavioral scope (per Wave 3.5.1, LED becomes ngspice-anchored via PB-DIO, off the behavioral list).
- **Files to modify**:
  - `spec/setup-load-split/02-behavioral.md` — add Flipflop and Sequential rows to the §Scope table; extend Shape rule 3's "Concrete field names per composite class" table with the 10 new class entries; add 10 rows to the "Behavioral element list" table at the bottom.
- **Tests**: none — spec-only.
- **Acceptance criteria**:
  - 02-behavioral.md §Scope lists Flipflop and Sequential groups.
  - Shape rule 3 table includes `BehavioralDFlipflopElement`, `BehavioralDAsyncFlipflopElement`, `BehavioralJKFlipflopElement`, `BehavioralJKAsyncFlipflopElement`, `BehavioralRSFlipflopElement`, `BehavioralRSAsyncLatchElement`, `BehavioralTFlipflopElement`, `BehavioralCounterElement`, `BehavioralRegisterElement`, `BehavioralCounterPresetElement`.
  - Behavioral element list at the bottom of the file includes pin-layout summaries for all 10 new classes.

---

## Wave 3.5.7: plan.md update

### Task 3.5.7.1: Add W3.5 row and phasing entry to plan.md

- **Description**: Add a row to the §Wave plan table for W3.5 covering the 6 PB tasks above plus the XFMR/TAPXFMR patches. Add an Implementation phasing entry (item 4.5). No half-state risk note required.
- **Files to modify**:
  - `spec/setup-load-split/plan.md` — add W3.5 row to the Wave plan table; add item 4.5 to the Implementation phasing list; add cross-reference in the Wave-by-wave reading guide.
- **Tests**: none — spec-only.
- **Acceptance criteria**:
  - plan.md Wave plan table contains a W3.5 row.
  - plan.md Implementation phasing lists item 4.5 with dependency on W3 complete.
  - Wave-by-wave reading guide table contains a W3.5 row.

---

## Verification policy (entire phase)

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split":

- Implementer agents MUST NOT run tests.
- Implementer agents MUST NOT identify or report numerical mismatches.
- Implementer agents MUST NOT modify test files to "make tests pass".
- Wave-verifier agents MUST NOT run tests.
- Wave-verifier agents MUST NOT use test pass/fail as a verification criterion.

PASS = source matches spec line-for-line. FAIL = source deviates from spec.
