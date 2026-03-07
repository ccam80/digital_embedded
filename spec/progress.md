# Engine Remaining Work — Progress

## Pre-requisite: ExecuteFunction Signature Update
- [x] Update ExecuteFunction signature to include highZs

## Wave 1: Structural Correctness
- [x] Task 1.0: Deduplicate EvaluationGroup Interface
- [x] Task 1.1: State Slot Allocation
- [ ] Task 1.2a: Core Engine and Infrastructure (Wiring Table)
- [ ] Task 1.2b: Gate Components (Wiring Table)
- [ ] Task 1.2c: IO Components (Wiring Table)
- [ ] Task 1.2d: Flip-flop Components (Wiring Table)
- [ ] Task 1.2e: Arithmetic Components (Wiring Table)
- [ ] Task 1.2f: Wiring, Switching, Memory, PLD, Graphics, Terminal, Misc, Subcircuit (Wiring Table)
- [ ] Task 1.2g: Test Files (Wiring Table)

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
