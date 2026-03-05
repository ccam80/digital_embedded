# Phase 10: FSM Editor

**Depends on**: Phase 8 (Analysis & Synthesis — needed for FSM → circuit)

## Overview

Graphical finite state machine editor with circuit synthesis. Students draw FSMs (states and transitions), then synthesize them into sequential circuits using the analysis/synthesis pipeline from Phase 8. The FSM editor reuses the canvas infrastructure (pan/zoom, selection, undo/redo) from Phase 2 but renders circles and arrows instead of rectangles and wires.

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **FSM editor uses same layout, mode switch.** The main canvas switches from circuit rendering to FSM rendering. The right panel switches from component properties to state/transition properties. The left palette hides. The toolbar switches to FSM tools (add state, add transition).
- **Shared canvas infrastructure.** Pan/zoom, selection framework, undo/redo stack, grid snapping are shared with the circuit editor. Rendering and hit-testing logic are separate.
- **State encoding options: binary, Gray, one-hot.**
- **FSMs saved in `.digb`.** The `.digb` format embeds FSM definitions alongside circuit data. `.fsm` import supported for Digital compatibility.

## Reference Source

| What | Where |
|------|-------|
| FSM model | `ref/Digital/src/main/java/de/neemann/digital/fsm/` |
| FSM editor | `ref/Digital/src/main/java/de/neemann/digital/gui/components/terminal/` |
| Transition table creator | `ref/Digital/src/main/java/de/neemann/digital/fsm/TransitionTableCreator.java` |
| State optimizer | `ref/Digital/src/main/java/de/neemann/digital/fsm/Optimizer.java` |

---

## Wave 10.1: FSM Model & Editor

### Task 10.1.1 — FSM Model

