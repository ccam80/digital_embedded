# Phase 5: Component Library

**Depends on**: Phase 1 (complete)
**Parallel with**: Phases 2, 3, 4
**Blocks**: Phase 6 (Core Integration)
**CHECKPOINT**: Task 5.1.1 (And gate exemplar) must be reviewed by the author before remaining components proceed. See `spec/author_instructions.md` § Checkpoint 2.

## Overview

Implement all ~110 component types from Digital's component library. Each component provides: a `CircuitElement` class (rendering, properties, serialization), a standalone flat `executeFn` (simulation logic operating on `Uint32Array`), `.dig` attribute mappings, and complete unit tests. Every component follows the exemplar pattern established by the And gate.

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **Exemplar-first.** The And gate (task 5.1.1) is implemented first and establishes the exact pattern. Every subsequent component copies this pattern. No deviations.
- **Internal state as pseudo-nets.** Stateful components (flip-flops, counters, registers) declare `internalStateCount` in their `ComponentDefinition`. The compiler allocates extra `Uint32Array` slots per instance. The executeFn accesses internal state via `layout.stateOffset(index)`.
- **RAM/ROM backing store.** Memory components declare `backingStoreType: 'datafield'`. The engine provides a `Map<number, DataField>` side-car. The executeFn accesses `backingStores.get(index)` for data read/write.
- **Interactive components.** User clicks change signal values via `engine.setSignalValue(netId, value)`. The executeFn for interactive inputs (Button, Switch) is a no-op or identity — the signal value is set externally.
- **Both gate shapes.** Every logic gate renders both IEEE/US (curved shapes) and IEC/DIN (rectangular with symbol). The active shape is determined by a global `wideShape` setting read from the `RenderContext`.
- **Full fidelity.** Every component is implemented completely. No stubs, no simplified behavior, no missing features. Reference: Digital's Java source exclusively.

## Reference Source

| What | Where |
|------|-------|
| Component simulation | `ref/Digital/src/main/java/de/neemann/digital/core/` (subdirectories per category) |
| Component shapes | `ref/Digital/src/main/java/de/neemann/digital/draw/shapes/` |
| Component descriptions | `ref/Digital/src/main/java/de/neemann/digital/draw/elements/` |
| Keys & attribute defaults | `ref/Digital/src/main/java/de/neemann/digital/core/element/Keys.java` |

## Component File Template

Every component file follows this structure (from `spec/author_instructions.md`):

```typescript
// src/components/<category>/<name>.ts

// 1. Imports
import type { CircuitElement, RenderContext } from '../../core/element';
import type { ComponentLayout } from '../../core/registry';
// ...

// 2. Component class implementing CircuitElement
//    - All properties declared with types
//    - draw() uses RenderContext abstraction, never Canvas2D directly
//    - NO simulation logic — that's in the flat function below
//    - help() returns documentation text

// 3. Flat execution function for compiled engine
//    - Standalone function, not a method
//    - Operates on Uint32Array state by index
//    - Zero allocations
//    - Reads inputs via layout.inputOffset(index) + pin index
//    - Writes outputs via layout.outputOffset(index) + pin index
//    - Reads/writes internal state via layout.stateOffset(index) + slot index
export function executeAnd(index: number, state: Uint32Array, layout: ComponentLayout): void { ... }

// 4. .dig attribute mapping registration
//    - Maps XML attribute names to component properties
//    - Uses converter functions from src/io/attribute-map.ts

// 5. ComponentDefinition for registry registration
//    - name, factory, executeFn, pinLayout, propertyDefs, attributeMap
//    - category, defaultDelay, internalStateCount, backingStoreType
export const AndDefinition: ComponentDefinition = { ... };
```

---

## Wave 5.1: Foundation Components (Exemplar + Core Types)

### Task 5.1.1 — And Gate (Exemplar Component)

- **Description**: The And gate is the **exemplar component**. It establishes the exact pattern that all ~109 remaining components must follow. This task must be completed and reviewed by the author before any other component work begins.

  **Simulation logic (executeAnd):**
  - Read N input values from state array (N = inputCount, configurable 2-5)
  - AND all input values together (bitwise AND across all bits)
  - Write result to output
  - Stateless (internalStateCount = 0)
  - Zero allocations

  **Properties:**
  - `inputCount: number` (default 2, range 2-5) — from .dig `Inputs`
  - `bitWidth: number` (default 1) — from .dig `Bits`
  - `wideShape: boolean` (default false) — from .dig `wideShape`
  - `inverterConfig: string[]` (default []) — from .dig `inverterConfig`
  - `label: string` (default "") — from .dig `Label`

  **Pin layout:**
  - N input pins on the left, labeled "in0"..."inN-1" (positions depend on inputCount)
  - 1 output pin on the right, labeled "out"
  - InverterConfig: pins listed in inverterConfig have `isNegated: true` (drawn with bubble)

  **Rendering (draw method):**
  - **IEEE/US shape** (when `wideShape` is true): Classic curved AND gate shape. Flat left edge, curved right edge meeting at output. Input pins on left, output pin on right. Inversion bubbles on negated inputs.
  - **IEC/DIN shape** (when `wideShape` is false): Rectangle with `&` symbol inside. Input pins on left, output pin on right.
  - Both shapes: draw pin labels if configured, draw component label if set.
  - Uses `RenderContext` abstraction exclusively (path, fill, stroke, text — never Canvas2D).

  **Attribute mappings:**
  - `Inputs` → `inputCount` (intConverter)
  - `Bits` → `bitWidth` (intConverter)
  - `wideShape` → `wideShape` (boolConverter)
  - `inverterConfig` → `inverterConfig` (inverterConfigConverter)
  - `Label` → `label` (stringConverter)

  **ComponentDefinition:**
  - `name: "And"`
  - `category: ComponentCategory.LOGIC`
  - `defaultDelay: 10`
  - `internalStateCount: 0`
  - `executeFn: executeAnd`

