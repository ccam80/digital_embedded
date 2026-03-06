# Engine Remaining Work — Implementation Spec

## Overview

Fixes and integrations required to make the simulation engine produce correct results for all existing components. Covers: EvaluationGroup deduplication, state slot allocation, wiring table indirection, two-phase sequential evaluation, bus resolution integration, noise mode / init sequence integration, oscillation detection, clock management, switch network integration, and Web Worker completion.

All decisions below are final and replace any conflicting statements in earlier documents.

---

## Pre-requisite: ExecuteFunction Signature Update

Before any wave begins, update `ExecuteFunction` to include `highZs`:

- **Current**: `(index: number, state: Uint32Array, layout: ComponentLayout) => void`
- **New**: `(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout) => void`

**Files to modify**:
  - `src/core/registry.ts` — Update `ExecuteFunction` type alias to add `highZs: Uint32Array` as the third parameter (before `layout`). Update the JSDoc to document it: "High-impedance flags array, parallel to `state`. Components that support tri-state output set `highZs[netId] = 1` when the output is high-Z, `0` otherwise."
  - `src/engine/digital-engine.ts` — All internal calls to executeFns and sampleFns pass `this._highZs` as the third argument: `fn(index, this._values, this._highZs, layout)`.
  - `src/engine/init-sequence.ts` — Update `evaluateAll()` and `releaseResetComponents()` to pass `highZs` to executeFn calls.
  - `src/engine/noise-mode.ts` — Update `evaluateWithNoise()` and `evaluateSynchronized()` to pass `highZs`.
  - All existing executeFns — Add `highZs: Uint32Array` parameter. Combinational components (gates, muxes, etc.) ignore it. Switch/FET components use it to set highZ on open outputs.

**Rationale**: Bus resolution (Task 3.1) requires `highZs` for `busResolver.onNetChanged(netId, state, highZs)`, and switch components (Task 4.2) need to set highZ when open. Without this parameter, both tasks are blocked.

**Acceptance criteria**:
  - `ExecuteFunction` signature includes `highZs: Uint32Array`
  - All engine call sites pass `_highZs`
  - All existing executeFns accept the new parameter (even if they ignore it)
  - Existing tests pass (behavioral no-op for non-tri-state components)

---

## Wave 1: Structural Correctness

Fixes foundational wiring and layout bugs that make the engine produce wrong results. All subsequent waves depend on Wave 1.

### Task 1.0: Deduplicate EvaluationGroup Interface

- **Description**: `EvaluationGroup` is defined identically in both `src/engine/digital-engine.ts` (line 46) and `src/engine/init-sequence.ts` (line 30). This duplication causes type conflicts when later tasks add fields. Fix: delete the definition from `init-sequence.ts`, import from `digital-engine.ts` instead.
- **Files to modify**:
  - `src/engine/init-sequence.ts` — Delete the `EvaluationGroup` interface (lines 22–35). Add import: `import type { EvaluationGroup } from "./digital-engine.js";`. Update `InitializableEngine.evaluationOrder` to use the imported type (already structurally compatible — no logic changes).
- **Tests**:
  - Existing tests pass (no behavioral change — types are structurally identical).
- **Acceptance criteria**:
  - `EvaluationGroup` is defined in exactly one place: `src/engine/digital-engine.ts`
  - `init-sequence.ts` imports it from `digital-engine.ts`
  - All existing tests pass

### Task 1.1: State Slot Allocation

