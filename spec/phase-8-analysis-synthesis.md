# Phase 8: Analysis & Synthesis

**Depends on**: Phase 6
**Parallel with**: Phases 7, 9

## Overview

Circuit analysis, truth table generation, boolean expression minimization, Karnaugh maps, and circuit synthesis. Port of Digital's `analyse` package. These are the discrete math teaching tools — students build circuits, analyze them to truth tables, minimize expressions, visualize on K-maps, and synthesize circuits from specifications.

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **Tabbed analysis dialog.** One dialog with tabs: Truth Table, Expressions, Karnaugh Map, Synthesis. Opens from menu (Analyze → Analyse Circuit).
- **Three-way binding.** Truth table ↔ expressions ↔ K-map. The truth table is the source of truth. Edits in any view flow back to the truth table, which then updates the other views.
- **20-input cap for exhaustive analysis.** 2^20 = ~1M rows. Beyond that, the analyzer reports an error suggesting test vectors instead.
- **Left-to-right flow layout for synthesized circuits.** Inputs on the left, gates in the middle, outputs on the right. Automatic grid-snapped positioning.

## Reference Source

| What | Where |
|------|-------|
| Model analyzer | `ref/Digital/src/main/java/de/neemann/digital/analyse/ModelAnalyser.java` |
| Substitute library | `ref/Digital/src/main/java/de/neemann/digital/analyse/SubstituteLibrary.java` |
| Quine-McCluskey | `ref/Digital/src/main/java/de/neemann/digital/analyse/quine/` |
| Expression types | `ref/Digital/src/main/java/de/neemann/digital/analyse/expression/` |
| Circuit synthesis | `ref/Digital/src/main/java/de/neemann/digital/builder/` |
| K-map | `ref/Digital/src/main/java/de/neemann/digital/gui/components/karnaugh/` |

---

## Wave 8.1: Circuit Analysis

### Task 8.1.1 — Model Analyzer

- **Description**: Analyze a combinational circuit to generate its complete truth table. Port of Digital's `ModelAnalyser`.

  Process:
  1. Identify input signals (all `In` components) and output signals (all `Out` components)
  2. Validate: input count ≤ 20 (error if exceeded)
  3. Detect combinational feedback loops via cycle detection (port `CycleDetector`). If cycles found, report to user and abort.
  4. For each of 2^N input combinations:
     - Set all inputs to the combination values
     - `runToStable()` to propagate
     - Read all output values
     - Record in truth table
  5. Return structured truth table

  ```typescript
  interface TruthTable {
    inputs: SignalSpec[];    // { name, bitWidth }
    outputs: SignalSpec[];
    rows: TruthTableRow[];  // { inputValues: bigint[], outputValues: bigint[] }
  }
  ```

  Multi-bit signals: each bit combination of each input is enumerated. An 8-bit input contributes 8 bits to the combination space. Total combinations = 2^(sum of all input bit widths).

- **Files to create**:
  - `src/analysis/model-analyser.ts` — `analyseCircuit(facade: SimulatorFacade, circuit: Circuit): TruthTable`
  - `src/analysis/cycle-detector.ts` — `detectCycles(circuit: Circuit): CycleInfo[]` — returns empty array if no cycles, otherwise describes each cycle

- **Tests**:
  - `src/analysis/__tests__/model-analyser.test.ts::andGate` — 2-input AND → truth table with 4 rows matching AND truth table
  - `src/analysis/__tests__/model-analyser.test.ts::halfAdder` — half adder → truth table with 4 rows, Sum and Carry columns correct
  - `src/analysis/__tests__/model-analyser.test.ts::inputLimit` — circuit with 21 single-bit inputs → throws with descriptive error
  - `src/analysis/__tests__/model-analyser.test.ts::cycleDetection` — circuit with combinational feedback → throws with cycle description
  - `src/analysis/__tests__/model-analyser.test.ts::multiBit` — 2-bit input, 2-bit output → 4 rows (2^2 combinations)
  - `src/analysis/__tests__/cycle-detector.test.ts::noCycles` — simple combinational circuit → empty array
  - `src/analysis/__tests__/cycle-detector.test.ts::selfLoop` — output wired to own input → cycle detected

