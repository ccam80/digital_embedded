# Wave 1 — NR Loop Restructure (CRITICAL)

Implementation spec for items 1.1-1.6 from ALIGNMENT-DIFFS.md.

## Current Code Structure

File: `src/solver/analog/newton-raphson.ts`, function `newtonRaphson()`, lines 389-743.

Current control flow per iteration:
```
1. prevVoltages.set(voltages)                          [line 470]
2. if iter==0: skip (matrix pre-assembled)             [lines 472-484]
   else: restoreLinearBase + stampNonlinear + stampReactiveCompanion + finalize
3. addDiagonalGmin                                     [lines 488-490]
4. factor()                                            [lines 493-501]
5. Save state0 for damping                             [lines 505-509]
6. solve(voltages)                                     [line 512]
7. Linear short-circuit return                         [lines 519-536]
8. Reset limitingCollector                             [lines 543-545]
9. updateOperatingPoints (sets noncon)                 [line 546]
10. Force noncon=1 at iteration 0                      [lines 549-552]
11. Transient mode automaton (initTran/initPred)       [lines 555-565]
12. Node damping                                       [lines 571-589]
13. Global convergence check                           [lines 599-616]
14. Element convergence check                          [lines 619-633]
15. Blame tracking                                     [lines 637-654]
16. postIterationHook                                  [line 658]
17. dcopModeLadder transitions                         [lines 662-706]
18. Convergence gate (initFloat only) + ipass          [lines 711-728]
19. onIter0Complete                                    [lines 737-739]
```

## Target Code Structure (ngspice NIiter)

The new loop body must follow ngspice niiter.c ordering exactly:

```
ENTRY:
  iterno = 0
  ipass = 0
  maxIter = max(rawMaxIter, 100)  // unless exactMaxIterations

  // UIC bypass check (item 7.1 — Wave 7, but entry point is here)
  if (isTranOp && uic) { singleLoad(); return OK }

  for (;;) {
    // ---- STEP A: Clear noncon + reset limit collector ----
    noncon = 0
    limitingCollector.length = 0

    // ---- STEP B: CKTload — unified device evaluation ----
    // Zero matrix + RHS
    solver.beginAssembly(matrixSize)   // or equivalent clear
    // Stamp ALL contributions (linear + nonlinear + reactive)
    assembler.stampAll(elements)       // NEW unified method
    // Increment iterno (ngspice does this inside CKTload)
    iterno++

    // ---- STEP C: Apply nodesets/ICs (Wave 7, DC mode only) ----
    if (isDcMode) applyNodesetsAndICs()

    // ---- STEP D: Preorder matrix (one-time) ----
    if (!didPreorder) { solver.preorder(); didPreorder = true }

    // ---- STEP E: Factorize ----
    if (shouldReorder) {
      result = solver.factorWithReorder(diagGmin)
      if (!result.success) return ERROR  // truly singular
      shouldReorder = false
    } else {
      result = solver.factorNumerical(diagGmin)
      if (!result.success) {
        // E_SINGULAR from numerical: retry with reorder
        shouldReorder = true
        continue  // back to STEP A
      }
    }

    // ---- STEP F: Solve ----
    solver.solve(rhs)  // solution now in rhs

    // ---- STEP G: Check iteration limit (BEFORE convergence) ----
    if (iterno > maxIter) return E_ITERLIM

    // ---- STEP H: Convergence check ----
    if (noncon == 0 && iterno != 1) {
      // NIconvTest: compare rhs vs rhsOld
      globalConverged = checkNodeConvergence(rhs, rhsOld)
      elemConverged = checkElementConvergence(...)
    } else {
      noncon = 1  // force at least 2 iterations
      globalConverged = false
      elemConverged = false
    }

    // ---- STEP I: Newton damping ----
    if (nodeDamping && noncon != 0 && (isTranOp || isDcOp) && iterno > 1) {
      applyDamping(rhs, rhsOld, state0, oldState0)
    }

    // ---- STEP J: INITF dispatcher (unified, all 6 modes) ----
    if (initMode == INITFLOAT) {
      if (noncon == 0) {
        if (ipass != 0) { ipass--; noncon = 1 }
        else { return OK }  // CONVERGED
      }
      // else: not converged, continue
    } else if (initMode == INITJCT) {
      initMode = INITFIX
      shouldReorder = true
    } else if (initMode == INITFIX) {
      if (noncon == 0) {
        initMode = INITFLOAT
        ipass = 1  // hadNodeset extra pass
      }
    } else if (initMode == INITTRAN) {
      initMode = INITFLOAT
      if (iterno <= 1) shouldReorder = true
    } else if (initMode == INITPRED) {
      initMode = INITFLOAT
    } else if (initMode == INITSMSIG) {
      initMode = INITFLOAT
    }

    // ---- STEP K: Swap RHS vectors (O(1) pointer swap) ----
    [rhs, rhsOld] = [rhsOld, rhs]

    // ---- Instrumentation (blame, hooks — side-effect only) ----
    postIterationHook?.(...)
  }
```