- **Files to create**:
  - `src/components/gates/and.ts`:
    - `AndElement` class implementing `CircuitElement`
    - `executeAnd(index: number, state: Uint32Array, layout: ComponentLayout): void`
    - `AndDefinition: ComponentDefinition`
    - `AND_ATTRIBUTE_MAPPINGS: AttributeMapping[]`

- **Tests**:
  - `src/components/gates/__tests__/and.test.ts::AndGate::executeAnd2Input` — inputs [0xFFFFFFFF, 0x0F0F0F0F] → output 0x0F0F0F0F
  - `src/components/gates/__tests__/and.test.ts::AndGate::executeAnd3Input` — inputs [0xFF, 0x0F, 0x03] → output 0x03
  - `src/components/gates/__tests__/and.test.ts::AndGate::allZeroInputs` — all inputs 0 → output 0
  - `src/components/gates/__tests__/and.test.ts::AndGate::allOnesInputs` — all inputs 0xFFFFFFFF → output 0xFFFFFFFF
  - `src/components/gates/__tests__/and.test.ts::AndGate::singleBit` — inputs [1, 1] → 1, [1, 0] → 0, [0, 1] → 0, [0, 0] → 0
  - `src/components/gates/__tests__/and.test.ts::AndGate::multiBit8` — 8-bit AND: [0xFF, 0x0F] → 0x0F
  - `src/components/gates/__tests__/and.test.ts::AndGate::zeroAllocation` — call executeAnd 1000 times, verify no allocations (profile check or manual inspection)
  - `src/components/gates/__tests__/and.test.ts::AndGate::pinLayout2Input` — AndDefinition with inputCount=2, verify 2 input pins + 1 output pin
  - `src/components/gates/__tests__/and.test.ts::AndGate::pinLayout5Input` — factory with inputCount=5, verify 5 input pins + 1 output pin
  - `src/components/gates/__tests__/and.test.ts::AndGate::attributeMapping` — DigEntry[Inputs=3, Bits=8, wideShape=true], apply mappings, verify PropertyBag
  - `src/components/gates/__tests__/and.test.ts::AndGate::drawIEEE` — create with wideShape=true, call draw() with mock RenderContext, verify path calls include curved AND shape
  - `src/components/gates/__tests__/and.test.ts::AndGate::drawIEC` — create with wideShape=false, call draw() with mock RenderContext, verify rect + "&" text
  - `src/components/gates/__tests__/and.test.ts::AndGate::drawInverterBubble` — inverterConfig=["in0"], verify draw() renders inversion bubble on first input
  - `src/components/gates/__tests__/and.test.ts::AndGate::definitionComplete` — verify AndDefinition has all required ComponentDefinition fields

- **Acceptance criteria**:
  - executeAnd produces correct output for all input combinations (1-bit and multi-bit)
  - Zero allocations in executeFn
  - Both IEEE/US and IEC/DIN rendering works
  - InverterConfig negation bubbles render correctly
  - All .dig attribute mappings work
  - ComponentDefinition has all fields populated
  - Help text provided
  - All tests pass
  - **CHECKPOINT: Author review before proceeding to remaining components**

---

### Task 5.1.2 — Remaining Standard Logic Gates

- **Description**: Implement `Or`, `Not`, `NAnd`, `NOr`, `XOr`, `XNOr` following the And gate exemplar pattern exactly. Each gate:
  - Has a standalone `executeFn` with the correct bitwise logic
  - Supports configurable input count (except Not: always 1 input)
  - Supports configurable bit width
  - Renders both IEEE/US and IEC/DIN shapes
  - Registers complete ComponentDefinition

  | Gate | Logic | IEC symbol | Inputs |
  |------|-------|-----------|--------|
  | Or | bitwise OR | `≥1` | 2-N |
  | Not | bitwise NOT | `1` | 1 |
  | NAnd | NOT(AND) | `&` with bubble | 2-N |
  | NOr | NOT(OR) | `≥1` with bubble | 2-N |
  | XOr | bitwise XOR | `=1` | 2-N |
  | XNOr | NOT(XOR) | `=1` with bubble | 2-N |

- **Files to create**:
  - `src/components/gates/or.ts` — `OrElement`, `executeOr`, `OrDefinition`
  - `src/components/gates/not.ts` — `NotElement`, `executeNot`, `NotDefinition`
  - `src/components/gates/nand.ts` — `NAndElement`, `executeNAnd`, `NAndDefinition`
  - `src/components/gates/nor.ts` — `NOrElement`, `executeNOr`, `NOrDefinition`
  - `src/components/gates/xor.ts` — `XOrElement`, `executeXOr`, `XOrDefinition`
  - `src/components/gates/xnor.ts` — `XNOrElement`, `executeXNOr`, `XNOrDefinition`