- **Acceptance criteria**:
  - Truth table generated correctly for combinational circuits
  - Input limit enforced at 20 bits
  - Cycles detected and reported clearly
  - Multi-bit signals handled
  - All tests pass

---

### Task 8.1.2 — Substitute Library

- **Description**: Replace complex components (subcircuits, counters, multiplexers, etc.) with analysis-compatible gate-level equivalents. Required for analyzing circuits containing non-primitive components.

  Port of Digital's `SubstituteLibrary`. Provides gate-level decompositions for:
  - Multiplexer → gates
  - Demultiplexer → gates
  - Decoder → gates
  - XOr (multi-input) → cascade of 2-input XOr
  - Subcircuits → recursively substitute their internals

  Components without substitutions (flip-flops, RAM, etc.) cannot be analyzed — the analyzer reports which components block analysis.

- **Files to create**:
  - `src/analysis/substitute-library.ts` — `substituteForAnalysis(circuit: Circuit, registry: ComponentRegistry): Circuit` — returns new circuit with complex components replaced by gate-level equivalents

- **Tests**:
  - `src/analysis/__tests__/substitute-library.test.ts::muxToGates` — circuit with Multiplexer → substituted circuit has only basic gates
  - `src/analysis/__tests__/substitute-library.test.ts::subcircuitInlined` — circuit with subcircuit → subcircuit internals inlined and substituted
  - `src/analysis/__tests__/substitute-library.test.ts::noSubNeeded` — circuit with only basic gates → returned unchanged
  - `src/analysis/__tests__/substitute-library.test.ts::unsubstitutable` — circuit with RAM → reports RAM as blocking component
  - `src/analysis/__tests__/substitute-library.test.ts::functionalEquivalence` — original and substituted circuits produce same truth table

- **Acceptance criteria**:
  - Complex components correctly decomposed to gate level
  - Substituted circuit is functionally equivalent to original
  - Unsubstitutable components reported clearly
  - All tests pass

---

### Task 8.1.3 — Truth Table Display/Editor

