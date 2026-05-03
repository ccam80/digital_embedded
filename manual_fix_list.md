# Manual Fix List

> Generated 2026-05-01. Source: spec/merged-implementer-contracts.md cross-referenced against the four phase docs.
> Work order: engine -> components -> tests. Check items off as completed.
>
> Phase tags: `phase-1-engine-infrastructure` (Phase1 File N), `phase-component-model-correctness-job` (Component A/B/C/G), `phase-composite-architecture` (Composite I/D/M/E), `phase-test-contract-updates` (Test 1.x / UC-7).
> Where a job has edits from multiple phases, the dominant phase for the row is listed and the secondary phase is noted in the intent sentence.

## Ripples for remaining jobs

> When fixing a job lands an architectural move that invalidates spec line-citations for later jobs, log it here. Before starting any job whose ID appears below, check this section first - the spec doc's path/line numbers will not match the working tree.
>
> Each entry: **affected job(s)** | **spec cites** | **actually lives in** | **note**.

### From J-132 + J-175 Wave 1 - `participatesInLoad` flag deleted, wrapper promoted to class (landed 2026-05-03)

ssI2 spec evolved: the `participatesInLoad?: boolean` field on `AnalogElement` was a one-producer / one-consumer flag covering an architectural gap (only the netlist-composite wrapper set it; only `analog-engine.ts:_setup` skipped on it). Wave 1 replaced the wrapper object literal with a real `SubcircuitWrapperElement` class (`src/solver/analog/subcircuit-wrapper-element.ts`) carrying no-op `setup()` / `load()` baked in. The flag was then deleted from the `AnalogElement` interface, the four decorative `readonly participatesInLoad = true` declarations on dac/comparator/adc/schmitt drivers, and the engine's skip site.

| Affected job | Spec cites | Actually lives in | Note |
|---|---|---|---|
| J-100 (Composite I2 portion) | `AnalogElement.participatesInLoad?: boolean` add | DELETED- field gone from `element.ts` entirely | Spec line removed; no `participatesInLoad` anywhere in `src/`. |
| J-132 (Composite I2 portion) | `_setup`/`_load` walks skip elements where `participatesInLoad === false` | `analog-engine.ts:_setup` walks every element unconditionally; `ckt-load.ts:88` keeps the existing `typeof element.load !== "function"` pluggable-safety guard | The wrapper's no-op `load()` is now stamping a no-op every iteration- functionally equivalent to skipping it, structurally cleaner. |
| J-175 (Composite I2 portion) | wrapper as plain object literal with `participatesInLoad: false` | `compiler.ts:550-567` constructs `new SubcircuitWrapperElement({...})`; class lives at `src/solver/analog/subcircuit-wrapper-element.ts` | Consumer at `compiler.ts:1212` / `:1248` uses `instanceof SubcircuitWrapperElement` instead of duck-type cast (also closes 1 of the 10 J-175 `as unknown as` casts as a side effect). |

### From J-178 follow-on - decomposition of `src/core/analog-types.ts` (landed 2026-05-02)

`src/core/analog-types.ts` deleted. Contents redistributed to natural owners under `src/solver/analog/`. No re-export shim. All importers rewritten to point at the new owner. Stale `src/core/__tests__/analog-types-setparam.test.ts` deleted (its meta-check on `setParam` being required is now enforced by the interface itself in `element.ts`).

**New homes:**
- `AnalogElement`, `PoolBackedAnalogElement`, `isPoolBacked` -> `src/solver/analog/element.ts` (was a 32-line re-export shim, now the real ~265-line home)
- `IntegrationMethod` -> `src/solver/analog/integration.ts`
- `SparseSolverStamp` -> `src/solver/analog/sparse-solver.ts`
- `ComplexSparseSolver` (interface) -> renamed to `ComplexSparseSolverStamp` in `src/solver/analog/complex-sparse-solver.ts` (collided with the class name; rename matches the existing `SparseSolverStamp` convention)
- `StatePoolRef` -> `src/solver/analog/state-pool.ts`
- `AcParams`, `AcResult` -> `src/solver/analog/ac-analysis.ts`
- `NGSPICE_LOAD_ORDER`, `TYPE_ID_TO_NGSPICE_LOAD_ORDER`, `getNgspiceLoadOrderByTypeId`, `TYPE_ID_TO_DECK_PIN_LABEL_ORDER` -> `src/solver/analog/ngspice-load-order.ts` (NEW)

| Affected job | Spec cites | Actually lives in | Note |
|---|---|---|---|
| J-100 | `src/core/analog-types.ts` (NGSPICE_LOAD_ORDER block lines 61-205; `AnalogElement.participatesInLoad` addition lines 278-540) | `src/solver/analog/ngspice-load-order.ts` (NEW; load-order policy + sentinels); `src/solver/analog/element.ts` (`participatesInLoad?: boolean` on `AnalogElement`) | Pin-key alignment for `resistor.ts` / `inductor.ts` is unaffected by this move; stays at original file paths. |
| J-101 | `src/core/mna-subcircuit-netlist.ts` | unchanged | Listed for completeness; this file was NOT moved. Spec citations valid. |
| Any job citing `src/solver/analog/element.ts` line numbers | line numbers in the old 32-line shim | `src/solver/analog/element.ts` (now ~265 lines containing the real `AnalogElement` / `PoolBackedAnalogElement` interfaces + `isPoolBacked`) | Re-grep for the symbol; do not trust line numbers in spec. |
| Any job citing `core/analog-types.ts` for `IntegrationMethod` / `SparseSolverStamp` / `ComplexSparseSolver` (interface) / `StatePoolRef` / `AcParams` / `AcResult` | `src/core/analog-types.ts` | `integration.ts`, `sparse-solver.ts`, `complex-sparse-solver.ts` (renamed `ComplexSparseSolverStamp`), `state-pool.ts`, `ac-analysis.ts` (all under `src/solver/analog/`) respectively | Co-located with implementation. The `ComplexSparseSolver` *class* is unchanged. |
| Any job citing `core/analog-types.ts` for `Diagnostic*` re-exports | `src/core/analog-types.ts` | `src/compile/types.ts` (their canonical home; analog-types.ts was just re-exporting them) | Import directly. |

## 1. Engine / Internals

### 1a. Type / interface foundations (must land first - everything else imports these)

- [x] `src/solver/analog/element.ts` -- **spec:** phase-component-model-correctness-job ssG12 -- Remove `accept?` slot from `AnalogElement` interface; keep `acceptStep?` (J-178). **Done 2026-05-02:** `accept?` slot was already gone (verified). Folded in: decomposed `src/core/analog-types.ts` (god-file violating no-shims rule) into natural owners under `src/solver/analog/`. See ripples table.
- [x] `src/core/analog-types.ts` -- **spec:** phase-composite-architecture ssI1+I2 -- Pin-key alignment for resistor/inductor; replace `NGSPICE_LOAD_ORDER` with sentinel-aware table including `INTERNAL_NET_ALLOC=-2`, `INTERNAL_NET_PATCH=-1`, `BEHAVIORAL=49`; add `participatesInLoad?: boolean` to `AnalogElement` (J-100; also Component B9). **Done 2026-05-03 (verified pre-landed via J-178 ripple):** `analog-types.ts` deleted; `NGSPICE_LOAD_ORDER` sentinels + `BEHAVIORAL=49` already in `src/solver/analog/ngspice-load-order.ts:28-55`; `participatesInLoad?: boolean` already on `AnalogElement` at `src/solver/analog/element.ts:49-54`; Resistor/Inductor pinLayout already `pos`/`neg` (component files + `TYPE_ID_TO_DECK_PIN_LABEL_ORDER`).
- [x] `src/core/mna-subcircuit-netlist.ts` -- **spec:** phase-composite-architecture ssI4 -- Define `SubcircuitElementParam` discriminated union; add `internalNetLabels?` and `branchCount?` to interfaces (J-101). **Done 2026-05-02:** Added 4-arm `SubcircuitElementParam` (number | string | siblingBranch | siblingState), `subElementName?`, and `internalNetLabels?`. `branchCount` was already present. File type-checks clean. **Contract decision (binding on all downstream jobs):** the union is CLOSED at 4 arms; flags / booleans MUST be encoded as `0`/`1` numbers per ngspice `IFvalue.iValue` convention. No `boolean` arm. Docstring on the type spells this out. Affects **J-019 (adc.ts)** and **J-023 (dac.ts)** whose spec examples passed `bipolar: <boolean>` directly - those jobs MUST coerce to 0/1 at the netlist boundary (or use a parent-params declarative path with `bipolar: "bipolar"` string-lookup, defaulting to 0). The contract does not bend; the implementations conform.
- [x] `src/components/registry.ts` -- **spec:** phase-composite-architecture ssI3+I6+I7+M4..M26 -- Add `internalOnly?: boolean`, function-form netlists in `ModelEntryNetlist`, register all 25 new driver/internal-only definitions (J-070). **Done 2026-05-03 (verified):** `internalOnly?: boolean` on `ModelEntryNetlist`; function-form netlist support landed; all 25 driver/internal-only definitions registered across Waves 1-6 + Bundles 1-3 (see Stats section for full attribution).

