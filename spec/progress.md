
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