- **Description**: Dialog showing truth table as an editable grid. Part of the tabbed analysis dialog.

  Features:
  - Table display: input columns, output columns, one row per combination
  - Editable output cells: click to cycle through 0 → 1 → X (don't-care)
  - Reorder inputs/outputs via column drag
  - Start from blank: specify input/output signal names and bit widths, then fill the table manually
  - Linked to expressions tab and K-map tab (edits propagate)

- **Files to create**:
  - `src/analysis/truth-table-ui.ts` — `TruthTableTab` class for the analysis dialog. Renders editable grid. Emits change events.
  - `src/analysis/truth-table.ts` — `TruthTable` data model with modification methods (`setOutput`, `addInput`, `removeInput`, `reorderColumns`)

- **Tests**:
  - `src/analysis/__tests__/truth-table-ui.test.ts::renderGrid` — 2 inputs, 1 output → 4 rows rendered
  - `src/analysis/__tests__/truth-table-ui.test.ts::editCell` — click output cell, value cycles 0→1→X→0
  - `src/analysis/__tests__/truth-table-ui.test.ts::blankTable` — create blank with 3 inputs, 2 outputs → 8 rows, all outputs X
  - `src/analysis/__tests__/truth-table.test.ts::setOutput` — set output value at row 2, verify stored
  - `src/analysis/__tests__/truth-table.test.ts::reorderColumns` — swap input A and B, verify row values rearranged correctly

- **Acceptance criteria**:
  - Truth table displays and is editable
  - Blank table creation works
  - Column reordering works
  - Changes emit events for cross-tab binding
  - All tests pass

---

### Task 8.1.4 — State Transition Table

- **Description**: For sequential circuits (containing flip-flops), generate the state transition table. Identifies state variables (flip-flop outputs), enumerates all state+input combinations, records next-state and outputs.

  Process:
  1. Identify state variables (flip-flop Q outputs)
  2. Identify combinational inputs and outputs
  3. For each (state, input) combination:
     - Force flip-flop states to the combination values
     - Apply input values
     - Step engine (one clock cycle)
     - Read next-state (new flip-flop values) and outputs
  4. Return structured transition table

  ```typescript
  interface StateTransitionTable {
    stateVars: SignalSpec[];
    inputs: SignalSpec[];
    outputs: SignalSpec[];
    transitions: StateTransition[];  // { currentState, input, nextState, output }
  }
  ```

- **Files to create**:
  - `src/analysis/state-transition.ts` — `analyseSequential(facade, circuit): StateTransitionTable`

- **Tests**:
  - `src/analysis/__tests__/state-transition.test.ts::dFlipflop` — D flip-flop circuit → correct state transition table (Q_next = D)
  - `src/analysis/__tests__/state-transition.test.ts::srLatch` — SR latch → correct transitions for all S,R combinations
  - `src/analysis/__tests__/state-transition.test.ts::twoStateBits` — 2 flip-flops → 4 states × input combinations
  - `src/analysis/__tests__/state-transition.test.ts::noCombinationalOnly` — purely combinational circuit → throws (no state variables found)

- **Acceptance criteria**:
  - State transition table correct for sequential circuits
  - All state/input combinations enumerated
  - Clear error for circuits without state variables
  - All tests pass

---

### Task 8.1.5 — Truth Table Import/Export

- **Description**: Import truth tables from files, export to multiple formats.

  Formats:
  - **Import**: CSV (column headers = signal names, rows = values)
  - **Export**: CSV, Hex (one output value per line), LaTeX (tabular environment), TestCase (Digital test syntax for embedding in Testcase components)
  - **File format**: `.tru` truth table files (simple text format matching Digital)

- **Files to create**:
  - `src/analysis/truth-table-io.ts` — `importCsv(text: string): TruthTable`, `exportCsv(table: TruthTable): string`, `exportHex(table: TruthTable): string`, `exportLatex(table: TruthTable): string`, `exportTestCase(table: TruthTable): string`, `loadTru(text: string): TruthTable`, `saveTru(table: TruthTable): string`

- **Tests**:
  - `src/analysis/__tests__/truth-table-io.test.ts::csvRoundTrip` — export to CSV, import back, verify identical
  - `src/analysis/__tests__/truth-table-io.test.ts::hexExport` — 2-input 1-output → hex output lines match output column values
  - `src/analysis/__tests__/truth-table-io.test.ts::latexExport` — verify output contains `\begin{tabular}` and correct columns
  - `src/analysis/__tests__/truth-table-io.test.ts::testCaseExport` — verify output is valid Digital test syntax (parseable by 6.3.1)
  - `src/analysis/__tests__/truth-table-io.test.ts::truRoundTrip` — save .tru, load .tru, verify identical

- **Acceptance criteria**:
  - All import/export formats work correctly
  - Round-trip preserves data
  - TestCase export produces valid test syntax
  - All tests pass

---

## Wave 8.2: Expression Generation & Minimization

### Task 8.2.1 — Expression Generation

- **Description**: Generate boolean expressions from a truth table. Supports sum-of-products (SOP) and product-of-sums (POS) canonical forms.

  Expression representation:
  ```typescript
  type BoolExpr =
    | { kind: 'variable'; name: string; negated: boolean }
    | { kind: 'and'; operands: BoolExpr[] }
    | { kind: 'or'; operands: BoolExpr[] }
    | { kind: 'not'; operand: BoolExpr }
    | { kind: 'constant'; value: boolean };
  ```

  Output formats:
  - Object tree (for manipulation/minimization)
  - Plain text: `A & B | !C`
  - LaTeX: `A \cdot B + \overline{C}`

- **Files to create**:
  - `src/analysis/expression.ts` — `BoolExpr` type, expression construction helpers, `exprToString()`, `exprToLatex()`
  - `src/analysis/expression-gen.ts` — `generateSOP(table: TruthTable, outputIndex: number): BoolExpr`, `generatePOS(table: TruthTable, outputIndex: number): BoolExpr`

- **Tests**:
  - `src/analysis/__tests__/expression-gen.test.ts::sopAndGate` — AND truth table → SOP expression `A & B`
  - `src/analysis/__tests__/expression-gen.test.ts::posOrGate` — OR truth table → POS expression `A | B`
  - `src/analysis/__tests__/expression-gen.test.ts::sopWithDontCare` — don't-care entries handled (not included as minterms)
  - `src/analysis/__tests__/expression-gen.test.ts::toStringFormat` — verify plain text output format
  - `src/analysis/__tests__/expression-gen.test.ts::toLatexFormat` — verify LaTeX output contains correct notation

- **Acceptance criteria**:
  - SOP and POS generation correct
  - Don't-care entries handled
  - String and LaTeX formatting correct
  - All tests pass

---

### Task 8.2.2 — Quine-McCluskey Minimization

- **Description**: Minimize boolean expressions using the Quine-McCluskey algorithm. Port of Digital's `MinimizerQuineMcCluskey`.

  Features:
  - Find all prime implicants
  - Select minimal cover (Petrick's method)
  - Handle don't-care terms
  - "All solutions" mode: find all minimal covers (not just one)

- **Files to create**:
  - `src/analysis/quine-mccluskey.ts` — `minimize(table: TruthTable, outputIndex: number): MinimizationResult`

  ```typescript
  interface MinimizationResult {
    primeImplicants: Implicant[];
    minimalCovers: BoolExpr[];  // all minimal solutions
    selectedCover: BoolExpr;     // first/default minimal solution
  }
  ```

- **Tests**:
  - `src/analysis/__tests__/quine-mccluskey.test.ts::simpleMinimize` — OR(A&B, A&!B) → A (single variable)
  - `src/analysis/__tests__/quine-mccluskey.test.ts::xorNotSimplifiable` — XOR function → no simplification possible (already minimal)
  - `src/analysis/__tests__/quine-mccluskey.test.ts::dontCareExploited` — don't-care terms enable simpler expression than without
  - `src/analysis/__tests__/quine-mccluskey.test.ts::allSolutions` — function with multiple minimal covers → `minimalCovers.length > 1`
  - `src/analysis/__tests__/quine-mccluskey.test.ts::4variables` — 4-variable function → correctly minimized
  - `src/analysis/__tests__/quine-mccluskey.test.ts::primeImplicants` — verify all prime implicants found (compare with known result)

- **Acceptance criteria**:
  - Minimization produces correct minimal expressions
  - Don't-care terms exploited for simpler expressions
  - All minimal covers found
  - Results match Digital's output for same inputs
  - All tests pass

---

### Task 8.2.3 — Karnaugh Map Visualization

- **Description**: Display Karnaugh map for up to 6 variables. Interactive — click cells to toggle values. Linked to truth table and expressions.

  Features:
  - K-map grid with Gray code row/column labels
  - Cell values: 0, 1, X (don't-care)
  - Prime implicant loops drawn as colored rounded rectangles
  - Click cell to toggle value (propagates to truth table)
  - Variable count: 2, 3, 4, 5, 6. For 5-6 variables, split into two side-by-side maps.
  - Linked to minimization: selecting different minimal covers highlights different implicant groups

- **Files to create**:
  - `src/analysis/karnaugh-map.ts` — `KarnaughMapTab` class for the analysis dialog. Canvas-based rendering. Click handling. Implicant loop rendering.

- **Tests**:
  - `src/analysis/__tests__/karnaugh-map.test.ts::render2var` — 2-variable → 2×2 grid
  - `src/analysis/__tests__/karnaugh-map.test.ts::render4var` — 4-variable → 4×4 grid with correct Gray code labels
  - `src/analysis/__tests__/karnaugh-map.test.ts::cellClick` — click cell, verify value toggles and change event emitted
  - `src/analysis/__tests__/karnaugh-map.test.ts::implicantLoops` — provide prime implicants, verify colored loops drawn around correct cells
  - `src/analysis/__tests__/karnaugh-map.test.ts::5varSplit` — 5 variables → two 4×4 maps side by side
  - `src/analysis/__tests__/karnaugh-map.test.ts::grayCodeOrder` — verify row/column labels follow Gray code sequence

- **Acceptance criteria**:
  - K-map renders correctly for 2-6 variables
  - Cell editing works and propagates
  - Prime implicant loops display correctly
  - Gray code ordering correct
  - All tests pass

---

### Task 8.2.4 — Expression Editor Dialog

- **Description**: Enter/edit boolean expressions manually. Parse, validate, and convert between forms.

  Features:
  - Text input for expression: `A & B | !C & D`
  - Parse button: validates syntax, shows error or parsed expression tree
  - Convert between forms: SOP, POS, canonical
  - "To Truth Table" button: evaluate expression for all input combinations, fill truth table
  - Variable auto-detection from expression

  Expression syntax:
  - Variables: `A`, `B`, `x0`, etc.
  - AND: `&`, `*`, `·`
  - OR: `|`, `+`
  - NOT: `!`, `~`, `¬`
  - Parentheses: `(`, `)`
  - Constants: `0`, `1`

- **Files to create**:
  - `src/analysis/expression-editor.ts` — `ExpressionEditorTab` class for the analysis dialog
  - `src/analysis/expression-parser.ts` — `parseExpression(text: string): BoolExpr`. Recursive descent parser. Error messages with position.

- **Tests**:
  - `src/analysis/__tests__/expression-parser.test.ts::simpleAnd` — `"A & B"` → correct BoolExpr tree
  - `src/analysis/__tests__/expression-parser.test.ts::precedence` — `"A | B & C"` → OR(A, AND(B,C)) (AND binds tighter)
  - `src/analysis/__tests__/expression-parser.test.ts::notOperator` — `"!A"` → NOT(A)
  - `src/analysis/__tests__/expression-parser.test.ts::parentheses` — `"(A | B) & C"` → AND(OR(A,B), C)
  - `src/analysis/__tests__/expression-parser.test.ts::syntaxError` — `"A & "` → error with position
  - `src/analysis/__tests__/expression-parser.test.ts::allOperators` — `&`, `*`, `|`, `+`, `!`, `~` all recognized
  - `src/analysis/__tests__/expression-editor.test.ts::toTruthTable` — parse `"A & B"`, generate truth table, verify 4 rows with correct values

- **Acceptance criteria**:
  - Expression parsing with correct precedence
  - All operator syntaxes recognized
  - Clear error messages with position for syntax errors
  - Conversion between forms works
  - Expression → truth table evaluation works
  - All tests pass

---

### Task 8.2.5 — Expression Modifiers

- **Description**: Generate circuits constrained to specific gate types. Teaching tool for gate-level design.

  Modifiers:
  - **NAND-only**: convert any expression to use only NAND gates (De Morgan's transformations)
  - **NOR-only**: convert to use only NOR gates
  - **N-input limit**: limit maximum fan-in to N inputs per gate (decompose wide gates into cascades)

  Port of Digital's `NAnd.java`, `NOr.java`, `NInputs.java`.

- **Files to create**:
  - `src/analysis/expression-modifiers.ts` — `toNandOnly(expr: BoolExpr): BoolExpr`, `toNorOnly(expr: BoolExpr): BoolExpr`, `limitFanIn(expr: BoolExpr, maxInputs: number): BoolExpr`

- **Tests**:
  - `src/analysis/__tests__/expression-modifiers.test.ts::nandConversion` — `A & B` → NAND(NAND(A,B)) equivalent
  - `src/analysis/__tests__/expression-modifiers.test.ts::norConversion` — `A | B` → NOR(NOR(A,B)) equivalent
  - `src/analysis/__tests__/expression-modifiers.test.ts::fanInLimit` — 4-input AND with limit 2 → cascade of 2-input ANDs
  - `src/analysis/__tests__/expression-modifiers.test.ts::functionalEquivalence` — original and modified expressions produce same truth table
  - `src/analysis/__tests__/expression-modifiers.test.ts::nandOnlyVerify` — converted expression contains only NAND and NOT nodes

- **Acceptance criteria**:
  - NAND-only and NOR-only conversions correct
  - Fan-in limiting produces correct cascades
  - Modified expressions functionally equivalent to originals
  - All tests pass

---

### Task 8.2.6 — JK Flip-Flop Synthesis

- **Description**: Derive JK flip-flop excitation equations from state transition tables. Port of Digital's `DetermineJKStateMachine`.

  Given a state transition table, for each state bit:
  - Determine the J and K inputs needed to produce each transition
  - Q: 0→0 → J=0,K=X; 0→1 → J=1,K=X; 1→0 → J=X,K=1; 1→1 → J=X,K=0
  - Generate truth tables for J and K as functions of current state and inputs
  - Minimize using Quine-McCluskey

- **Files to create**:
  - `src/analysis/jk-synthesis.ts` — `deriveJKEquations(table: StateTransitionTable): JKEquations`

  ```typescript
  interface JKEquations {
    stateBits: { name: string; jExpr: BoolExpr; kExpr: BoolExpr }[];
    outputExprs: { name: string; expr: BoolExpr }[];
  }
  ```

- **Tests**:
  - `src/analysis/__tests__/jk-synthesis.test.ts::toggleFlipflop` — single state bit toggling → J=1, K=1
  - `src/analysis/__tests__/jk-synthesis.test.ts::dTypeFromJK` — D flip-flop equivalent → J=D, K=!D
  - `src/analysis/__tests__/jk-synthesis.test.ts::twoStateBits` — 2-state-bit FSM → correct J/K equations for each bit
  - `src/analysis/__tests__/jk-synthesis.test.ts::dontCaresExploited` — verify JK derivation exploits don't-cares from the JK excitation table

- **Acceptance criteria**:
  - JK excitation equations derived correctly
  - Don't-care terms properly exploited
  - Multi-bit state handled
  - All tests pass

---

## Wave 8.3: Circuit Synthesis & Analysis Tools

### Task 8.3.1 — Circuit Synthesis

- **Description**: Generate a circuit from boolean expressions. Creates gate components, wires them, and produces a valid `Circuit` loadable in the editor.

  Features:
  - Input: `BoolExpr` (from expression generation, minimization, or manual entry)
  - Output: `Circuit` with gates and wires, ready for the editor
  - Respects expression modifier constraints (NAND-only, NOR-only, N-input)
  - Left-to-right flow layout: inputs on the left edge, gates in the middle, outputs on the right edge
  - Grid-snapped positions with automatic spacing

  Layout algorithm:
  1. Determine expression depth (longest path from input to output)
  2. Place inputs at column 0, outputs at column (depth + 1)
  3. Place each gate at the column matching its depth in the expression tree
  4. Within each column, space gates vertically with sufficient room for wires
  5. Route wires between connected pins

- **Files to create**:
  - `src/analysis/synthesis.ts` — `synthesizeCircuit(expressions: Map<string, BoolExpr>, inputNames: string[], registry: ComponentRegistry): Circuit`
  - `src/analysis/auto-layout.ts` — `layoutCircuit(circuit: Circuit): void` — positions components using left-to-right flow

- **Tests**:
  - `src/analysis/__tests__/synthesis.test.ts::singleGate` — expression `A & B` → circuit with 2 In, 1 And, 1 Out, correctly wired
  - `src/analysis/__tests__/synthesis.test.ts::multiOutput` — two expressions → circuit with shared inputs, two output chains
  - `src/analysis/__tests__/synthesis.test.ts::nandOnly` — NAND-only expression → circuit contains only NAND gates
  - `src/analysis/__tests__/synthesis.test.ts::layoutPositions` — verify all components have valid grid positions, no overlaps
  - `src/analysis/__tests__/synthesis.test.ts::functionalVerification` — synthesize from truth table, analyze synthesized circuit, verify truth tables match
  - `src/analysis/__tests__/synthesis.test.ts::loadInEditor` — synthesized circuit loads without errors

- **Acceptance criteria**:
  - Synthesized circuits are functionally correct (truth table round-trip)
  - Layout is left-to-right with no overlaps
  - Expression modifier constraints respected
  - Circuits loadable in the editor
  - All tests pass

---

### Task 8.3.2 — Critical Path Analysis

- **Description**: Calculate the longest propagation delay path through combinational logic. Port of `ModelAnalyser.calcMaxPathLen()`.

  Output:
  ```typescript
  interface CriticalPath {
    pathLength: number;           // total delay in ns
    components: string[];         // component names on the critical path, in order
    gateCount: number;            // number of gates on the path
  }
  ```

  Uses the `defaultDelay` from each component's `ComponentDefinition`.

- **Files to create**:
  - `src/analysis/path-analysis.ts` — `findCriticalPath(circuit: Circuit, registry: ComponentRegistry): CriticalPath`

- **Tests**:
  - `src/analysis/__tests__/path-analysis.test.ts::singleGate` — one AND gate → path length = defaultDelay (10ns)
  - `src/analysis/__tests__/path-analysis.test.ts::cascade` — AND → OR → NOT → path length = sum of delays
  - `src/analysis/__tests__/path-analysis.test.ts::parallelPaths` — two paths of different length → reports the longer one
  - `src/analysis/__tests__/path-analysis.test.ts::componentList` — verify components listed in path order

- **Acceptance criteria**:
  - Critical path length correct
  - Components on the path identified in order
  - Selects longest path among parallel alternatives
  - All tests pass

---

### Task 8.3.3 — Statistics Dialog

- **Description**: Summary statistics about the current circuit.

  Metrics:
  - Component count by type (e.g., And: 5, Or: 3, FlipflopD: 2)
  - Total gate count
  - Total wire count
  - Total net count
  - Input/output count
  - Subcircuit count (before flattening)
  - Circuit depth (longest path in gates)

- **Files to create**:
  - `src/analysis/statistics.ts` — `computeStatistics(circuit: Circuit, registry: ComponentRegistry): CircuitStatistics`

- **Tests**:
  - `src/analysis/__tests__/statistics.test.ts::componentCounts` — circuit with 3 AND + 2 OR → counts correct
  - `src/analysis/__tests__/statistics.test.ts::wireCount` — circuit with 5 wires → wireCount = 5
  - `src/analysis/__tests__/statistics.test.ts::emptyCircuit` — empty circuit → all counts zero

- **Acceptance criteria**:
  - All metrics computed correctly
  - All tests pass

---

### Task 8.3.4 — Dependency Analysis

- **Description**: Analyze which outputs depend on which inputs. Display as a dependency matrix.

  ```typescript
  interface DependencyMatrix {
    inputs: string[];
    outputs: string[];
    depends: boolean[][];  // depends[outputIdx][inputIdx] = true if output depends on input
  }
  ```

  Determined by: for each output, vary each input while holding others fixed. If output changes, the dependency exists.

- **Files to create**:
  - `src/analysis/dependency.ts` — `analyseDependencies(facade, circuit): DependencyMatrix`

- **Tests**:
  - `src/analysis/__tests__/dependency.test.ts::andGate` — output depends on both inputs
  - `src/analysis/__tests__/dependency.test.ts::passThrough` — buffer (In→Out) → output depends on input, not on other inputs
  - `src/analysis/__tests__/dependency.test.ts::independentOutputs` — two independent output chains → correct dependency subsets

- **Acceptance criteria**:
  - Dependency matrix correct
  - All tests pass