- **Tests** (per gate, in respective `__tests__/` files):
  - `::execute2Input` — correct truth table for 2 inputs
  - `::executeMultiInput` — correct result for 3+ inputs (except Not)
  - `::multiBit` — correct operation on multi-bit values
  - `::drawIEEE` — correct IEEE/US shape rendered
  - `::drawIEC` — correct IEC/DIN shape rendered (correct symbol)
  - `::attributeMapping` — .dig attributes map correctly
  - `::definitionComplete` — all ComponentDefinition fields present

- **Acceptance criteria**:
  - All 6 gates produce correct output for all input combinations
  - All render both gate shapes
  - All follow the And gate exemplar pattern exactly
  - All tests pass

---

### Task 5.1.3 — Basic I/O Components

- **Description**: Implement `In`, `Out`, `Clock`, `Const`, `Ground`, `VDD`, `NotConnected`. These are the fundamental circuit interface components.

  | Component | Behavior | Key properties |
  |-----------|----------|---------------|
  | In | Interactive toggle input. User clicks to change value. executeFn is identity (value set externally). | label, bitWidth, default value, small |
  | Out | Display component showing current value with configurable radix (bin/dec/hex). executeFn reads input, stores for display. | label, bitWidth, radix format |
  | Clock | Periodic signal source. Managed by ClockManager (Phase 3). executeFn is no-op (clock value set by engine). | label, frequency, runRealTime |
  | Const | Constant value source. executeFn writes fixed value to output. | value (bigint), bitWidth |
  | Ground | Always 0. executeFn writes 0. | (none) |
  | VDD | Always 1 (all bits). executeFn writes all-ones. | bitWidth |
  | NotConnected | Marks intentionally unconnected pin (suppresses warning). No simulation behavior. | (none) |

  `In` is **interactive**: during simulation, the user can click it to toggle its value (1-bit: toggle 0↔1; multi-bit: opens value editor dialog). The click handler calls `engine.setSignalValue(netId, newValue)`. The executeFn just passes through whatever value is in the signal array.

- **Files to create**:
  - `src/components/io/in.ts` — `InElement`, `executeIn`, `InDefinition`
  - `src/components/io/out.ts` — `OutElement`, `executeOut`, `OutDefinition`
  - `src/components/io/clock.ts` — `ClockElement`, `executeClock`, `ClockDefinition`
  - `src/components/io/const.ts` — `ConstElement`, `executeConst`, `ConstDefinition`
  - `src/components/io/ground.ts` — `GroundElement`, `executeGround`, `GroundDefinition`
  - `src/components/io/vdd.ts` — `VddElement`, `executeVdd`, `VddDefinition`
  - `src/components/io/not-connected.ts` — `NotConnectedElement`, `NotConnectedDefinition`

- **Tests** (per component):
  - `::execute` — correct output behavior
  - `::draw` — renders correctly (label shown, value display for Out)
  - `::attributeMapping` — .dig attributes map correctly
  - `::interactiveToggle` (In only) — verify toggle changes output value concept
  - `::radixDisplay` (Out only) — hex, decimal, binary display formatting

- **Acceptance criteria**:
  - All basic I/O components work correctly
  - In is interactive (value can be set externally)
  - Out displays values in configurable radix
  - Clock declares correct properties for ClockManager integration
  - All tests pass

---

### Task 5.1.4 — Basic Wiring: Driver, Splitter, Tunnel

- **Description**: Implement `Driver`, `DriverInvSel`, `Splitter`, `BusSplitter`, `Tunnel`. These handle signal routing and bus manipulation.

  | Component | Behavior | internalStateCount |
  |-----------|----------|-------------------|
  | Driver | Tri-state buffer: when enable is high, output = input; when enable is low, output = high-Z. | 0 |
  | DriverInvSel | Driver with inverted select (enable active-low). | 0 |
  | Splitter | Split a multi-bit bus into individual bits or sub-buses, or merge bits/sub-buses into a bus. Configurable via `Input Splitting` and `Output Splitting` string patterns (e.g., "4,4" splits 8-bit into two 4-bit). | 0 |
  | BusSplitter | Variant of Splitter with different visual representation. | 0 |
  | Tunnel | Named wire connection. Two Tunnels with the same label in the same circuit are electrically connected. No executeFn needed — net resolution (Phase 3) merges Tunnel nets. | 0 |

  `Tunnel` is special: it has no simulation behavior. Its purpose is purely for the net resolver to merge same-name nets. The executeFn is a no-op.

  `Splitter` is complex: the splitting pattern is a string like `"4,4"` or `"1,1,1,1,4"` that describes how a bus is divided. The executeFn must copy the appropriate bits between the wide bus pin and the individual narrow pins.

- **Files to create**:
  - `src/components/wiring/driver.ts` — `DriverElement`, `executeDriver`, `DriverDefinition`
  - `src/components/wiring/driver-inv.ts` — `DriverInvSelElement`, `executeDriverInvSel`, `DriverInvSelDefinition`
  - `src/components/wiring/splitter.ts` — `SplitterElement`, `executeSplitter`, `SplitterDefinition`
  - `src/components/wiring/bus-splitter.ts` — `BusSplitterElement`, `executeBusSplitter`, `BusSplitterDefinition`
  - `src/components/wiring/tunnel.ts` — `TunnelElement`, `TunnelDefinition`

