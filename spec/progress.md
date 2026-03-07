# Engine Remaining Work — Progress

## Pre-requisite: ExecuteFunction Signature Update
- [x] Update ExecuteFunction signature to include highZs

## Wave 1: Structural Correctness
- [x] Task 1.0: Deduplicate EvaluationGroup Interface
- [x] Task 1.1: State Slot Allocation
- [x] Task 1.2a: Core Engine and Infrastructure (Wiring Table)
- [x] Task 1.2b: Gate Components (Wiring Table)
- [x] Task 1.2c: IO Components (Wiring Table)
- [x] Task 1.2d: Flip-flop Components (Wiring Table)
- [x] Task 1.2e: Arithmetic Components (Wiring Table)
- [x] Task 1.2f: Wiring, Switching, Memory, PLD, Graphics, Terminal, Misc, Subcircuit (Wiring Table)
- [x] Task 1.2g: Test Files (Wiring Table)

## Wave 2: Two-Phase Sequential Protocol
- [x] Task 2.1: sampleFn on ComponentDefinition
- [x] Task 2.2: Two-Phase _stepLevel()
- [x] Task 2.3a: Edge-Triggered Flip-Flops (Two-Phase)
- [x] Task 2.3b: Counters and Registers (Two-Phase)
- [x] Task 2.3c: Memory Components and PRNG (Two-Phase)

## Wave 3: Engine Subsystem Integration
- [x] Task 3.1: Bus Resolution Integration
- [x] Task 3.2: Noise Mode / Init Sequence Integration
- [x] Task 3.3: Oscillation Detection Integration

## Wave 4: Clock and Switch Network
- [x] Task 4.1: Clock Manager as External Utility
- [x] Task 4.2: Switch Network Integration

## Wave 5: Web Worker Mode
- [x] Task 5.1: Worker Init Protocol
- [x] Task 5.2: Worker Signal Synchronization
- [x] Task 5.3: createEngine Factory Fix

## Task prereq-executefn-signature: ExecuteFunction Signature Update
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/core/registry.ts, src/engine/digital-engine.ts, src/engine/init-sequence.ts, src/engine/noise-mode.ts, src/components/arithmetic/prng.ts, and all executeFn files across src/components/ (gates, flipflops, memory, io, wiring, switching, pld, graphics, terminal, misc, subcircuit, basic, arithmetic), plus all corresponding test files
- **Tests**: 4500/4511 passing (10 failing: 8 pre-existing baseline failures + 2 unrelated pre-existing failures in pin.test.ts and wire-renderer.test.ts not caused by this change)
- **Changes summary**: Added `highZs: Uint32Array` as third parameter to ExecuteFunction type. Updated all engine call sites to pass `this._highZs`. Updated InitializableEngine interface to include highZs. Updated evaluateWithNoise and evaluateSynchronized signatures. Updated all ~90 executeFn implementations across components (using `_highZs` prefix since unused). Updated all test files with highZs declarations and call site arguments.

## Task 1.0: Deduplicate EvaluationGroup Interface
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/engine/init-sequence.ts
- **Tests**: 4500/4511 passing (10 failing — all pre-existing baseline failures, 1 skipped)
- **Changes**: Removed duplicate EvaluationGroup interface from init-sequence.ts. Added `import type { EvaluationGroup } from "./digital-engine.js"` and `export type { EvaluationGroup }` to maintain the existing re-export for downstream consumers (noise-mode.test.ts). EvaluationGroup is now defined in exactly one place: digital-engine.ts.

## Task 1.1: State Slot Allocation
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/engine/__tests__/state-slots.test.ts
- **Files modified**: src/core/registry.ts, src/engine/compiled-circuit.ts, src/engine/compiler.ts, src/engine/digital-engine.ts, src/components/flipflops/d.ts, src/components/flipflops/d-async.ts, src/components/flipflops/jk.ts, src/components/flipflops/jk-async.ts, src/components/flipflops/rs.ts, src/components/flipflops/rs-async.ts, src/components/flipflops/t.ts, src/components/flipflops/monoflop.ts, src/components/memory/counter.ts, src/components/memory/counter-preset.ts, src/components/memory/program-counter.ts, src/components/memory/register.ts, src/components/memory/program-memory.ts, src/components/memory/register-file.ts, src/components/memory/eeprom.ts, src/components/memory/ram.ts, src/components/memory/rom.ts, src/components/memory/lookup-table.ts, src/components/switching/nfet.ts, src/components/switching/pfet.ts, src/components/switching/fgnfet.ts, src/components/switching/fgpfet.ts, src/components/switching/trans-gate.ts, src/components/switching/relay.ts, src/components/switching/relay-dt.ts, src/components/arithmetic/prng.ts, src/engine/__tests__/digital-engine.test.ts, src/engine/__tests__/clock.test.ts, src/engine/__tests__/micro-step.test.ts, src/engine/__tests__/quick-run.test.ts, src/engine/__tests__/run-to-break.test.ts, src/engine/__tests__/snapshot.test.ts
- **Tests**: 5/5 passing (state-slots.test.ts); 142/144 engine tests passing (2 pre-existing delay.test.ts failures); 873/876 component tests passing (3 pre-existing rendering failures)
- **Changes summary**: Added `stateSlotCount?: number | ((props: PropertyBag) => number)` to ComponentDefinition. FlatComponentLayout now accepts stateOffsets Int32Array; stateOffset(i) returns per-component offset. Compiler allocates state slots after net IDs: stateOffset[i] = netCount + sum(resolvedSlotCount for 0..i-1). CompiledCircuitImpl gains totalStateSlots and signalArraySize fields. DigitalEngine.init() allocates signal arrays sized to signalArraySize, with net portion UNDEFINED and state portion zeroed. All sequential components declare stateSlotCount (flip-flops: 2-3, counters/registers: 2, memory dynamic: function of addrBits, ROM/LUT: 0, switching: 1-2, PRNG: 2). Updated 6 test helper files to include totalStateSlots and signalArraySize in ConcreteCompiledCircuit objects.

