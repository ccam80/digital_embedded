# Phase 1: Zero-Alloc Infrastructure — CKTCircuitContext

## Overview

Introduce `CKTCircuitContext` as the single god-object holding all pre-allocated buffers, solver state, and compiled circuit references. Matches ngspice's `CKTcircuit *ckt` — the one struct every function receives. Eliminates all per-call allocations in NR, integration, LTE, and DC-OP hot paths.

**Testing surfaces:** Phase 1 is an engine-internal refactor. Per the master plan Testing Surface Policy, Phase 1 is satisfied by unit tests defined below (headless API surface) plus Phase 7 parity tests as the E2E surface. No per-phase MCP or Playwright tests are required.

## Wave 1.1: CKTCircuitContext Definition and Allocation

### Task 1.1.1: Define CKTCircuitContext class

- **Description**: Create the `CKTCircuitContext` class containing all pre-allocated buffers, mode flags, element lists, and result structs. This replaces the current pattern of passing `solver`, `elements`, `matrixSize`, etc. as separate params to every function. Allocated once in `MNAEngine.init()`, mutated in place, never re-created.

  Fields are canonically defined in master plan **Appendix A — CKTCircuitContext Field Inventory** (`spec/ngspice-alignment-master.md`). Summary of field groups (see Appendix A for complete TypeScript definition with exact types):
  - Matrix/solver: `solver: SparseSolver`, `assembler: MNAAssembler` (hoisted per master plan resolved decisions; deleted in Phase 2 Wave 2.2)
  - Node voltages: `rhsOld`, `rhs`, `rhsSpare` (all `Float64Array(matrixSize)`)
  - Accepted solution: `acceptedVoltages`, `prevAcceptedVoltages` (`Float64Array(matrixSize)`)
  - DC-OP scratch: `dcopVoltages`, `dcopSavedVoltages`, `dcopSavedState0`, `dcopOldState0` (`Float64Array`)
  - Integration: `ag: Float64Array(7)`, `agp: Float64Array(7)`, `deltaOld: number[]` (pre-allocated length 7, matching `computeNIcomCof`/`solveGearVandermonde` `readonly number[]` parameter signature)
  - Gear scratch: `gearMatScratch: Float64Array(49)`
  - Results: `nrResult: NRResult` (mutable class), `dcopResult: DcOpResult` (mutable class)
  - Load context: `loadCtx: LoadContext` (mutable, passed to every `element.load()`)
  - Assembler state: `noncon: number`
  - Mode flags: `initMode`, `isDcOp`, `isTransient`, `srcFact`, `hadNodeset`
  - Circuit refs: `elements`, `matrixSize`, `nodeCount`, `statePool`
  - Pre-computed lists: `nonlinearElements`, `reactiveElements`, `poolBackedElements`, `elementsWithConvergence`, `elementsWithLte`, `elementsWithAcceptStep`
  - Tolerances: `reltol`, `abstol`, `voltTol`, `iabstol`, `maxIterations`, `transientMaxIterations`, `dcTrcvMaxIter`
  - Damping: `nodeDamping`, `diagonalGmin`
  - Nodesets: `nodesets: Map<number, number>`, `ics: Map<number, number>`
  - Instrumentation: `diagnostics`, `limitingCollector`, `enableBlameTracking`, `postIterationHook`, `detailedConvergence`
  - Bound closures (zero-alloc replacement for per-step arrow functions): `addBreakpointBound: (t: number) => void`, `preIterationHook: ((iteration: number, iterVoltages: Float64Array) => void) | null`

  The `assembler: MNAAssembler` field is initialized in the constructor via `new MNAAssembler(this.solver)` and is deleted in Phase 2 Wave 2.2 when `cktLoad` replaces it.

- **Files to create**:
  - `src/solver/analog/ckt-context.ts` — `CKTCircuitContext` class with constructor that takes `ConcreteCompiledAnalogCircuit` + `ResolvedSimulationParams` and allocates all buffers. Includes `NRResult` and `DcOpResult` as mutable classes (not interfaces).