- **Tests**:
  - `::Driver::enableHigh` — enable=1, input=0xFF → output=0xFF, highZ=0
  - `::Driver::enableLow` — enable=0 → output=highZ (all bits high-Z)
  - `::Splitter::split8to4and4` — 8-bit input 0xAB → outputs 0xA, 0xB
  - `::Splitter::merge4and4to8` — inputs 0xA, 0xB → 8-bit output 0xAB
  - `::Splitter::splitPattern` — "1,1,1,1,4" on 8-bit, verify correct bit extraction
  - `::Tunnel::noOpExecute` — executeFn does nothing (net merging handled by compiler)
  - `::Tunnel::sameNameConnection` — two Tunnels with same label, verify they declare same net label for net resolver

- **Acceptance criteria**:
  - Driver tri-state behavior correct
  - Splitter handles all splitting patterns correctly (split and merge)
  - Tunnel name-based connection works via net resolver
  - All tests pass

---

## Wave 5.2: All Remaining Standard Components

All tasks in this wave follow the exemplar pattern exactly. Each task lists the components to implement, their key behaviors, and state requirements. Components within a task can be implemented in parallel. Tasks within this wave can be implemented in parallel (no inter-task dependencies).

### Task 5.2.1 — Multiplexer & Routing

- **Description**: `Multiplexer`, `Demultiplexer`, `Decoder`, `BitSelector`, `PriorityEncoder`.

  | Component | Behavior | State |
  |-----------|----------|-------|
  | Multiplexer | Select one of N inputs based on selector bits. Output = input[selector]. | 0 |
  | Demultiplexer | Route input to one of N outputs based on selector. Selected output = input, others = 0. | 0 |
  | Decoder | N-bit input → 2^N one-hot outputs. Only output[input_value] is 1. | 0 |
  | BitSelector | Select a single bit from a multi-bit input. Output = input[selector]. | 0 |
  | PriorityEncoder | Outputs the index of the highest-priority (most significant) active input. | 0 |

- **Files to create**: `src/components/wiring/mux.ts`, `src/components/wiring/demux.ts`, `src/components/wiring/decoder.ts`, `src/components/wiring/bit-selector.ts`, `src/components/wiring/priority-encoder.ts`

- **Tests** (per component): truth table verification for representative cases, multi-bit operation, attribute mapping, rendering, definition completeness.

- **Acceptance criteria**: All components produce correct outputs. All tests pass.

---

### Task 5.2.2 — Simulation Control Components

- **Description**: `Delay`, `Break`, `Stop`, `Reset`, `AsyncSeq`.

  | Component | Behavior | State |
  |-----------|----------|-------|
  | Delay | Pass-through with configurable delay. In timed mode: schedules output at currentTime + delayValue. In level-by-level: pass-through. | 0 |
  | Break | Monitor input; when input goes high, signals the engine to halt (run-to-break). | 0 |
  | Stop | Like Break but terminates simulation entirely. | 0 |
  | Reset | During init, output is held low. After init, output goes high. Used to reset sequential circuits to known state. | 1 (init flag) |
  | AsyncSeq | Marks circuit as asynchronous sequential (no explicit clock). Propagation triggered by input changes only. | 0 |

- **Files to create**: `src/components/wiring/delay.ts`, `src/components/wiring/break.ts`, `src/components/wiring/stop.ts`, `src/components/wiring/reset.ts`, `src/components/wiring/async-seq.ts`

- **Tests**: Delay pass-through, Break assertion detection, Reset init/release protocol, AsyncSeq flag propagation.

- **Acceptance criteria**: All simulation control behaviors correct. All tests pass.

---

### Task 5.2.3 — Flip-Flops

- **Description**: `FlipflopD`, `FlipflopDAsync`, `FlipflopJK`, `FlipflopJKAsync`, `FlipflopRS`, `FlipflopRSAsync`, `FlipflopT`. Port from `ref/Digital/src/main/java/de/neemann/digital/core/flipflops/`.

  All flip-flops:
  - `internalStateCount: 1` (stored output value)
  - Clock input (edge-triggered for synchronous variants)
  - Async set/reset inputs (active-high clear/preset)
  - Q and Q̄ outputs
  - Edge detection: sample clock input, compare with stored previous value

  | Component | Logic | Inputs | State |
  |-----------|-------|--------|-------|
  | FlipflopD | Q = D on clock edge | D, C, Set, Clr | 1 |
  | FlipflopDAsync | Q = D immediately when enabled | D, En, Set, Clr | 1 |
  | FlipflopJK | J=1,K=0→set; J=0,K=1→reset; J=K=1→toggle | J, K, C, Set, Clr | 1 |
  | FlipflopJKAsync | JK without clock (level-sensitive) | J, K, En, Set, Clr | 1 |
  | FlipflopRS | S=1→set; R=1→reset; both=1→undefined | S, R, C, Set, Clr | 1 |
  | FlipflopRSAsync | RS without clock (level-sensitive) | S, R, En, Set, Clr | 1 |
  | FlipflopT | Toggle on clock edge when T=1 | T, C, Set, Clr | 1 |