- **Description**: Data model for finite state machines.

  ```typescript
  interface FSM {
    name: string;
    states: FSMState[];
    transitions: FSMTransition[];
    inputSignals: string[];       // input signal names
    outputSignals: string[];      // output signal names
    stateEncoding: 'binary' | 'gray' | 'oneHot';
    stateBits?: number;           // auto-calculated if not set
  }

  interface FSMState {
    id: string;
    name: string;                 // display name (e.g., "S0", "IDLE")
    position: { x: number; y: number };  // canvas position
    outputs: Record<string, number>;     // Moore outputs: signal name → value
    isInitial: boolean;           // initial/reset state
    radius: number;               // rendering radius (default 30)
  }

  interface FSMTransition {
    id: string;
    sourceStateId: string;
    targetStateId: string;
    condition: string;            // boolean expression (e.g., "A & !B")
    actions?: Record<string, number>;    // Mealy outputs (optional)
    controlPoints: { x: number; y: number }[];  // curve control points for rendering
  }
  ```

  Serialization:
  - To/from `.digb` JSON: FSM embedded as `fsm` field in `DigbDocument`
  - Import `.fsm` files (Digital's format): parse XML, convert to our model

  Validation:
  - Every state reachable from initial state
  - No duplicate state names
  - Transition conditions are valid boolean expressions over declared input signals
  - At least one initial state

- **Files to create**:
  - `src/fsm/model.ts` — `FSM`, `FSMState`, `FSMTransition` interfaces. `createFSM()`, `addState()`, `addTransition()`, `removeState()`, `removeTransition()`, `validateFSM()`.
  - `src/fsm/fsm-serializer.ts` — `serializeFSM(fsm: FSM): object` (for embedding in `.digb`), `deserializeFSM(data: object): FSM`
  - `src/fsm/fsm-import.ts` — `importDigitalFSM(xml: string): FSM` — parse Digital's `.fsm` XML format

- **Files to modify**:
  - `src/io/digb-schema.ts` — Add optional `fsm?: object` field to `DigbDocument`

- **Tests**:
  - `src/fsm/__tests__/model.test.ts::createFSM` — create FSM with 2 states and 1 transition, verify structure
  - `src/fsm/__tests__/model.test.ts::addRemoveState` — add state, verify present; remove state, verify absent and connected transitions removed
  - `src/fsm/__tests__/model.test.ts::addRemoveTransition` — add transition between states, verify present; remove, verify absent
  - `src/fsm/__tests__/model.test.ts::validateReachability` — state not reachable from initial → validation warning
  - `src/fsm/__tests__/model.test.ts::validateDuplicateNames` — two states with same name → validation error
  - `src/fsm/__tests__/model.test.ts::validateConditionSyntax` — transition with invalid condition expression → validation error
  - `src/fsm/__tests__/model.test.ts::serializeRoundTrip` — serialize FSM, deserialize, verify identical
  - `src/fsm/__tests__/model.test.ts::importFsmFile` — import Digital .fsm XML, verify states and transitions match

- **Acceptance criteria**:
  - FSM model supports all required fields
  - CRUD operations on states and transitions work
  - Validation catches common errors
  - Serialization round-trip preserves all data
  - .fsm import works
  - All tests pass

---

### Task 10.1.2 — FSM Graphical Editor

- **Description**: Interactive canvas editor for drawing FSMs. Reuses Phase 2 canvas infrastructure (pan/zoom, selection, undo/redo, grid snapping) but with FSM-specific rendering and interaction.

  Mode switch: triggered from menu (Edit → Edit FSM) or by opening an FSM. When entering FSM mode:
  - Canvas renders FSM states and transitions instead of circuit elements
  - Right panel shows selected state/transition properties
  - Left palette hides
  - Toolbar shows FSM tools

  Rendering:
  - States: circles with name label centered. Initial state has a thick border or double circle. Moore output values shown below or inside.
  - Transitions: curved arrows from source to target state. Label shows condition expression (and Mealy actions if present). Self-loops rendered as circular arcs above the state.
  - Selected items: highlighted with selection color.

  Interaction:
  - **Add state**: click tool, then click canvas position → new state placed
  - **Add transition**: click tool, then click source state, then click target state → new transition with empty condition
  - **Self-loop**: click same state for source and target
  - **Edit properties**: double-click state → state property dialog (name, outputs, initial flag). Double-click transition → transition property dialog (condition, actions).
  - **Move**: drag states. Transitions follow (control points adjust automatically or can be manually dragged).
  - **Delete**: select + Delete key
  - **Undo/redo**: uses shared undo/redo stack from Phase 2

  Auto-layout option: "Auto Arrange" menu item positions states in a circle or grid layout.

- **Files to create**:
  - `src/fsm/editor.ts` — `FSMEditor` class. Manages FSM mode canvas rendering and interaction. Uses shared canvas toolkit.
  - `src/fsm/fsm-renderer.ts` — Render states (circles), transitions (curved arrows with labels), self-loops. Uses `RenderContext`.
  - `src/fsm/fsm-hit-test.ts` — Hit testing for states (point-in-circle) and transitions (point-near-curve).
  - `src/fsm/state-dialog.ts` — State property editor (name, outputs, initial flag)
  - `src/fsm/transition-dialog.ts` — Transition property editor (condition, actions)
  - `src/fsm/auto-layout.ts` — `autoLayoutFSM(fsm: FSM): void` — arrange states in circle or grid

- **Tests**:
  - `src/fsm/__tests__/editor.test.ts::addState` — click add-state tool, click canvas → state added at click position
  - `src/fsm/__tests__/editor.test.ts::addTransition` — click add-transition tool, click state A, click state B → transition from A to B
  - `src/fsm/__tests__/editor.test.ts::selfLoop` — click same state for source and target → self-loop transition
  - `src/fsm/__tests__/editor.test.ts::deleteState` — select state, press Delete → state and its transitions removed
  - `src/fsm/__tests__/editor.test.ts::moveState` — drag state → position updated, transitions follow
  - `src/fsm/__tests__/editor.test.ts::undoRedo` — add state, undo → state removed, redo → state restored
  - `src/fsm/__tests__/fsm-renderer.test.ts::drawState` — render state → circle and name label drawn via mock RenderContext
  - `src/fsm/__tests__/fsm-renderer.test.ts::drawInitialState` — initial state → double circle rendered
  - `src/fsm/__tests__/fsm-renderer.test.ts::drawTransition` — render transition → arrow path and label drawn
  - `src/fsm/__tests__/fsm-renderer.test.ts::drawSelfLoop` — self-loop → circular arc above state
  - `src/fsm/__tests__/fsm-hit-test.test.ts::hitState` — click inside state circle → state selected
  - `src/fsm/__tests__/fsm-hit-test.test.ts::missState` — click outside all states → nothing selected
  - `src/fsm/__tests__/auto-layout.test.ts::circleLayout` — 4 states → arranged in a circle, verify positions

- **Acceptance criteria**:
  - All FSM editing operations work (add, delete, move, edit states/transitions)
  - Self-loops render and interact correctly
  - Undo/redo works for all operations
  - Double-click opens correct property editor
  - Auto-layout arranges states reasonably
  - Rendering uses RenderContext (not Canvas2D directly)
  - All tests pass

---

## Wave 10.2: FSM Synthesis

### Task 10.2.1 — FSM → State Transition Table

- **Description**: Convert an FSM model to a state transition table. Port of Digital's `TransitionTableCreator`.

  Process:
  1. Assign encoding to each state (binary, Gray, or one-hot per FSM configuration)
  2. For each (current state encoding, input combination):
     - Find the matching transition (evaluate condition expressions)
     - Record next state encoding and outputs
  3. Handle default (no matching transition): remain in current state, outputs = 0
  4. Return `StateTransitionTable` (same structure as Phase 8 task 8.1.4)

  The output feeds directly into Phase 8's analysis pipeline.

- **Files to create**:
  - `src/fsm/table-creator.ts` — `fsmToTransitionTable(fsm: FSM): StateTransitionTable`
  - `src/fsm/state-encoding.ts` — `encodeStates(states: FSMState[], encoding: 'binary' | 'gray' | 'oneHot'): Map<string, bigint>`

- **Tests**:
  - `src/fsm/__tests__/table-creator.test.ts::simpleToggle` — 2-state FSM with toggle on input → 4 transitions (2 states × 2 input values)
  - `src/fsm/__tests__/table-creator.test.ts::binaryEncoding` — 4 states, binary encoding → state bits = 2
  - `src/fsm/__tests__/table-creator.test.ts::grayEncoding` — 4 states, Gray encoding → verify Gray code assignments
  - `src/fsm/__tests__/table-creator.test.ts::oneHotEncoding` — 4 states, one-hot → state bits = 4, one bit per state
  - `src/fsm/__tests__/table-creator.test.ts::defaultTransition` — state with no matching transition for an input → stays in same state
  - `src/fsm/__tests__/table-creator.test.ts::mooreOutputs` — Moore outputs appear in correct columns

- **Acceptance criteria**:
  - Transition table correct for all encoding types
  - Default transitions handled
  - Output format matches Phase 8's StateTransitionTable
  - All tests pass

---

### Task 10.2.2 — FSM → Circuit

- **Description**: Full pipeline from FSM to synthesized sequential circuit.

  Pipeline:
  ```
  FSM
    → state transition table (10.2.1)
    → truth tables for next-state and output functions (Phase 8 infrastructure)
    → minimize expressions (Quine-McCluskey, 8.2.2)
    → synthesize circuit (8.3.1): flip-flops + combinational logic
    → load in editor
  ```

  The FSM-specific work is producing the transition table and selecting flip-flop type. The rest reuses Phase 8.

  Flip-flop type options:
  - D flip-flops (direct: next-state = D input)
  - JK flip-flops (uses JK synthesis from 8.2.6)

  The synthesized circuit contains:
  - One flip-flop per state bit
  - Combinational logic for next-state and output functions
  - Input and output pins matching the FSM's signal declarations

- **Files to create**:
  - `src/fsm/circuit-gen.ts` — `fsmToCircuit(fsm: FSM, options?: FSMSynthesisOptions): Circuit`. Options: `flipflopType: 'D' | 'JK'`, `minimize: boolean`.

- **Tests**:
  - `src/fsm/__tests__/circuit-gen.test.ts::simpleCounter` — 2-state counter FSM → circuit with 1 D flip-flop + gates
  - `src/fsm/__tests__/circuit-gen.test.ts::jkFlipflops` — synthesize with JK option → circuit contains JK flip-flops
  - `src/fsm/__tests__/circuit-gen.test.ts::functionalVerification` — synthesized circuit's state transitions match original FSM (run test vectors)
  - `src/fsm/__tests__/circuit-gen.test.ts::loadableCircuit` — synthesized circuit loads in editor without errors
  - `src/fsm/__tests__/circuit-gen.test.ts::minimizedExpressions` — with minimize=true → fewer gates than unminimized

- **Acceptance criteria**:
  - Synthesized circuits functionally match the FSM
  - D and JK flip-flop options both work
  - Minimization reduces gate count
  - Circuits loadable in the editor
  - All tests pass

---

### Task 10.2.3 — FSM Optimizer

- **Description**: State minimization — merge equivalent states. Port of Digital's `Optimizer`.

  Two states are equivalent if:
  - They have the same outputs (Moore)
  - For every input combination, they transition to equivalent states

  Uses iterative partition refinement:
  1. Initial partition: group states by output values
  2. Refine: split groups where states transition to different groups
  3. Repeat until stable
  4. Merge equivalent states within each group

- **Files to create**:
  - `src/fsm/optimizer.ts` — `optimizeFSM(fsm: FSM): FSM` — returns new FSM with equivalent states merged

- **Tests**:
  - `src/fsm/__tests__/optimizer.test.ts::alreadyMinimal` — minimal FSM → returned unchanged (same state count)
  - `src/fsm/__tests__/optimizer.test.ts::mergeEquivalent` — FSM with 2 equivalent states → one state removed, transitions redirected
  - `src/fsm/__tests__/optimizer.test.ts::functionalEquivalence` — original and optimized FSMs produce same output sequences for all input sequences
  - `src/fsm/__tests__/optimizer.test.ts::preservesInitialState` — initial state preserved (or merged group keeps initial designation)

- **Acceptance criteria**:
  - Equivalent states correctly identified and merged
  - Optimized FSM is functionally equivalent to original
  - Initial state preserved
  - All tests pass
