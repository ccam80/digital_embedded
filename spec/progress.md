# Engine Remaining Work — Progress

## Pre-requisite: ExecuteFunction Signature Update
- [ ] Update ExecuteFunction signature to include highZs

## Wave 1: Structural Correctness
- [ ] Task 1.0: Deduplicate EvaluationGroup Interface
- [ ] Task 1.1: State Slot Allocation
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