- **Files to create**: `src/components/flipflops/d.ts`, `src/components/flipflops/d-async.ts`, `src/components/flipflops/jk.ts`, `src/components/flipflops/jk-async.ts`, `src/components/flipflops/rs.ts`, `src/components/flipflops/rs-async.ts`, `src/components/flipflops/t.ts`

- **Tests** (per flip-flop): truth table on clock edge, async set/clear, Q and Q̄ complementary, edge detection (rising vs falling), state persistence between edges.

- **Acceptance criteria**: All flip-flop behaviors match Digital's implementation. Edge detection correct. Async set/clear works. All tests pass.

---

### Task 5.2.4 — Monoflop

- **Description**: `Monoflop` — monostable multivibrator. On trigger (rising edge on input), output goes high for a configurable number of clock cycles, then returns to low.

  - `internalStateCount: 2` (counter + previous input for edge detection)
  - Properties: `timerDelay` (number of cycles)

- **Files to create**: `src/components/flipflops/monoflop.ts`

- **Tests**: trigger produces pulse of correct duration, retriggering behavior, edge detection.

- **Acceptance criteria**: Pulse timing correct. All tests pass.

---

### Task 5.2.5 — Basic Arithmetic

- **Description**: `Add`, `Sub`, `Mul`, `Div` — configurable bit width, carry/overflow/borrow flags. Port from `ref/Digital/src/main/java/de/neemann/digital/core/arithmetic/`.

  | Component | Operation | Outputs | Properties |
  |-----------|-----------|---------|------------|
  | Add | A + B + Cin | Sum, Cout | bitWidth, signed |
  | Sub | A - B - Bin | Diff, Bout | bitWidth, signed |
  | Mul | A * B | Product (2x width) | bitWidth, signed |
  | Div | A / B | Quotient, Remainder | bitWidth, signed, remainderPositive |

- **Files to create**: `src/components/arithmetic/add.ts`, `src/components/arithmetic/sub.ts`, `src/components/arithmetic/mul.ts`, `src/components/arithmetic/div.ts`

- **Tests**: correctness for unsigned and signed modes, carry/overflow detection, division by zero handling, multi-bit widths.

- **Acceptance criteria**: All arithmetic operations correct for both signed and unsigned modes. All tests pass.

---

### Task 5.2.6 — Arithmetic Utilities

- **Description**: `Neg`, `Comparator`, `BarrelShifter`, `BitCount`, `BitExtender`, `PRNG`.

  | Component | Operation | State |
  |-----------|-----------|-------|
  | Neg | Two's complement negation | 0 |
  | Comparator | A < B, A = B, A > B outputs | 0 |
  | BarrelShifter | Configurable shift (left, right, rotate left, rotate right, arithmetic right) | 0 |
  | BitCount | Count number of set bits | 0 |
  | BitExtender | Sign-extend or zero-extend from narrow to wide | 0 |
  | PRNG | Pseudo-random number generator (LFSR-based) | 1 (LFSR state) |

- **Files to create**: `src/components/arithmetic/neg.ts`, `src/components/arithmetic/comparator.ts`, `src/components/arithmetic/barrel-shifter.ts`, `src/components/arithmetic/bit-count.ts`, `src/components/arithmetic/bit-extender.ts`, `src/components/arithmetic/prng.ts`

- **Tests**: correctness for each operation, edge cases (zero, max value, sign extension), PRNG produces non-constant sequence.

- **Acceptance criteria**: All operations correct. All tests pass.

---

### Task 5.2.7 — Counters

- **Description**: `Counter`, `CounterPreset` — configurable bits, modulus, direction, carry/overflow. Port from `ref/Digital/src/main/java/de/neemann/digital/core/memory/Counter.java`.

  - `internalStateCount: 1` (current count value)
  - Properties: bitWidth, maxValue, direction (up/down), enable, clear, load, preset value

- **Files to create**: `src/components/memory/counter.ts`, `src/components/memory/counter-preset.ts`

- **Tests**: count up sequence, count down, overflow/wrap, clear, preset load, enable/disable.

- **Acceptance criteria**: All counter behaviors correct. All tests pass.

---

### Task 5.2.8 — Registers

- **Description**: `Register`, `RegisterFile` — edge-triggered storage. Port from `ref/Digital/src/main/java/de/neemann/digital/core/memory/Register.java`.

  | Component | Behavior | State |
  |-----------|----------|-------|
  | Register | Store D input on clock edge, output stored value. Enable gate. | 1 |
  | RegisterFile | N registers addressable by read/write address. 2 read ports, 1 write port. | N (one per register) |

- **Files to create**: `src/components/memory/register.ts`, `src/components/memory/register-file.ts`

- **Tests**: store and recall, enable gate, RegisterFile multi-register read/write, simultaneous read and write.

- **Acceptance criteria**: All register behaviors correct. All tests pass.

---

### Task 5.2.9 — RAM Components

