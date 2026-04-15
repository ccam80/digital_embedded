# Wave 4 — DCOP Flow (HIGH)

Implementation spec for items 2.1-2.6 from ALIGNMENT-DIFFS.md.

## Changes

### 2.1 CKTop wrapper

Add `cktop()` function in `dc-operating-point.ts`:
```typescript
function cktop(
  opts: CKTopOptions,
  firstMode: InitMode,    // e.g. "initJct"
  continueMode: InitMode, // e.g. "initFloat"
  maxIter: number,
): CKTopResult {
  if (opts.params.noOpIter) {
    return { converged: true, iterations: 0, voltages: opts.voltages };
  }
  pool.initMode = firstMode;
  const result = newtonRaphson({ ...opts.nrBase, maxIterations: maxIter });
  return result;
}
```

Wrap `solveDcOperatingPoint()` direct NR call in `cktop()`. Add `noOpIter` parameter to SimulationParams.

### 2.2 DCOP finalization

After CKTop converges:
```typescript
function dcopFinalize(opts, voltages): void {
  pool.initMode = "initSmsig";
  newtonRaphson({ ...nrBase, maxIterations: 1, exactMaxIterations: true, initialGuess: voltages });
  pool.initMode = "transient";
}
```

### 2.3 Add initSmsig

Add `"initSmsig"` to `StatePoolRef.initMode` type union in `analog-types.ts`.

### 2.4 Fix premature mode reset

Remove `pool.initMode = "transient"` reset at current line ~280 in dc-operating-point.ts. Mode stays through finalization.

### 2.5 CKTncDump

On failure, emit per-node non-convergence diagnostic:
```typescript
function cktncDump(elements, voltages, prevVoltages, reltol, voltTol, abstol, nodeCount, matrixSize): Diagnostic {
  const nonConverged = [];
  for (let i = 0; i < matrixSize; i++) {
    const delta = Math.abs(voltages[i] - prevVoltages[i]);
    const tol = reltol * Math.max(Math.abs(voltages[i]), Math.abs(prevVoltages[i]))
              + (i < nodeCount ? voltTol : abstol);
    if (delta > tol) nonConverged.push({ node: i, delta, tol });
  }
  return nonConverged;
}
```

### 2.6 Separate transient DCOP entry

Add `_transientDcop()` in `analog-engine.ts` that calls `cktop()` with `MODETRANOP|MODEINITJCT`.

## File Changes

- `dc-operating-point.ts` — add `cktop()`, `dcopFinalize()`, `cktncDump()`, wrap direct NR
- `analog-types.ts` — add `"initSmsig"` to initMode union
- `state-pool.ts` — add `"initSmsig"` to initMode
- `analog-engine.ts` — add `_transientDcop()`, call finalization
- `analog-engine-interface.ts` — add `noOpIter?: boolean` to SimulationParams

## Dependencies

- Depends on: Wave 1 (unified INITF dispatcher must handle initSmsig)
