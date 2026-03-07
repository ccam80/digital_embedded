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
- [ ] Task 2.1: sampleFn on ComponentDefinition
- [ ] Task 2.2: Two-Phase _stepLevel()
- [ ] Task 2.3a: Edge-Triggered Flip-Flops (Two-Phase)
- [ ] Task 2.3b: Counters and Registers (Two-Phase)
- [ ] Task 2.3c: Memory Components and PRNG (Two-Phase)

## Wave 3: Engine Subsystem Integration
- [ ] Task 3.1: Bus Resolution Integration
- [ ] Task 3.2: Noise Mode / Init Sequence Integration
- [ ] Task 3.3: Oscillation Detection Integration

## Wave 4: Clock and Switch Network
- [ ] Task 4.1: Clock Manager as External Utility
- [ ] Task 4.2: Switch Network Integration

## Wave 5: Web Worker Mode
- [ ] Task 5.1: Worker Init Protocol
- [ ] Task 5.2: Worker Signal Synchronization
- [ ] Task 5.3: createEngine Factory Fix

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