- **Description**: `RAMSinglePort`, `RAMSinglePortSel`, `RAMDualPort`, `RAMDualAccess`, `RAMAsync`, `BlockRAMDualPort`. All use `backingStoreType: 'datafield'` for data storage. Port from `ref/Digital/src/main/java/de/neemann/digital/core/memory/RAM*.java`.

  | Component | Behavior | Properties |
  |-----------|----------|-----------|
  | RAMSinglePort | Single address bus, read/write on same port | addrBits, dataBits |
  | RAMSinglePortSel | RAMSinglePort with chip select | addrBits, dataBits |
  | RAMDualPort | Separate read and write address buses | addrBits, dataBits |
  | RAMDualAccess | Two independent read/write ports | addrBits, dataBits |
  | RAMAsync | Asynchronous RAM (combinational read) | addrBits, dataBits |
  | BlockRAMDualPort | Block RAM with synchronous read | addrBits, dataBits |

  All RAM components: expose memory contents interface for live memory viewer (Phase 7). Hex initialization from DataField.

- **Files to create**: `src/components/memory/ram.ts` (all RAM variants in one file, sharing common logic)

- **Tests**: write-then-read, address boundaries, DataField initialization, dual-port simultaneous access, async vs synchronous read timing.

- **Acceptance criteria**: All RAM variants behave correctly. DataField backing store works. All tests pass.

---

### Task 5.2.10 — ROM & EEPROM

- **Description**: `ROM`, `ROMDualPort`, `EEPROM`, `EEPROMDualPort`. Read-only (ROM) or electrically-erasable (EEPROM) memory. All use `backingStoreType: 'datafield'`. Port from `ref/Digital/src/main/java/de/neemann/digital/core/memory/ROM*.java`.

  ROM components support `isProgramMemory` flag for CPU instruction fetch integration, and `autoReload` for automatic reload from hex file on simulation reset.

- **Files to create**: `src/components/memory/rom.ts`, `src/components/memory/eeprom.ts`

- **Tests**: read from DataField, address boundary, isProgramMemory flag, EEPROM write and read-back, auto-reload flag.

- **Acceptance criteria**: All ROM/EEPROM behaviors correct. All tests pass.

---

### Task 5.2.11 — Specialty Memory

- **Description**: `LookUpTable`, `ProgramCounter`, `ProgramMemory`. Port from Digital's memory package.

  | Component | Behavior | State |
  |-----------|----------|-------|
  | LookUpTable | Combinational: output = table[input]. User-editable truth table. | datafield |
  | ProgramCounter | Counter that reads address from program memory. Jump/branch support. | 1 |
  | ProgramMemory | ROM with address auto-increment for instruction fetch. | datafield |

- **Files to create**: `src/components/memory/lookup-table.ts`, `src/components/memory/program-counter.ts`, `src/components/memory/program-memory.ts`

- **Tests**: LookUpTable lookup correctness, ProgramCounter increment and jump, ProgramMemory fetch sequence.

- **Acceptance criteria**: All specialty memory components correct. All tests pass.

---

### Task 5.2.12 — Switches

- **Description**: `Switch`, `SwitchDT`, `PlainSwitch`, `PlainSwitchDT`. Interactive toggle switches (SPST/SPDT). Port from `ref/Digital/src/main/java/de/neemann/digital/core/switching/Switch*.java`.

  Switches are **runtime-dynamic**: closing a switch merges two nets (handled by bus resolution, Phase 3 task 3.2.3). Opening splits them. The executeFn notifies the engine of switch state changes.

  | Component | Type | Behavior |
  |-----------|------|----------|
  | Switch | SPST | Close: connect two terminals. Open: disconnect. |
  | SwitchDT | SPDT | Common terminal connects to either A or B. |
  | PlainSwitch | SPST | Like Switch but with simpler rendering (no mechanical symbol). |
  | PlainSwitchDT | SPDT | Like SwitchDT with simpler rendering. |

- **Files to create**: `src/components/switching/switch.ts`, `src/components/switching/switch-dt.ts`, `src/components/switching/plain-switch.ts`, `src/components/switching/plain-switch-dt.ts`

- **Tests**: open/close state, SPDT routing, interaction with bus resolution.

- **Acceptance criteria**: Switch behavior correct. Bus net merging/splitting triggers correctly. All tests pass.

---

### Task 5.2.13 — Relays

- **Description**: `Relay`, `RelayDT`. Coil-controlled contacts (SPST/SPDT). Port from `ref/Digital/src/main/java/de/neemann/digital/core/switching/Relay*.java`. Similar to switches but controlled by a coil input (current through coil closes the contact).

- **Files to create**: `src/components/switching/relay.ts`, `src/components/switching/relay-dt.ts`

- **Tests**: coil energized → contact closed, coil de-energized → contact open, SPDT routing.

- **Acceptance criteria**: Relay behaviors correct. All tests pass.

---

### Task 5.2.14 — FETs & Transmission Gate

- **Description**: `NFET`, `PFET`, `FGNFET`, `FGPFET`, `TransGate`. Port from `ref/Digital/src/main/java/de/neemann/digital/core/switching/`. FETs behave as voltage-controlled switches. Floating-gate variants (FG) have a programmable threshold.

  | Component | Behavior |
  |-----------|----------|
  | NFET | Gate high → source-drain connected |
  | PFET | Gate low → source-drain connected |
  | FGNFET | NFET with floating gate (fuse-like, can be blown) |
  | FGPFET | PFET with floating gate |
  | TransGate | Bidirectional CMOS transmission gate (NFET + PFET in parallel) |