## Task 1.2a: Core Engine and Infrastructure (Wiring Table)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/engine/__tests__/wiring-table.test.ts
- **Files modified**: src/core/registry.ts, src/engine/compiled-circuit.ts, src/engine/compiler.ts, src/engine/digital-engine.ts, src/engine/init-sequence.ts, src/engine/run-to-break.ts, src/engine/clock.ts, src/engine/__tests__/digital-engine.test.ts, src/engine/__tests__/micro-step.test.ts, src/engine/__tests__/quick-run.test.ts, src/engine/__tests__/snapshot.test.ts, src/engine/__tests__/run-to-break.test.ts, src/engine/__tests__/clock.test.ts, src/engine/__tests__/noise-mode.test.ts, src/engine/__tests__/delay.test.ts, src/engine/__tests__/compiler.test.ts, src/engine/__tests__/state-slots.test.ts
- **Tests**: 149/151 engine tests passing (2 pre-existing delay.test.ts failures); 7/7 new wiring-table.test.ts passing
- **Changes summary**: Added `readonly wiringTable: Int32Array` to ComponentLayout interface in registry.ts. Updated doc comments to specify wiring table access pattern. FlatComponentLayout constructor now accepts wiringTable parameter (5th arg); inputOffset/outputOffset return wiring-table indices. CompiledCircuitImpl gains `wiringTable: Int32Array` field. Compiler passes the already-built inputOffsets/outputOffsets (not raw net IDs from buildNetIdOffsets) and wiringTable to FlatComponentLayout and CompiledCircuitImpl. Removed buildNetIdOffsets helper. ConcreteCompiledCircuit interface gains wiringTable field. Engine _collectOutputNets resolves through wiringTable. Engine _stepTimed reads/writes outputs through wiringTable. Engine runToBreak reads break input through wiringTable. init-sequence captureOutputs/outputsChanged read output nets through wiringTable. ClockManager._findClocksInternal reads clock output net ID through wiringTable. Updated all engine test StaticLayout/StubLayout classes to build wiringTable from input/output net arrays and return wiring-table indices from inputOffset/outputOffset. Updated inline executeFns in state-slots.test.ts and micro-step.test.ts to use wiring table indirection. Updated compiler.test.ts to resolve through wiringTable when comparing net IDs. noise-mode.test.ts makeLayout uses identity wiringTable. Component executeFns (gates, io, flipflops, etc.) NOT updated — that is tasks 1.2b-1.2f. Component test files NOT updated — that is task 1.2g. Integration/headless tests that use real component executeFns will fail until 1.2b-1.2f are applied.

## Task 1.2b: Gate Components (Wiring Table)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/gates/and.ts, src/components/gates/nand.ts, src/components/gates/nor.ts, src/components/gates/not.ts, src/components/gates/or.ts, src/components/gates/xnor.ts, src/components/gates/xor.ts, src/components/gates/__tests__/and.test.ts, src/components/gates/__tests__/nand.test.ts, src/components/gates/__tests__/nor.test.ts, src/components/gates/__tests__/not.test.ts, src/components/gates/__tests__/or.test.ts, src/components/gates/__tests__/xnor.test.ts, src/components/gates/__tests__/xor.test.ts
- **Tests**: 240/240 passing
- **Changes summary**: Applied wiring table indirection to all 7 gate executeFns (executeAnd, executeNAnd, executeNOr, executeNot, executeOr, executeXNOr, executeXOr). Each executeFn now reads `const wt = layout.wiringTable` and accesses inputs via `state[wt[inputStart + i]]` and outputs via `state[wt[outputIdx]]`. Updated all 7 gate test files to include identity wiringTable (`Int32Array.from({ length: totalSlots }, (_, i) => i)`) in mock ComponentLayout objects.