### 1b. Solver core (NR limiting, topology diagnostics, coordinator wiring)

- [x] `src/solver/analog/newton-raphson.ts` -- **spec:** phase-component-model-correctness-job ssC3 -- Add `railLim` function and widen `LimitingEvent.limitType` union to include `"railLim"` (J-179). **Done 2026-05-03 (verified):** `RailLimResult` interface (line 260), `_railLimResult` singleton (line 262), `railLim()` function (lines 274-291), and widened `LimitingEvent.limitType` union including `"railLim"` (line 38) all present and match spec verbatim. Reviewer-blessed in `spec/reviews/batch-44.md:175-182` ("No violations"). **In-blast-radius latent bug folded in:** `src/solver/analog/__tests__/harness/types.ts` carried a duplicate `LimitingEvent` interface with a stale `limitType` union missing `"railLim"`, causing ~60 cascading TS errors. Replaced the duplicate with `export type { LimitingEvent } from "../../newton-raphson.js";` — single source of truth.
- [x] `src/solver/analog/topology-diagnostics.ts` -- **spec:** phase-1-engine-infrastructure File 1 -- NEW FILE; export `TopologyEntry`, `buildTopologyInfo`, `runCompileTimeDetectors`, `runPostSetupDetectors` (J-180). **Done (verified pre-landed 2026-05-03):** all 4 exports + 4 private helpers present; bodies match spec verbatim; no compiler.ts / analog-engine.ts imports; consumer wiring already live at `compiler.ts:45-47` + `:1369-1370` and `analog-engine.ts:38` + `:1328-1329` (those wires are J-175 / J-132 partial-landings; both jobs still have remaining cast-cleanup + function-form-netlist work tracked under Wave 2). **Scope note:** following the extraction into its consumer `src/solver/analog/compiler.ts` (lines 565-940 per spec) is in-scope for this job — the inline detectors and validator must be deleted from compiler.ts and replaced with calls into the new module. Verifying compiler.ts still type-checks after the move is part of the J-180 acceptance gate, not a separate job.
- [ ] `src/solver/coordinator-types.ts` -- **spec:** phase-1-engine-infrastructure File 9 -- Add `getRuntimeDiagnostics()`, `setLimitingCapture()`, `getLimitingEvents()` to `SimulationCoordinator` interface (J-181; also Component C4).
- [ ] `src/solver/coordinator.ts` -- **spec:** phase-1-engine-infrastructure File 10 -- Wire `mnaEngine.onDiagnostic` into `_diagnostics` collector; add `getRuntimeDiagnostics()`; implement `setLimitingCapture`/`getLimitingEvents` (J-182; also Component C5; UC-7 retains line 115).
- [ ] `src/solver/null-coordinator.ts` -- **spec:** phase-component-model-correctness-job ssC6 -- No-op implementations of `setLimitingCapture`/`getLimitingEvents` on `NullSimulationCoordinator` (J-183).

### 1c. Compiler / engine setup pipeline (depend on the above)

