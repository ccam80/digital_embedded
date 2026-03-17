# Phase 1: MNA Engine Core

## Overview

Build the complete analog simulation engine: sparse linear solver, MNA matrix assembly with separate linear/nonlinear stamp passes, Newton-Raphson nonlinear iteration with voltage limiting, companion models for reactive elements, LTE-controlled adaptive timestepping with breakpoint support, DC operating point solver with three-level convergence fallback stack, and the `MNAEngine` class that orchestrates everything behind the `AnalogEngine` interface. At the end of this phase, circuits with resistors, voltage/current sources, capacitors, inductors, and diodes can be compiled, solved for their DC operating point, and stepped through transient simulation with correct results.

## Wave structure and dependencies

```
Wave 1.1: Sparse Solver          (no dependencies — pure math)
Wave 1.2: MNA Infrastructure     (depends on 1.1)
Wave 1.3: NR + DC Operating Pt   (depends on 1.2)
Wave 1.4: Integration + Timestep (depends on 1.3)
Wave 1.5: Engine Assembly        (depends on all above)
```

---

## Wave 1.1: Sparse Solver

### Task 1.1.1: Sparse Linear Solver

- **Description**: Implement the full sparse solver pipeline: COO triplet assembly, CSC format conversion, AMD approximate minimum degree ordering, symbolic LU factorization (nonzero pattern), numeric LU factorization (values with partial pivoting), forward/backward substitution solve. All arithmetic uses `Float64Array`. The solver caches the symbolic factorization and AMD ordering across calls — only numeric refactorization runs when values change but topology is unchanged (the common case during NR iteration). `invalidateTopology()` forces a full re-analysis on the next `finalize()`.
- **Files to create**:
  - `src/analog/sparse-solver.ts`:
    - Class `SparseSolver`:
      - `beginAssembly(size: number)` — clears COO triplet list and RHS vector, sets matrix dimension
      - `stamp(row: number, col: number, value: number)` — appends (row, col, value) to COO list; duplicates summed during finalize
      - `stampRHS(row: number, value: number)` — accumulates value into RHS vector at row
      - `finalize()` — sorts COO triplets, sums duplicates, converts to CSC arrays; runs AMD ordering + symbolic factorization if topology has changed (new nonzero pattern)
      - `factor(): FactorResult` — numeric LU factorization using the symbolic nonzero pattern; threshold partial pivoting within the symbolic pattern (Markowitz strategy, pivotThreshold=0.01); triggers re-symbolization if no valid pivot exists in pattern; returns `{ success, conditionEstimate?, singularRow? }`
      - `solve(x: Float64Array)` — forward substitution (L) then backward substitution (U) using factored values; writes solution into x
      - `invalidateTopology()` — marks topology dirty so next `finalize()` re-runs AMD + symbolic
    - `FactorResult` type: `{ success: boolean, conditionEstimate?: number, singularRow?: number }`
    - Implementation notes:
      - COO triplets stored in three parallel arrays (`Float64Array` values, `Int32Array` rows, `Int32Array` cols`) with a count
      - CSC format: `colPtr: Int32Array`, `rowIdx: Int32Array`, `values: Float64Array`
      - AMD ordering: Approximate Minimum Degree — reduces fill-in during factorization; produces a permutation vector; reference CSparse (Tim Davis, public domain) for the algorithm
      - Symbolic factorization: determines nonzero pattern of L and U factors without computing values; runs once per topology change
      - Numeric factorization: fills in values using the symbolic pattern; runs every NR iteration for nonlinear circuits, once for linear. Pivot selection uses threshold partial pivoting within the symbolic nonzero pattern (Markowitz strategy): among pivot candidates within the existing symbolic nonzero pattern, select the one that minimizes Markowitz count (row_nnz - 1) × (col_nnz - 1), subject to `|candidate| >= pivotThreshold × max(|column|)` where `pivotThreshold = 0.01`. If no candidate in the symbolic pattern meets the threshold (near-zero diagonal), trigger one-time re-symbolization incorporating the current numeric values.
      - All internal arrays pre-allocated after first symbolic pass; no heap allocations on numeric factor + solve hot path
- **Tests**:
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::solves_2x2_dense` — A = [[4,1],[1,3]], b = [1,2]; assert solution x within 1e-12 of analytical result
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::solves_3x3_sparse_tridiagonal` — A = [[2,-1,0],[-1,3,-1],[0,-1,2]], b = [1,2,1]; assert correct solution within 1e-12
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::sums_duplicate_entries` — stamp (0,0) with 3.0, stamp (0,0) with 2.0; assert the (0,0) entry equals 5.0 after finalize
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::detects_singular_matrix` — A = [[1,1],[1,1]]; assert `factor()` returns `{ success: false }` with `singularRow` set
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::identity_matrix_trivial` — I × x = b; assert x equals b exactly
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::reuses_symbolic_across_numeric_refactor` — assemble + finalize + factor + solve; change values only (same nonzero pattern), finalize + factor + solve again; assert both solutions correct; verify symbolic ran only once (internal state check or timing comparison)
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::invalidate_forces_resymbolize` — change the nonzero pattern after `invalidateTopology()`; assert the new pattern is used and produces correct results
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::mna_resistor_divider_3x3` — stamp the full MNA matrix for Vs=5V between node 1 and ground, R1=1kOhm between node 1 and node 2, R2=1kOhm between node 2 and ground; assert V1=5.0, V2=2.5, Ivs=-0.0025A within 1e-10
  - `src/analog/__tests__/sparse-solver.test.ts::SparseSolver::performance_50_node` — random 50-node sparse matrix (density ~10%): assert symbolic < 1ms, numeric factor < 0.5ms, solve < 0.2ms (5x relaxed for CI)
- **Acceptance criteria**:
  - Solves arbitrary sparse systems Ax=b correctly to double precision
  - Singular matrices detected and reported via `FactorResult`
  - Symbolic factorization cached and reused when topology unchanged
  - No heap allocations on numeric factor + solve path after first symbolic pass
  - Performance within targets in circuits-engine-spec.md section 3 (with CI tolerance)

---

## Wave 1.2: MNA Infrastructure

### Task 1.2.1: Diagnostic Emission Infrastructure

- **Description**: Build the runtime machinery for emitting, collecting, and dispatching `SolverDiagnostic` events. The types were defined in Phase 0 (`analog-engine-interface.ts`); this task builds the collector that the NR loop, DC OP solver, and timestep controller emit into.
- **Files to create**:
  - `src/analog/diagnostics.ts`:
    - Class `DiagnosticCollector`:
      - `emit(diag: SolverDiagnostic)` — stores diagnostic and synchronously dispatches to all registered callbacks
      - `onDiagnostic(callback: (diag: SolverDiagnostic) => void)` — registers a listener
      - `removeDiagnosticListener(callback)` — unregisters a listener
      - `getDiagnostics(): SolverDiagnostic[]` — returns all collected diagnostics since last clear
      - `clear()` — clears collected diagnostics (called between analyses)
    - Helper `makeDiagnostic(code: SolverDiagnosticCode, severity: 'info' | 'warning' | 'error', summary: string, opts?: Partial<SolverDiagnostic>): SolverDiagnostic` — factory with required fields filled in, suggestions defaults to `[]`, optional fields from opts
    - `ConvergenceTrace` type: `{ largestChangeElement: number, largestChangeNode: number, oscillating: boolean, iteration: number, fallbackLevel: 'none' | 'gmin' | 'source-step' }`
- **Tests**:
  - `src/analog/__tests__/diagnostics.test.ts::DiagnosticCollector::emits_to_registered_callbacks` — register two callbacks, emit one diagnostic; assert both receive it with correct fields
  - `src/analog/__tests__/diagnostics.test.ts::DiagnosticCollector::collects_all_diagnostics` — emit 3 diagnostics; assert `getDiagnostics()` returns all 3 in emission order
  - `src/analog/__tests__/diagnostics.test.ts::DiagnosticCollector::clear_resets` — emit diagnostics, clear; assert `getDiagnostics()` returns empty array
  - `src/analog/__tests__/diagnostics.test.ts::DiagnosticCollector::remove_listener_stops_delivery` — register callback, remove it, emit; assert callback was not called after removal
  - `src/analog/__tests__/diagnostics.test.ts::makeDiagnostic::fills_required_fields` — assert code, severity, summary are set; suggestions defaults to `[]`; involvedNodes defaults to undefined
- **Acceptance criteria**:
  - Diagnostics emitted synchronously (no deferred dispatch)
  - Multiple listeners supported; removal works
  - Every diagnostic has code, severity, summary at minimum
  - `ConvergenceTrace` type is exported for use by NR loop

---

### Task 1.2.2: Analog Element Interface + Node Mapping + MNA Assembler

- **Description**: Define the `AnalogElement` interface that all analog components program against (with separate linear and nonlinear stamp methods), the node mapping system that assigns integer node IDs to circuit nodes, and the `MNAAssembler` that orchestrates stamp passes. Implement minimal test elements (resistor, voltage source, current source) for testing the infrastructure — these are engine-internal fixtures, not full `ComponentDefinition` registrations (Phase 2).
- **Files to create**:
  - `src/analog/element.ts`:
    - `AnalogElement` interface:
      - `readonly nodeIndices: readonly number[]` — node IDs this element connects to (2 for two-terminal, 3 for BJT, 4 for MOSFET)
      - `readonly branchIndex: number` — assigned branch index for elements that add MNA rows (voltage sources, inductors); -1 for elements with no branch
      - `stamp(solver: SparseSolver): void` — stamp linear (topology-dependent, operating-point-independent) contributions; called once at the start of each NR solve
      - `stampNonlinear?(solver: SparseSolver): void` — stamp linearized nonlinear contributions at current operating point; called every NR iteration; only implemented by nonlinear elements (diodes, BJTs, MOSFETs)
      - `updateOperatingPoint?(voltages: Float64Array): void` — update internal linearization state from latest solution vector; called after each NR iteration for nonlinear elements
      - `stampCompanion?(dt: number, method: IntegrationMethod, voltages: Float64Array): void` — recomputes companion model coefficients (geq, ieq) for the current dt and integration method, then stamps them into the MNA matrix; called on reactive elements (capacitors, inductors, coupled inductors)
      - `updateState?(dt: number, voltages: Float64Array): void` — updates internal state variables that are NOT MNA companion models (e.g., thermal energy in fuses, memristor flux state); called after each accepted timestep on elements that have non-MNA internal state
      - `checkConvergence?(voltages: Float64Array, prevVoltages: Float64Array): boolean` — element-specific convergence check beyond the global node voltage criterion
      - `getLteEstimate?(dt: number): { truncationError: number }` — optional method for reactive elements to compute and return their local truncation error
      - `setSourceScale?(factor: number): void` — optional method for independent voltage and current sources; called by the DC operating point solver during source stepping with `factor` ramping from 0 to 1; elements that are not independent sources do not implement this method
      - `stampAc?(solver: ComplexSparseSolver, omega: number): void` — stamps the element's frequency-dependent small-signal model for AC analysis; resistors stamp conductance (same as DC); capacitors stamp `jωC` admittance; inductors stamp `1/(jωL)` admittance; nonlinear elements stamp linearized small-signal conductances (gm, gds, etc.) at the DC operating point; called once per frequency point during AC sweep; the `ComplexSparseSolver` type is defined in Phase 6
      - `readonly isNonlinear: boolean` — true if element implements `stampNonlinear`
      - `readonly isReactive: boolean` — true if element implements `stampCompanion`
      - `label?: string` — for diagnostic attribution
    - `IntegrationMethod` type: `'trapezoidal' | 'bdf1' | 'bdf2'`
  - `src/analog/node-map.ts`:
    - Function `buildNodeMap(circuit: Circuit): NodeMap`
    - `NodeMap` type:
      - `nodeCount: number` — number of non-ground nodes
      - `branchCount: number` — number of voltage source / inductor branches
      - `matrixSize: number` — `nodeCount + branchCount`
      - `wireToNodeId: Map<Wire, number>` — maps every wire segment to its node ID
      - `labelToNodeId: Map<string, number>` — maps In/Out/Probe component labels to node IDs
      - `elementNodes: Map<CircuitElement, number[]>` — per-element ordered list of node IDs matching pin order
    - Ground identification: finds elements with type "Ground" (or analog equivalent); all wires connected to a Ground element's pin get node ID 0; if no Ground element found, emits `no-ground` diagnostic and assigns node 0 to the most-connected node with a warning
  - `src/analog/mna-assembler.ts`:
    - Class `MNAAssembler`:
      - Constructor takes `SparseSolver` reference
      - `stampLinear(elements: readonly AnalogElement[])` — calls `element.stamp(solver)` for every element; called once at the start of each NR solve
      - `stampNonlinear(elements: readonly AnalogElement[])` — calls `element.stampNonlinear!(solver)` for every element where `isNonlinear === true`; called every NR iteration
      - `updateOperatingPoints(elements: readonly AnalogElement[], voltages: Float64Array)` — calls `element.updateOperatingPoint!(voltages)` for nonlinear elements
      - `checkAllConverged(elements: readonly AnalogElement[], voltages: Float64Array, prevVoltages: Float64Array): boolean` — returns true only when all elements report converged (elements without `checkConvergence` are assumed converged)
  - `src/analog/test-elements.ts` (engine-internal test fixtures):
    - `makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement` — stamps +/-1/R conductance into the G matrix; `isNonlinear: false, isReactive: false`
    - `makeVoltageSource(nodePos: number, nodeNeg: number, branchIdx: number, voltage: number): AnalogElement` — stamps incidence matrix B/C entries and RHS voltage; `isNonlinear: false, isReactive: false`
    - `makeCurrentSource(nodePos: number, nodeNeg: number, current: number): AnalogElement` — stamps RHS current entries; `isNonlinear: false, isReactive: false`
- **Tests**:
  - `src/analog/__tests__/mna-assembler.test.ts::NodeMapping::assigns_unique_node_ids` — build a circuit with 3 disjoint wire groups plus ground; assert 3 non-ground node IDs assigned (1, 2, 3)
  - `src/analog/__tests__/mna-assembler.test.ts::NodeMapping::ground_is_node_zero` — assert all wires connected to a Ground element get node ID 0
  - `src/analog/__tests__/mna-assembler.test.ts::NodeMapping::merged_wires_share_node_id` — two wires sharing an endpoint get the same node ID
  - `src/analog/__tests__/mna-assembler.test.ts::NodeMapping::labels_mapped` — assert In/Out component labels appear in `labelToNodeId` with correct node IDs
  - `src/analog/__tests__/mna-assembler.test.ts::NodeMapping::missing_ground_emits_diagnostic` — circuit with no Ground element; assert a diagnostic is emitted (not a hard error)
  - `src/analog/__tests__/mna-assembler.test.ts::Stamping::resistor_divider_dc` — Vs=5V, R1=1kOhm, R2=1kOhm: assemble linear → finalize → factor → solve; assert V_mid = 2.5V within 1e-10
  - `src/analog/__tests__/mna-assembler.test.ts::Stamping::two_voltage_sources_series` — V1=3V + V2=2V in series with R=1kOhm to ground; assert current = 5mA
  - `src/analog/__tests__/mna-assembler.test.ts::Stamping::current_source_with_resistor` — I=1mA through R=1kOhm; assert V = 1.0V across resistor
  - `src/analog/__tests__/mna-assembler.test.ts::Assembler::linear_only_stamps_once` — spy on resistor's `stamp()`; call `stampLinear` twice; assert stamp called twice (caller controls when to call)
  - `src/analog/__tests__/mna-assembler.test.ts::Assembler::nonlinear_skips_linear_elements` — spy on resistor (isNonlinear=false); call `stampNonlinear`; assert resistor's `stampNonlinear` never called
  - `src/analog/__tests__/mna-assembler.test.ts::Convergence::all_linear_converges_immediately` — assert `checkAllConverged()` returns true when all elements have no `checkConvergence` method
- **Acceptance criteria**:
  - `AnalogElement` interface is the sole contract analog components program against
  - Linear and nonlinear stamp passes are separate — the NR loop stamps linear once, nonlinear each iteration
  - Node mapping correctly identifies connected wire groups via union-find or equivalent
  - Ground node is always ID 0 when a Ground element is present
  - Missing Ground element produces a diagnostic, not a crash
  - Test elements (resistor, voltage source, current source) produce correct MNA stamps verified through full solve

---

## Wave 1.3: Newton-Raphson + DC Operating Point

### Task 1.3.1: Newton-Raphson Iteration Loop

- **Description**: Implement the NR iteration loop with separate linear/nonlinear stamp passes, voltage limiting (`pnjlim` for diode/BJT junctions, `fetlim` for MOSFETs), convergence checking (global node voltage criterion + element-specific checks), and blame tracking via `ConvergenceTrace`. Implement a `makeDiode` test element (Shockley equation with NR linearization) to validate nonlinear convergence.
- **Files to create**:
  - `src/analog/newton-raphson.ts`:
    - Function `newtonRaphson(opts: NROptions): NRResult`:
      - `NROptions`: `{ solver: SparseSolver, elements: readonly AnalogElement[], matrixSize: number, maxIterations: number, reltol: number, abstol: number, initialGuess?: Float64Array, diagnostics: DiagnosticCollector }`
      - Algorithm:
        1. Allocate `voltages` and `prevVoltages` (Float64Array, size = matrixSize)
        2. Copy `initialGuess` into `voltages` if provided, else zero
        3. For iteration = 1 to maxIterations:
           a. `solver.beginAssembly(matrixSize)` — clear matrix
           b. `assembler.stampLinear(elements)` — stamp all linear contributions
           c. `assembler.stampNonlinear(elements)` — stamp nonlinear at current operating point
           d. `solver.finalize()`
           e. `solver.factor()` — if singular, record in trace, return non-converged
           f. `solver.solve(voltages)`
           g. Apply voltage limiting: `pnjlim` for elements with PN junctions, `fetlim` for FETs
           h. Check convergence: `|v_new[i] - v_old[i]| < abstol + reltol * |v_new[i]|` for every node, AND `assembler.checkAllConverged(elements, voltages, prevVoltages)`
           i. Record `ConvergenceTrace` for this iteration (largest change node, largest change element, oscillation detection)
           j. If converged, return `{ converged: true, iterations, voltages, trace }`
           k. `assembler.updateOperatingPoints(elements, voltages)`
           l. Copy `voltages` → `prevVoltages`
        4. Return `{ converged: false, iterations: maxIterations, voltages, trace }`
      - Returns `NRResult`: `{ converged: boolean, iterations: number, voltages: Float64Array, trace: ConvergenceTrace[] }`
    - `pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number` — if voltage step > 2·Vt, compress logarithmically; clamp to Vcrit = Vt · ln(Vt / (Is · sqrt(2)))
    - `fetlim(vnew: number, vold: number, vto: number): number` — clamp Vgs change to 0.5V per iteration when above threshold
  - `src/analog/test-elements.ts` (extend):
    - `makeDiode(nodeAnode: number, nodeCathode: number, is: number, n: number): AnalogElement`:
      - `isNonlinear: true, isReactive: false`
      - Internal state: `geq` (linearized conductance), `ieq` (equivalent current), `vd` (current operating point voltage)
      - `stamp()`: no-op (no linear contribution)
      - `stampNonlinear()`: stamps `geq` as conductance and `ieq` as current source between anode and cathode
      - `updateOperatingPoint(voltages)`: reads vd = V(anode) - V(cathode), computes `Id = Is · (exp(vd / (n·Vt)) - 1)`, `geq = Id / (n·Vt)` (+ gmin for numerical stability), `ieq = Id - geq · vd`
      - `checkConvergence()`: checks diode voltage change is within pnjlim bounds
- **Tests**:
  - `src/analog/__tests__/newton-raphson.test.ts::NR::linear_converges_in_one_iteration` — resistor divider (Vs + R1 + R2); assert `converged: true, iterations: 1`
  - `src/analog/__tests__/newton-raphson.test.ts::NR::diode_circuit_converges` — diode (Is=1e-14, n=1) in series with 1kOhm resistor and 5V source; assert `converged: true`, `iterations < 20`, forward voltage between 0.6V and 0.75V
  - `src/analog/__tests__/newton-raphson.test.ts::NR::diode_reverse_bias` — diode with -5V source; assert converged, current magnitude < 1e-12 A
  - `src/analog/__tests__/newton-raphson.test.ts::NR::pnjlim_clamps_large_step` — `pnjlim(100, 0.5, 0.026, 0.6)` returns a value << 100 (logarithmic compression applied)
  - `src/analog/__tests__/newton-raphson.test.ts::NR::pnjlim_passes_small_step` — `pnjlim(0.65, 0.60, 0.026, 0.6)` returns 0.65 (unchanged, within threshold)
  - `src/analog/__tests__/newton-raphson.test.ts::NR::fetlim_clamps_above_threshold` — Vgs step from 1.0V to 3.0V (>0.5V change above Vto=0.7V); assert clamped to at most 0.5V change
  - `src/analog/__tests__/newton-raphson.test.ts::NR::reports_non_convergence` — diode circuit with maxIterations=2; assert `converged: false, iterations: 2`
  - `src/analog/__tests__/newton-raphson.test.ts::NR::convergence_trace_populated` — assert trace array has one entry per iteration with `largestChangeNode` set to a valid node index
  - `src/analog/__tests__/newton-raphson.test.ts::NR::initial_guess_used` — provide initial guess close to solution; assert fewer iterations than zero initial guess
- **Acceptance criteria**:
  - Linear circuits converge in exactly 1 NR iteration
  - Diode circuits converge in < 20 iterations with correct forward voltage
  - Voltage limiters prevent exponential runaway (no NaN or Infinity in solution)
  - Non-convergence is reported via return value, not thrown — the caller (DC OP solver) decides fallback
  - `ConvergenceTrace` is populated for every iteration — blame tracking from day 1
  - Linear and nonlinear contributions both stamped inside the NR loop after matrix clear each iteration

---

### Task 1.3.2: DC Operating Point Solver

- **Description**: Implement the DC operating point solver with the three-level fallback stack: direct NR → Gmin stepping → source stepping → failure. Each fallback level emits diagnostics via the `DiagnosticCollector`.
- **Files to create**:
  - `src/analog/dc-operating-point.ts`:
    - Function `solveDcOperatingPoint(opts: DcOpOptions): DcOpResult`:
      - `DcOpOptions`: `{ solver: SparseSolver, elements: readonly AnalogElement[], matrixSize: number, params: SimulationParams, diagnostics: DiagnosticCollector }`
      - **Level 0 — Direct NR**: run `newtonRaphson()` with configured tolerances. If converged, emit `dc-op-converged` (info), return `{ converged: true, method: 'direct', ... }`.
      - **Level 1 — Gmin stepping**: create temporary Gmin shunt elements (conductance from every node to ground). Start with gmin = 1e-2, solve. Reduce by 10×: 1e-2 → 1e-3 → ... → configured `params.gmin`. Each step uses previous solution as initial guess. Emit `dc-op-gmin` diagnostic (info). If all steps converge, return `{ method: 'gmin-stepping' }`.
      - **Level 2 — Source stepping**: scale all independent voltage and current sources to 0. Solve (trivial — zero initial guess works). Ramp in 10% increments: 10% → 20% → ... → 100%. Each step uses previous solution. Emit `dc-op-source-step` diagnostic (warning). If all steps converge, return `{ method: 'source-stepping' }`.
      - **Level 3 — Failure**: emit `dc-op-failed` diagnostic (error) with blame attribution from the last NR trace (which node, which element). Return `{ converged: false }`.
    - Gmin shunt implementation: temporary `AnalogElement` objects that stamp `gmin` conductance from each node to ground; these are prepended to the element list during Gmin stepping and removed after.
    - Source scaling: each independent source element needs a `setScale(factor: number)` mechanism. Add `scale?: number` to the test elements' voltage/current source implementations. During source stepping, the DC OP solver sets scale on each source before running NR.
- **Files to modify**:
  - `src/analog/test-elements.ts`:
    - Add `scale` property to `makeVoltageSource` and `makeCurrentSource` return types; stamp function multiplies the source value by `scale` (default 1.0)
- **Tests**:
  - `src/analog/__tests__/dc-operating-point.test.ts::DcOP::simple_resistor_divider_direct` — Vs=5V, R1=R2=1kOhm; assert `method: 'direct', converged: true`, V_mid = 2.5V
  - `src/analog/__tests__/dc-operating-point.test.ts::DcOP::diode_circuit_direct` — single diode + resistor + Vs; assert converges directly, forward voltage correct
  - `src/analog/__tests__/dc-operating-point.test.ts::DcOP::gmin_stepping_fallback` — circuit that fails direct NR (two diodes in anti-parallel with high-value resistor, poor initial conditions); assert `method: 'gmin-stepping'`, `dc-op-gmin` diagnostic emitted
  - `src/analog/__tests__/dc-operating-point.test.ts::DcOP::source_stepping_fallback` — circuit that fails gmin stepping (deeply nonlinear, multiple operating points); assert `method: 'source-stepping'`, both `dc-op-gmin` and `dc-op-source-step` diagnostics emitted
  - `src/analog/__tests__/dc-operating-point.test.ts::DcOP::failure_reports_blame` — force total failure (maxIterations=1, all fallbacks fail); assert `converged: false`, `dc-op-failed` diagnostic with `involvedNodes` populated
  - `src/analog/__tests__/dc-operating-point.test.ts::DcOP::direct_success_emits_converged_info` — assert `dc-op-converged` diagnostic (severity info) emitted on direct success
- **Acceptance criteria**:
  - Three-level fallback stack executes in order: direct → gmin → source → failure
  - Each level emits appropriate diagnostics before proceeding to next level
  - Diagnostics include circuit-level attribution (node IDs, element IDs), not matrix row numbers
  - `DcOpResult` matches the type defined in Phase 0
  - Gmin stepping reduces gmin by 10× per step from 1e-2 down to `params.gmin`
  - Source stepping ramps in 10% increments from 0% to 100%
  - Each fallback level uses previous solution as initial guess for the next step

---

## Wave 1.4: Companion Models + Timestep Control

### Task 1.4.1: Companion Models for Reactive Elements

- **Description**: Implement companion model coefficients for capacitor and inductor under three integration methods (trapezoidal, BDF-1, BDF-2). Add test elements `makeCapacitor` and `makeInductor` that stamp using companion models. Implement history storage (two `Float64Array` vectors, pointer-swapped per timestep) for BDF-2 which requires v(n) and v(n-1).
- **Files to create**:
  - `src/analog/integration.ts`:
    - Companion model coefficient functions:
      - `capacitorConductance(C: number, dt: number, method: IntegrationMethod): number` — returns geq
      - `capacitorHistoryCurrent(C: number, dt: number, method: IntegrationMethod, vNow: number, vPrev: number, iNow: number): number` — returns ieq
      - `inductorConductance(L: number, dt: number, method: IntegrationMethod): number` — returns geq
      - `inductorHistoryCurrent(L: number, dt: number, method: IntegrationMethod, iNow: number, iPrev: number, vNow: number): number` — returns ieq
    - Coefficient formulas (from circuits-engine-spec.md section 4):
      - BDF-1 (Backward Euler): capacitor geq = C/h, ieq = -geq · v(n)
      - Trapezoidal: capacitor geq = 2C/h, ieq = -geq · v(n) - i(n)
      - BDF-2 (Gear order 2): capacitor geq = 3C/(2h), ieq = -geq · (4/3 · v(n) - 1/3 · v(n-1))
      - Inductor: same pattern with L replacing C, voltage/current roles swapped
    - Class `HistoryStore`:
      - Constructor takes `elementCount: number`
      - `get(elementIndex: number, stepsBack: 0 | 1): number` — returns v(n) (stepsBack=0) or v(n-1) (stepsBack=1)
      - `push(elementIndex: number, value: number)` — rotates history for this element via pointer swap (v(n-1) ← v(n), v(n) ← new value); no array copy
      - `reset()` — zeros all history entries
      - Internal: two `Float64Array` vectors of length `elementCount`, swapped by toggling an index flag
  - `src/analog/test-elements.ts` (extend):
    - `makeCapacitor(nodeA: number, nodeB: number, capacitance: number): AnalogElement`:
      - `isNonlinear: false, isReactive: true`
      - Internal state: `geq`, `ieq` computed in `stampCompanion()`
      - `stamp()`: stamps `geq` as conductance and `ieq` as current source between nodes
      - `stampCompanion(dt, method, voltages)`: computes `geq` and `ieq` using `capacitorConductance` and `capacitorHistoryCurrent`, then stamps them; reads terminal voltages from solution
    - `makeInductor(nodeA: number, nodeB: number, branchIdx: number, inductance: number): AnalogElement`:
      - Same pattern with voltage/current roles swapped; adds MNA branch row
- **Tests**:
  - `src/analog/__tests__/integration.test.ts::CompanionModels::capacitor_bdf1_coefficients` — C=1uF, h=1us; assert geq = 1.0 S
  - `src/analog/__tests__/integration.test.ts::CompanionModels::capacitor_trapezoidal_coefficients` — C=1uF, h=1us; assert geq = 2.0 S
  - `src/analog/__tests__/integration.test.ts::CompanionModels::capacitor_bdf2_coefficients` — C=1uF, h=1us; assert geq = 1.5 S
  - `src/analog/__tests__/integration.test.ts::CompanionModels::inductor_coefficients_dual_of_capacitor` — verify inductor geq for each method equals the capacitor formula with L in place of C
  - `src/analog/__tests__/integration.test.ts::HistoryStore::push_rotates_values` — push v1, push v2; assert get(idx, 0) = v2, get(idx, 1) = v1
  - `src/analog/__tests__/integration.test.ts::HistoryStore::reset_zeros_all` — push values, reset; assert all get() returns 0
  - `src/analog/__tests__/integration.test.ts::HistoryStore::independent_per_element` — push different values for element 0 and element 1; assert independent history
  - `src/analog/__tests__/integration.test.ts::RCCircuit::exponential_decay_trapezoidal` — RC circuit (R=1kOhm, C=1uF) charged to 5V: DC OP at 5V, then step 1000 times with trapezoidal at h=1us; assert voltage at t=RC (1ms) within 5% of 5·e^(-1) = 1.839V
  - `src/analog/__tests__/integration.test.ts::RCCircuit::exponential_decay_bdf2` — same circuit with BDF-2; assert within 5% of analytical
  - `src/analog/__tests__/integration.test.ts::RLCircuit::current_rise` — RL circuit (R=1kOhm, L=1mH, Vs=5V): step and verify current at t=L/R within 5% of (Vs/R)·(1-e^(-1))
- **Acceptance criteria**:
  - Companion model coefficients match circuits-engine-spec.md section 4 exactly
  - RC circuit transient matches analytical exponential decay within 5% at t=RC
  - RL circuit transient matches analytical current rise within 5% at t=L/R
  - BDF-2 history uses pointer swap, not array copy (zero allocation per timestep)
  - All three integration methods produce converging, stable results

---

### Task 1.4.2: LTE Timestep Control + Auto-Switching

- **Description**: Implement local truncation error estimation for reactive elements, adaptive timestep computation with safety margin, timestep rejection with halving, and automatic integration method switching (BDF-1 startup → trapezoidal → BDF-2 on trap ringing → back to trapezoidal). Include breakpoint support for Phase 4 mixed-signal coordination.
- **Files to create**:
  - `src/analog/timestep.ts`:
    - Class `TimestepController`:
      - Constructor takes `SimulationParams`
      - `currentDt: number` — current timestep in seconds; initialized to `params.maxTimeStep`
      - `currentMethod: IntegrationMethod` — current integration method
      - `readonly largestErrorElement: number | undefined` — index of element with largest LTE (for diagnostics)
      - `computeNewDt(elements: readonly AnalogElement[], history: HistoryStore): number`:
        - Iterates reactive elements, calls `element.getLteEstimate(dt)` on each that implements the method
        - Takes the maximum `truncationError` across all reactive elements
        - Computes new dt as `dt * (tolerance / maxError)^(1/3)`, clamped to `[dt/4, 4*dt]`
        - Clamps to `[params.minTimeStep, params.maxTimeStep]`
        - Clamps to next breakpoint if within range: `min(newDt, nextBreakpoint - simTime)`
        - Records which element had the largest LTE in `largestErrorElement`
      - `shouldReject(r: number): boolean` — returns true when `r < 1`
      - `reject(): number` — halves `currentDt`, clamps to minTimeStep, returns new dt
      - `accept(simTime: number)` — advances accepted step count, pops breakpoint if reached
      - `checkMethodSwitch(elements: readonly AnalogElement[], history: HistoryStore): void`:
        - If a reactive element's terminal voltage alternates sign across 3 consecutive accepted timesteps → switch `currentMethod` to `'bdf2'`
        - After 5 consecutive non-oscillating accepted steps on BDF-2 → switch back to `'trapezoidal'`
        - Ringing detection runs once per accepted timestep, cost: one sign comparison per reactive element
      - Auto-switching state machine:
        - Steps 1-2 (accepted): `currentMethod = 'bdf1'` (suppress startup transients)
        - Steps 3+: `currentMethod = 'trapezoidal'`
        - On ringing detection: `currentMethod = 'bdf2'`
        - After 5 stable steps on BDF-2: `currentMethod = 'trapezoidal'`
      - Breakpoint support:
        - `addBreakpoint(time: number)` — inserts into sorted breakpoint list
        - `clearBreakpoints()` — empties breakpoint list
        - Internal: `_breakpoints: number[]` sorted ascending; `computeNewDt` clamps to `nextBreakpoint - simTime`; `accept()` pops breakpoint if `simTime >= _breakpoints[0]`
- **Tests**:
  - `src/analog/__tests__/timestep.test.ts::LTE::reduces_dt_for_large_error` — mock reactive element with LTE > chargeTol (r < 1); assert computed dt < currentDt
  - `src/analog/__tests__/timestep.test.ts::LTE::increases_dt_for_small_error` — mock small LTE (r >> 1); assert computed dt > currentDt, capped at 2× currentDt
  - `src/analog/__tests__/timestep.test.ts::LTE::clamps_to_bounds` — assert dt never goes below minTimeStep or above maxTimeStep regardless of r
  - `src/analog/__tests__/timestep.test.ts::LTE::safety_factor_0_9` — verify the 0.9× safety margin is applied (computed dt is 90% of unclamped theoretical)
  - `src/analog/__tests__/timestep.test.ts::LTE::largest_error_element_tracked` — assert `largestErrorElement` identifies the correct element
  - `src/analog/__tests__/timestep.test.ts::Rejection::shouldReject_true_when_r_lt_1` — assert `shouldReject(0.5)` returns true
  - `src/analog/__tests__/timestep.test.ts::Rejection::shouldReject_false_when_r_ge_1` — assert `shouldReject(1.0)` returns false
  - `src/analog/__tests__/timestep.test.ts::Rejection::reject_halves_dt` — assert dt after `reject()` equals half previous dt
  - `src/analog/__tests__/timestep.test.ts::Rejection::reject_clamps_to_min` — set dt = 2 × minTimeStep, reject twice; assert dt = minTimeStep (not below)
  - `src/analog/__tests__/timestep.test.ts::AutoSwitch::starts_with_bdf1` — assert `currentMethod` is `'bdf1'` before any accepted steps
  - `src/analog/__tests__/timestep.test.ts::AutoSwitch::switches_to_trapezoidal_after_2_steps` — call `accept()` twice; assert `currentMethod` is `'trapezoidal'`
  - `src/analog/__tests__/timestep.test.ts::AutoSwitch::detects_ringing_switches_to_bdf2` — feed alternating-sign terminal voltages across 3 steps; assert `currentMethod` switches to `'bdf2'`
  - `src/analog/__tests__/timestep.test.ts::AutoSwitch::returns_to_trapezoidal_after_5_stable` — after BDF-2 switch, feed 5 non-oscillating steps; assert `currentMethod` returns to `'trapezoidal'`
  - `src/analog/__tests__/timestep.test.ts::Breakpoints::clamps_dt_to_breakpoint` — add breakpoint at t=100us; with simTime=95us and adaptiveDt=10us; assert computed dt = 5us (lands exactly on breakpoint)
  - `src/analog/__tests__/timestep.test.ts::Breakpoints::pops_breakpoint_on_accept` — add breakpoint at t=100us; accept at simTime=100us; assert breakpoint removed from list
  - `src/analog/__tests__/timestep.test.ts::Breakpoints::clear_removes_all` — add 3 breakpoints, clear; assert no clamping on next computeNewDt
- **Acceptance criteria**:
  - LTE estimation matches circuits-engine-spec.md section 5 formulas
  - Timestep rejection reports via return value; state rollback is caller's responsibility
  - Auto-switching follows the state machine: BDF-1 (2 steps) → trapezoidal → BDF-2 (on ringing) → trapezoidal (after 5 stable)
  - Breakpoints clamp dt so steps land exactly at registered times
  - Diagnostic attribution identifies which element forced the timestep change via `largestErrorElement`

---

## Wave 1.5: Engine Assembly

### Task 1.5.1: Analog Compiler

- **Description**: Replace the Phase 0 stub in `src/analog/compiler.ts` with a working compiler that takes a `Circuit` with `engineType: "analog"`, builds the node map, instantiates `AnalogElement` objects from registered analog `ComponentDefinition`s via their `analogFactory`, and produces a `ConcreteCompiledAnalogCircuit`. Validates topology (floating nodes, voltage source loops, inductor loops, missing ground).
- **Files to modify**:
  - `src/analog/compiler.ts` — replace stub with:
    - `compileAnalogCircuit(circuit: Circuit, registry: ComponentRegistry): ConcreteCompiledAnalogCircuit`
    - Steps:
      1. Verify `circuit.metadata.engineType === "analog"` — throw if not
      2. Build node map via `buildNodeMap(circuit)` — assigns node IDs, identifies ground
      3. Read `requiresBranchRow` from each `ComponentDefinition`. Assign sequential branch indices (starting from 0) to components where `requiresBranchRow === true`. Pass the assigned `branchIdx` to `analogFactory`. Components with `requiresBranchRow === false` receive `branchIdx = -1`.
         - Note: The `requiresBranchRow: boolean` field is added to `ComponentDefinition` in Phase 0.
      4. The compiler calls `def.getInternalNodeCount?.(props) ?? 0` for each component to determine how many internal nodes to allocate. Internal node indices are assigned sequentially after the circuit's external nodes. This function is added to `ComponentDefinition` in Phase 0.
      5. For each circuit element: look up `ComponentDefinition` in registry; verify `engineType === "analog"` or the component is a shared type; call `analogFactory(nodeIds, branchIdx, props)` to create the `AnalogElement`
      6. Topology validation — emit diagnostics for:
         - `floating-node`: node with only one element terminal (no current path)
         - `voltage-source-loop`: cycle of voltage sources with no resistance
         - `inductor-loop`: cycle of inductors with no resistance (would create singular matrix)
         - Missing ground: no Ground element found (already handled by `buildNodeMap` but compiler re-checks)
      7. Build and return `ConcreteCompiledAnalogCircuit`
- **Files to create**:
  - `src/analog/compiled-analog-circuit.ts`:
    - `ConcreteCompiledAnalogCircuit` implementing `CompiledAnalogCircuit` (from Phase 0):
      - `netCount` / `nodeCount: number` — number of non-ground nodes (netCount = nodeCount for CompiledCircuit base)
      - `componentCount` / `elementCount: number` — number of analog elements
      - `matrixSize: number` — nodeCount + branchCount
      - `branchCount: number` — number of voltage source / inductor branches
      - `elements: AnalogElement[]` — all elements with stamp functions and node assignments
      - `labelToNodeId: Map<string, number>` — for runner label resolution
      - `wireToNodeId: Map<Wire, number>` — for wire renderer signal access
      - `models: Map<string, DeviceModel>` — device models (empty until Phase 2 adds .MODEL support)
      - `elementToCircuitElement: Map<number, CircuitElement>` — element index → visual element, for diagnostic attribution and UI highlighting
- **Tests**:
  - `src/analog/__tests__/compiler.test.ts::AnalogCompiler::compiles_resistor_divider` — build a Circuit with analog Vs, R1, R2, Ground elements registered in a test registry with `analogFactory`; assert nodeCount=2, branchCount=1, matrixSize=3, elements.length=4
  - `src/analog/__tests__/compiler.test.ts::AnalogCompiler::assigns_ground_node_zero` — assert the Ground element connects to node 0
  - `src/analog/__tests__/compiler.test.ts::AnalogCompiler::maps_labels_to_nodes` — add labeled In/Out elements; assert `labelToNodeId` contains them with correct node IDs
  - `src/analog/__tests__/compiler.test.ts::AnalogCompiler::detects_floating_node` — circuit with a node connected to only one element terminal; assert `floating-node` diagnostic emitted
  - `src/analog/__tests__/compiler.test.ts::AnalogCompiler::detects_voltage_source_loop` — two voltage sources in a loop with no resistance; assert `voltage-source-loop` diagnostic
  - `src/analog/__tests__/compiler.test.ts::AnalogCompiler::detects_missing_ground` — circuit with no Ground element; assert diagnostic emitted
  - `src/analog/__tests__/compiler.test.ts::AnalogCompiler::rejects_digital_only_component` — circuit containing an AND gate (engineType undefined = digital); assert error thrown
  - `src/analog/__tests__/compiler.test.ts::AnalogCompiler::calls_analog_factory_with_correct_args` — spy on a ComponentDefinition's `analogFactory`; assert it receives correct `nodeIds`, `branchIdx`, and `props`
- **Acceptance criteria**:
  - Produces a valid `ConcreteCompiledAnalogCircuit` from a Circuit with registered analog components
  - Node mapping correctly identifies connected wire groups; ground is node 0
  - Topology validation catches floating nodes, voltage source loops, inductor loops, missing ground
  - Digital-only components in an analog circuit are rejected with a clear error
  - Element creation goes through `analogFactory` on ComponentDefinition — no hardcoded element construction
  - Label resolution works for runner's `setInput`/`readOutput`

---

### Task 1.5.2: MNAEngine Class

- **Description**: Implement `MNAEngine` — the class that implements `AnalogEngine`, orchestrating the sparse solver, MNA assembler, NR iteration, companion models, timestep controller, and diagnostics into a working transient simulator. This is the analog counterpart of `DigitalEngine`.
- **Files to create**:
  - `src/analog/analog-engine.ts`:
    - Class `MNAEngine implements AnalogEngine`:
      - **State**:
        - `_voltages: Float64Array` — current node voltages + branch currents (size = matrixSize)
        - `_prevVoltages: Float64Array` — previous timestep's solution (for LTE and rollback)
        - `_solver: SparseSolver`
        - `_assembler: MNAAssembler`
        - `_timestep: TimestepController`
        - `_history: HistoryStore`
        - `_diagnostics: DiagnosticCollector`
        - `_compiled: ConcreteCompiledAnalogCircuit | null`
        - `_engineState: EngineState`
        - `_simTime: number` — current simulation time in seconds
        - `_lastDt: number` — last accepted timestep
      - **Lifecycle** (Engine interface):
        - `init(circuit: CompiledCircuit)`: narrow to `ConcreteCompiledAnalogCircuit`, allocate Float64Array state, create solver/assembler/timestep/history/diagnostics, configure from default `SimulationParams`
        - `reset()`: zero all voltages, reset history, reset timestep controller (back to BDF-1 startup), clear diagnostics, simTime = 0
        - `dispose()`: release all arrays and references
        - `step()`: one transient timestep:
          1. Save `_voltages` → `_prevVoltages` (for potential rollback)
          2. Update companion models: call `element.stampCompanion(dt, method, voltages)` for each reactive element
          3. Run `newtonRaphson()` to convergence
          4. If NR did not converge: reject the timestep. Halve dt down to `minDt = 1e-15s`. Retry NR with the reduced dt. If dt < minDt, emit `convergence-failed` diagnostic with severity `error`, blaming the element with the largest voltage change between the last two NR iterations, and transition to `STOPPED` state.
          5. Estimate LTE via `_timestep.computeNewDt(elements, history)`
          6. If `_timestep.shouldReject()`: restore `_prevVoltages`, call `_timestep.reject()`, retry step with halved dt (up to minTimeStep; emit `timestep-at-minimum` if reached)
          7. If accepted: `_simTime += _lastDt`, push history, `_timestep.accept(simTime)`, check method switch, update `_lastDt` to new dt
        - `start()`: transition to RUNNING state
        - `stop()`: transition to PAUSED state
        - `getState()`: return current EngineState
        - `addChangeListener` / `removeChangeListener`: standard listener management
      - **Analog-specific** (AnalogEngine interface):
        - `dcOperatingPoint()`: delegate to `solveDcOperatingPoint()`, store result in `_voltages`, return `DcOpResult`
        - `get simTime()`: return `_simTime`
        - `get lastDt()`: return `_lastDt`
        - `getNodeVoltage(nodeId)`: return `_voltages[nodeId]`
        - `getBranchCurrent(branchId)`: return `_voltages[nodeCount + branchId]`
        - `getElementCurrent(elementId)`: compute from element's terminal node voltages and stamp-derived conductance (for resistors: V/R; for sources: branch current; for nonlinear: stored operating point current)
        - `getElementPower(elementId)`: voltage across × current through
        - `configure(params)`: merge into stored `SimulationParams`, rebuild timestep controller if bounds changed
        - `onDiagnostic(callback)`: delegate to `_diagnostics.onDiagnostic(callback)`
        - `addBreakpoint(time)`: delegate to `_timestep.addBreakpoint(time)`
        - `clearBreakpoints()`: delegate to `_timestep.clearBreakpoints()`
- **Tests**:
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::init_allocates_correct_size` — init with compiled resistor divider (matrixSize=3); assert `_voltages` has length 3
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::dc_op_resistor_divider` — Vs=5V, R1=R2=1kOhm; init → dcOperatingPoint(); assert `getNodeVoltage(1)` = 5.0, `getNodeVoltage(2)` = 2.5
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::dc_op_diode_circuit` — diode + resistor + Vs; init → dcOperatingPoint(); assert forward voltage between 0.6V and 0.75V
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::dc_op_returns_result` — assert returned `DcOpResult` has `converged: true`, `method: 'direct'`, `nodeVoltages` array with correct values
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::transient_rc_decay` — RC circuit (R=1kOhm, C=1uF, V0=5V): dcOP → step 1000 times; assert voltage at t approximately RC (1ms) within 5% of 5·e^(-1)
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::sim_time_advances` — step 10 times; assert `simTime > 0` and `simTime` equals cumulative sum of accepted dt values
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::last_dt_reflects_adaptive_step` — step once; assert `lastDt > 0` and `lastDt <= maxTimeStep`
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::reset_clears_state` — dcOP → step 5 times → reset; assert `simTime === 0`, all `getNodeVoltage()` returns 0, `getState()` returns STOPPED
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::configure_changes_tolerances` — configure with `{ reltol: 1e-6 }`; assert next dcOP uses tighter tolerance (may require more iterations for same circuit)
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::diagnostics_emitted_on_fallback` — circuit requiring gmin stepping; register onDiagnostic callback; assert callback receives `dc-op-gmin` diagnostic
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::satisfies_engine_interface` — `const e: Engine = new MNAEngine(); e.step();` — compile-time check that MNAEngine is assignable to Engine
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::satisfies_analog_engine_interface` — `const ae: AnalogEngine = new MNAEngine();` — compile-time assignability check
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::breakpoint_honored` — add breakpoint at t=50us; step until simTime >= 50us; assert simTime === 50us exactly (within floating-point tolerance)
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::runner_integration` — create `SimulationRunner`, compile an analog Circuit, call `dcOperatingPoint(engine)`, call `readOutput(engine, "V_mid")`; assert correct voltage returned by label
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::get_branch_current` — resistor divider with Vs; assert `getBranchCurrent(0)` equals expected current (Vs / (R1+R2))
  - `src/analog/__tests__/analog-engine.test.ts::MNAEngine::engine_state_transitions` — assert init→STOPPED, start→RUNNING, stop→PAUSED, reset→STOPPED
- **Acceptance criteria**:
  - `MNAEngine` implements `AnalogEngine` which extends `Engine`
  - DC operating point works correctly for linear and nonlinear circuits
  - Transient simulation with RC circuit matches analytical solution within 5% at t=RC
  - `simTime` advances correctly and equals cumulative accepted dt
  - `lastDt` reflects the most recently accepted adaptive timestep
  - Timestep rejection triggers rollback and retry with halved dt
  - Breakpoints are honored — steps land exactly at registered times
  - Diagnostics are emitted to registered callbacks for all solver events
  - Engine integrates with `SimulationRunner` for label-based signal access
  - All Engine lifecycle methods work correctly: init, step, reset, dispose, start, stop, getState
  - Change listeners are notified on state transitions