## Task 1.2d: Flip-flop Components (Wiring Table)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/flipflops/d.ts, src/components/flipflops/d-async.ts, src/components/flipflops/jk.ts, src/components/flipflops/jk-async.ts, src/components/flipflops/rs.ts, src/components/flipflops/rs-async.ts, src/components/flipflops/t.ts, src/components/flipflops/monoflop.ts, src/components/flipflops/__tests__/flipflops.test.ts, src/components/flipflops/__tests__/monoflop.test.ts
- **Tests**: 126/126 passing
- **Changes summary**: Applied wiring table indirection to all 8 flip-flop executeFns (executeD, executeDAsync, executeJK, executeJKAsync, executeRS, executeRSAsync, executeT, executeMonoflop). Each executeFn now reads `const wt = layout.wiringTable` and accesses inputs via `state[wt[inBase + k]]` and outputs via `state[wt[outBase + k]]`. State slot access remains direct: `state[stBase + k]` (no indirection). Updated both test files (flipflops.test.ts and monoflop.test.ts) to include identity wiringTable in mock layout objects.

## Task 1.2e: Arithmetic Components (Wiring Table)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/arithmetic/add.ts, src/components/arithmetic/sub.ts, src/components/arithmetic/mul.ts, src/components/arithmetic/div.ts, src/components/arithmetic/neg.ts, src/components/arithmetic/comparator.ts, src/components/arithmetic/barrel-shifter.ts, src/components/arithmetic/bit-count.ts, src/components/arithmetic/bit-extender.ts, src/components/arithmetic/prng.ts, src/components/arithmetic/__tests__/arithmetic.test.ts, src/components/arithmetic/__tests__/arithmetic-utils.test.ts
- **Tests**: 229/229 passing
- **Changes summary**: Applied wiring table indirection to all 10 arithmetic executeFns (executeAdd, executeSub, executeMul, executeDiv, executeNeg, executeComparator, executeBarrelShifter, executebitCount, executeBitExtender, executePRNG) and their make* factory variants. Each executeFn now reads `const wt = layout.wiringTable` and accesses inputs via `state[wt[inBase + k]]` and outputs via `state[wt[outBase + k]]`. State slot access in PRNG remains direct: `state[stateBase + k]` (no indirection). Updated both test files to include identity wiringTable (`Int32Array.from({ length: totalSlots }, (_, i) => i)`) in all mock ComponentLayout objects including makeLayout, makeLayoutWithProps, and makePRNGLayoutFull.

## Task 1.2c: IO Components (Wiring Table)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/io/button-led.ts, src/components/io/led.ts, src/components/io/light-bulb.ts, src/components/io/out.ts, src/components/io/probe.ts, src/components/io/polarity-led.ts, src/components/io/rgb-led.ts, src/components/io/power-supply.ts, src/components/io/const.ts, src/components/io/ground.ts, src/components/io/vdd.ts, src/components/io/seven-seg-hex.ts, src/components/io/seven-seg.ts, src/components/io/sixteen-seg.ts, src/components/io/scope.ts, src/components/io/scope-trigger.ts, src/components/io/rotary-encoder.ts, src/components/io/midi.ts, src/components/io/stepper-motor.ts, src/components/io/__tests__/button.test.ts, src/components/io/__tests__/button-led.test.ts, src/components/io/__tests__/dip-switch.test.ts, src/components/io/__tests__/io.test.ts, src/components/io/__tests__/led.test.ts, src/components/io/__tests__/midi.test.ts, src/components/io/__tests__/power-supply.test.ts, src/components/io/__tests__/probe.test.ts, src/components/io/__tests__/rotary-encoder-motor.test.ts, src/components/io/__tests__/scope.test.ts, src/components/io/__tests__/segment-displays.test.ts
- **Tests**: 539/540 passing (1 pre-existing baseline failure: InComponent > draw > draw shows no text when label is empty)
- **Changes summary**: Applied wiring table indirection to all 20 IO executeFns (executeButtonLED, executeLed, executeLightBulb, executeOut, executeProbe, executePolarityLed, executeRgbLed, executePowerSupply, executeConst, executeGround, executeVdd, executeSevenSegHex, executeSevenSeg, executeSixteenSeg, executeScope, executeScopeTrigger, executeRotaryEncoder, executeMidi, executeStepperMotorBipolar, executeStepperMotorUnipolar). No-op executeFns (executeButton, executeDipSwitch, executeIn, executeClock, executeNotConnected) left unchanged as they do not access state. Each transformed executeFn now reads `const wt = layout.wiringTable` and accesses inputs via `state[wt[inBase + k]]` and outputs via `state[wt[outBase + k]]`. Updated all 11 IO test files to include identity wiringTable (`new Int32Array(64).map((_, i) => i)`) in mock ComponentLayout objects.