- **Files to create**: `src/components/switching/nfet.ts`, `src/components/switching/pfet.ts`, `src/components/switching/fgnfet.ts`, `src/components/switching/fgpfet.ts`, `src/components/switching/trans-gate.ts`

- **Tests**: gate voltage → switch state, bidirectional signal flow for TransGate, floating gate blow.

- **Acceptance criteria**: All FET behaviors correct. All tests pass.

---

### Task 5.2.15 — Fuse

- **Description**: `Fuse` — one-time irreversible component. Initially closed (conducting). When current exceeds threshold or explicitly blown, opens permanently (disconnects). `internalStateCount: 1` (blown flag). Port from `ref/Digital/src/main/java/de/neemann/digital/core/switching/Fuse.java`.

- **Files to create**: `src/components/switching/fuse.ts`

- **Tests**: initially closed, blow → open, cannot re-close.

- **Acceptance criteria**: Fuse behavior correct. All tests pass.

---

### Task 5.2.16 — PLD Components

- **Description**: `Diode`, `DiodeBackward`, `DiodeForward`, `PullUp`, `PullDown`. Programmable logic device components. Port from `ref/Digital/src/main/java/de/neemann/digital/core/pld/`.

  | Component | Behavior |
  |-----------|----------|
  | Diode | Unidirectional current flow (used in PLD arrays) |
  | DiodeBackward/Forward | Orientation variants of Diode |
  | PullUp | Pulls floating net to logic 1 |
  | PullDown | Pulls floating net to logic 0 |

  PullUp/PullDown interact with bus resolution (Phase 3 task 3.2.3) — they configure the pull resistor on a bus net.

- **Files to create**: `src/components/pld/diode.ts`, `src/components/pld/pull-up.ts`, `src/components/pld/pull-down.ts`

- **Tests**: diode forward conduction, pull-up on floating net, pull-down on floating net.

- **Acceptance criteria**: All PLD component behaviors correct. All tests pass.

---

### Task 5.2.17 — Interactive I/O

- **Description**: `Button`, `ButtonLED`, `DipSwitch`, `Probe`, `PowerSupply`. Port from `ref/Digital/src/main/java/de/neemann/digital/core/io/`.

  | Component | Behavior | Interactive |
  |-----------|----------|------------|
  | Button | Momentary push button (output high while held, low when released) | Yes (mouse down/up) |
  | ButtonLED | Button with integrated LED indicator | Yes |
  | DipSwitch | Multi-bit toggle switch array | Yes (per-bit toggle) |
  | Probe | Measurement point (reads signal, adds to measurement list, configurable radix) | No (display only) |
  | PowerSupply | VCC/GND source for CMOS circuits | No |

- **Files to create**: `src/components/io/button.ts`, `src/components/io/button-led.ts`, `src/components/io/dip-switch.ts`, `src/components/io/probe.ts`, `src/components/io/power-supply.ts`

- **Tests**: button press/release, DipSwitch per-bit toggle, Probe value reading, radix display.

- **Acceptance criteria**: All interactive behaviors correct. All tests pass.

---

### Task 5.2.18 — Visual Indicators

- **Description**: `LED`, `PolarityAwareLED`, `LightBulb`, `RGBLED`. Port from `ref/Digital/src/main/java/de/neemann/digital/core/io/`.

  | Component | Rendering | Inputs |
  |-----------|-----------|--------|
  | LED | Circle, configurable color, on/off based on input | 1-bit |
  | PolarityAwareLED | LED considering anode/cathode orientation | 2 pins (anode, cathode) |
  | LightBulb | Incandescent bulb shape, brightness proportional to input | 1-bit |
  | RGBLED | 3-color LED, each channel independent | R, G, B inputs |

- **Files to create**: `src/components/io/led.ts`, `src/components/io/polarity-led.ts`, `src/components/io/light-bulb.ts`, `src/components/io/rgb-led.ts`

- **Tests**: on/off state, color rendering, RGBLED color mixing.

- **Acceptance criteria**: All LED variants render correctly. All tests pass.

---

### Task 5.2.19 — Segment Displays

- **Description**: `SevenSeg`, `SevenSegHex`, `SixteenSeg`. Port from `ref/Digital/src/main/java/de/neemann/digital/core/io/`.

  | Component | Inputs | Behavior |
  |-----------|--------|----------|
  | SevenSeg | 7 segment inputs + decimal point | Direct segment drive |
  | SevenSegHex | 4-bit BCD input | Internal decoder, displays 0-F |
  | SixteenSeg | 16 segment inputs | Alphanumeric display |

  All share a common 7-segment/16-segment rendering engine. `commonCathode` property controls polarity.

- **Files to create**: `src/components/io/seven-seg.ts`, `src/components/io/seven-seg-hex.ts`, `src/components/io/sixteen-seg.ts`

- **Tests**: correct segment mapping for all hex digits, decimal point, common anode vs cathode.

- **Acceptance criteria**: All segment displays render correctly. All tests pass.

---

### Task 5.2.20 — Oscilloscope

- **Description**: `Scope`, `ScopeTrigger`. Multi-channel waveform recorder. Port from `ref/Digital/src/main/java/de/neemann/digital/core/io/Scope*.java`.

  - `Scope` records signal values over time, renders waveform in a separate floating panel
  - `ScopeTrigger` is a separate placeable component that triggers the scope capture
  - Properties: time scale, channel labels, trigger mode (edge/level)
  - Data stored as time-value arrays per channel