- [ ] `src/solver/analog/compiler.ts` -- **spec:** phase-1-engine-infrastructure File 2 -- Strip 5 inline detectors + validator; wire `topology-diagnostics` compile-time entry; sentinel ordinals on allocator/patcher; wrapper as `SubcircuitWrapperElement` class (no-op setup/load) per ssI2 evolution; siblingBranch/siblingState dispatch; function-form netlist resolution with merged-instance params per ssI6; per-leaf label stamping; **re-implement `labelToNodeId` to ngspice spec** (replace the single-node-per-label workaround flagged in-place at compiler.ts:930-944 and the matching `labelPinNodes` build site that follows; delete both the workaround code and the IMPLEMENTATION-FAILURE comment block once correct; acceptance gate is per-step harness comparison via `harness_get_step` against ngspice, NOT a Grep -- per spec/reviews/REVIEW_SUMMARY.md:165 and spec/reviews/batch-43.md) (J-175; also Composite I1, I2, I4, I5, I6; labelToNodeId remediation per spec-review batch-43). **Partial (2026-05-03):** Wave 1+2 closed all ssI1+I2+I4+I5+I6+Phase1 File 2 acceptance criteria. SubcircuitWrapperElement class lives at `src/solver/analog/subcircuit-wrapper-element.ts`; all 11 `as unknown as` casts in compiler.ts removed (1 was duplicate-eliminated by Wave 1's `instanceof` rewrite, 9 in Wave 2); `extractRuntimeModels` deleted (dead+wrong-typed: was reading metadata.models — the SPICE model registry — and casting to `Record<defName, MnaSubcircuitNetlist>`, structurally wrong; the dead fallback path would have masked an unresolved-model-ref); function-form netlist call now passes merged-instance PropertyBag per ssI6. **REMAINING:** `labelToNodeId` remediation per batch-43 review (single-node-per-label workaround at compiler.ts:930-944 area still in place; needs harness_get_step parity gate). Keep this row open until that lands.
- [x] `src/solver/analog/analog-engine.ts` -- **spec:** phase-1-engine-infrastructure File 3 -- Delete per-element `accept()` invocation loop; delete `_walkSubElements`; (ssI2 evolved: `participatesInLoad` field deleted entirely — wrapper is now `SubcircuitWrapperElement` class with no-op setup/load); run `runPostSetupDetectors` at end of `_setup()`; add public `getDiagnostics()` (J-132; also Component G13, Composite I2). **Done (verified 2026-05-03):** G13 + Phase1 File 3 acceptance criteria met. ssI2 portion superseded by Wave 1 (no `participatesInLoad` field anywhere; engine walks every element unconditionally; wrapper carries no-op stubs).

### 1d. Headless / harness / IO surfaces

- [ ] `src/headless/spice-model-apply.ts` -- **spec:** phase-composite-architecture ssI3 -- Skip `internalOnly: true` registry entries during SPICE-import primary-element matching (J-105).
- [ ] `scripts/mcp/harness-tools.ts` -- **spec:** phase-composite-architecture ssI3 -- `harness_describe` groups `internalOnly` sub-elements under their parent composite's user-facing label (J-004).
- [ ] `src/app/simulation-controller.ts` -- **spec:** phase-1-engine-infrastructure File 11 -- `compileAndBind` reads `coordinator.getRuntimeDiagnostics()` after `getDcOpResult()`, surfaces runtime errors to status bar + canvas overlays, aborts on runtime error (J-006).
- [ ] `src/editor/palette.ts` -- **spec:** phase-composite-architecture ssI3 -- Filter `internalOnly` definitions from palette tree (J-104).
- [ ] `src/editor/palette-ui.ts` -- **spec:** phase-composite-architecture ssI3 -- Filter `internalOnly` definitions from palette tree (J-103).

### 1e. Composite / digital-pin-model deletions (parallel-pool peers; trigger import-removal cascade)

- [ ] `src/solver/analog/composite-element.ts` -- **spec:** phase-composite-architecture ssD1 -- DELETE the file (J-176).
- [ ] `src/solver/analog/digital-pin-model.ts` -- **spec:** phase-composite-architecture ssD2 -- DELETE the file (J-177).

## 2. Components

### 2a. Behavioural-driver leaves (NEW FILES; consumed by user-facing component netlists)

#### Output / pin / bridge primitives (gate template depends on these)

- [x] `src/solver/analog/behavioral-output-driver.ts` -- **spec:** phase-composite-architecture ssI7 -- NEW FILE; `BehavioralOutputDriverElement` (VSRC-shape voltage driver reading siblingState `OUTPUT_LOGIC_LEVEL`) (J-171).
- [ ] `src/components/digital-pins/digital-input-pin-loaded.ts` -- **spec:** phase-composite-architecture ssI7 -- NEW FILE; loaded digital input pin netlist (R + C to GND) (J-033).
- [ ] `src/components/digital-pins/digital-input-pin-unloaded.ts` -- **spec:** phase-composite-architecture ssI7 -- NEW FILE; unloaded digital input pin netlist (empty) (J-034).
- [ ] `src/components/digital-pins/digital-output-pin-loaded.ts` -- **spec:** phase-composite-architecture ssI7 -- NEW FILE; loaded digital output pin netlist (driver + R + C) (J-035).
- [ ] `src/components/digital-pins/digital-output-pin-unloaded.ts` -- **spec:** phase-composite-architecture ssI7 -- NEW FILE; unloaded digital output pin netlist (driver only) (J-036).
- [ ] `src/solver/analog/behavioral-drivers/bridge-input-driver.ts` -- **spec:** phase-composite-architecture ssM21 -- NEW FILE; `BridgeInputDriverElement` (digital pin -> analog node coupling) (J-135).
- [ ] `src/solver/analog/behavioral-drivers/bridge-output-driver.ts` -- **spec:** phase-composite-architecture ssM21 -- NEW FILE; `BridgeOutputDriverElement` (analog node -> digital pin coupling) (J-136).

#### Gate driver leaves (M10 - 8 files)

- [x] `src/solver/analog/behavioral-drivers/and-driver.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE; `BehavioralAndDriverElement` (J-134). ✅ Canonical Template A-variable-pin (variable inputs via `pinLayoutFactory`, fixed 1-slot schema, hold-on-indeterminate semantic).
- [x] `src/solver/analog/behavioral-drivers/or-driver.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE; `BehavioralOrDriverElement` (J-153). ✅ Wave 4 (driver+parent pair).
- [x] `src/solver/analog/behavioral-drivers/nand-driver.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE; `BehavioralNandDriverElement` (J-150). ✅ Wave 4 (driver+parent pair).
- [x] `src/solver/analog/behavioral-drivers/nor-driver.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE; `BehavioralNorDriverElement` (J-151). ✅ Wave 4 (driver+parent pair).
- [x] `src/solver/analog/behavioral-drivers/xor-driver.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE; `BehavioralXorDriverElement` (J-161). ✅ Wave 4 (driver+parent pair).
- [x] `src/solver/analog/behavioral-drivers/xnor-driver.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE; `BehavioralXnorDriverElement` (J-160). ✅ Wave 4 (driver+parent pair).
- [x] `src/solver/analog/behavioral-drivers/not-driver.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE; `BehavioralNotDriverElement` (N=1) (J-152). ✅ Wave 5 (W5-B; driver+parent pair).
- [x] `src/solver/analog/behavioral-drivers/buf-driver.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE; `BehavioralBufDriverElement` (N=1) (J-137). ✅ Wave 5 (W5-C; driver + new parent buf.ts pair).

#### Combinational driver leaves (M11)

- [x] `src/solver/analog/behavioral-drivers/mux-driver.ts` -- **spec:** phase-composite-architecture ssM11 -- NEW FILE; `BehavioralMuxDriverElement` (J-149). ✅ Wave 4 (driver + mux.ts parent migration).
- [x] `src/solver/analog/behavioral-drivers/demux-driver.ts` -- **spec:** phase-composite-architecture ssM11 -- NEW FILE; `BehavioralDemuxDriverElement` (J-144). ✅ Bundle 2 (driver + `buildDemuxNetlist` precursor + parent migration; combinational A-multi-bit-schema with whole-vector hold-on-indeterminate; analog model 1-bit, multi-bit demuxes fall through to digital path).
- [x] `src/solver/analog/behavioral-drivers/decoder-driver.ts` -- **spec:** phase-composite-architecture ssM11 -- NEW FILE; `BehavioralDecoderDriverElement` (J-143). ✅ Bundle 2 (driver + `buildDecoderNetlist` precursor + parent migration; one-hot output via per-bit OUTPUT_LOGIC_LEVEL_BITi slots; whole-vector hold-on-indeterminate because per-bit hold is incoherent for one-hot decoding).

#### Sequential driver leaves (M12)

- [x] `src/solver/analog/behavioral-drivers/counter-driver.ts` -- **spec:** phase-composite-architecture ssM12 -- NEW FILE; `BehavioralCounterDriverElement` (J-139). ✅ Canonical Template A-multi-bit-schema (memoised arity-indexed schema; LAST_CLOCK + COUNT_BITi + OUTPUT_LOGIC_LEVEL_BITi + OUTPUT_LOGIC_LEVEL_OVF). Spec extension: OVF added beyond J-139 acceptance criteria, required because Counter parent has an ovf output pin.
- [x] `src/solver/analog/behavioral-drivers/counter-preset-driver.ts` -- **spec:** phase-composite-architecture ssM12 -- NEW FILE; `BehavioralCounterPresetDriverElement` (J-140). ✅ Wave 6 (W6-G; bus-pin shape, edge-triggered, vIH/vIL hysteresis on packed `in` decode + parent migration).
- [x] `src/solver/analog/behavioral-drivers/register-driver.ts` -- **spec:** phase-composite-architecture ssM12 -- NEW FILE; `BehavioralRegisterDriverElement` (J-154). ✅ Wave 6 (W6-H; bus-pin shape D/Q, en-guarded edge sample + parent migration with bitWidth paramDef forwarding fix).

#### Misc behavioural drivers (M13)

- [x] `src/solver/analog/behavioral-drivers/driver-driver.ts` -- **spec:** phase-composite-architecture ssM13 -- NEW FILE; `BehavioralDriverDriverElement` (J-145). ✅ Bundle 1 (active-high tri-state via OUTPUT_LOGIC_LEVEL_ENABLE slot + sibling `enableLogic` ref; BehavioralOutputDriver Thévenin → Norton refactor as the enabling architectural change; high-Z = 1 GΩ shunt + zero current injection).
- [x] `src/solver/analog/behavioral-drivers/driver-inv-driver.ts` -- **spec:** phase-composite-architecture ssM13 -- NEW FILE; `BehavioralDriverInvDriverElement` (J-146). ✅ Bundle 1 (mirror of J-145 with active-LOW enable polarity; same Norton + sibling enableLogic architecture).
- [x] `src/solver/analog/behavioral-drivers/splitter-driver.ts` -- **spec:** phase-composite-architecture ssM13 -- NEW FILE; `BehavioralSplitterDriverElement` (J-158). ✅ Wave 5 (W5-F; multi-port multi-slot, split/merge/passthrough modes mirroring executeSplitter, vIL hot-loadable + parent migration).
- [x] `src/solver/analog/behavioral-drivers/seven-seg-driver.ts` -- **spec:** phase-composite-architecture ssM13 -- NEW FILE; `BehavioralSevenSegDriverElement` (J-157). ✅ Wave 5 (W5-E; divergent shape — 8 INPUT-only pins, 8 observation-only slots, no consumer sub-elements + parent migration).
- [x] `src/solver/analog/behavioral-drivers/button-led-driver.ts` -- **spec:** phase-composite-architecture ssM13 -- NEW FILE; `BehavioralButtonLEDDriverElement` (J-138). ✅ Wave 5 (W5-D; threshold-classify with logicLevel; spec referenced non-existent composite load() body, agent escalated, user authorized Template A pattern + parent migration).

#### Flip-flop driver leaves (M14-M20)

- [x] `src/solver/analog/behavioral-drivers/d-flipflop-driver.ts` -- **spec:** phase-composite-architecture ssM14 -- NEW FILE; `BehavioralDFlipflopDriverElement` (J-142). ✅ Precursor (Template A canonical authored + cleaned this followup).
- [ ] `src/solver/analog/behavioral-drivers/t-flipflop-driver.ts` -- **spec:** phase-composite-architecture ssM15 -- NEW FILE; `BehavioralTFlipflopDriverElement` (J-159).
- [ ] `src/solver/analog/behavioral-drivers/rs-flipflop-driver.ts` -- **spec:** phase-composite-architecture ssM16 -- NEW FILE; `BehavioralRSFlipflopDriverElement` (J-156).
- [ ] `src/solver/analog/behavioral-drivers/rs-async-latch-driver.ts` -- **spec:** phase-composite-architecture ssM17 -- NEW FILE; `BehavioralRSAsyncLatchDriverElement` (J-155).
- [ ] `src/solver/analog/behavioral-drivers/jk-flipflop-driver.ts` -- **spec:** phase-composite-architecture ssM18 -- NEW FILE; `BehavioralJKFlipflopDriverElement` (J-148).
- [ ] `src/solver/analog/behavioral-drivers/jk-async-flipflop-driver.ts` -- **spec:** phase-composite-architecture ssM19 -- NEW FILE; `BehavioralJKAsyncFlipflopDriverElement` (J-147).
- [ ] `src/solver/analog/behavioral-drivers/d-async-flipflop-driver.ts` -- **spec:** phase-composite-architecture ssM20 -- NEW FILE; `BehavioralDAsyncFlipflopDriverElement` (J-141).

#### Composite-specific driver leaves

- [x] `src/components/active/dac-driver.ts` -- **spec:** phase-composite-architecture ssM22 -- NEW FILE; `DACDriverElement` (VCVS branch row stamp) (J-022). ✅ Wave 3 (Template D hybrid).
- [x] `src/components/active/adc-driver.ts` -- **spec:** phase-composite-architecture ssM23 -- NEW FILE; `ADCDriverElement` with packed `SAR_BITS` slot (J-018). ✅ Wave 3 (reclassified to A-multi-bit-schema; per-bit slots not packed SAR per audit).
- [x] `src/components/active/comparator-driver.ts` -- **spec:** phase-composite-architecture ssM24 -- NEW FILE; `ComparatorDriverElement` (J-020).
- [x] `src/components/active/schmitt-trigger-driver.ts` -- **spec:** phase-composite-architecture ssM25 -- NEW FILE; `SchmittTriggerDriverElement` (J-028). ✅ Wave 3 (Template D hybrid).
- [x] `src/components/active/timer-555-latch-driver.ts` -- **spec:** phase-composite-architecture ssM5 -- NEW FILE; `Timer555LatchDriverElement` (RS latch + discharge BJT base driver) (J-030). ✅ Wave 5 (W5-A; hybrid Template A + 1 local stamp block for BJT base clamp; spec API `ctx.matrix.add` translated to `ctx.solver.allocElement`/`stampElement`).
- [x] `src/components/active/internal-zero-volt-sense.ts` -- **spec:** phase-composite-architecture ssM4 -- NEW FILE; `InternalZeroVoltSense` extracted from optocoupler `VsenseSubElement` (J-025).
- [x] `src/components/active/internal-cccs.ts` -- **spec:** phase-composite-architecture ssM4 -- NEW FILE; `InternalCccs` extracted from optocoupler `CccsSubElement` (J-024).
- [x] `src/components/passives/transformer-coupling.ts` -- **spec:** phase-composite-architecture ssM26 -- NEW FILE; `TransformerCouplingElement` mutual inductance via siblingBranch (J-063).
- [x] `src/components/switching/relay-coupling.ts` -- **spec:** phase-composite-architecture ssM7 -- NEW FILE; `RelayCouplingElement` first siblingState user (J-095).
- [x] `src/components/switching/fgnfet-blown-driver.ts` -- **spec:** phase-composite-architecture ssM8+M9 -- NEW FILE; `FGNFETBlownDriverElement` + shared `stampBlownClamp` helper (J-091).
- [x] `src/components/switching/fgpfet-blown-driver.ts` -- **spec:** phase-composite-architecture ssM9 -- NEW FILE; `FGPFETBlownDriverElement` calling shared `stampBlownClamp` (J-093).
- [x] `src/components/passives/transmission-segment-r.ts` -- **spec:** phase-composite-architecture ssM6 -- NEW FILE; `TransmissionSegmentR` (J-068).
- [x] `src/components/passives/transmission-segment-l.ts` -- **spec:** phase-composite-architecture ssM6 -- NEW FILE; `TransmissionSegmentL` (J-067).
- [x] `src/components/passives/transmission-segment-c.ts` -- **spec:** phase-composite-architecture ssM6 -- NEW FILE; `TransmissionSegmentC` (J-065).
- [x] `src/components/passives/transmission-segment-g.ts` -- **spec:** phase-composite-architecture ssM6 -- NEW FILE; `TransmissionSegmentG` (J-066).
- [x] `src/components/passives/transmission-segment-rl.ts` -- **spec:** phase-composite-architecture ssM6 -- NEW FILE; `TransmissionSegmentRL` (J-069).

### 2b. Pool-backed migrations (Component G - StatePool slot conversions)

- [ ] `src/components/passives/analog-fuse.ts` -- **spec:** phase-component-model-correctness-job ssG1 -- `ANALOG_FUSE_SCHEMA` 2-slot; `acceptStep` keeps breakpoint scheduling; bottom-of-load history writes; delete `accept()` and instance fields (J-056).
- [ ] `src/components/passives/memristor.ts` -- **spec:** phase-component-model-correctness-job ssB3 -- Pin-key `pos`/`neg`; `MEMRISTOR_SCHEMA` (W slot); pool migration; delete `_w` and `accept()` (J-060).
- [ ] `src/components/sensors/spark-gap.ts` -- **spec:** phase-component-model-correctness-job ssG3 -- `SPARK_GAP_SCHEMA` (CONDUCTING slot); pool migration; delete `accept()` and instance field (J-086).
- [ ] `src/components/sensors/ntc-thermistor.ts` -- **spec:** phase-component-model-correctness-job ssG5 -- `NTC_SCHEMA` (TEMPERATURE slot); pool migration; delete `accept()` (J-085).
- [x] `src/components/active/real-opamp.ts` -- **spec:** phase-component-model-correctness-job ssC1 -- `REAL_OPAMP_SCHEMA` 8-slot; `PoolBackedAnalogElement`; `railLim` integration; bottom-of-load CKTstate0 writes (J-027). **Done 2026-05-03 (verified, J-179 follow-on):** 8-slot `REAL_OPAMP_SCHEMA` declared (lines 76-85); `RealOpAmpAnalogElement implements PoolBackedAnalogElement` (line 348); `accept()` deleted; `railLim` invoked under `initBits === 0` mode-mask gate (lines 495-518) emitting `LimitingEvent { limitType: "railLim" }`; bottom-of-load CKTstate0 writes for VINT/VOUT plus 5 observability slots (lines 577-583); slew "previous" reads `s1[VINT]` per spec (line 457). All closure-local mutable state listed in spec (vInt, vIntPrev, _vOutPrev, outputSaturated, etc.) is gone — only `p`, `_lastSrcFact`, TSTALLOC handles, `_pool` remain.
- [ ] `src/components/active/comparator.ts` -- **spec:** phase-component-model-correctness-job ssG7 + composite ssM24 -- Pool migration on existing schema (`OUTPUT_WEIGHT` integration from `s1`); netlist + ComparatorDriver (J-021).

### 2c. Pin-key alignment outliers (Component B - rename A/B to pos/neg)

- [ ] `src/components/passives/resistor.ts` -- **spec:** phase-component-model-correctness-job ssB1 -- Pin keys `A`/`B` -> `pos`/`neg`; drop/normalise `ngspiceNodeMap` (J-061).
- [ ] `src/components/passives/inductor.ts` -- **spec:** phase-component-model-correctness-job ssB2 -- Pin keys `A`/`B` -> `pos`/`neg`; drop `ngspiceNodeMap` (J-059).
- [ ] `src/components/passives/crystal.ts` -- **spec:** phase-component-model-correctness-job ssB5 -- Pin keys `A`/`B` -> `pos`/`neg` (J-058).

### 2d. BJT factory rename (Component A1, then dependents A2-A5)

- [ ] `src/components/semiconductors/bjt.ts` -- **spec:** phase-component-model-correctness-job ssA1 -- Rename `createBjtElement`/`createPnpBjtElement` -> `createBjtL0Element`/`createPnpBjtL0Element` (J-078).
- [ ] `src/components/semiconductors/triac.ts` -- **spec:** phase-component-model-correctness-job ssA4 + composite ssM3 -- BJT factory rename callsites; declare `TRIAC_NETLIST`; delete `TriacCompositeElement` (J-082).
- [ ] `src/components/active/optocoupler.ts` -- **spec:** phase-component-model-correctness-job ssA2 + composite ssM4 -- BJT factory rename; declare `OPTOCOUPLER_NETLIST`; delete composite + sub-element classes (J-026).
- [ ] `src/components/active/timer-555.ts` -- **spec:** phase-component-model-correctness-job ssA3 + composite ssM5 -- BJT factory rename; declare `buildTimer555Netlist`; delete `Timer555CompositeElement`, `Timer555ResElement`, `makeVcvsComparatorExpression` (J-031).
- [ ] `src/components/active/vcvs.ts` -- **spec:** phase-composite-architecture ssM5 -- Add `VCVSDefinition.modelRegistry.comparator` factory; migrate `makeVcvsComparatorExpression` body from timer-555.ts (J-032).

### 2e. Composite class deletions / netlist conversions (Composite M-tasks)

- [ ] `src/components/semiconductors/scr.ts` -- **spec:** phase-composite-architecture ssM1 -- Declare `SCR_NETLIST`; delete `ScrCompositeElement`, `createScrElement` (J-081).
- [ ] `src/components/semiconductors/diac.ts` -- **spec:** phase-composite-architecture ssM2 -- Declare `DIAC_NETLIST`; delete `createDiacElement` (J-079).
- [ ] `src/components/semiconductors/diode.ts` -- **spec:** phase-test-contract-updates Test 1.46 -- Architecture-fix: gate `ctx.limitingCollector?.push(...)` on MODEINIT* mask matching `dioload.c:139-205` (J-080).
- [ ] `src/components/active/adc.ts` -- **spec:** phase-composite-architecture ssM23 -- Declare `buildAdcNetlist`; delete `ADCAnalogElement` (J-019).
- [ ] `src/components/active/dac.ts` -- **spec:** phase-composite-architecture ssM22 + phase-1-engine-infrastructure ssG -- Declare `buildDacNetlist`; delete `DACAnalogElement`; set `rOut.default: 1` (J-023).
- [ ] `src/components/active/schmitt-trigger.ts` -- **spec:** phase-component-model-correctness-job ssG9 + composite ssM25 -- Delete empty `accept(){}`; declare netlist + `SchmittTriggerDriver` (J-029).
- [ ] `src/components/passives/transmission-line.ts` -- **spec:** phase-composite-architecture ssM6 -- Declare `buildTransmissionLineNetlist`; delete `TransmissionLineElement` and 5 inline sub-element classes (J-064).
- [ ] `src/components/passives/tapped-transformer.ts` -- **spec:** phase-composite-architecture ssM26 -- Declare `buildTappedTransformerNetlist`; delete `AnalogTappedTransformerElement` (J-062).
- [ ] `src/components/passives/capacitor.ts` -- **spec:** phase-composite-architecture ssD3 -- Docstring-only update on `AnalogCapacitorElement` declaring it the registered factory's element class (J-057).
- [ ] `src/components/switching/switch.ts` -- **spec:** phase-composite-architecture ssM7 -- Add `SWITCH_SCHEMA` with `CLOSED` slot; `Switch.load()` reads `s1[CLOSED]`; remove `closed` constructor param (J-098).
- [ ] `src/components/switching/relay.ts` -- **spec:** phase-component-model-correctness-job ssB6 + composite ssM7 -- Pin-key rename; declare `RELAY_NETLIST`; delete composite + sub-element classes (J-097).
- [ ] `src/components/switching/relay-dt.ts` -- **spec:** phase-component-model-correctness-job ssB7 + composite ssM7 -- Pin-key rename; declare double-throw netlist; delete composite (J-096).
- [ ] `src/components/switching/fgnfet.ts` -- **spec:** phase-composite-architecture ssM8 -- Declare `FGNFET_NETLIST`; delete `FGNFETAnalogElement` and inline sub-elements (J-092).
- [ ] `src/components/switching/fgpfet.ts` -- **spec:** phase-composite-architecture ssM9 -- Declare `FGPFET_NETLIST`; delete `FGPFETAnalogElement` and inline sub-elements (J-094).

### 2f. Gate user-facing components (M10 netlist conversions; depend on 2a gate drivers)

- [x] `src/components/gates/and.ts` -- **spec:** phase-composite-architecture ssM10 -- Convert `modelRegistry.behavioral` to function-form netlist via `buildAndGateNetlist` (J-037). ✅ Migrated to `kind: "netlist"`; emits drv + N inPin_i + outPin via siblingState (`OUTPUT_LOGIC_LEVEL`). Adds `AND_BEHAVIORAL_PARAM_DEFS` (inputCount, loaded, vIH, vIL, rOut, cOut, vOH, vOL).
- [x] `src/components/gates/or.ts` -- **spec:** phase-composite-architecture ssM10 -- Convert to function-form netlist using `BehavioralOrDriver` (J-042). ✅ Wave 4.
- [x] `src/components/gates/nand.ts` -- **spec:** phase-composite-architecture ssM10 -- Convert to function-form netlist using `BehavioralNandDriver` (J-039). ✅ Wave 4.
- [x] `src/components/gates/nor.ts` -- **spec:** phase-composite-architecture ssM10 -- Convert to function-form netlist using `BehavioralNorDriver` (J-040). ✅ Wave 4.
- [x] `src/components/gates/xor.ts` -- **spec:** phase-composite-architecture ssM10 -- Convert to function-form netlist using `BehavioralXorDriver` (J-044). ✅ Wave 4.
- [x] `src/components/gates/xnor.ts` -- **spec:** phase-composite-architecture ssM10 -- Convert to function-form netlist using `BehavioralXnorDriver` (J-043). ✅ Wave 4.
- [x] `src/components/gates/not.ts` -- **spec:** phase-composite-architecture ssM10 -- Convert to function-form netlist with N=1 fixed using `BehavioralNotDriver` (J-041). ✅ Wave 5 (W5-B).
- [x] `src/components/gates/buf.ts` -- **spec:** phase-composite-architecture ssM10 -- NEW FILE mirroring `not.ts` with `BehavioralBufDriver` (J-038). **DECISION (locked):** make the file (BUF is user-facing). ✅ Wave 5 (W5-C; new file authored).

### 2g. Behavioural-element file deletions / class removals (Composite M11-M21)

- [ ] `src/solver/analog/behavioral-gate.ts` -- **spec:** phase-composite-architecture ssM10 -- Delete `BehavioralGateElement` and `GateTruthTable`; delete file if no exports remain (J-170).
- [ ] `src/solver/analog/behavioral-combinational.ts` -- **spec:** phase-component-model-correctness-job ssG10 + composite ssM11 -- Delete 3 empty `accept(){}` stubs and 3 composite classes (J-133).
- [ ] `src/solver/analog/behavioral-sequential.ts` -- **spec:** phase-composite-architecture ssM12 -- Delete 3 composite classes (Counter/Register/CounterPreset) (J-173).
- [ ] `src/solver/analog/behavioral-remaining.ts` -- **spec:** phase-component-model-correctness-job ssG11 + composite ssM13 -- Delete 3 empty `accept(){}` stubs and 5 composite classes (J-172).
- [x] `src/solver/analog/behavioral-flipflop.ts` -- **spec:** phase-composite-architecture ssM14 -- Delete `BehavioralDFlipflopElement`; convert user-facing definition to function-form netlist (J-162). DONE: file deleted; user-facing d.ts converted to netlist behavioural model in same session.
- [x] `src/solver/analog/behavioral-flipflop/d-async.ts` -- **spec:** phase-composite-architecture ssM20 -- Delete `BehavioralDAsyncFlipflopElement`; convert to netlist; **delete file unconditionally if empty after class removal (locked)** (J-163). DONE: file deleted; live builder inlined in flipflops/d-async.ts.
- [x] `src/solver/analog/behavioral-flipflop/jk-async.ts` -- **spec:** phase-composite-architecture ssM19 -- Delete `BehavioralJKAsyncFlipflopElement`; convert to netlist; **delete file unconditionally if empty (locked)** (J-164). DONE: file deleted; live builder inlined in flipflops/jk-async.ts.
- [x] `src/solver/analog/behavioral-flipflop/jk.ts` -- **spec:** phase-composite-architecture ssM18 -- Delete `BehavioralJKFlipflopElement`; convert to netlist; **delete file unconditionally if empty (locked)** (J-165). DONE: file deleted; live builder inlined in flipflops/jk.ts.
- [x] `src/solver/analog/behavioral-flipflop/rs-async.ts` -- **spec:** phase-composite-architecture ssM17 -- Delete `BehavioralRSAsyncLatchElement`; convert to netlist; **delete file unconditionally if empty (locked)** (J-166). DONE: file deleted; live builder inlined in flipflops/rs-async.ts.
- [x] `src/solver/analog/behavioral-flipflop/rs.ts` -- **spec:** phase-composite-architecture ssM16 -- Delete `BehavioralRSFlipflopElement`; convert to netlist; **delete file unconditionally if empty (locked)** (J-167). DONE: file deleted; live builder inlined in flipflops/rs.ts.
- [x] `src/solver/analog/behavioral-flipflop/t.ts` -- **spec:** phase-composite-architecture ssM15 -- Delete `BehavioralTFlipflopElement`; convert to netlist; **delete file unconditionally if empty (locked)** (J-169). DONE: file deleted; live builder inlined in flipflops/t.ts.
- [x] `src/solver/analog/behavioral-flipflop/shared.ts` -- **spec:** phase-composite-architecture ssM20 -- DELETE the file; helpers moved to per-driver leaves (J-168). DONE: file deleted.

> Same-blast-radius cleanup also performed: deleted orphan `src/solver/analog/behavioral-flipflop/index.ts` (barrel re-export of deleted leaves) and `src/solver/analog/behavioral-flipflop-variants.ts` (re-export of the barrel; zero importers verified). The empty `behavioral-flipflop/` directory was removed. tsc error count dropped 623 -> 617 (the 6 broken parent-composite imports), no new errors introduced.
- [ ] `src/solver/analog/bridge-adapter.ts` -- **spec:** phase-composite-architecture ssM21 -- Delete `BridgeOutputAdapter` / `BridgeInputAdapter` classes; keep factories with same signatures wrapping new driver leaves (J-174).

## 3. Tests

### 3a. Test fixtures / helpers (other tests depend on these)

- [ ] `src/test-utils/falstad-fixture-reference.ts` -- **spec:** phase-component-model-correctness-job ssB8 -- Pin-key rename for resistor/inductor/crystal/memristor entries (J-184).
- [ ] `src/test-utils/mock-coordinator.ts` -- **spec:** phase-component-model-correctness-job ssC7 -- Add no-op `setLimitingCapture`/`getLimitingEvents` on `MockCoordinator` (J-185).
- [ ] `src/solver/analog/__tests__/test-helpers.ts` -- **spec:** phase-test-contract-updates Test 1.45 -- UC-2 sweep at lines 151, 189 (J-131).
- [ ] `src/solver/analog/__tests__/fixtures/analog-fixtures.ts` -- **spec:** phase-component-model-correctness-job ssB11 -- Pin-key rename for resistor/inductor factories at lines 166, 181 (J-122).

### 3b. UC-7 retentions (NO-CHANGE acknowledgements - claim parity)

- [ ] `src/components/passives/__tests__/capacitor.test.ts` -- **spec:** phase-test-contract-updates UC-7 -- NO-CHANGE retention of pre-setup `_stateBase===-1` read at line 306 (J-047).
- [ ] `src/components/passives/__tests__/crystal.test.ts` -- **spec:** phase-test-contract-updates UC-7 -- NO-CHANGE retention at line 452 (J-048).
- [ ] `src/components/passives/__tests__/inductor.test.ts` -- **spec:** phase-test-contract-updates UC-7 -- NO-CHANGE retention at line 301 (J-049).
- [ ] `src/components/passives/__tests__/polarized-cap.test.ts` -- **spec:** phase-test-contract-updates UC-7 -- NO-CHANGE retention at line 478 (J-051).
- [ ] `src/solver/analog/__tests__/compile-analog-partition.test.ts` -- **spec:** phase-test-contract-updates UC-7 -- NO-CHANGE retentions at lines 528, 549, 555 (J-116).

### 3c. Engine / solver unit tests

- [ ] `src/compile/__tests__/compile-bridge-guard.test.ts` -- **spec:** phase-test-contract-updates Test 1.2 -- UC-1 M2 migration at line 134 (J-007). **DECISION (locked):** user deleted this file in frustration; it was full of engine-digging and the protected invariant was unclear. KEEP on list, but when reached, agent must produce a strong written justification that the test is doing something useful that no other test covers; if not, delete the job and move on.
- [ ] `src/solver/analog/__tests__/sparse-solver.test.ts` -- **spec:** phase-test-contract-updates Test 1.44 -- UC-1 M1 migration at line 579 (J-130).
- [ ] `src/solver/analog/__tests__/ckt-load.test.ts` -- **spec:** phase-component-model-correctness-job ssB15 -- Pin-key rename at line 41 (J-115).
- [ ] `src/solver/analog/__tests__/compiler.test.ts` -- **spec:** phase-component-model-correctness-job ssB16 -- Pin-key rename at lines 98, 128 (J-117).
- [ ] `src/solver/analog/__tests__/ac-analysis.test.ts` -- **spec:** phase-component-model-correctness-job ssB13 -- Pin-key rename at lines 50, 80, 109 (J-106).
- [ ] `src/solver/analog/__tests__/ckt-context.test.ts` -- **spec:** phase-component-model-correctness-job ssB14 + phase-1-engine-infrastructure File 7 -- Pin-key rename at line 26; replace `allocates_all_buffers_at_init` with `allocates_all_buffers_after_setup` (J-114).
- [ ] `src/solver/analog/__tests__/competing-voltage-constraints.test.ts` -- **spec:** phase-1-engine-infrastructure File 8 -- Migrate from `compileUnified+result.analog.diagnostics` to `facade.compile()+coordinator.dcOperatingPoint()+coordinator.getRuntimeDiagnostics()` (J-118).
- [ ] `src/solver/analog/__tests__/setup-stamp-order.test.ts` -- **spec:** phase-test-contract-updates Test 1.43 + phase-component-model-correctness-job ssA6 + phase-composite-architecture ssE1 -- 56-site UC-1 sweep; switch to L1 BJT factory; re-record 20-entry TSTALLOC golden; update goldens for shifted fixtures (J-129).
- [ ] `src/solver/analog/__tests__/dc-operating-point.test.ts` -- **spec:** phase-test-contract-updates Test 1.36 + phase-component-model-correctness-job ssB17 -- Delete `makeDiode` helper; migrate 5 tests to M1 with `params.noOpIter`; pin-key rename at line 60 (J-120).
- [ ] `src/solver/analog/__tests__/analog-engine.test.ts` -- **spec:** phase-test-contract-updates Test 1.27 + Test 1.27b + phase-component-model-correctness-job ssB12 -- UC-1 sweep + accessor-test rename + delete `accessors return null/empty before init` test + pin-key rename at line 43 (J-107).
- [ ] `src/solver/analog/__tests__/convergence-regression.test.ts` -- **spec:** phase-test-contract-updates Test 1.35 + phase-component-model-correctness-job ssB18 -- Migrate HWR tests to M1/M3; delete `makeHalfWaveRectifier`/`makeRCCircuit`; pin-key rename at line 26 (J-119).
- [ ] `src/solver/analog/__tests__/bridge-adapter.test.ts` -- **spec:** phase-test-contract-updates Test 1.32 -- UC-2 sweep at lines 175, 239, 271 (J-112).
- [ ] `src/solver/analog/__tests__/bridge-compilation.test.ts` -- **spec:** phase-test-contract-updates Test 1.33 -- UC-2 sweep at line 362 (J-113).
- [ ] `src/solver/analog/__tests__/dcop-init-jct.test.ts` -- **spec:** phase-component-model-correctness-job ssA7 -- BJT factory rename at lines 16, 17, 134, 172, 189 (J-121).
- [ ] `src/solver/analog/__tests__/mna-end-to-end.test.ts` -- **spec:** phase-test-contract-updates Test 1.41 -- UC-1 sweep at 15 sites (J-127).
- [ ] `src/solver/analog/__tests__/rc-ac-transient.test.ts` -- **spec:** phase-test-contract-updates Test 1.42 -- UC-1 sweep at 7 sites (J-128).
- [ ] `src/solver/analog/__tests__/behavioral-combinational.test.ts` -- **spec:** phase-test-contract-updates Test 1.28 -- UC-1, UC-5 contract-update; programmatic combinational topology + voltage-sag assertions (J-108).
- [ ] `src/solver/analog/__tests__/behavioral-gate.test.ts` -- **spec:** phase-test-contract-updates Test 1.29 -- UC-2 sweep + Entry 1 pin-loading migration (J-109).
- [ ] `src/solver/analog/__tests__/behavioral-integration.test.ts` -- **spec:** phase-test-contract-updates Test 1.30 -- UC-1 M1 migration of `beforeEach` at line 315 (J-110).
- [ ] `src/solver/analog/__tests__/behavioral-sequential.test.ts` -- **spec:** phase-test-contract-updates Test 1.31 -- Counter/Register Entry 1 migration; UC-1 + UC-5; bit-pattern reconstruction (J-111).

### 3d. Harness-integration tests

- [ ] `src/solver/analog/__tests__/harness/boot-step.test.ts` -- **spec:** phase-test-contract-updates Test 1.37 -- UC-1 M1 migration at line 35 (J-123).
- [ ] `src/solver/analog/__tests__/harness/harness-integration.test.ts` -- **spec:** phase-test-contract-updates Test 1.38 + Test 1.38b -- M3 migration; rename accessor test; delete `MNAEngine accessors return null/empty before init` (J-124).
- [ ] `src/solver/analog/__tests__/harness/lte-retry-grouping.test.ts` -- **spec:** phase-test-contract-updates Test 1.39 -- UC-1 M1 migration at 8 sites (J-125).
- [ ] `src/solver/analog/__tests__/harness/nr-retry-grouping.test.ts` -- **spec:** phase-test-contract-updates Test 1.40 -- UC-1 M1 migration at 7 sites (J-126).

### 3e. Component tests (alphabetical by component family)

- [ ] `src/components/active/__tests__/analog-switch.test.ts` -- **spec:** phase-test-contract-updates Test 1.3 -- UC-1, UC-2 mutations at lines 253, 277 (J-008).
- [ ] `src/components/active/__tests__/cccs.test.ts` -- **spec:** phase-test-contract-updates Test 1.4 -- UC-1 mutations at lines 241, 252, 263, 289 (J-009).
- [ ] `src/components/active/__tests__/ccvs.test.ts` -- **spec:** phase-test-contract-updates Test 1.5 -- UC-1 mutations at lines 236, 255, 266, 292 (J-010).
- [ ] `src/components/active/__tests__/comparator-rollback.test.ts` -- **spec:** phase-component-model-correctness-job ssG8 -- NEW FILE; LTE-rejection rollback test for `OUTPUT_WEIGHT` (J-011).
- [ ] `src/components/active/__tests__/dac.test.ts` -- **spec:** phase-test-contract-updates Test 1.6 -- UC-1 at line 143 (J-012).
- [ ] `src/components/active/__tests__/optocoupler.test.ts` -- **spec:** phase-composite-architecture ssM4 -- Update lines 85-87 to assert `participatesInLoad: false` on wrapper (J-013).
- [ ] `src/components/active/__tests__/real-opamp-raillim.test.ts` -- **spec:** phase-component-model-correctness-job ssC2 -- NEW FILE; railLim LimitingEvent capture test (J-014).
- [ ] `src/components/active/__tests__/timer-555-debug.test.ts` -- **spec:** phase-test-contract-updates Test 1.7 -- UC-1 at line 165; UC-3 at lines 180, 201 (J-015).
- [ ] `src/components/active/__tests__/vccs.test.ts` -- **spec:** phase-test-contract-updates Test 1.8 -- UC-1 mutations at lines 131, 148, 165, 181 (J-016).
- [ ] `src/components/active/__tests__/vcvs.test.ts` -- **spec:** phase-test-contract-updates Test 1.9 -- UC-1 mutations at lines 125, 140, 156, 174, 189 (J-017).
- [ ] `src/components/io/__tests__/led.test.ts` -- **spec:** phase-test-contract-updates Test 1.10 + 1.10b + 1.10c -- M1 migration of 4 forward-drop tests + Entry 5 junction-cap + 7.a/7.d; delete tests for MODEINITJCT and null-collector branches (J-045).
- [ ] `src/components/passives/__tests__/analog-fuse-rollback.test.ts` -- **spec:** phase-component-model-correctness-job ssG2 -- NEW FILE; LTE-rejection rollback for `I2T_ACCUM`/`CONDUCT` (J-046).
- [ ] `src/components/passives/__tests__/memristor-rollback.test.ts` -- **spec:** phase-component-model-correctness-job ssB4 -- NEW FILE; LTE rollback test for `W` (J-050).
- [ ] `src/components/passives/__tests__/potentiometer.test.ts` -- **spec:** phase-test-contract-updates Test 1.11 -- Entry 11 W<->B index swap fix; M1 migration; resload citation (J-052).
- [ ] `src/components/passives/__tests__/resistor.test.ts` -- **spec:** phase-test-contract-updates Test 1.12 -- Entry 4 contract-update; M1 migration; bit-exact stamp assertions; resload.c:34-37 citation (J-053).
- [ ] `src/components/passives/__tests__/tapped-transformer.test.ts` -- **spec:** phase-test-contract-updates (TBD §) -- Rewrite against new `buildTappedTransformerNetlist` decomposed architecture (Inductor x3 + TransformerCoupling x3); current tests instantiate the deleted `AnalogTappedTransformerElement` constructor with positional MNA args (7 occurrences). Use harness comparison per CLAUDE.md hard rule. Surfaced during J-063 Template B authoring; not previously tracked. (J-NEW-tt1)
- [ ] `src/components/passives/__tests__/tx_trace.test.ts` -- **spec:** phase-test-contract-updates (TBD §) -- Same rewrite as tapped-transformer.test.ts; tracing/diagnostic test against the deleted class (3 occurrences). Either rewrite via harness or delete if it duplicates main suite coverage. Surfaced during J-063. (J-NEW-tt2)
- [ ] `src/components/passives/__tests__/transformer.test.ts` -- **spec:** phase-test-contract-updates Test 1.13 + phase-1-engine-infrastructure File 6 + UC-7 -- UC-2 at line 176; unskip `analogFactory creates element with correct branch indices` test; line 663 retained (J-054).
- [ ] `src/components/passives/__tests__/transmission-line.test.ts` -- **spec:** phase-test-contract-updates Test 1.14 -- UC-1 + UC-2 mutations across 6 engine sites and 3 `_stateBase` writes (J-055).
- [ ] `src/components/semiconductors/__tests__/bjt.test.ts` -- **spec:** phase-component-model-correctness-job ssA5 -- BJT factory rename at 24 sites (J-071).
- [ ] `src/components/semiconductors/__tests__/diode.test.ts` -- **spec:** phase-test-contract-updates Test 1.15 -- UC-2 sweep at 18 lines (J-072).
- [ ] `src/components/semiconductors/__tests__/jfet.test.ts` -- **spec:** phase-test-contract-updates Test 1.16 -- Entry 9 saturation-circuit migration + UC-2 sweep; jfetload.c citations (J-073).
- [ ] `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts` -- **spec:** phase-component-model-correctness-job ssA8 -- L1 conversion at lines 11, 313 (J-074).
- [ ] `src/components/semiconductors/__tests__/schottky.test.ts` -- **spec:** phase-test-contract-updates Test 1.17 -- UC-1 + UC-2 at lines 71, 285, 314 (J-075).
- [ ] `src/components/semiconductors/__tests__/varactor.test.ts` -- **spec:** phase-test-contract-updates Test 1.18 -- UC-1 M1 at line 121 (J-076).
- [ ] `src/components/semiconductors/__tests__/zener.test.ts` -- **spec:** phase-test-contract-updates Test 1.19 -- UC-2 at line 59 (J-077).
- [ ] `src/components/sensors/__tests__/ntc-thermistor-rollback.test.ts` -- **spec:** phase-component-model-correctness-job ssG6 -- NEW FILE; LTE rollback test for `TEMPERATURE` (J-083).
- [ ] `src/components/sensors/__tests__/spark-gap-rollback.test.ts` -- **spec:** phase-component-model-correctness-job ssG4 -- NEW FILE; LTE rollback test for `CONDUCTING` (J-084).
- [ ] `src/components/sources/__tests__/ac-voltage-source.test.ts` -- **spec:** phase-test-contract-updates Test 1.20 -- UC-1 M1 at line 337 (J-087).
- [ ] `src/components/sources/__tests__/current-source-kcl.test.ts` -- **spec:** phase-test-contract-updates Test 1.21 -- UC-1 M1 at lines 73, 109 (J-088).
- [ ] `src/components/switching/__tests__/fuse.test.ts` -- **spec:** phase-test-contract-updates Test 1.22 -- UC-1 M1 at 6 sites (J-089).
- [ ] `src/components/switching/__tests__/trans-gate.test.ts` -- **spec:** phase-test-contract-updates Test 1.23 -- UC-1 + UC-3 migration with state inspection (J-090).
- [ ] `src/core/__tests__/resolve-simulation-params.test.ts` -- **spec:** phase-test-contract-updates Test 1.25 -- UC-1 M2 at lines 115, 130, 137 (J-099).
- [ ] `src/editor/__tests__/wire-current-resolver.test.ts` -- **spec:** phase-test-contract-updates Test 1.26 + phase-component-model-correctness-job ssB10 -- UC-1 M2 at 7 sites; pin-key rename at lines 33, 111 (J-102).

### 3f. E2E tests

- [ ] `e2e/gui/analog-bjt-convergence.spec.ts` -- **spec:** phase-test-contract-updates Test 1.1 -- Insert missing `placeLabeled('Diode', 43, 12, 'TD', 90)` after line 153 (J-002).
- [ ] `e2e/gui/component-sweep.spec.ts` -- **spec:** phase-1-engine-infrastructure ssE -- Wire VDD/GND/inputs in CMOS-mode sweep block (lines 766-789) using property label `'voltage'` (J-003).

## Unclassified (needs user triage)

*(none - every job in the contracts maps cleanly to one of the four phase docs)*

## Stats

- Total files: 183 (185 J-IDs in source contracts; J-001 and J-005 struck per user decision)
- Engine: 21
- Components: 89
- Tests: 73 (10 are new-file/rollback test entries within 3e)
- Unclassified: 0
- **Completed (J-070 List A followup, all waves):**
  - **Wave 1 (Template B siblings-only):** J-095 (relay-coupling), J-063 (transformer-coupling).
  - **Wave 2 (Template C MNA-stamp):** J-068, J-067, J-066, J-065, J-069 (transmission segments R/L/G/C/RL); J-091, J-093 (fgnfet/fgpfet blown drivers); J-024, J-025 (internal-cccs, internal-zero-volt-sense).
  - **Wave 3 (Template D + A-multi-bit):** J-020 (comparator-driver), J-022 (dac-driver), J-018 (adc-driver, reclassified to A-multi-bit), J-028 (schmitt-trigger-driver).
  - **Wave 4 (Template A-variable-pin gates):** J-153, J-150, J-151, J-161, J-160 (or/nand/nor/xor/xnor drivers); J-149 (mux-driver); J-042, J-039, J-040, J-044, J-043 (gate parent migrations); mux.ts parent migration (no J-ID).
  - **Wave 5 (Template A-fixed standalone):** J-152 (not-driver), J-137 (buf-driver), J-138 (button-led-driver), J-157 (seven-seg-driver, divergent), J-158 (splitter-driver), J-030 (timer-555-latch-driver, hybrid w/ stamp); J-041 (not.ts parent), J-038 (buf.ts NEW parent); button-led.ts, seven-seg.ts, splitter.ts parent migrations (no J-ID).
  - **Wave 6 (A multi-bit bus-pin):** J-140 (counter-preset-driver), J-154 (register-driver); counter-preset.ts, register.ts parent migrations (no J-ID).
  - **Template E deletions (mechanical):** J-162 through J-169 (8 flipflop class deletions + 2 same-blast-radius orphan files; behavioral-flipflop/ directory removed).
  - **Precursor canonicals:** J-134 (and-driver, A-variable-pin canonical), J-139 (counter-driver, A-multi-bit-schema canonical), J-142 (d-flipflop-driver, A-fixed canonical, cleaned), J-037 (and.ts parent, gate parent migration canonical); counter.ts parent (no J-ID); 6 flipflop parent-composite migrations (d.ts, d-async.ts, jk.ts, jk-async.ts, rs.ts, rs-async.ts, t.ts); J-171 (behavioral-output-driver, found already-canonical, dropped from spawn scope); compiler.ts:410 siblingState resolver fix; edge-detect.ts (NEW shared helper module).
  - **Manual exports (lifted from agent scope):** RelayInductorDefinition + RelayResistorDefinition (handled directly).
- **List A blocked items — all CLEARED via direct-authoring bundles (this session):**
  - **Bundle 1** (commit `61e96a2e`): J-145 + J-146 — tri-state via (b1) OUTPUT_LOGIC_LEVEL_ENABLE slot + sibling `enableLogic` siblingState ref; `BehavioralOutputDriver` Thévenin → Norton refactor as the enabling architectural change; `DigitalOutputPinLoaded` simplified (Resistor child + driveNode internal net removed; driver now owns the conductance). Adjacent broken-import cleanup in `seven-seg-hex.ts` + `bus-splitter.ts` (their behavioural entries dropped pending future scoped J-jobs since neither fits the existing builders' shape).
  - **Bundle 2** (this commit): J-143 + J-144 — `buildDecoderNetlist` + `buildDemuxNetlist` authored directly in `behavioral-combinational.ts` (replacing the 11-line stub); driver leaves added with memoised arity-indexed schema; `decoder.ts` + `demux.ts` migrated to `kind: "netlist"`. Whole-vector hold-on-indeterminate semantic; demux analog model 1-bit (matches mux limitation).
  - **Bundle 3** (this commit): `RelayInductorDefinition` + `RelayResistorDefinition` exports landed. `relay-inductor.ts` collapsed to thin adapter over `AnalogInductorElement` (inherited setup/findBranchFor preserve indsetup.c parity; constructor maps relay-local `L` → base's `inductance`); `relay-resistor.ts` constructor normalised to `(pinNodes, props)` reading `R`. `register-all.ts:224-225` TS2305 errors resolved; total project errors at 293 baseline (no regressions, zero `as unknown as` introduced).

> **Locked decisions (recorded 2026-05-01):**
>
> - **J-001** (`comparison-session.ts` UC-7 retention) - **STRUCK** from list. Non-source acknowledgement, no work to do.
> - **J-005** (`spec/setup-load-split/00-engine.md` UC-7 retention) - **STRUCK** from list. Documentation fence, no work to do.
> - **J-007** (`compile-bridge-guard.test.ts`) - **KEPT** on list with strong-justification gate. User deleted this file in frustration; agent must justify the test's value when the job is reached, otherwise drop it.
> - **J-038** (`buf.ts`) - **MAKE THE FILE.** BUF is user-facing; no further user input needed.
> - **J-163/J-164/J-165/J-166/J-167/J-169** (flip-flop class-removal files) - **DELETE THE FILE UNCONDITIONALLY IF EMPTY** after class removal. No further user input needed.
>
> **Notes on the contracts as input:**
>
> 1. The contract document declares 185 jobs (`J-001..J-185`); after the two strikes above, 183 remain. Every retained job has a unique absolute file path; no duplicates across J-IDs.
> 2. Stat counts above are by tier; sub-bucket counts are approximate because entries overlap two phases (e.g. a Component-G + Composite-M file is listed once but contributes work from both).