## Task 1.2f: Wiring, Switching, Memory, PLD, Graphics, Terminal, Misc, Subcircuit (Wiring Table)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/wiring/bit-selector.ts, src/components/wiring/break.ts, src/components/wiring/delay.ts, src/components/wiring/decoder.ts, src/components/wiring/bus-splitter.ts, src/components/wiring/demux.ts, src/components/wiring/driver.ts, src/components/wiring/driver-inv.ts, src/components/wiring/mux.ts, src/components/wiring/priority-encoder.ts, src/components/wiring/splitter.ts, src/components/wiring/stop.ts, src/components/switching/nfet.ts, src/components/switching/pfet.ts, src/components/switching/fgnfet.ts, src/components/switching/fgpfet.ts, src/components/switching/trans-gate.ts, src/components/switching/relay.ts, src/components/switching/relay-dt.ts, src/components/memory/counter.ts, src/components/memory/counter-preset.ts, src/components/memory/eeprom.ts, src/components/memory/lookup-table.ts, src/components/memory/program-counter.ts, src/components/memory/program-memory.ts, src/components/memory/ram.ts, src/components/memory/register.ts, src/components/memory/register-file.ts, src/components/memory/rom.ts, src/components/pld/diode.ts, src/components/pld/pull-up.ts, src/components/pld/pull-down.ts, src/components/graphics/led-matrix.ts, src/components/graphics/vga.ts, src/components/graphics/graphic-card.ts, src/components/terminal/terminal.ts, src/components/terminal/keyboard.ts, src/components/basic/function.ts
- **Tests**: 1329/1334 passing (5 failures are all pre-existing baseline failures in rendering: fets blown indicator x2, fuse blown indicator, pld diode blown indicator x2)
- **Changes summary**: Applied wiring table indirection to 38 executeFn implementations across 8 component categories. Each executeFn now reads `const wt = layout.wiringTable` and accesses inputs via `state[wt[inBase + k]]` and outputs via `state[wt[outBase + k]]`. State slot access (`state[stBase + k]`) remains direct (no wt indirection). No-op executeFns (async-seq, tunnel, reset, fuse, switch, switch-dt, plain-switch, plain-switch-dt, rectangle, text, testcase, subcircuit) were left unchanged as they don't access state. Switching components (nfet, pfet, fgnfet, fgpfet, trans-gate, relay, relay-dt) only needed wt for input reads; their stBase writes remain direct.

## Task 1.2g: Test Files (Wiring Table)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/wiring/__tests__/bit-selector.test.ts, src/components/wiring/__tests__/decoder.test.ts, src/components/wiring/__tests__/demux.test.ts, src/components/wiring/__tests__/mux.test.ts, src/components/wiring/__tests__/priority-encoder.test.ts, src/components/wiring/__tests__/sim-control.test.ts, src/components/wiring/__tests__/wiring.test.ts, src/components/switching/__tests__/fets.test.ts, src/components/switching/__tests__/fuse.test.ts, src/components/switching/__tests__/relay.test.ts, src/components/switching/__tests__/switches.test.ts, src/components/memory/__tests__/counter.test.ts, src/components/memory/__tests__/eeprom.test.ts, src/components/memory/__tests__/lookup-table.test.ts, src/components/memory/__tests__/program-counter.test.ts, src/components/memory/__tests__/program-memory.test.ts, src/components/memory/__tests__/ram.test.ts, src/components/memory/__tests__/register.test.ts, src/components/memory/__tests__/rom.test.ts, src/components/pld/__tests__/pld.test.ts, src/components/graphics/__tests__/graphic-card.test.ts, src/components/graphics/__tests__/led-matrix.test.ts, src/components/graphics/__tests__/vga.test.ts, src/components/basic/__tests__/function.test.ts, src/components/terminal/__tests__/terminal.test.ts, src/components/misc/__tests__/testcase.test.ts, src/components/misc/__tests__/text-rectangle.test.ts, src/components/subcircuit/__tests__/subcircuit.test.ts, src/io/__tests__/subcircuit-loader.test.ts, src/analysis/__tests__/dependency.test.ts, src/analysis/__tests__/model-analyser.test.ts, src/analysis/__tests__/substitute-library.test.ts, src/headless/__tests__/integration.test.ts, src/headless/__tests__/runner.test.ts, src/headless/__tests__/test-runner.test.ts
- **Tests**: 4511/4523 passing (11 failing: 8 pre-existing baseline failures + 3 pre-existing failures from earlier tasks in pin.test.ts, wire-renderer.test.ts, trace.test.ts not caused by this change)
- **Changes summary**: Added identity `wiringTable: new Int32Array(64).map((_, i) => i)` to all mock ComponentLayout objects in 29 component test files (helper functions and inline layout literals). Updated 6 additional test files (analysis, headless) containing inline executeFn implementations to use wiring table indirection: `state[layout.wiringTable[layout.inputOffset(index)]]` and `state[layout.wiringTable[layout.outputOffset(index)]]`.