- **Files to modify**:
  - `src/solver/analog/analog-engine.ts` — Replace all per-field buffer declarations (`_voltages`, `_prevVoltages`, `_nrVoltages`, `_nrPrevVoltages`, `_agp`, `_nodeVoltageHistory`) with a single `_ctx: CKTCircuitContext` field. `init()` constructs the context. All methods read/write through `_ctx`.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-context.test.ts::allocates_all_buffers_at_init` — Construct a `CKTCircuitContext` for a 10-node circuit. Assert all `Float64Array` fields have correct lengths. Assert `assembler` field exists and is a non-null `MNAAssembler` instance. Assert `nrResult` and `dcopResult` exist with default values. Assert pre-computed element lists are populated.
  - `src/solver/analog/__tests__/ckt-context.test.ts::zero_allocations_on_reuse` — In `beforeEach`, replace `globalThis.Float64Array` with a counting proxy wrapper: `const RealF64 = Float64Array; let allocCount = 0; globalThis.Float64Array = new Proxy(RealF64, { construct(target, args) { allocCount++; return new target(...args); } }) as any;`. Restore in `afterEach`. After initial context construction, reset `allocCount = 0`, then call a method that exercises the context (simulated NR iteration) twice. Assert `allocCount === 0` after the second invocation. This monkey-patch pattern is deterministic and exercises the exact constructor call path we care about.
  - `src/solver/analog/__tests__/ckt-context.test.ts::precomputed_lists_match_element_flags` — Assert `nonlinearElements` contains exactly the elements with `isNonlinear === true`, `reactiveElements` matches `isReactive === true`, etc.

- **Acceptance criteria**:
  - All buffers allocated once in constructor, never re-created.
  - `assembler: MNAAssembler` field exists and is initialized in the constructor.
  - `NRResult` and `DcOpResult` are mutable classes, not freshly-allocated object literals.
  - Pre-computed element lists eliminate all `elements.filter(...)` calls in hot paths.

### Task 1.1.2: Convert newtonRaphson to take CKTCircuitContext

- **Description**: Replace the `NROptions` interface and `NRResult` return type. `newtonRaphson(ctx: CKTCircuitContext): void` — writes into `ctx.nrResult` via mutation. All fields currently on `NROptions` are read from `ctx`. The `MNAAssembler` instantiation (`new MNAAssembler(solver)` at newton-raphson.ts:442) is eliminated — `ctx.noncon` replaces `assembler.noncon`, and `stampAll` logic moves into a `cktLoad(ctx)` function (Phase 2).

  For Phase 1, the assembler is hoisted to a field on `CKTCircuitContext` (temporary — deleted in Phase 6 when `cktLoad` replaces it).

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — Change `newtonRaphson` signature to `(ctx: CKTCircuitContext): void`. Remove `NROptions` interface. Remove `NRResult` interface (moved to ckt-context.ts as a class). Replace all `opts.X` reads with `ctx.X`. Replace `assembler` with `ctx.assembler`. Replace `return { converged, ... }` with `ctx.nrResult.converged = ...; return;`.
  - `src/solver/analog/analog-engine.ts` — Update all `newtonRaphson()` call sites in `step()` and `dcOperatingPoint()` to pass `this._ctx`.
  - `src/solver/analog/dc-operating-point.ts` — Update all `newtonRaphson()` call sites to pass `ctx`. `solveDcOperatingPoint` takes `ctx: CKTCircuitContext` instead of `DcOpOptions`.

- **Tests**:
  - `src/solver/analog/__tests__/newton-raphson.test.ts::writes_into_ctx_nrResult` — Call `newtonRaphson(ctx)` on a simple resistive circuit. Assert `ctx.nrResult.converged === true`, `ctx.nrResult.iterations > 0`, and `ctx.nrResult.voltages` points to a valid buffer.
  - `src/solver/analog/__tests__/newton-raphson.test.ts::zero_allocations_in_nr_loop` — Use the monkey-patch pattern from `ckt-context.test.ts::zero_allocations_on_reuse` to wrap `Float64Array` and `MNAAssembler` constructors with counting proxies. Run 100 NR iterations on a nonlinear circuit. Assert both counters remain `0` after the first iteration completes.

- **Acceptance criteria**:
  - `NROptions` interface deleted from codebase.
  - `newtonRaphson` returns `void`, writes into `ctx.nrResult`.
  - Zero allocations inside the NR loop (no `new` keyword in the hot path).

### Task 1.1.3: Convert solveDcOperatingPoint to take CKTCircuitContext

- **Description**: Replace `DcOpOptions` interface. `solveDcOperatingPoint(ctx: CKTCircuitContext): void` writes into `ctx.dcopResult`. All internal functions (`cktop`, `dynamicGmin`, `spice3Gmin`, `gillespieSrc`, `spice3Src`, `dcopFinalize`) take `ctx` instead of separate params. DC-OP scratch buffers (`new Float64Array(matrixSize)` at dc-operating-point.ts:663,669,670,801,879,951,958,959) are read from pre-allocated fields on `ctx`.

- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — Rewrite all functions to take `ctx: CKTCircuitContext`. Remove `DcOpOptions`, `CKTopCallOptions`, `NrBase` interfaces. Remove all `new Float64Array(matrixSize)` allocations — use `ctx.dcopVoltages`, `ctx.dcopSavedVoltages`, `ctx.dcopSavedState0`.
  - `src/solver/analog/analog-engine.ts` — Update `dcOperatingPoint()` and `_transientDcop()` to pass `this._ctx`.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::writes_into_ctx_dcopResult` — Run DC-OP on a resistive divider. Assert `ctx.dcopResult.converged === true` and `ctx.dcopResult.nodeVoltages` contains correct values.
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::zero_alloc_gmin_stepping` — Run DC-OP on a circuit requiring gmin stepping. Assert no `new Float64Array` calls during the entire gmin stepping sequence.

- **Acceptance criteria**:
  - `DcOpOptions` interface deleted from codebase.
  - All DC-OP scratch buffers read from `ctx`, never allocated per-call.
  - `solveDcOperatingPoint` returns `void`, writes into `ctx.dcopResult`.

## Wave 1.2: Remaining Hot-Path Allocation Elimination

### Task 1.2.1: Convert integration functions to zero-alloc

- **Description**: `solveGearVandermonde` (integration.ts:351-355) allocates `mat[][]` per call. Replace with `ctx.gearMatScratch: Float64Array(49)` — a flat 7x7 scratch buffer accessed as `mat[row * 7 + col]`.

  `computeIntegrationCoefficients` (integration.ts:469-500) returns `{ ag0, ag1 }` objects. Eliminate this function — it duplicates `computeNIcomCof` with bugs (the plan identifies `ag1: -ag0` as wrong for trap order 2). All callers should use `computeNIcomCof` which writes into `ctx.ag[]` directly.

- **Files to modify**:
  - `src/solver/analog/integration.ts` — `solveGearVandermonde` takes a `scratch: Float64Array` param instead of allocating. Delete `computeIntegrationCoefficients` function. Update `computeNIcomCof` to take scratch buffer param.
  - All callers of `computeIntegrationCoefficients` — switch to reading `ctx.ag[0]` / `ctx.ag[1]`.

- **Tests**:
  - `src/solver/analog/__tests__/integration.test.ts::gear_vandermonde_uses_scratch_buffer` — Call `solveGearVandermonde` with a pre-allocated scratch buffer. Assert correct ag[] coefficients for GEAR orders 2-6. Assert the scratch buffer was mutated (not a new allocation).
  - `src/solver/analog/__tests__/integration.test.ts::computeIntegrationCoefficients_deleted` — Assert the function no longer exists as an export.

- **Acceptance criteria**:
  - `solveGearVandermonde` allocates zero arrays — uses flat scratch buffer.
  - `computeIntegrationCoefficients` deleted from codebase.
  - All integration coefficient access goes through `computeNIcomCof` → `ctx.ag[]`.

### Task 1.2.2: Eliminate per-step closures and filter calls

- **Description**: Remove per-step allocations in `analog-engine.ts`:
  - `preIterationHook` closure (created per NR call in `step()`): bind once at compile time as engine method stored on `ctx.preIterationHook`.
  - The `elements.filter(isPoolBacked)` call inside `refreshElementRefs`: use `ctx.poolBackedElements` pre-computed list.
  - `(t) => this._timestep.addBreakpoint(t)` per element per step: bind once at init as `ctx.addBreakpointBound`.
  - `convergenceFailedElements = []` per iteration in `newton-raphson.ts`: pre-allocate fixed-size array on `ctx`, reset length to 0 each iteration.

- **Files to modify**:
  - `src/solver/analog/analog-engine.ts` — Replace closure creation with bound method references from `ctx`. Replace `elements.filter(isPoolBacked)` with `ctx.poolBackedElements`.
  - `src/solver/analog/newton-raphson.ts` — Use pre-allocated array for `convergenceFailedElements` from `ctx`.

- **Tests**:
  - `src/solver/analog/__tests__/analog-engine.test.ts::no_closures_in_step` — Run 10 transient steps. Assert no arrow functions or closures created inside `step()` (verify by checking that function references are stable across steps via identity comparison).

- **Acceptance criteria**:
  - Zero closures created per step or per NR iteration.
  - Zero `filter`/`map` calls on element arrays in hot paths.
  - All pre-computed lists populated once in `CKTCircuitContext` constructor.

### Task 1.2.3: Eliminate LTE-path allocations

- **Description**: Audit the LTE (Local Truncation Error) code path executed per accepted transient step. Eliminate all allocations in this path, satisfying master plan governing principle #2 ("Zero allocations in hot paths ... per-step code").

  Hot-path call sites to audit:
  - `src/solver/analog/analog-engine.ts` — per-accepted-step LTE loop over `ctx.elementsWithLte` calling each element's `getLteTimestep(...)`.
  - `src/solver/analog/ckt-terr.ts` — `cktTerr`, `cktTerrVoltage`, and internal helpers. Any intermediate arrays, `Math.max` spread arrays, or array literals used in computation must be replaced with pre-allocated `Float64Array` scratch fields on `CKTCircuitContext` (e.g., `ctx.lteScratch: Float64Array` sized appropriately) or with scalar temporaries.

  Any element-level LTE timestep computation (inside `getLteTimestep`) that needs scratch storage reads it from `LoadContext`/`CKTCircuitContext` rather than allocating.

- **Files to modify**:
  - `src/solver/analog/ckt-context.ts` — Add `lteScratch: Float64Array` (length sized to handle the largest intermediate vector needed by `cktTerr`/`cktTerrVoltage`; per Appendix A, sized generously to accommodate Phase 3's formula corrections).
  - `src/solver/analog/ckt-terr.ts` — Thread `ctx` (or scratch buffer) into `cktTerr` and `cktTerrVoltage` signatures. Replace any per-call array allocation with scratch buffer use.
  - `src/solver/analog/analog-engine.ts` — Update LTE-loop call sites to pass `ctx`.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-terr.test.ts::zero_allocations_in_lte_path` — Use the monkey-patch pattern from Task 1.1.1 to count `Float64Array` and `Array` constructor calls. Run 100 LTE evaluations across a circuit with capacitors, inductors, and diodes. Assert both counters remain `0` after the first call completes.

- **Acceptance criteria**:
  - Zero allocations inside `cktTerr`, `cktTerrVoltage`, or the engine's per-step LTE loop.
  - Governing principle #2 fully satisfied after Phase 1: NR loop, integration, LTE, and DC-OP hot paths are all allocation-free.