- **Description**: `FlatComponentLayout.stateOffset()` returns 0 unconditionally. Every flip-flop writes its internal state (stored Q, prevClock) to `state[0]` and `state[1]`, corrupting real nets and sharing state across all sequential components. The compiler never allocates state slots. Fix: add `stateSlotCount` to `ComponentDefinition`, compiler allocates state slots after all net IDs, `FlatComponentLayout` returns correct per-component state offsets.
- **Files to modify**:
  - `src/core/registry.ts` — Add `stateSlotCount?: number | ((props: PropertyBag) => number)` (default 0) to `ComponentDefinition`. Static number for most components; function for components whose state size depends on properties (RAM, register-file, EEPROM).
  - `src/engine/compiler.ts` — After net ID assignment (step 6), accumulate state slots: for each component, resolve `stateSlotCount` (call function with instance props if it's a function, otherwise use the number directly). `stateOffset[i] = netCount + sum(resolvedSlotCount for components 0..i-1)`. Total signal array size becomes `netCount + totalStateSlots`. Pass `stateOffsets: Int32Array` to `FlatComponentLayout`.
  - `src/engine/compiled-circuit.ts` — `FlatComponentLayout` constructor accepts `stateOffsets: Int32Array`. `stateOffset(i)` returns `_stateOffsets[i]`. `CompiledCircuitImpl` gains `totalStateSlots: number` field. `CompiledCircuitImpl.netCount` remains the count of actual nets (not including state slots). Add `signalArraySize: number` = `netCount + totalStateSlots` for engine allocation.
  - `src/engine/digital-engine.ts` — `init()` allocates `_values` and `_highZs` sized to `compiled.signalArraySize` (not `compiled.netCount`). `_initSignalsUndefined()` fills the net portion with UNDEFINED, state portion with 0.
  - **Flip-flops** (all edge-triggered and async variants use 2 state slots: storedQ + prevClock):
    - `src/components/flipflops/d.ts` — Set `stateSlotCount: 2` (storedQ + prevClock)
    - `src/components/flipflops/d-async.ts` — Set `stateSlotCount: 2` (storedQ + prevClock)
    - `src/components/flipflops/jk.ts` — Set `stateSlotCount: 2` (storedQ + prevClock)
    - `src/components/flipflops/jk-async.ts` — Set `stateSlotCount: 2` (storedQ + prevClock)
    - `src/components/flipflops/rs.ts` — Set `stateSlotCount: 2` (storedQ + prevClock)
    - `src/components/flipflops/rs-async.ts` — Set `stateSlotCount: 2` (storedQ + storedQn)
    - `src/components/flipflops/t.ts` — Set `stateSlotCount: 2` (storedQ + prevClock)
    - `src/components/flipflops/monoflop.ts` — Set `stateSlotCount: 3` (storedQ + prevClock + counter)
  - **Memory — static state slots**:
    - `src/components/memory/counter.ts` — Set `stateSlotCount: 2` (counter + prevClock)
    - `src/components/memory/counter-preset.ts` — Set `stateSlotCount: 2` (counter + prevClock)
    - `src/components/memory/program-counter.ts` — Set `stateSlotCount: 2` (counter + prevClock)
    - `src/components/memory/register.ts` — Set `stateSlotCount: 2` (storedVal + prevClock)
    - `src/components/memory/program-memory.ts` — Set `stateSlotCount: 2` (addrReg + prevClock)
  - **Memory — dynamic state slots** (use function form):
    - `src/components/memory/register-file.ts` — Set `stateSlotCount: (props) => 1 + (1 << (props.get("addrBits") ?? 2))` (prevClock + 2^addrBits registers)
    - `src/components/memory/eeprom.ts` — Set `stateSlotCount: 2` for WE-edge variant (lastWE + writeAddr); `stateSlotCount: 1` for clock-edge variant (lastClk). Use the appropriate value per definition export.
    - `src/components/memory/ram.ts` — Set `stateSlotCount` per variant: basic sync RAM = `(props) => 1 + (1 << (props.get("addrBits") ?? 4))` (lastClk + memory words); registered-output variant adds 1 for outputVal.
  - **Memory — combinational (no state)**:
    - `src/components/memory/rom.ts` — `stateSlotCount: 0` (combinational lookup)
    - `src/components/memory/lookup-table.ts` — `stateSlotCount: 0` (combinational)
  - **Switching**:
    - `src/components/switching/nfet.ts` — Set `stateSlotCount: 1` (closedFlag)
    - `src/components/switching/pfet.ts` — Set `stateSlotCount: 1` (closedFlag)
    - `src/components/switching/fgnfet.ts` — Set `stateSlotCount: 2` (closedFlag + blownFlag)
    - `src/components/switching/fgpfet.ts` — Set `stateSlotCount: 2` (closedFlag + blownFlag)
    - `src/components/switching/trans-gate.ts` — Set `stateSlotCount: 1` (closedFlag)
    - `src/components/switching/relay.ts` — Set `stateSlotCount: 1` (closedFlag)
    - `src/components/switching/relay-dt.ts` — Set `stateSlotCount: 1` (energisedFlag)
  - **Other**:
    - `src/components/arithmetic/prng.ts` — Set `stateSlotCount: 2` (lfsrState + prevClock)
- **Tests**:
  - `src/engine/__tests__/state-slots.test.ts::StateSlotAllocation::allocates_state_after_nets` — Compile a circuit with 2 AND gates (0 state slots each) and 1 D flip-flop (2 state slots). Assert `compiled.signalArraySize === netCount + 2`. Assert `layout.stateOffset(dffIndex) === netCount`.
  - `src/engine/__tests__/state-slots.test.ts::StateSlotAllocation::multiple_sequential_components_get_distinct_offsets` — Compile a circuit with 2 D flip-flops. Assert their `stateOffset` values differ by 2 (each needs 2 slots). Assert neither overlaps with any net ID.
  - `src/engine/__tests__/state-slots.test.ts::StateSlotAllocation::state_slots_do_not_corrupt_nets` — Compile a circuit with a D flip-flop. Set net 0 and net 1 to known values. Step the engine. Assert net 0 and net 1 retain their values (not overwritten by flip-flop state).
  - `src/engine/__tests__/state-slots.test.ts::StateSlotAllocation::components_with_zero_stateSlotCount_get_stateOffset_zero_or_netCount` — Verify that combinational components (stateSlotCount=0 or undefined) have a stateOffset that does not interfere, and that calling `state[stateOffset]` on them is harmless.
  - `src/engine/__tests__/state-slots.test.ts::StateSlotAllocation::dynamic_stateSlotCount_resolved_per_instance` — Register a component with `stateSlotCount: (props) => props.get("size") ?? 4`. Create two instances with size=4 and size=8. Compile. Assert their state slot allocations differ by 4 (first instance) and 8 (second instance).
- **Acceptance criteria**:
  - `FlatComponentLayout.stateOffset(i)` returns a unique, non-overlapping position for each component with `stateSlotCount > 0`
  - No state slot overlaps with any net ID
  - Signal array is sized to `netCount + totalStateSlots`
  - All flip-flop/counter/register/switch components declare their `stateSlotCount`
  - Dynamic `stateSlotCount` functions are resolved per-instance during compilation
  - Existing tests pass (no regressions)

### Task 1.2: Wiring Table Indirection

- **Description**: The compiler builds a `wiringTable: Int32Array` mapping wiring-table offsets to net IDs but then discards it — `FlatComponentLayout.inputOffset(i)` returns the raw first input net ID. ExecuteFns do `state[inputOffset(i) + k]` which only works if a component's input nets are contiguous. Fix: store wiringTable on `CompiledCircuitImpl`, change `inputOffset`/`outputOffset` to return wiring-table indices, executeFns read `state[wiringTable[offset + k]]`. State slots remain direct: `state[stateOffset(i) + k]`.
- **Scope**: This is a large mechanical transformation affecting ~260 occurrences of `state[inBase + k]` / `state[outBase + k]` across ~48 source files, plus ~17 occurrences of `state[layout.inputOffset(index)]` across ~13 files, plus their tests. The transformation is uniform and can be applied mechanically. **Split into sub-tasks by component category for manageability.**
- **Mechanical transformation pattern for all executeFns**:
  1. Add `const wt = layout.wiringTable;` as the first line of the function body.
  2. Replace `state[inBase + k]` with `state[wt[inBase + k]]` for all input reads.
  3. Replace `state[outBase + k]` with `state[wt[outBase + k]]` for all output writes.
  4. Replace `state[layout.inputOffset(index)]` with `state[wt[layout.inputOffset(index)]]`.
  5. Replace `state[layout.outputOffset(index)]` with `state[wt[layout.outputOffset(index)]]`.
  6. State slot access remains unchanged: `state[stBase + k]` (direct, no indirection).
- **File selection criterion**: Apply to every `.ts` file under `src/components/` that exports a function matching `execute*` (the executeFn convention). Also apply to every file under `src/engine/` that calls an executeFn or reads from `state[inputOffset/outputOffset]`.

#### Sub-task 1.2a: Core Engine and Infrastructure

- **Files to modify**:
  - `src/engine/compiled-circuit.ts` — `CompiledCircuitImpl` gains `readonly wiringTable: Int32Array`. `FlatComponentLayout` constructor accepts the wiring table. Add `readonly wiringTable: Int32Array` to `FlatComponentLayout`. `inputOffset(i)` returns the wiring-table index (not the net ID). `outputOffset(i)` returns the wiring-table index.
  - `src/engine/compiler.ts` — Pass the already-built `wiringTable` to `CompiledCircuitImpl` and `FlatComponentLayout`. Change `buildNetIdOffsets()` to return wiring-table offsets (already computed as `inputOffsets` and `outputOffsets` in the compiler — these are the correct values).
  - `src/core/registry.ts` — `ComponentLayout` interface gains `readonly wiringTable: Int32Array`. Update `ExecuteFunction` doc comment to specify the access pattern: `state[layout.wiringTable[layout.inputOffset(i) + k]]` for inputs, `state[layout.wiringTable[layout.outputOffset(i) + k]]` for outputs, `state[layout.stateOffset(i) + k]` for state (direct, no indirection).
  - `src/engine/digital-engine.ts` — `ConcreteCompiledCircuit` gains `readonly wiringTable: Int32Array`. `_collectOutputNets` reads through wiringTable: `wiringTable[outOffset + o]` instead of `outOffset + o`. `_stepTimed()` reads outputs through wiringTable: `state[wt[outOffset + o]]` instead of `state[outOffset + o]`, and uses `wt[outOffset + o]` as the netId for timed events.
  - `src/engine/init-sequence.ts` — `captureOutputs` and `outputsChanged` read output nets through wiringTable: `state[wt[outOffset + j]]` instead of `state[outOffset + j]`. Requires `layout.wiringTable` access (already available via `InitializableEngine.layout`).
  - `src/engine/noise-mode.ts` — `evaluateWithNoise` and `evaluateSynchronized` pass layout (which now includes wiringTable) to executeFns. No signature change needed.
  - `src/engine/run-to-break.ts` — `run()` reads break input through wiringTable: `state[layout.wiringTable[layout.inputOffset(componentIndex)]]`.
  - `src/engine/clock.ts` — `ClockManager._findClocksInternal()` reads clock output net ID through wiringTable: `const netId = layout.wiringTable[layout.outputOffset(componentIndex)]` instead of `layout.outputOffset(componentIndex)`. `advanceClocks()` writes to `state[clock.netId]` (unchanged — netId is now the resolved net ID).
  - `src/engine/micro-step.ts` — Signal snapshot diffing remains on raw `state[]` (comparing all net values), no change needed.

#### Sub-task 1.2b: Gate Components

- **Files**: `src/components/gates/and.ts`, `nand.ts`, `nor.ts`, `not.ts`, `or.ts`, `xnor.ts`, `xor.ts` (7 files)
- Apply mechanical transformation pattern to all executeFns.

#### Sub-task 1.2c: IO Components

- **Files**: All `.ts` files in `src/components/io/` that export `execute*` functions (button.ts, button-led.ts, dip-switch.ts, in.ts, led.ts, midi.ts, out.ts, power-supply.ts, probe.ts, rotary-encoder-motor.ts, scope.ts, seven-seg.ts, seven-seg-hex.ts, sixteen-seg.ts, etc.)
- Apply mechanical transformation pattern to all executeFns.

#### Sub-task 1.2d: Flip-flop Components

- **Files**: `src/components/flipflops/d.ts`, `d-async.ts`, `jk.ts`, `jk-async.ts`, `rs.ts`, `rs-async.ts`, `t.ts`, `monoflop.ts` (8 files)
- Apply pattern for input/output access. State access remains `state[stBase + k]` (direct).

#### Sub-task 1.2e: Arithmetic Components

- **Files**: All `.ts` files in `src/components/arithmetic/` that export `execute*` functions (barrel-shifter.ts, comparator.ts, div.ts, neg.ts, prng.ts, etc.)
- Apply mechanical transformation pattern.

#### Sub-task 1.2f: Wiring, Switching, Memory, PLD, Graphics, Terminal, Misc, Subcircuit

- **Files**:
  - `src/components/wiring/*.ts` — All files with executeFns (bit-selector.ts, bus-splitter.ts, decoder.ts, demux.ts, driver.ts, driver-inv.ts, mux.ts, priority-encoder.ts, splitter.ts, break.ts, sim-control.ts, etc.)
  - `src/components/switching/*.ts` — All files with executeFns (nfet.ts, pfet.ts, fgnfet.ts, fgpfet.ts, trans-gate.ts, relay.ts, relay-dt.ts, fuse.ts, switch.ts, etc.)
  - `src/components/memory/*.ts` — All files with executeFns (counter.ts, counter-preset.ts, eeprom.ts, lookup-table.ts, program-counter.ts, program-memory.ts, ram.ts, register.ts, register-file.ts, rom.ts)
  - `src/components/pld/*.ts` — All files with executeFns
  - `src/components/graphics/*.ts`, `src/components/terminal/*.ts`, `src/components/basic/*.ts`, `src/components/misc/*.ts`, `src/components/subcircuit/*.ts` — Apply pattern where executeFns exist.

#### Sub-task 1.2g: Test Files

- All test files under `src/components/*/__tests__/` and `src/engine/__tests__/` that construct mock layouts or call executeFns directly: update to provide `wiringTable` in test fixtures and use the indirection pattern.

- **Tests** (in addition to updating all existing tests):
  - `src/engine/__tests__/wiring-table.test.ts::WiringIndirection::non_contiguous_inputs_resolve_correctly` — Create a circuit where component A has 2 inputs connected to non-contiguous nets (e.g. net 0 and net 5). Set `state[wiringTable[inputOffset + 0]] = 1` and `state[wiringTable[inputOffset + 1]] = 1`. Step. Assert the output reflects both inputs being 1.
  - `src/engine/__tests__/wiring-table.test.ts::WiringIndirection::output_writes_go_to_correct_nets` — Create a circuit with an AND gate whose output net is non-contiguous with its inputs. Set inputs high. Step. Assert `state[wiringTable[outputOffset]]` is 1.
  - `src/engine/__tests__/wiring-table.test.ts::WiringIndirection::state_access_bypasses_wiring_table` — Compile a circuit with a D flip-flop. Assert `state[layout.stateOffset(dffIndex)]` is directly addressable (no wiringTable indirection). Toggle clock, step, verify state slot holds latched value.
  - `src/engine/__tests__/wiring-table.test.ts::WiringIndirection::compiled_circuit_from_real_circuit_has_correct_wiring` — Build a half-adder circuit programmatically (In→XOR→Out, In→AND→Out). Compile. Verify all 4 input combinations produce correct outputs by writing through wiringTable indirection.
  - `src/engine/__tests__/wiring-table.test.ts::WiringIndirection::gate_component_reads_through_wiring_table` — Compile an OR gate with non-contiguous input nets. Set both inputs high via wiringTable. Step. Assert output net (via wiringTable) is 1.
  - `src/engine/__tests__/wiring-table.test.ts::WiringIndirection::flipflop_io_uses_wiring_table_state_is_direct` — Compile a D flip-flop. Verify input/output access uses wiringTable, state slot access is direct. Step through a clock edge. Assert correct latching.
  - `src/engine/__tests__/wiring-table.test.ts::WiringIndirection::memory_component_reads_through_wiring_table` — Compile a RAM component. Set address and data inputs via wiringTable. Clock edge. Assert output via wiringTable reflects stored value.
- **Acceptance criteria**:
  - `layout.inputOffset(i)` and `layout.outputOffset(i)` return wiring-table indices
  - `layout.wiringTable` is a `Int32Array` mapping wiring-table positions to net IDs
  - All executeFns read inputs as `state[wt[inputOffset + k]]` and write outputs as `state[wt[outputOffset + k]]`
  - State slots are accessed directly: `state[stateOffset + k]`
  - Circuits with non-contiguous net IDs produce correct simulation results
  - Engine internal methods (`_collectOutputNets`, `_stepTimed`, `captureOutputs`, `outputsChanged`) use wiringTable for output net resolution
  - `ClockManager` and `run-to-break` read net IDs through wiringTable
  - All existing tests updated to use the new access pattern and pass

---

## Wave 2: Two-Phase Sequential Protocol

Depends on Wave 1 (state slots and wiring table must work first).

### Task 2.1: sampleFn on ComponentDefinition

- **Description**: Add an optional `sampleFn` to `ComponentDefinition`. Sequential components provide `sampleFn` (reads inputs, detects clock edge, latches D/JK/T value into state slots) and `executeFn` (reads state slots, writes Q/~Q outputs). The compiler collects `sampleFn` references into a function table alongside `executeFn`.
- **Files to modify**:
  - `src/core/registry.ts` — Add `sampleFn?: ExecuteFunction` to `ComponentDefinition`. Update doc comment: "Sequential components provide `sampleFn` to latch inputs on clock edges. Called before the combinational sweep."
  - `src/engine/compiled-circuit.ts` — `CompiledCircuitImpl` gains `readonly sampleFns: (ExecuteFunction | null)[]` indexed by type ID. Constructor accepts `sampleFns`.
  - `src/engine/compiler.ts` — Build `sampleFns` array in the function table step (step 6): for each type ID, `sampleFns[typeId] = def.sampleFn ?? null`.
  - `src/engine/digital-engine.ts` — `ConcreteCompiledCircuit` gains `readonly sampleFns: (ExecuteFunction | null)[]`.
- **Tests**:
  - `src/engine/__tests__/two-phase.test.ts::SampleFn::compiler_populates_sampleFns_table` — Register a component with `sampleFn`. Compile. Assert `compiled.sampleFns[typeId]` is the registered function.
  - `src/engine/__tests__/two-phase.test.ts::SampleFn::components_without_sampleFn_have_null_entry` — Register an AND gate (no sampleFn). Compile. Assert `compiled.sampleFns[typeId]` is null.
- **Acceptance criteria**:
  - `ComponentDefinition` has optional `sampleFn` field
  - Compiler populates `sampleFns` array on compiled circuit
  - No behavioral change yet (engine doesn't call sampleFn until Task 2.2)

### Task 2.2: Two-Phase `_stepLevel()`

- **Description**: Modify `_stepLevel()` to call `sampleFn` for all sequential components before the combinational sweep. The engine's step sequence becomes: (1) call `sampleFn` for every component in `sequentialComponents` that has one, (2) evaluate all groups in topological order (the existing sweep, calling `executeFn` for everything including sequential components — sequential executeFns now write Q from latched state).
- **Files to modify**:
  - `src/engine/digital-engine.ts` — In `_stepLevel()`, before the evaluation loop: iterate `compiled.sequentialComponents`, for each index get `typeId`, check `sampleFns[typeId]`, if non-null call it with `(index, state, layout)`. Then run the existing group evaluation loop.
- **Tests**:
  - `src/engine/__tests__/two-phase.test.ts::TwoPhaseStep::shift_register_propagates_correctly` — Build a 2-stage shift register: In→DFF_A→DFF_B→Out, shared clock. Set In=1, clock low. Step (nothing latched). Toggle clock high, step. Assert DFF_A.Q=1, DFF_B.Q=0 (B sampled A's OLD output). Toggle clock low, then high, step. Assert DFF_B.Q=1 (B now has A's value from previous cycle).
  - `src/engine/__tests__/two-phase.test.ts::TwoPhaseStep::concurrent_flip_flops_sample_simultaneously` — Two D flip-flops with cross-feedback: A.Q→B.D, B.Q→A.D, shared clock. Initialize A.Q=1, B.Q=0. Clock edge + step. Assert A.Q=0 and B.Q=1 (they swapped — each sampled the other's OLD output).
  - `src/engine/__tests__/two-phase.test.ts::TwoPhaseStep::combinational_only_circuit_unaffected` — Build an AND gate circuit (no sequential components). Step. Assert correct output. Verify no sampleFn calls (sequentialComponents is empty).
- **Acceptance criteria**:
  - `_stepLevel()` calls sampleFn for all sequential components before the combinational sweep
  - Shift registers propagate data one stage per clock cycle (not all at once)
  - Cross-feedback flip-flops swap values correctly
  - Combinational-only circuits are unaffected

### Task 2.3: Update All Sequential Component ExecuteFns

- **Description**: Split each flip-flop/counter/register's `executeFn` into `sampleFn` + `executeFn`. `sampleFn` reads inputs (D, clock, set, reset), detects clock edge via prevClock in state slot, and latches the appropriate value. `executeFn` reads state slots and writes Q/~Q outputs. **Split into sub-tasks by component category for manageability.**

#### Sub-task 2.3a: Edge-Triggered Flip-Flops

- **Files to modify**:
    - `src/components/flipflops/d.ts` — Add `sampleD`: reads D and C inputs through wiringTable, compares C to prevClock in state, if rising edge stores D into state slot, updates prevClock. Modify `executeD`: reads storedQ from state slot, writes Q and ~Q outputs through wiringTable. Set `sampleFn: sampleD` on `DDefinition`.
    - `src/components/flipflops/jk.ts` — Add `sampleJK`: reads J, K, C, detects rising edge, computes next Q from J/K/currentQ, stores in state. Modify `executeJK`: outputs from state. Set `sampleFn`.
    - `src/components/flipflops/t.ts` — Add `sampleT`: reads T, C, detects edge, toggles stored Q if T=1. Modify `executeT`: outputs from state. Set `sampleFn`.
    - `src/components/flipflops/rs.ts` — Add `sampleRS`: reads S, R, C, detects edge, stores. Modify `executeRS`: outputs from state. Set `sampleFn`.
    - `src/components/flipflops/monoflop.ts` — Add `sampleMonoflop`: detects trigger edge, starts timing. Modify `executeMonoflop`: outputs from state. Set `sampleFn`.
- **Async flip-flops (NO sampleFn — level-sensitive, confirm only)**:
    - `src/components/flipflops/d-async.ts` — Async flip-flops are level-sensitive with async set/clear priority. They do NOT get a `sampleFn` — their `executeFn` reads inputs and writes outputs directly. Confirm `sampleFn` is undefined on definition.
    - `src/components/flipflops/jk-async.ts` — Same: no `sampleFn` (level-sensitive with async set/clear).
    - `src/components/flipflops/rs-async.ts` — Same: no `sampleFn` (pure level-sensitive SR latch).
- **Tests**:
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::DFlipFlop::sampleD_latches_on_rising_edge` — Set D=1, clock low→high. Call `sampleD`. Assert state slot holds 1. Call `executeD`. Assert Q=1, ~Q=0.
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::DFlipFlop::sampleD_ignores_falling_edge` — Set D=1, clock high→low. Call `sampleD`. Assert state slot unchanged.
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::DFlipFlop::executeD_outputs_from_state_not_inputs` — Set D=1 in inputs but state slot holds 0 (no edge occurred). Call `executeD`. Assert Q=0 (outputs from state, not from D).
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::AsyncDFlipFlop::has_no_sampleFn` — Assert `DAsyncDefinition.sampleFn` is undefined.
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::JKFlipFlop::sampleJK_computes_next_state` — J=1, K=0, rising edge. Assert state slot is 1. J=1, K=1 (toggle), rising edge. Assert state slot flipped.
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::TFlipFlop::sampleT_toggles_on_edge_when_T_high` — T=1, rising edge. Assert stored Q toggled.
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::RSFlipFlop::sampleRS_sets_on_rising_edge` — S=1, R=0, rising edge. Call `sampleRS`. Assert state slot is 1 (set).
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::RSFlipFlop::sampleRS_resets_on_rising_edge` — S=0, R=1, rising edge. Call `sampleRS`. Assert state slot is 0 (reset).
  - `src/components/flipflops/__tests__/two-phase-flipflops.test.ts::Monoflop::sampleMonoflop_starts_timing_on_trigger_edge` — Trigger low→high. Call `sampleMonoflop`. Assert state slot shows active and counter initialized.

#### Sub-task 2.3b: Counters and Registers

- **Files to modify**:
  - **Edge-triggered counters (get sampleFn)**:
    - `src/components/memory/counter.ts` — Add `sampleCounter`: reads en, C, clr through wiringTable, detects rising clock edge, if enabled increments counter in state, if clr resets to 0. Modify `executeCounter`: reads counter from state, writes out and ovf outputs. Set `sampleFn`.
    - `src/components/memory/counter-preset.ts` — Add `sampleCounterPreset`: reads en, C, dir, loadVal, ld, clr, detects clock edge, handles load/count/clear logic. Modify execute: outputs from state. Set `sampleFn`.
    - `src/components/memory/program-counter.ts` — Add `sampleProgramCounter`: reads D, en, C, ld, detects clock edge, handles load/increment. Modify execute: outputs from state. Set `sampleFn`.
  - **Edge-triggered registers (get sampleFn)**:
    - `src/components/memory/register.ts` — Add `sampleRegister`: reads D, C, en, detects clock edge, if enabled latches D into state. Modify execute: outputs from state. Set `sampleFn`.
    - `src/components/memory/register-file.ts` — Add `sampleRegisterFile`: reads Din, we, Rw, C, detects clock edge, if we=1 writes Din to register[Rw] in state. Modify execute: reads Ra/Rb, outputs register values from state. Set `sampleFn`.
    - `src/components/memory/program-memory.ts` — Add `sampleProgramMemory`: reads A, ld, C, detects clock edge, if ld=1 latches A into addrReg. Modify execute: outputs data from ROM table at addrReg. Set `sampleFn`.
- **Tests**:
  - `src/components/memory/__tests__/two-phase-memory.test.ts::Counter::sampleCounter_increments_on_rising_edge` — en=1, clock low→high. Call `sampleCounter`. Assert counter state incremented. Call `executeCounter`. Assert output matches counter.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::Counter::sampleCounter_clears_on_clr` — clr=1, clock low→high. Call `sampleCounter`. Assert counter state is 0.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::CounterPreset::sampleCounterPreset_loads_on_ld` — ld=1, loadVal=0x42, clock edge. Assert counter state is 0x42.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::ProgramCounter::sampleProgramCounter_increments_on_edge` — en=1, ld=0, clock edge. Assert counter state incremented.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::Register::sampleRegister_latches_on_rising_edge` — D=0xAB, en=1, clock low→high. Call `sampleRegister`. Assert state holds 0xAB. Call `executeRegister`. Assert Q=0xAB.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::Register::executeRegister_outputs_from_state_not_inputs` — D=0xFF but state holds 0x00. Call `executeRegister`. Assert Q=0x00 (from state).
  - `src/components/memory/__tests__/two-phase-memory.test.ts::RegisterFile::sampleRegisterFile_writes_on_edge` — we=1, Din=0xCD, Rw=2, clock edge. Assert register[2] in state is 0xCD.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::ProgramMemory::sampleProgramMemory_latches_address` — ld=1, A=5, clock edge. Assert addrReg in state is 5.

#### Sub-task 2.3c: Memory Components and PRNG

- **Files to modify**:
  - **Edge-triggered memory (get sampleFn)**:
    - `src/components/memory/ram.ts` — Add `sampleRam` per variant: detects clock edge, if write-enable stores data at address. Modify execute: reads from stored memory. Set `sampleFn` on each RAM definition.
    - `src/components/memory/eeprom.ts` — Add `sampleEeprom` per variant: detects WE/clock edge, captures write address/data. Modify execute: reads from stored data. Set `sampleFn`.
  - **Combinational memory (NO sampleFn, confirm only)**:
    - `src/components/memory/rom.ts` — No `sampleFn` (combinational address lookup).
    - `src/components/memory/lookup-table.ts` — No `sampleFn` (combinational).
  - **Other edge-triggered**:
    - `src/components/arithmetic/prng.ts` — Add `samplePrng`: detects clock edge, advances LFSR. Modify execute: outputs from state. Set `sampleFn`.
- **Tests**:
  - `src/components/memory/__tests__/two-phase-memory.test.ts::RAM::sampleRam_stores_on_clock_edge` — we=1, addr=3, data=0xFF, clock edge. Call `sampleRam`. Assert memory word 3 in state is 0xFF.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::RAM::sampleRam_ignores_when_we_low` — we=0, clock edge. Assert memory unchanged.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::RAM::executeRam_reads_from_state` — Set memory word 3 in state to 0xAB. Set addr=3. Call `executeRam`. Assert output is 0xAB.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::EEPROM::sampleEeprom_captures_write` — WE edge, addr=1, data=0x55. Call `sampleEeprom`. Assert stored data at addr 1 is 0x55.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::EEPROM::executeEeprom_reads_from_state` — Set stored data, set addr. Call `executeEeprom`. Assert correct output.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::PRNG::samplePrng_advances_lfsr_on_edge` — Clock edge. Call `samplePrng`. Assert LFSR state changed. Call again. Assert different state (not stuck).
  - `src/components/memory/__tests__/two-phase-memory.test.ts::ROM::has_no_sampleFn` — Assert ROM definition has no sampleFn.
  - `src/components/memory/__tests__/two-phase-memory.test.ts::LookupTable::has_no_sampleFn` — Assert LookupTable definition has no sampleFn.
- **Acceptance criteria**:
  - All edge-triggered sequential components have `sampleFn` that latches inputs on clock edge
  - All async (level-sensitive) sequential components have no `sampleFn`
  - All combinational memory components (ROM, lookup-table) have no `sampleFn`
  - `executeFn` for sequential components reads ONLY from state slots for output computation
  - `sampleFn` reads inputs through wiringTable indirection
  - Each component's `stateSlotCount` matches the number of state slots its sampleFn/executeFn use

---

## Wave 3: Engine Subsystem Integration

### Task 3.1: Bus Resolution Integration

- **Description**: `BusResolver` is fully implemented but disconnected. The compiler doesn't identify multi-driver nets and the engine never calls the resolver. Fix: compiler detects multi-driver nets during net assignment, creates and populates a `BusResolver`, attaches it to `CompiledCircuitImpl`. Engine calls `busResolver.onNetChanged()` after each evaluation group and `busResolver.checkAllBurns()` after each step.
- **Files to modify**:
  - `src/engine/compiled-circuit.ts` — `CompiledCircuitImpl` gains `readonly busResolver: BusResolver | null`. Constructor accepts optional `busResolver`.
  - `src/engine/compiler.ts` — In step 7 (dependency graph), change `netDriver` from `Map<number, number>` (single driver) to `Map<number, number[]>` (all drivers). For each component's output nets, push the component index onto the net's driver list. After step 7, scan for nets where `drivers.length > 1` — these are multi-driver nets. For each multi-driver net: determine pull-resistor type (check if any driver component's typeId is `"PullUp"` or `"PullDown"` via registry lookup), create a `BusNet` entry with output net = the shared net ID and driver nets = all driver component output net IDs. If any multi-driver nets exist, create a `BusResolver`, populate it, and pass to `CompiledCircuitImpl`. Store the multi-driver net set as `multiDriverNets: Set<number>` on `CompiledCircuitImpl` for use by Task 4.2's switch classification. **Note**: switch/FET/relay registration with the bus resolver is NOT done here — it is deferred to Task 4.2, which classifies switches as unidirectional vs bidirectional before registering only the bidirectional ones.
  - `src/engine/digital-engine.ts` — `ConcreteCompiledCircuit` gains `readonly busResolver: BusResolver | null`. Bus resolution triggering differs by group type:
    - **Feedback groups** (`_evaluateFeedbackGroup()`): Snapshots already exist for convergence detection. After each iteration, if `busResolver` is non-null, compare each output net's value against the snapshot. For nets that changed, call `busResolver.onNetChanged(netId, state, highZs)`. The `state` and `highZs` arrays are `this._values` and `this._highZs` respectively.
    - **Non-feedback groups** (`_evaluateGroupOnce()`): No snapshot mechanism exists. When `busResolver` is non-null, call `busResolver.onNetChanged(netId, state, highZs)` for ALL output nets of the group unconditionally after evaluation. The BusResolver internally skips nets that are not bus nets (O(1) check against its internal set), so the overhead for non-bus nets is negligible.
    - After `_stepLevel()` completes all groups: call `busResolver.checkAllBurns()` — if any burns, throw `BurnException`.
- **Tests**:
  - `src/engine/__tests__/bus-resolution.test.ts::BusIntegration::compiler_identifies_multi_driver_nets` — Create a circuit where two output pins drive the same net (via wires meeting at a junction). Compile. Assert `compiled.busResolver` is not null. Assert the bus resolver has one bus net with two drivers.
  - `src/engine/__tests__/bus-resolution.test.ts::BusIntegration::tri_state_resolves_correctly` — Two drivers on one net: driver A outputs 1 (not high-Z), driver B is high-Z. Step. Assert net value is 1.
  - `src/engine/__tests__/bus-resolution.test.ts::BusIntegration::burn_detected_on_conflicting_drivers` — Two drivers on one net: driver A outputs 1, driver B outputs 0, neither high-Z. Step. Assert `BurnException` is thrown.
  - `src/engine/__tests__/bus-resolution.test.ts::BusIntegration::pull_up_resolves_floating_net` — One driver is high-Z on a net with a PullUp component. Step. Assert net value is all-ones.
  - `src/engine/__tests__/bus-resolution.test.ts::BusIntegration::single_driver_nets_have_no_bus_resolver` — Compile a simple AND→Out circuit (single driver per net). Assert `compiled.busResolver` is null (no overhead for simple circuits).
- **Acceptance criteria**:
  - Compiler identifies multi-driver nets (drivers.length > 1) and creates BusResolver when needed
  - `multiDriverNets: Set<number>` is stored on `CompiledCircuitImpl` for Task 4.2's switch classification
  - Engine calls bus resolution after each evaluation pass (unconditionally for non-feedback groups, change-based for feedback groups)
  - Tri-state resolution produces correct values (OR of non-high-Z drivers, AND of high-Z masks)
  - Bus conflicts (burn) are detected post-step
  - Pull resistors resolve floating nets
  - Single-driver circuits have no BusResolver (zero overhead)

### Task 3.2: Noise Mode / Init Sequence Integration

- **Description**: `initializeCircuit()` in `init-sequence.ts` is complete but never called. The engine's `init()` only zeroes signal arrays. Also, `_evaluateFeedbackGroup()` allocates `new Uint32Array` per iteration instead of using the pre-allocated `sccSnapshotBuffer`. Fix: engine calls `initializeCircuit()` during init, implements `InitializableEngine`, compiler identifies Reset components.
- **Files to modify**:
  - `src/engine/compiled-circuit.ts` — `CompiledCircuitImpl` gains `readonly resetComponentIndices: Uint32Array`. Note: the `InitializableEngine` interface in `init-sequence.ts` already declares `readonly resetComponentIndices: Uint32Array` (line 62). The work here is making `CompiledCircuitImpl` provide the data so `DigitalEngine` can expose it.
  - `src/engine/compiler.ts` — After step 8 (sequential classification), scan for Reset components by typeId (`"Reset"`). Build `resetComponentIndices: Uint32Array`. Pass to `CompiledCircuitImpl`.
  - `src/engine/digital-engine.ts` — Implement `InitializableEngine` on `DigitalEngine`: expose `state` (as getter returning `_values`), `snapshotBuffer` (as getter returning `_compiled.sccSnapshotBuffer`), `typeIds`, `executeFns`, `layout`, `evaluationOrder`, `resetComponentIndices` — all read from `_compiled`. In `init()`, after allocating signal arrays and setting `_compiled`, call `initializeCircuit(this)`. Remove the inline `_initSignalsUndefined()` call (the init sequence handles it). Replace `_evaluateFeedbackGroup()`'s inline snapshot allocation (`new Uint32Array(outputNets.length)`) with a prefix slice of `_compiled.sccSnapshotBuffer`. The `sccSnapshotBuffer` is sized to the largest feedback SCC's output net count (allocated once by the compiler in step 7); each feedback group uses `sccSnapshotBuffer.subarray(0, outputNets.length)` as its snapshot workspace.
  - `src/engine/init-sequence.ts` — The wiringTable indirection update for `captureOutputs` and `outputsChanged` is already covered by Task 1.2 (Sub-task 1.2a). No additional changes needed here beyond what Task 1.2 specifies.
- **Tests**:
  - `src/engine/__tests__/init-sequence-integration.test.ts::InitSequence::engine_init_runs_noise_propagation` — Build an SR latch from NOR gates (combinational feedback). Compile, init engine. Assert Q and ~Q are complementary (noise broke symmetry — one is 0 and the other is 1, not both undefined).
  - `src/engine/__tests__/init-sequence-integration.test.ts::InitSequence::reset_components_released_after_noise` — Build a circuit with a Reset component driving a D flip-flop's async reset. Compile, init. Assert Reset output is 1 (released). Assert flip-flop is in its reset state.
  - `src/engine/__tests__/init-sequence-integration.test.ts::InitSequence::deterministic_settle_after_noise` — Build a chain of 3 inverters (odd-length loop = oscillating feedback). Compile, init. Assert the oscillation is detected (the init sequence iterates MAX_NOISE_ITERATIONS without stabilizing, and the state is left as-is — not a crash).
  - `src/engine/__tests__/init-sequence-integration.test.ts::InitSequence::feedback_group_uses_preallocated_snapshot` — Compile an SR latch. Spy on `Uint32Array` constructor. Step the engine 100 times. Assert `Uint32Array` constructor was not called during stepping (only during init).
- **Acceptance criteria**:
  - `engine.init()` runs the full initialization sequence (noise → reset release → settle)
  - SR latches from NOR/NAND gates initialize to a definite state (not both undefined)
  - Reset components are released after noise propagation
  - `_evaluateFeedbackGroup()` uses the pre-allocated `sccSnapshotBuffer` (zero allocation in steady-state evaluation)
  - `captureOutputs` and `outputsChanged` use wiringTable indirection
  - Existing tests pass (init behavior change is additive, not breaking)

### Task 3.3: Oscillation Detection Integration

- **Description**: `OscillationDetector` in `oscillation.ts` is implemented but not wired in. The engine's `_evaluateFeedbackGroup()` silently stops after MAX_FEEDBACK_ITERATIONS. Fix: define the missing `COLLECTION_STEPS` constant, wire the detector into feedback evaluation. On oscillation, throw `OscillationError` with the oscillating component list.
- **Files to modify**:
  - `src/engine/oscillation.ts` — Add `export const COLLECTION_STEPS = 100;` (matches Digital's Java source). The constant is referenced in existing JSDoc but was never defined.
  - `src/engine/digital-engine.ts` — Add a `private _oscillationDetector: OscillationDetector` field to `DigitalEngine`, initialized in `init()`. In `_evaluateFeedbackGroup()`: call `this._oscillationDetector.reset()` at the start of each invocation. Call `this._oscillationDetector.tick()` each iteration. When `this._oscillationDetector.isOverLimit()`, run `COLLECTION_STEPS` more iterations calling `this._oscillationDetector.collectOscillatingComponents()` with the indices of components whose outputs changed. Then call `this._oscillationDetector.getOscillatingComponents()` and throw `OscillationError` with the oscillating component list and a descriptive message.
  - `src/core/errors.ts` — Add `componentIndices: number[]` field to `OscillationError` (alongside existing `iterations` field). Update constructor to accept `componentIndices?: number[]` in options, defaulting to `[]`.
- **Tests**:
  - `src/engine/__tests__/oscillation-integration.test.ts::OscillationDetection::ring_oscillator_throws` — Build a 3-inverter ring (A→B→C→A). Compile, init, step. Assert `OscillationError` is thrown with the 3 component indices.
  - `src/engine/__tests__/oscillation-integration.test.ts::OscillationDetection::stable_feedback_does_not_throw` — Build an SR latch (NOR gates). Compile, init, step. Assert no exception (the latch stabilizes).
  - `src/engine/__tests__/oscillation-integration.test.ts::OscillationDetection::exception_contains_oscillating_components` — Build a ring oscillator. Catch the `OscillationError`. Assert `componentIndices` contains exactly the components in the ring. Assert `iterations` is populated.
- **Acceptance criteria**:
  - `COLLECTION_STEPS` constant is defined in `oscillation.ts`
  - Oscillating feedback throws `OscillationError` (not `NodeException`) with component list
  - Stable feedback (SR latches) does not throw
  - Exception message identifies which components are oscillating
  - `OscillationError.componentIndices` contains the oscillating component indices

---

## Wave 4: Clock and Switch Network

### Task 4.1: Clock Manager as External Utility

- **Description**: `ClockManager` exists and is correct (after Task 1.2's wiringTable update to `_findClocksInternal()`). It should be used as an external utility called by app-init before each `engine.step()`, not integrated into the engine's step method. The engine is a passive propagator — clock toggling is an external concern. Update app-init to create a `ClockManager` after compilation and call `advanceClocks()` in the run loop.
- **Files to modify**:
  - `src/app/app-init.ts` — After `compileAndBind()`, create a `ClockManager` from the compiled circuit. In `startContinuousRun()`'s tick loop, call `clockManager.advanceClocks(engine_state_array)` before each `engine.step()`. In `btn-step` handler, call `clockManager.advanceClocks()` before `engine.step()`. Expose the engine's `_values` array via a getter or pass it through the binding.
  - `src/engine/digital-engine.ts` — Add a public getter `getSignalArray(): Uint32Array` returning `_values` (needed for ClockManager to write clock outputs directly into the signal array).
  - `src/engine/clock.ts` — No changes needed beyond the wiringTable update in Task 1.2. **Explicit dependency**: Task 1.2 (Sub-task 1.2a) must be completed first — it changes `_findClocksInternal()` to read clock output net IDs through wiringTable (`layout.wiringTable[layout.outputOffset(componentIndex)]` instead of `layout.outputOffset(componentIndex)`). Task 4.1 relies on this being done correctly.
- **Tests**:
  - `src/engine/__tests__/clock-integration.test.ts::ClockExternal::clock_advances_before_step` — Create a circuit with a Clock component driving a D flip-flop. Create ClockManager. Call `advanceClocks(state)`, then `engine.step()`. Assert the clock output toggled and the flip-flop responded to the edge.
  - `src/engine/__tests__/clock-integration.test.ts::ClockExternal::step_without_clock_advance_does_not_toggle` — Call `engine.step()` WITHOUT calling `advanceClocks()`. Assert clock output unchanged. Assert flip-flop did not latch (no edge).
  - `src/engine/__tests__/clock-integration.test.ts::ClockExternal::multi_frequency_clocks` — Two Clock components with different frequencies (K=1 and K=2). Call `advanceClocks` + step 4 times. Assert fast clock toggled 4 times, slow clock toggled 2 times.
- **Acceptance criteria**:
  - `ClockManager.advanceClocks()` is called externally before `engine.step()`
  - Engine's `step()` does not toggle clocks (passive propagator)
  - Clock-driven sequential circuits produce correct behavior when clock is advanced externally
  - Step without clock advance is a valid operation (evaluates combinational logic with current state)

### Task 4.2: Switch Network Integration

- **Description**: Switch components (NFET, PFET, TransGate, Switch, Relay, etc.) determine their closed/open state during evaluation and write a `closedFlag` to their state slot. The engine detects switch state changes after each evaluation group and triggers `busResolver.reconfigureForSwitch()` to merge or split nets. The existing feedback iteration loop then naturally converges as merged/split net values propagate. This mirrors Digital's `BusModelStateObserver.reconfigureNets()` algorithm.

  **Compiler-time optimization**: Following Digital's `PlainSwitch.createSwitchModel()`, the compiler classifies each switch as either:
  - **Unidirectional**: one side has a single driver (non-bus net) or is a constant. The executeFn simply forwards input→output when closed, sets highZ when open. No bus resolver interaction needed.
  - **Bidirectional**: both sides are multi-driver bus nets. The executeFn writes `closedFlag` to its state slot. The engine triggers bus reconfiguration when the flag changes.

  This optimization keeps simple FET circuits (single driver) on the fast unidirectional path with no bus resolver overhead.

- **Files to modify**:
  - `src/engine/compiled-circuit.ts` — `CompiledCircuitImpl` gains `readonly switchComponentIndices: Uint32Array` (indices of all switch components that are bidirectional). Constructor accepts it.
  - `src/engine/compiler.ts` — After bus resolution setup (Task 3.1), classify each switch/FET/relay component:
    - Identify switch components by typeId (NFET, PFET, FGNFET, FGPFET, TransGate, Relay, RelayDT, Switch). Each switch component declares two signal pins as its "switch pair" — these are the pins that connect/disconnect when the switch opens/closes. For FETs: drain (pin 0) and source (pin 1). For TransGate: A (pin 0) and B (pin 1). For Relay: the contact pins. The switch pair pin indices are specified per component type via a new optional `switchPins?: [number, number]` field on `ComponentDefinition` (added in this task).
    - Look up net IDs for both switch-pair pins using the wiring table.
    - If both net IDs appear in the `multiDriverNets` set from Task 3.1 (both are bus nets): classify as **bidirectional**. Add to `switchComponentIndices`. Call `busResolver.registerSwitch(componentIndex, netA, netB)`.
    - Otherwise: classify as **unidirectional**. No bus resolver registration needed (the executeFn handles it directly).
    - Store the classification as a per-instance flag: add `switchClassification: Uint8Array` to `CompiledCircuitImpl`, indexed by component index. Values: `0` = not a switch, `1` = unidirectional, `2` = bidirectional. ExecuteFns read `layout.getSwitchClassification(index)` to branch between unidirectional (forward value / set highZ) and bidirectional (write closedFlag only) behavior.
  - `src/core/registry.ts` — Add optional `switchPins?: [number, number]` to `ComponentDefinition`. Only switch components set this. It identifies the two pin indices that form the switchable connection.
  - `src/engine/compiled-circuit.ts` — `FlatComponentLayout` gains `getSwitchClassification(index: number): number` reading from `switchClassification: Uint8Array`. Add `switchClassification` to `CompiledCircuitImpl`.
  - `src/engine/digital-engine.ts` — `ConcreteCompiledCircuit` gains `readonly switchComponentIndices: Uint32Array`. After each evaluation group in `_stepLevel()`: if `switchComponentIndices.length > 0`, scan each switch's `closedFlag` state slot. If the flag changed since the previous check (track previous values in a `_switchPrevStates: Uint32Array` allocated once at init), call `busResolver.reconfigureForSwitch(switchId, closed)` and mark that a re-evaluation is needed. If any switch changed, re-evaluate the current group (or subsequent affected groups) until stable.
  - `src/components/switching/trans-gate.ts` — Update `executeTransGate` to implement Digital's gate logic: if S is highZ or ~S is highZ → closed=false; else if S ≠ ~S → closed=S. Write `closedFlag` to state slot. If unidirectional: forward value when closed, highZ when open. If bidirectional: only write closedFlag (bus resolver handles net merging).
  - `src/components/switching/nfet.ts` — Set `switchPins: [0, 1]` (drain, source) on definition. Update executeFn: compute `closedFlag` from gate input (closed when G=1, open when G=0 or G=highZ). Write `closedFlag` to state slot. Check `layout.getSwitchClassification(index)`: if unidirectional (1), forward D→S via `state[wt[outBase]]` when closed, set `highZs[wt[outBase]] = 1` when open; if bidirectional (2), only write closedFlag (bus resolver handles net merging).
  - `src/components/switching/pfet.ts` — Same pattern as NFET (closed when G=0). Set `switchPins: [0, 1]`.
  - `src/components/switching/fgnfet.ts`, `src/components/switching/fgpfet.ts` — Same plus blown-fuse check from blownFlag state slot.
  - `src/components/switching/relay.ts`, `src/components/switching/relay-dt.ts` — Update to write closedFlag/energisedFlag based on coil input.
  - **TransGate burn check**: Add post-step validation in the engine — after `_stepLevel()` completes, for each TransGate component check if S == ~S and neither is highZ. If so, throw `BurnException` (invalid transmission gate state — control signals must be complementary).
- **Tests**:
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::nfet_forwards_when_gate_high` — NFET with gate=1. Assert drain value appears at source.
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::nfet_highz_when_gate_low` — NFET with gate=0. Assert source is highZ.
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::transgate_closed_when_s_neq_ns` — TransGate with S=1, ~S=0. Assert A and B are connected (value passes through).
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::transgate_open_when_s_eq_ns` — TransGate with S=1, ~S=1. Assert burn exception on step.
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::transgate_open_when_control_highz` — TransGate with S=highZ. Assert A and B are disconnected (highZ).
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::bidirectional_switch_triggers_bus_reconfiguration` — Two drivers on net A and two on net B, connected by a bidirectional switch. Close switch. Assert merged net value reflects all four drivers.
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::unidirectional_nfet_no_bus_resolver` — Single-driver NFET circuit. Compile. Assert NFET is NOT in `switchComponentIndices` (classified as unidirectional).
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::bidirectional_switch_registered_with_bus_resolver` — Create a circuit with an NFET where both switch-pair pins connect to multi-driver nets. Compile. Assert `busResolver.registerSwitch()` was called with the NFET's bidirectional net IDs. Assert NFET IS in `switchComponentIndices`.
  - `src/engine/__tests__/switch-network.test.ts::SwitchNetwork::switch_feedback_converges` — NFET-based feedback loop. Compile, step. Assert stable output (the feedback iteration loop converges).
- **Acceptance criteria**:
  - Switch executeFns write `closedFlag` to their state slot
  - Engine detects switch state changes after each evaluation group
  - Bidirectional switches trigger `busResolver.reconfigureForSwitch()` on state change
  - Unidirectional switches forward input→output directly (no bus resolver overhead)
  - TransGate implements Digital's complementary gate logic (S ≠ ~S → closed)
  - TransGate burn check fires when S == ~S (non-highZ)
  - Switch feedback converges via the normal iteration loop
  - Simple FET circuits (unidirectional) incur zero bus resolver overhead

---

## Wave 5: Web Worker Mode

### Task 5.1: Worker Init Protocol

- **Description**: `WorkerEngine` and `worker.ts` are scaffolded but non-functional. The worker has no way to receive a compiled circuit. Fix: define an init message that transfers the compiled circuit's typed arrays and the SharedArrayBuffer to the worker in a single message. The worker reconstructs a minimal `ConcreteCompiledCircuit` using its own registry (for the function table) and the received typed arrays.
- **Files to modify**:
  - `src/core/engine-interface.ts` — Add `EngineMessage` variant: `{ type: "init"; sharedBuffer: SharedArrayBuffer; netCount: number; componentCount: number; signalArraySize: number; typeIds: Uint8Array; typeNames: string[]; inputOffsets: Int32Array; outputOffsets: Int32Array; inputCounts: Uint8Array; outputCounts: Uint8Array; stateOffsets: Int32Array; wiringTable: Int32Array; evaluationGroups: Array<{ componentIndices: Uint32Array; isFeedback: boolean }>; sequentialComponents: Uint32Array; netWidths: Uint8Array; delays: Uint32Array; resetComponentIndices: Uint32Array; switchComponentIndices: Uint32Array; switchClassification: Uint8Array }`. All fields are structured-clone-compatible. Update the `EngineMessage` discriminated union's JSDoc to document the new `"init"` variant. Add an `"init"` case to the message type's documentation listing all fields and their purposes. Note: this is distinct from the existing `"reset"` case.

    **Transfer semantics**: The `sharedBuffer` (`SharedArrayBuffer`) is always **shared** — it appears in the `Transferable` list but SABs are not moved (both threads retain access). All `Uint8Array`, `Int32Array`, and `Uint32Array` fields are **structured-cloned** (copied), NOT transferred — the main thread retains its copies for `WorkerEngine.getSignalValue()` and other main-thread reads. Only the SAB is listed in the `Transferable` array: `postMessage(msg, [msg.sharedBuffer])`.

  - `src/engine/worker-engine.ts` — `init(circuit)`: narrow to `ConcreteCompiledCircuit`, extract all typed arrays and type name list, build the init message, post it with `postMessage(msg, [msg.sharedBuffer])`. Remove the dynamic `import()` in `setSignalValue` — use static import. Fix `setSignalValue` to properly extract full BitVector data (use `bitVectorToRaw` synchronously). `getSignalValue`: store `netWidths` locally during init for width lookup. Handle unrecognized type names from the worker by logging a warning (graceful degradation).
  - `src/engine/worker.ts` — Handle `"init"` message: import `createDefaultRegistry` from `register-all.ts`, construct registry, rebuild `executeFns` and `sampleFns` arrays from `typeNames` + registry lookups (if a type name is not found in registry, log warning and use a no-op executeFn). Construct `FlatComponentLayout` from received offset arrays, construct `EvaluationGroup[]` from received group data. Build a **worker-side** `ConcreteCompiledCircuit` object literal (not a `CompiledCircuitImpl` instance) that satisfies the interface. For non-serializable fields that only the main thread uses:
    - `componentToElement`: set to `new Map()` (empty — the worker has no `CircuitElement` instances)
    - `wireToNetId`: set to `new Map()` (empty — no `Wire` instances in the worker)
    - `labelToNetId`: set to `new Map()` (empty — label lookups happen on main thread via `WorkerEngine.getSignalValue`)
    - `pinNetMap`: set to `new Map()` (empty — pin lookups happen on main thread)

    These fields are only used by `EditorBinding` and external APIs on the main thread; the worker only needs the typed arrays and function tables for simulation. Create `DigitalEngine`, call `engine.init(compiled)`. Store reference to the `SharedArrayBuffer` views for signal sync (Task 5.2).
  - `src/engine/compiled-circuit.ts` — No changes (CompiledCircuitImpl constructor already accepts all needed fields).
- **Tests**:
  - `src/engine/__tests__/worker-engine.test.ts::WorkerInit::init_message_transfers_typed_arrays` — Mock Worker. Call `workerEngine.init(compiled)`. Assert the posted message contains `typeIds`, `wiringTable`, `inputOffsets`, `sharedBuffer`, etc. with correct values matching the compiled circuit.
  - `src/engine/__tests__/worker-engine.test.ts::WorkerInit::worker_reconstructs_circuit_from_message` — In a simulated worker context: receive an init message, reconstruct the compiled circuit, create engine, step. Assert signal values are written to the shared buffer.
- **Acceptance criteria**:
  - `WorkerEngine.init()` serializes compiled circuit typed arrays and posts to worker with SAB in a single init message
  - Typed arrays are structured-cloned (main thread retains copies); only the `SharedArrayBuffer` is in the `Transferable` list
  - Worker reconstructs a functional `ConcreteCompiledCircuit` from received data + its own registry, with empty Maps for non-serializable fields (`componentToElement`, `wireToNetId`, `labelToNetId`, `pinNetMap`)
  - Unrecognized type names are handled gracefully (warning + no-op)
  - Worker engine produces identical results to main-thread engine for the same circuit

### Task 5.2: Worker Signal Synchronization

- **Description**: After each `step()` in the worker, signal values must be written to the `SharedArrayBuffer` so the main thread can read them via `Atomics.load()`. The worker writes using `Atomics.store()`. The SAB is included in the init message (Task 5.1).
- **Files to modify**:
  - `src/engine/worker.ts` — After each `engine.step()` (in "step", "microStep", "start" continuous loop): copy `engine.getSignalArray()` values into the shared `Int32Array` using `Atomics.store()` for each net. Similarly for highZ values. For continuous run: the worker runs a tight loop using `MessageChannel` port for yielding (post a message to self, resume on receipt — gives the browser a chance to process incoming messages between steps). Sync the shared buffer after each step.
  - `src/engine/worker-engine.ts` — The SAB is already sent in the init message (Task 5.1). `getSignalRaw` and `getSignalValue` read from the shared buffer via `Atomics.load()` (existing implementation is correct).
- **Tests**:
  - `src/engine/__tests__/worker-signal.test.ts::WorkerSignal::main_thread_reads_signal_after_step` — (Integration test, may require actual Worker or mock.) Init worker engine, set an input value, step. Assert `workerEngine.getSignalRaw(outputNetId)` returns the correct computed value.
  - `src/engine/__tests__/worker-signal.test.ts::WorkerSignal::setSignalValue_propagates_to_worker` — Set input via `workerEngine.setSignalValue()`. Step. Assert the input value was received by the worker engine and propagated.
- **Acceptance criteria**:
  - Worker writes signal values to SharedArrayBuffer after each step
  - Main thread reads correct values via `Atomics.load()` (getSignalRaw)
  - Signal values in worker and main thread are consistent after each step
  - Continuous run uses MessageChannel for yielding (not setTimeout)

### Task 5.3: createEngine Factory Fix

- **Description**: `createEngine()` in `worker-detection.ts` checks `canUseSharedArrayBuffer()` which returns true in Node.js (SAB is always available). This would incorrectly select `WorkerEngine` in test environments where `Worker` is undefined. Fix: also check for `Worker` availability and that the worker can actually be spawned.
- **Files to modify**:
  - `src/engine/worker-detection.ts` — `canUseSharedArrayBuffer()`: also check `typeof Worker !== "undefined"`. Rename to `canUseWorkerEngine()` for clarity. `createEngine()`: try `WorkerEngine` first, if spawn fails (caught in constructor), fall back to `DigitalEngine`.
- **Tests**:
  - `src/engine/__tests__/worker-detection.test.ts::WorkerDetection::falls_back_when_Worker_undefined` — In a test environment where `Worker` is undefined (Node.js default): assert `canUseWorkerEngine()` returns false. Assert `createEngine()` returns a `DigitalEngine` instance.
  - `src/engine/__tests__/worker-detection.test.ts::WorkerDetection::uses_worker_when_available` — Mock `Worker` and `SharedArrayBuffer` as available. Assert `canUseWorkerEngine()` returns true.
- **Acceptance criteria**:
  - `createEngine()` returns `DigitalEngine` in environments without Web Worker support
  - `createEngine()` returns `WorkerEngine` only when both SAB and Worker are available
  - Graceful fallback on Worker spawn failure