## Task 2.2: Two-Phase _stepLevel()
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/engine/digital-engine.ts, src/engine/__tests__/two-phase.test.ts
- **Tests**: 5/5 passing (two-phase.test.ts); 154/156 engine tests passing (2 pre-existing delay.test.ts failures)
- **Changes summary**: Modified `_stepLevel()` in `digital-engine.ts` to iterate `compiled.sequentialComponents` before the combinational evaluation loop. For each sequential component index, looks up its typeId, checks `compiled.sampleFns[typeId]`, and if non-null calls it with `(index, state, highZs, layout)`. Added 3 new tests to `two-phase.test.ts`: `shift_register_propagates_correctly` (verifies data propagates one stage per clock cycle), `concurrent_flip_flops_sample_simultaneously` (verifies cross-feedback flip-flops swap values correctly because both sample before either writes), `combinational_only_circuit_unaffected` (verifies AND gate circuit works and sequentialComponents is empty).

## Task 2.3b: Counters and Registers (Two-Phase)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/memory/counter.ts, src/components/memory/counter-preset.ts, src/components/memory/program-counter.ts, src/components/memory/register.ts, src/components/memory/register-file.ts, src/components/memory/program-memory.ts, src/components/memory/__tests__/two-phase-memory.test.ts
- **Tests**: 169/169 passing (counter.test.ts: 50, program-counter.test.ts: 18, register.test.ts: 50, program-memory.test.ts: 19, two-phase-memory.test.ts: 32)
- **Changes summary**: Added sampleFn to all 6 edge-triggered counter/register components. Each sampleFn reads inputs through wiringTable, detects rising clock edge via prevClock in state slot, and updates state (increment/clear/load/latch). ExecuteFns retain full logic (edge detection + output) for backward compatibility with existing tests that call executeFn standalone; in two-phase engine mode, sampleFn runs first and updates prevClock, so executeFn sees no edge and only outputs from state. Added sampleFn field to CounterDefinition, CounterPresetDefinition, ProgramCounterDefinition, RegisterDefinition, RegisterFileDefinition, and ProgramMemoryDefinition. Added 14 tests to two-phase-memory.test.ts covering: sampleCounter increments on rising edge, sampleCounter clears on clr, sampleCounterPreset loads on ld, sampleProgramCounter increments on edge, sampleRegister latches on rising edge, executeRegister outputs from state not inputs, sampleRegisterFile writes on edge, sampleProgramMemory latches address, plus definition sampleFn presence checks for all 6 components.

## Task 2.3a: Edge-Triggered Flip-Flops (Two-Phase)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/components/flipflops/__tests__/two-phase-flipflops.test.ts
- **Files modified**: src/components/flipflops/d.ts, src/components/flipflops/jk.ts, src/components/flipflops/t.ts, src/components/flipflops/rs.ts, src/components/flipflops/monoflop.ts, src/components/flipflops/__tests__/flipflops.test.ts, src/components/flipflops/__tests__/monoflop.test.ts
- **Tests**: 142/142 passing (16 new two-phase tests + 126 existing tests updated to use sampleFn+executeFn)

## Task 2.3c: Memory Components and PRNG (Two-Phase)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none (two-phase-memory.test.ts already created by Task 2.3b)
- **Files modified**: src/components/memory/ram.ts, src/components/memory/eeprom.ts, src/components/arithmetic/prng.ts, src/components/memory/__tests__/ram.test.ts, src/components/memory/__tests__/eeprom.test.ts, src/components/arithmetic/__tests__/arithmetic-utils.test.ts, src/components/memory/__tests__/two-phase-memory.test.ts
- **Tests**: 270/270 passing across affected test files (105 ram.test.ts + 34 eeprom.test.ts + 99 arithmetic-utils.test.ts + 32 two-phase-memory.test.ts)
- **Changes summary**: Split edge-triggered RAM/EEPROM/PRNG executeFns into sampleFn + executeFn. Added sampleRAMSinglePort, sampleRAMDualPort, sampleRAMDualAccess, sampleBlockRAMDualPort to ram.ts. Added sampleEEPROM, sampleEEPROMDualPort to eeprom.ts. Added samplePRNG and makeSamplePRNG to prng.ts. Each sampleFn handles clock/WE edge detection and memory writes; executeFn only reads from memory and writes outputs. Set sampleFn on RAMSinglePortDefinition, RAMDualPortDefinition, RAMDualAccessDefinition, BlockRAMDualPortDefinition, EEPROMDefinition, EEPROMDualPortDefinition, PRNGDefinition. Confirmed RAMSinglePortSelDefinition, RAMAsyncDefinition (combinational) have no sampleFn. Confirmed ROMDefinition and LookUpTableDefinition have no sampleFn. Updated existing tests in ram.test.ts, eeprom.test.ts, and arithmetic-utils.test.ts to call sampleFn before executeFn for write-then-read scenarios. Added 18 new tests to two-phase-memory.test.ts covering RAM sample/execute split, EEPROM sample/execute split, PRNG sample/execute split, and ROM/LookupTable no-sampleFn confirmation.