## File-by-File Change List

### `src/solver/analog/newton-raphson.ts`

Functions changed:
- `newtonRaphson()` (lines 389-743): Complete rewrite of loop body to match pseudocode above.

New internal state:
- `iterno: number` — 1-based iteration counter (ngspice convention)
- `ipass: number` — already exists at line 407, keep but move into unified dispatcher
- `shouldReorder: boolean` — local flag, set by INITF transitions and singular-retry
- `didPreorder: boolean` — one-time preorder flag
- `rhs: Float64Array` and `rhsOld: Float64Array` — two buffers, pointer-swapped at step K

Removed:
- `prevVoltages.set(voltages)` copy at line 470 (replaced by pointer swap at loop bottom)
- Linear stamp hoisting (lines 427-438, 454-458, 472-484): replaced by unified CKTload
- `solver.saveLinearBase()`, `solver.restoreLinearBase()`, `solver.captureLinearRhs()`, `solver.setCooCount()` — no longer needed
- `ladderModeIter` counter (line 466) — replaced by unified INITF dispatcher
- Separate transient mode automaton block (lines 555-565) — folded into INITF
- Separate convergence gate block (lines 711-728) — folded into INITF step J

Added:
- `noncon = 0` + limit reset at loop top (step A)
- Iteration limit check immediately after solve (step G)
- Unified INITF dispatcher (step J) handling all 6 modes
- RHS pointer swap at loop bottom (step K)

### `src/solver/analog/mna-assembler.ts`

Added:
- `stampAll(elements, voltages_old, iteration)` method: unified CKTload equivalent. Per-element:
  ```
  for each el in elements:
    el.stamp(solver)                     // linear stamp
    if el.isNonlinear:
      el.updateOperatingPoint(voltages_old, limitingCollector)
      if limited: noncon++
      el.stampNonlinear(solver)
    if el.isReactive && el.stampReactiveCompanion:
      el.stampReactiveCompanion(solver)
  solver.finalize()
  ```

### `src/solver/analog/sparse-solver.ts`

Changed:
- `beginAssembly()` called every iteration (currently called once before loop)
- `finalize()` called every iteration with `cooStart=0` (full scatter)
- Linear-base API (`saveLinearBase`, `restoreLinearBase`, `captureLinearRhs`) — no longer called by NR loop

### `src/core/analog-types.ts`

Changed:
- `StatePoolRef.initMode` type union: add `"initSmsig"`

## ngspice Source Mapping

| ngspice function/line | Our function/line |
|---|---|
| NIiter entry (niiter.c:609) | `newtonRaphson()` entry |
| `CKTnoncon = 0` (niiter.c:461) | Step A: `noncon = 0` |
| CKTload (cktload.c) | Step B: `assembler.stampAll()` |
| apply_nodesets_and_ics (cktload.c:104-158) | Step C: `applyNodesetsAndICs()` (Wave 7) |
| SMPpreOrder (niiter.c:844-858) | Step D: `solver.preorder()` (Wave 2) |
| spOrderAndFactor / spFactor | Step E: `solver.factorWithReorder()` / `solver.factorNumerical()` (Wave 2) |
| SMPsolve (spsolve.c) | Step F: `solver.solve()` |
| iterno > maxIter (niiter.c:944) | Step G: iteration limit check |
| NIconvTest (niconv.c) | Step H: convergence check |
| node damping (niiter.c:1020-1045) | Step I: damping |
| INITF dispatcher (niiter.c:1050-1085) | Step J: unified INITF |
| swap CKTrhs/CKTrhsOld (niiter.c:1087-1090) | Step K: pointer swap |

## Dependency Notes

- **Must be done first.** All other waves depend on the new NR loop structure.
- Wave 2 (factorization) can proceed in parallel if NR loop uses `solver.factor()` as placeholder.
- Linear stamp hoisting removal means every iteration calls `stamp()` for ALL elements. Performance regression but matches ngspice exactly.

## Test Impact

- `newton-raphson.test.ts` — iteration counts and convergence behavior change
- `mna-assembler.test.ts` — new `stampAll` method
- `analog-engine.test.ts` — transient step uses NR
- `dc-operating-point.test.ts` — DCOP uses NR
- `dcop-init-jct.test.ts` — mode ladder behavior changes
- `mna-end-to-end.test.ts` — end-to-end convergence
- `sparse-solver.test.ts` — if linear-base API is removed
- `convergence-regression.test.ts` — regression baselines
- All harness comparison tests
