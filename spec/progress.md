
## Task 0.1.3: Remove acceptTimestep() and state0.set(state1) retry-entry copy
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/state-pool.ts`, `src/solver/analog/analog-engine.ts`, `src/components/semiconductors/bjt.ts`
- **Tests**: 0/0 (no new tests written — Phase 0 dead code removal; breakage in test files is expected per spec)
- **Notes**: 
  - Removed `acceptTimestep()` method entirely from `StatePool` class in state-pool.ts
  - Removed `statePool?.state0.set(statePool.state1)` retry-entry copy at the top of the for(;;) loop in analog-engine.ts (line 349)
  - Replaced `statePool.acceptTimestep()` call in analog-engine.ts acceptance block with inline pointer rotation (without the seed copy that `acceptTimestep()` previously included)
  - Cleaned a comment in bjt.ts that referenced `acceptTimestep()` as a historical-provenance comment (rules.md bans such comments)
  - All remaining `acceptTimestep` references are in `__tests__` files only — expected breakage per Phase 0 spec
  - No stale imports of `acceptTimestep` exist (it was a method, not an export)

## Task 0.1.1: Remove linear stamp hoisting path and 7-state dispatch in NR loop
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/newton-raphson.ts`
- **Tests**: 3/14 passing in newton-raphson.test.ts (11 new regressions expected per spec — Phase 0 dead code removal intentionally breaks NR loop; Phase 1 adds stampAll replacement)
- **Removed from newton-raphson.ts**:
  - Linear stamp hoisting block before the NR loop: `updateOperatingPoints`, `beginAssembly`, `stampLinear`, `captureLinearRhs`, `stampNonlinear`, `stampReactiveCompanion`, `finalize`, `saveLinearBase` calls, and the `linearCooCount` variable
  - Per-iteration `if (iteration === 0) / else { restoreLinearBase + setCooCount + stampNonlinear + stampReactiveCompanion + finalize }` multi-branch dispatch block
  - dcopModeLadder pre-iteration `updateOperatingPoints` + re-stamp block (was inside the `if (ladder)` init section)
  - All references to: `linearCooCount`, `saveLinearBase`, `restoreLinearBase`, `captureLinearRhs`, `setCooCount`
- **Kept**: NR loop structure (for loop, factor, solve, convergence checks, damping, ladder transitions, blame tracking); `ladderModeIter` counter (used in ladder transition block); `preIterationHook` call retained at loop top
- **mna-assembler.ts**: No 7-state dispatch present in this file; class structure left intact for Phase 1 `stampAll()` addition
- **Phase 0 verification**: `npx tsc --noEmit` shows zero errors in newton-raphson.ts or mna-assembler.ts; no stale symbols remain in newton-raphson.ts