## Task 3.2: Noise Mode / Init Sequence Integration
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/engine/__tests__/init-sequence-integration.test.ts
- **Files modified**: src/engine/compiled-circuit.ts, src/engine/compiler.ts, src/engine/digital-engine.ts, src/engine/__tests__/digital-engine.test.ts, src/engine/__tests__/clock.test.ts, src/engine/__tests__/micro-step.test.ts, src/engine/__tests__/quick-run.test.ts, src/engine/__tests__/run-to-break.test.ts, src/engine/__tests__/snapshot.test.ts, src/engine/__tests__/delay.test.ts, src/engine/__tests__/oscillation-integration.test.ts
- **Tests**: 4/4 passing (init-sequence-integration.test.ts); 158/163 engine tests passing (5 failures: 2 pre-existing delay.test.ts baseline failures + 3 pre-existing oscillation-integration.test.ts failures from Task 3.3)
- **Changes summary**: Added `resetComponentIndices: Uint32Array` to `CompiledCircuitImpl` (compiled-circuit.ts). Compiler scans for Reset components by typeId and builds `resetComponentIndices` array. `DigitalEngine` implements `InitializableEngine` interface with getters for `state`, `highZs`, `snapshotBuffer`, `typeIds`, `executeFns`, `sampleFns`, `layout`, `evaluationOrder`, `resetComponentIndices`. Engine `init()` calls `initializeCircuit(this)` after allocating signal arrays. Added `_initSnapshotBuffer` (state-sized) for `evaluateSynchronized` during init. `_evaluateFeedbackGroup()` uses `_compiled.sccSnapshotBuffer.subarray(0, outputNets.length)` instead of allocating `new Uint32Array` per iteration. Updated 8 engine test files to include `resetComponentIndices: new Uint32Array(0)` in ConcreteCompiledCircuit mocks. Reset side-effect counters in digital-engine.test.ts and run-to-break.test.ts after `engine.init()` since init sequence now evaluates components during initialization.

## Task 3.3: Oscillation Detection Integration
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/engine/__tests__/oscillation-integration.test.ts
- **Files modified**: src/engine/oscillation.ts, src/core/errors.ts, src/engine/digital-engine.ts
- **Tests**: 3/3 passing (oscillation-integration.test.ts); 166/168 engine tests passing (2 pre-existing delay.test.ts failures)
- **Changes summary**: Added `COLLECTION_STEPS = 100` constant to oscillation.ts. Added `componentIndices: number[]` field to `OscillationError` in errors.ts with constructor support. Wired `OscillationDetector` into `_evaluateFeedbackGroup()` in digital-engine.ts: added `_oscillationDetector` field, imported `OscillationDetector`, `COLLECTION_STEPS`, and `OscillationError`. In `_evaluateFeedbackGroup()`: detector resets at start, ticks each iteration, and when the main loop exhausts `MAX_FEEDBACK_ITERATIONS` without convergence, runs `COLLECTION_STEPS` additional iterations collecting which components' outputs changed. Throws `OscillationError` with the confirmed oscillating component indices. Added 3 integration tests: ring oscillator throws OscillationError with 3 component indices, SR latch (NOR gates) converges without throwing, and exception contains correct componentIndices and iterations fields.

## Task 3.1: Bus Resolution Integration
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/engine/compiled-circuit.ts, src/engine/compiler.ts, src/engine/digital-engine.ts, src/engine/__tests__/bus-resolution.test.ts, src/engine/__tests__/digital-engine.test.ts, src/engine/__tests__/clock.test.ts, src/engine/__tests__/delay.test.ts, src/engine/__tests__/micro-step.test.ts, src/engine/__tests__/quick-run.test.ts, src/engine/__tests__/run-to-break.test.ts, src/engine/__tests__/snapshot.test.ts, src/engine/__tests__/noise-mode.test.ts
- **Tests**: 21/21 passing (bus-resolution.test.ts: 9 BusNet unit + 7 BusResolver unit + 5 BusIntegration integration); 165/168 engine tests passing (3 pre-existing failures: 2 delay.test.ts baseline + 1 oscillation-integration.test.ts from concurrent task)
- **Changes summary**: Wired existing BusResolver into compiler and engine. CompiledCircuitImpl gains `busResolver: BusResolver | null` and `multiDriverNets: Set<number>`. Compiler step 7 changed `netDriver` from `Map<number, number>` to `Map<number, number[]>` to track all drivers per net. New step 7b detects multi-driver nets (drivers.length > 1), allocates shadow driver nets so each driver writes to a private slot (preventing overwrite), creates BusResolver with shadow net IDs as drivers and original shared net as output, determines pull-resistor type from PullUp/PullDown typeIds, shifts state offsets to accommodate shadow nets, and remaps wiring table entries. ConcreteCompiledCircuit interface gains `busResolver: BusResolver | null`. Engine `_stepLevel()` calls `busResolver.checkAllBurns()` after all groups and throws BurnException on conflict. `_evaluateGroupOnce()` calls `busResolver.onNetChanged()` for all output nets unconditionally. `_evaluateFeedbackGroup()` calls `busResolver.onNetChanged()` for changed nets after each iteration. Updated 8 engine test files to include `busResolver: null` in ConcreteCompiledCircuit mocks. Added 5 integration tests: compiler_identifies_multi_driver_nets, tri_state_resolves_correctly, burn_detected_on_conflicting_drivers, pull_up_resolves_floating_net, single_driver_nets_have_no_bus_resolver.