- **Files to create**: `src/components/io/scope.ts`, `src/components/io/scope-trigger.ts`

- **Tests**: waveform recording over multiple steps, trigger detection, multi-channel capture.

- **Acceptance criteria**: Scope records and presents waveform data correctly. All tests pass.

---

### Task 5.2.21 — Rotary Encoder & Motors

- **Description**: `RotEncoder`, `StepperMotorBipolar`, `StepperMotorUnipolar`. Port from Digital's I/O package.

- **Files to create**: `src/components/io/rotary-encoder.ts`, `src/components/io/stepper-motor.ts`

- **Tests**: encoder quadrature output, stepper motor step sequence, direction control.

- **Acceptance criteria**: All electromechanical components correct. All tests pass.

---

### Task 5.2.22 — MIDI

- **Description**: `MIDI` — note on/off, channel, velocity. Uses Web MIDI API in browser. Port from `ref/Digital/src/main/java/de/neemann/digital/core/extern/PortMidi.java`.

  Graceful degradation: if Web MIDI API unavailable, MIDI component works but produces no audio output (signals still propagate correctly).

- **Files to create**: `src/components/io/midi.ts`

- **Tests**: MIDI message construction from inputs, graceful degradation without Web MIDI.

- **Acceptance criteria**: MIDI component correct. All tests pass.

---

### Task 5.2.23 — Boolean Function

- **Description**: `Function` — generic boolean function defined by a truth table. Users can edit the truth table; the component implements the function. Port from `ref/Digital/src/main/java/de/neemann/digital/core/basic/Function.java`.

- **Files to create**: `src/components/basic/function.ts`

- **Tests**: truth table evaluation, multi-output function, don't-care entries.

- **Acceptance criteria**: Function component correct. All tests pass.

---

### Task 5.2.24 — Text & Rectangle Annotations

- **Description**: `Text`, `Rectangle` — non-functional visual elements. No simulation behavior. No executeFn.

  | Component | Purpose |
  |-----------|---------|
  | Text | Label/annotation on the canvas. Configurable font size, orientation. |
  | Rectangle | Visual grouping box. Configurable size, optional label. |

- **Files to create**: `src/components/misc/text.ts`, `src/components/misc/rectangle.ts`

- **Tests**: rendering with mock context (correct text/rect drawn), no simulation behavior.

- **Acceptance criteria**: Annotations render correctly. All tests pass.

---

### Task 5.2.25 — LED Matrix

- **Description**: `LedMatrix` — NxN LED grid display. Input is row/column selection + data. Separate floating panel shows the matrix output. Port from `ref/Digital/src/main/java/de/neemann/digital/core/io/LedMatrix.java`.

- **Files to create**: `src/components/graphics/led-matrix.ts`

- **Tests**: pixel set/clear, matrix addressing, display panel data extraction.

- **Acceptance criteria**: LED Matrix correct. All tests pass.

---

### Task 5.2.26 — VGA Display

- **Description**: `VGA` — VGA-resolution pixel display. Framebuffer contents shown in a separate floating panel. Inputs: RGB data, HSync, VSync, clock. Port from `ref/Digital/src/main/java/de/neemann/digital/core/io/VGA.java`.

  Uses `backingStoreType: 'datafield'` for framebuffer.

- **Files to create**: `src/components/graphics/vga.ts`

- **Tests**: framebuffer write at addressed pixel, HSync/VSync timing, display panel data extraction.

- **Acceptance criteria**: VGA display correct. All tests pass.

---

### Task 5.2.27 — Graphic Card

- **Description**: `GraphicCard` — graphics framebuffer with drawing commands. Port from `ref/Digital/src/main/java/de/neemann/digital/core/io/GraphicCard.java`.

  Uses `backingStoreType: 'datafield'` for framebuffer.

- **Files to create**: `src/components/graphics/graphic-card.ts`

- **Tests**: drawing command execution, framebuffer contents, display panel data.

- **Acceptance criteria**: Graphic card correct. All tests pass.

---

### Task 5.2.28 — Terminal & Keyboard

- **Description**: `Terminal`, `Keyboard`. Port from `ref/Digital/src/main/java/de/neemann/digital/core/io/`.

  | Component | Behavior | Panel |
  |-----------|----------|-------|
  | Terminal | Serial text terminal: data input → character display in scrollback panel. Also receives keyboard input from panel. | Floating terminal panel |
  | Keyboard | Keyboard input: reads key from keyboard dialog, outputs key code + ready flag. | Key input dialog |

- **Files to create**: `src/components/terminal/terminal.ts`, `src/components/terminal/keyboard.ts`

- **Tests**: character output to terminal buffer, keyboard key code output, ready flag.

- **Acceptance criteria**: Terminal and keyboard correct. All tests pass.

---

### Task 5.2.29 — Testcase Element

- **Description**: `Testcase` — placeable test case component containing embedded truth table test data. Displayed as a labeled box on the canvas. Test data accessible to the test executor (Phase 6). No simulation behavior — executeFn is no-op.

- **Files to create**: `src/components/misc/testcase.ts`

- **Tests**: test data extraction from properties, rendering as labeled box.

- **Acceptance criteria**: Testcase element correct. All tests pass.