## Task 0.1.2: Remove single-path factor() pivot search
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/sparse-solver.ts`, `src/solver/analog/__tests__/sparse-solver.test.ts`
- **Tests**: 2/2 new Phase 0 stub tests passing (10 pre-existing tests now fail as expected per Phase 0 spec — all were passing before and break because `factor()` is now a stub)

## Task 1.1.1: Remove linear stamp hoisting, add unified stampAll()
- **Status**: complete
- **Agent**: implementer
- **Files created**: (none)
- **Files modified**: src/solver/analog/mna-assembler.ts, src/solver/analog/newton-raphson.ts, src/solver/analog/__tests__/mna-assembler.test.ts
- **Tests**: 11/14 passing (3 failures are pre-existing from Phase 0 factor() stub in sparse-solver.ts — resistor_divider_dc, two_voltage_sources_series, current_source_with_resistor all fail on solver.factor().success === false)
- **Changes made**:
  - Added `stampAll()` method to MNAAssembler: clears matrix via beginAssembly, calls updateOperatingPoints (iteration>0), stamps all elements (linear + nonlinear + reactive companion) unconditionally, calls finalize
  - Rewrote NR loop top to follow ngspice NIiter: Step A (noncon=0, reset limitingCollector), Step B (preIterationHook + assembler.stampAll), then gmin, factor, state0 save, prevVoltages save, solve
  - Removed standalone updateOperatingPoints and limitingCollector reset from post-solve section (now handled by stampAll at loop top)
  - Added 4 stampAll tests: stamps all element types, skips updateOperatingPoints on iteration 0, sets noncon from limiting, verifies beginAssembly/finalize calls

## Task 1.1.2: Reorder the NR loop body
- **Status**: complete
- **Agent**: implementer
- **Files created**: (none)
- **Files modified**: src/solver/analog/newton-raphson.ts
- **Tests**: 3/14 passing (11 failures are pre-existing from Phase 0 factor() stub — all NR tests that call newtonRaphson() fail on solver.factor().success === false)
- **Changes made**:
  - Changed for loop from bounded `iteration < maxIterations` to unbounded `for(;;)` matching ngspice NIiter
  - Added Step G: explicit iteration limit check (`iteration + 1 > maxIterations`) after solve, before convergence — returns E_ITERLIM
  - Reordered loop body to match ngspice NIiter: Step A (noncon=0) -> Step B (stampAll) -> Step E (factor) -> Step F (solve) -> Step G (iterlim) -> Step H (convergence) -> Step I (damping) -> Step J (INITF/ladder) -> convergence return
  - Damping (Step I) now fires AFTER convergence check (Step H), matching ngspice ordering
  - Transient mode automaton (initTran/initPred) moved into Step J section alongside ladder
  - Step labels (A, B, E, F, G, H, I, J) added as comments matching spec pseudocode

## Task 1.2.2: Add RHS pointer swap at loop bottom; add initSmsig to initMode type union
- **Status**: complete
- **Agent**: implementer
- **Files created**: (none)
- **Files modified**: src/solver/analog/newton-raphson.ts, src/core/analog-types.ts, src/solver/analog/state-pool.ts, src/solver/analog/dc-operating-point.ts
- **Tests**: 3/14 passing (11 failures are pre-existing from Phase 0 factor() stub)
- **Changes made**:
  - Added Step K: O(1) RHS pointer swap at loop bottom replacing O(n) prevVoltages.set(voltages) copy
  - Changed voltages/prevVoltages from const to let to enable pointer swap
  - Updated stampAll call to pass prevVoltages (holds current best solution after swap)
  - Updated initialGuess to copy into prevVoltages (used by stampAll on iteration 0)
  - Post-loop E_ITERLIM return uses prevVoltages (holds last solution after final swap)
  - Added "initSmsig" to initMode type union in: analog-types.ts (StatePoolRef), newton-raphson.ts (dcopModeLadder.pool), state-pool.ts (StatePool.initMode), dc-operating-point.ts (DcopParams.statePool + ladder pool)

## Task 1.2.1: Merge two INITF dispatchers into one unified dispatcher
- **Status**: complete
- **Agent**: implementer
- **Files created**: (none)
- **Files modified**: src/solver/analog/newton-raphson.ts
- **Tests**: 3/14 passing (11 failures are pre-existing from Phase 0 factor() stub)
- **Changes made**:
  - Merged dcopModeLadder dispatcher and transient mode automaton into one unified Step J INITF dispatcher
  - Unified dispatcher handles all 6 modes: initFloat, initJct, initFix, initTran, initPred, initSmsig
  - Folded convergence return logic into the initFloat/transient branch of the INITF dispatcher with ipass guard
  - Reads initMode from ladder.pool (DC-OP) or statePool (transient), defaults to "transient" when neither exists
  - Removed ladderModeIter counter (no longer needed with unified dispatcher)
  - Ladder phase callbacks (onModeEnd/onModeBegin) fire on mode transitions within the unified dispatcher

## Task: Fix rule violation in mna-assembler.ts
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/solver/analog/mna-assembler.ts
- **Change**: Removed "Legacy" and "remain available for direct test use" from JSDoc (lines 11-12). Replaced with clean description: "Individual stamping methods stamp element subsets independently for fine-grained test control."
- **Rules fixed**:
  - Removed backwards compatibility shibboleth (no "Legacy" label)
  - Removed historical-provenance comment (no "remain available for...")

## Task: Delete dead MNAAssembler per-phase stamp methods
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/mna-assembler.ts`, `src/solver/analog/__tests__/mna-assembler.test.ts`
- **Tests**: 11/14 passing (3 pre-existing failures)
- **Notes**:
  - Deleted `stampLinear()`, `stampNonlinear()`, `stampReactiveCompanion()` methods from MNAAssembler
  - Removed JSDoc lines referencing those methods from the file header
  - Updated all test call sites to use `stampAll(elements, matrixSize, voltages, null, 0)` instead
  - Renamed test cases `linear_only_stamps_once` → `stampAll_stamps_linear_element_each_call` and `nonlinear_skips_linear_elements` → `stampAll_skips_stampNonlinear_for_linear_elements`
  - 3 pre-existing failures (`resistor_divider_dc`, `two_voltage_sources_series`, `current_source_with_resistor`) all fail at `expect(factorResult.success).toBe(true)` because `SparseSolver.factor()` is a stub returning `{ success: false }` — identical failure was present in HEAD before this change