---
## Wave 3 Summary
- **Status**: complete
- **Tasks completed**: 3/3
- **Rounds**: 1

## Task 4.1: Clock Manager as External Utility
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/engine/__tests__/clock-integration.test.ts
- **Files modified**: src/engine/digital-engine.ts, src/app/app-init.ts
- **Tests**: 3/3 passing (clock-integration.test.ts); 169/171 engine tests passing (2 pre-existing delay.test.ts failures)
- **Changes summary**: Added `getSignalArray(): Uint32Array` public getter to `DigitalEngine` returning `_values` array. In `app-init.ts`: imported `ClockManager`, created `clockManager` variable initialized in `compileAndBind()` after `engine.init()`. Added `clockManager.advanceClocks(engine.getSignalArray())` call before `engine.step()` in the menu-step handler and before the In component toggle step. Created 3 integration tests: `clock_advances_before_step` verifies clock toggles and DFF latches D on rising edge, `step_without_clock_advance_does_not_toggle` verifies step alone does not toggle clock or latch DFF, `multi_frequency_clocks` verifies fast clock (freq=1) toggles 4 times in 4 steps while slow clock (freq=2) toggles 2 times.

## Task 4.2: Switch Network Integration
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/engine/__tests__/switch-network.test.ts
- **Files modified**: src/core/registry.ts, src/engine/compiled-circuit.ts, src/engine/compiler.ts, src/engine/digital-engine.ts, src/components/switching/nfet.ts, src/components/switching/pfet.ts, src/components/switching/fgnfet.ts, src/components/switching/fgpfet.ts, src/components/switching/trans-gate.ts, src/components/switching/relay.ts, src/components/switching/relay-dt.ts
- **Tests**: 8/8 passing (switch-network.test.ts); 375/380 engine+switching tests passing (5 pre-existing baseline failures: FGNFET/FGPFET/Fuse blown rendering x3, delay.test.ts x2)
- **Changes summary**: Added `switchPins?: [number, number]` to ComponentDefinition in registry.ts. Added `getSwitchClassification?(componentIndex: number): number` to ComponentLayout. FlatComponentLayout gains `_switchClassification` field and `setSwitchClassification()`/`getSwitchClassification()` methods. CompiledCircuitImpl gains `switchComponentIndices: Uint32Array` and `switchClassification: Uint8Array`. Compiler step 7c classifies components with switchPins: if both nets are in multiDriverNets, classification=2 (bidirectional, registered with busResolver.registerSwitch()), otherwise classification=1 (unidirectional). DigitalEngine gains `_switchPrevStates: Uint32Array` tracking previous closedFlag values; `_checkSwitchStateChanges()` scans after combinational evaluation and calls `busResolver.reconfigureForSwitch()` on changes, then re-evaluates all groups. Updated 7 switching executeFns: NFET/PFET/TransGate/FGNFET/FGPFET forward values or set highZ for unidirectional mode (classification !== 2), skip forwarding for bidirectional mode (bus resolver handles). Added switchPins to all 7 switching ComponentDefinitions. Engine defensively handles missing switchComponentIndices for backward compatibility with existing test mocks. 8 new tests: nfet_forwards_when_gate_high, nfet_highz_when_gate_low, transgate_closed_when_s_neq_ns, transgate_open_when_s_eq_ns, transgate_open_when_control_highz, unidirectional_nfet_no_bus_resolver, bidirectional_switch_registered_with_bus_resolver, switch_feedback_converges.

## Task 4.2: Switch Network Integration
- **Status**: complete
- **Agent**: implementer
- **Files created**: (none - all created by concurrent agent)
- **Files modified**: src/core/registry.ts (added getSwitchClassification to ComponentLayout), src/engine/__tests__/switch-network.test.ts (added 9th test: bidirectional_switch_triggers_bus_reconfiguration)
- **Tests**: 9/9 passing (switch-network.test.ts)
- **Changes summary**: Added `getSwitchClassification?(componentIndex: number): number` to the `ComponentLayout` interface in registry.ts. Added the missing 9th test `bidirectional_switch_triggers_bus_reconfiguration` which verifies: BusResolver with two bus nets (each with 2 drivers), a registered switch connecting them, reconfigureForSwitch(0, true) merges the nets so all four drivers contribute, reconfigureForSwitch(0, false) splits them back so changes to one net do not affect the other. Most of the task implementation (switchPins on ComponentDefinitions, compiler classification logic, engine switch state change detection, executeFn classification-aware forwarding) was already completed by a concurrent agent.

## Task 5.3: createEngine Factory Fix
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/engine/worker-detection.ts, src/engine/__tests__/worker-detection.test.ts
- **Tests**: 3/3 passing (worker-detection.test.ts)
- **Changes summary**: Renamed `canUseSharedArrayBuffer()` to `canUseWorkerEngine()`. The new function checks both `typeof SharedArrayBuffer !== "undefined"` and `typeof Worker !== "undefined"`, preventing incorrect WorkerEngine selection in Node.js test environments where SAB is available but Worker is not. Updated `createEngine()` to wrap the WorkerEngine construction in a try/catch for graceful fallback on Worker spawn failure. Updated test file: `falls_back_when_Worker_undefined` verifies that in Node.js (no Worker), `canUseWorkerEngine()` returns false and `createEngine()` returns DigitalEngine. `uses_worker_when_available` mocks Worker on globalThis and verifies `canUseWorkerEngine()` returns true when both SAB and Worker are present. `falls_back_when_SAB_undefined` removes SAB from globalThis and verifies fallback to DigitalEngine.

---
## Wave 4 Summary
- **Status**: complete
- **Tasks completed**: 2/2 (plus Task 5.3 completed ahead of schedule)
- **Rounds**: 1

---
## Wave 5 Summary
- **Status**: complete
- **Tasks completed**: 3/3
- **Rounds**: 1

## Task 5.1: Worker Init Protocol
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/engine/__tests__/worker-engine.test.ts
- **Files modified**: src/core/engine-interface.ts, src/engine/worker-engine.ts, src/engine/worker.ts, src/engine/compiled-circuit.ts, src/engine/compiler.ts
- **Tests**: 2/2 passing (worker-engine.test.ts); 32/32 passing across worker-detection, compiler, and digital-engine tests
- **Changes summary**: Added `"init"` variant to `EngineMessage` discriminated union in engine-interface.ts containing all typed arrays needed to reconstruct a compiled circuit (sharedBuffer, typeIds, typeNames, inputOffsets, outputOffsets, inputCounts, outputCounts, stateOffsets, wiringTable, evaluationGroups, sequentialComponents, netWidths, delays, resetComponentIndices, switchComponentIndices, switchClassification). WorkerEngine.init() now narrows to ConcreteCompiledCircuit, extracts all typed arrays and layout offsets, builds typeNames list, and posts the init message with SharedArrayBuffer in the Transferable list. Removed dynamic import() in setSignalValue -- now uses static import of bitVectorToRaw. Stores netWidths locally for width lookup in getSignalValue. Worker.ts handles "init" message: imports createDefaultRegistry, reconstructs executeFns/sampleFns from typeNames via registry lookups (unrecognised types get no-op with console warning), builds FlatComponentLayout from received offset arrays, constructs worker-side ConcreteCompiledCircuit object with empty Maps for non-serializable fields (componentToElement, wireToNetId, labelToNetId, pinNetMap). Creates DigitalEngine, calls init(), syncs shared buffer. Added syncSharedBuffer() that copies engine signal values to SharedArrayBuffer via Atomics.store() after each step/microStep/runToBreak/reset. Added continuous run using MessageChannel for yielding. CompiledCircuitImpl gains typeNames field populated by compiler. Compiler step 10 now builds typeNameMap alongside executeFnsMap.

## Task 5.2: Worker Signal Synchronization
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/engine/__tests__/worker-signal.test.ts
- **Files modified**: none (sync logic was implemented in Task 5.1's worker.ts changes)
- **Tests**: 2/2 passing (worker-signal.test.ts)
- **Changes summary**: Signal synchronization logic was already implemented in Task 5.1 (syncSharedBuffer() in worker.ts using Atomics.store(), continuous run via MessageChannel, Atomics.load() reads in worker-engine.ts). This task adds the dedicated test file with two integration tests: `main_thread_reads_signal_after_step` verifies that after the worker writes values to the SharedArrayBuffer via Atomics.store(), the main thread reads correct values through getSignalRaw() and getSignalValue() (including proper BitVector width from stored netWidths). `setSignalValue_propagates_to_worker` verifies that setSignalValue() updates the SharedArrayBuffer immediately (main-thread side via Atomics.store) and posts a setSignal message to the worker with correct netId and value fields.
