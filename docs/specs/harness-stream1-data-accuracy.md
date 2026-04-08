# Harness Stream 1: Data Completeness and Accuracy

**Status:** Ready for implementation  
**Depends on:** None (foundational stream)  
**Depended on by:** Stream 2 (MCP), Stream 3 (Interface)

This spec covers all data completeness and accuracy fixes for the ngspice comparison harness.
The harness captures per-NR-iteration internal solver state from both our SPICE engine and
ngspice for side-by-side numerical debugging. Every item in this document is mandatory.

---

## Hard Constraints

### Performance Neutrality

All engine changes must be performance-neutral when no capture session is active:

- Hook-gated capture: nullable function pointers, `if (hook) hook(...)`
- Single `captureFlags` bitmask for multiple hook sites, checked once at NR loop entry
- Zero allocations, zero copies, zero function calls when hooks are null/flags are 0
- No structural changes to hot-path data structures

### Symmetry

For every data point captured on our side, the ngspice side must capture the equivalent.
For every data point captured from ngspice, our side must capture the equivalent.
Asymmetry is a spec failure — every field on `IterationSnapshot`, `StepSnapshot`, and
`ElementStateSnapshot` must be populated on both sessions.

---

## Current State (Baseline)

The harness lives at `src/solver/analog/__tests__/harness/`. The current files are:

| File | Current state |
|------|---------------|
| `types.ts` | `preSolveRhs` optional on `IterationSnapshot`. No `state1Slots`/`state2Slots` on `ElementStateSnapshot`. No `limitingEvents`, `convergenceFailedElements`. No `integrationCoefficients`/`analysisPhase` on `StepSnapshot`. No `matrixRowLabels`/`matrixColLabels` on `TopologySnapshot`. `RawNgspiceIterationEx` missing state1/state2, matrix CSC, ag0/ag1, per-device convergence, limiting events. |
| `capture.ts` | `captureElementStates` reads `state0` only. Strategy 3 in `captureTopology` uses `el.label` (UUID fallback). No matrix label maps built. |
| `ngspice-bridge.ts` | Callback registers 12 parameters (no state1/state2, no matrix, no ag coefficients, no per-device convergence, no limiting). Topology callback leaves `nodeIndices: []` for all devices. `matrix: []` always empty. |
| `device-mappings.ts` | `BJT_MAPPING` maps charges (`Q_BE`/`Q_BC`/`Q_CS`) but not companion currents (`CCAP_BE`/`CCAP_BC`/`CCAP_CS`). |
| `compare.ts` | `compareSnapshots` pairs steps by array index — no time-alignment. |
| `comparison-session.ts` | Uses `resolve(__dirname, "../../../../..")` (broken at runtime under Vitest ESM). DC OP re-run undocumented. |
| `sparse-solver.ts` | No pre-solve RHS capture. `getRhsSnapshot()` returns post-solve solution vector. |
| `mna-assembler.ts` | `checkAllConverged` short-circuits on first failure — no detailed per-element reporting. |
| `newton-raphson.ts` | `postIterationHook` signature has 6 parameters. No `limitingCollector` pass-through. |
| `integration.ts` | `integrateCapacitor`/`integrateInductor` compute ag0 internally. Not exposed as standalone. |
| `coordinator.ts` | Analysis phase (dcop/tranInit/tranFloat) not exposed. |

---

## Item 1: Time-Based Step Alignment

### Problem

`compareSnapshots()` and all query methods pair steps by array index. Our step 0 may be at
`t=1ns` while ngspice step 0 is at `t=0`. This produces spurious diffs for every field.

### Specification

**`comparison-session.ts`** — Build a time-alignment index after both runs complete.

Add private field to `ComparisonSession`:

```typescript
private _alignedNgIndex: Map<number, number> = new Map();
```

After `_reindexNgSession()` completes in both `runDcOp()` and `runTransient()`, call:

```typescript
private _buildTimeAlignment(): void {
  this._alignedNgIndex.clear();
  const ngSteps = this._ngSessionAligned()?.steps ?? [];
  if (ngSteps.length === 0) return;

  const ourSteps = this._ourSession?.steps ?? [];
  for (let i = 0; i < ourSteps.length; i++) {
    const tOurs = ourSteps[i].simTime;
    const dtOurs = ourSteps[i].dt;

    // Binary search ngspice steps by simTime for nearest match
    let lo = 0;
    let hi = ngSteps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ngSteps[mid].simTime < tOurs) lo = mid + 1;
      else hi = mid;
    }

    // Check lo and lo-1 for the nearest
    const candidates = [lo - 1, lo, lo + 1].filter(j => j >= 0 && j < ngSteps.length);
    let bestJ = candidates[0];
    let bestDelta = Infinity;
    for (const j of candidates) {
      const delta = Math.abs(ngSteps[j].simTime - tOurs);
      if (delta < bestDelta) { bestDelta = delta; bestJ = j; }
    }

    // Accept match only within tolerance: |t_ours - t_ng| < 0.5 * min(dt_ours, dt_ng)
    const dtNg = ngSteps[bestJ].dt;
    const halfMinDt = 0.5 * Math.min(dtOurs > 0 ? dtOurs : Infinity, dtNg > 0 ? dtNg : Infinity);
    if (bestDelta <= halfMinDt || halfMinDt <= 0) {
      this._alignedNgIndex.set(i, bestJ);
    }
  }
}
```

Add `alignment: Map<number, number>` parameter to `compareSnapshots()` in `compare.ts`.
When provided, use `alignment.get(si) ?? si` instead of `si` to look up the ngspice step.

All internal query methods in `ComparisonSession` that currently access
`this._ngSessionAligned()?.steps[stepIndex]` must use
`this._alignedNgIndex.get(stepIndex) ?? stepIndex` as the ngspice step index.

**Performance:** Time-alignment runs offline after simulation completes. O(N log M) where N
= our step count, M = ngspice step count. No hot-path impact.

---

## Item 2: State History Capture (s1, s2)

### Problem

`captureElementStates` only reads `statePool.state0`. `statePool.state1` and
`statePool.state2` contain the previous two timepoints' state values and are used by BDF-2
and trapezoidal integration. They exist on `StatePool` but are not captured. The ngspice
callback sends only `CKTstate0`.

### Specification

**`types.ts`** — Extend `ElementStateSnapshot`:

```typescript
export interface ElementStateSnapshot {
  elementIndex: number;
  label: string;
  /** State at current timepoint (state0). */
  slots: Record<string, number>;
  /** State at previous timepoint (state1). Empty Record for non-pool elements. */
  state1Slots: Record<string, number>;
  /** State two timepoints ago (state2). Empty Record for non-pool elements. */
  state2Slots: Record<string, number>;
}
```

**`capture.ts`** — Extend `captureElementStates` to read all three state vectors:

```typescript
export function captureElementStates(
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
): ElementStateSnapshot[] {
  if (!statePool) return [];
  const snapshots: ElementStateSnapshot[] = [];
  const s0 = statePool.state0;
  const s1 = statePool.state1;
  const s2 = statePool.state2;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!isPoolBacked(el)) continue;

    const schema = el.stateSchema;
    const base = el.stateBaseOffset;
    const slots: Record<string, number> = {};
    const state1Slots: Record<string, number> = {};
    const state2Slots: Record<string, number> = {};

    for (let s = 0; s < schema.slots.length; s++) {
      const name = schema.slots[s].name;
      slots[name] = s0[base + s];
      if (s1) state1Slots[name] = s1[base + s];
      if (s2) state2Slots[name] = s2[base + s];
    }

    snapshots.push({
      elementIndex: i,
      label: elementLabels?.get(i) ?? el.label ?? `element_${i}`,
      slots,
      state1Slots,
      state2Slots,
    });
  }

  return snapshots;
}
```

**`types.ts`** — Extend `RawNgspiceIterationEx`:

```typescript
export interface RawNgspiceIterationEx {
  // ... existing fields ...
  /** Full CKTstate1 flat array (previous timepoint). */
  state1: Float64Array;
  /** Full CKTstate2 flat array (prev-prev timepoint). */
  state2: Float64Array;
}
```

**`ngspice-bridge.ts`** — Extend C callback signature to include `state1Ptr` and `state2Ptr`
immediately after `state0Ptr`. Decode both in the callback body and store on the raw
iteration object. Extend `_unpackElementStates` to accept `state1` and `state2` and return
`ElementStateSnapshot` objects with `state1Slots` and `state2Slots` populated.

The extended C callback receives state1/state2 pointers as additional `_Inout_ double*`
parameters — see Item 15 (C Callback Extension Summary) for the full revised signature.

`_unpackElementStates` signature change:

```typescript
private _unpackElementStates(
  state0: Float64Array,
  state1: Float64Array,
  state2: Float64Array,
): ElementStateSnapshot[]
```

For each device, read offsets from all three arrays using `mapping.ngspiceToSlot`.

**Performance:** Hook-gated. Only called inside `postIterationHook`. Zero cost when hook is null.

---

## Item 3: ngspice G Matrix Capture

### Problem

Our side captures the assembled G matrix via `solver.getCSCNonZeros()`. The ngspice callback
currently sends `matrix: []` (always empty). Side-by-side matrix comparison is impossible.

### Specification

**C callback extension** — After `CKTload()` and before `SMPsolve()`, serialize the
`CKTmatrix` sparse entries. The C-side sends four flat buffers:

```
[nnz: int32]
[colPtrs: int32 * (matrixSize + 1)]
[rowIndices: int32 * nnz]
[values: double * nnz]
```

Extended C callback parameters (appended to existing signature):

```c
int matrixNnz,
_Inout_ int* matrixColPtr,   /* length: matrixSize + 1 */
_Inout_ int* matrixRowIdx,   /* length: matrixNnz */
_Inout_ double* matrixVals   /* length: matrixNnz */
```

**`ngspice-bridge.ts`** — Update `_registerIterationCallback` to declare these four
additional parameters in the koffi proto string. Decode them in the callback body:

```typescript
const matrixColPtrArr = matrixNnz > 0 && matrixColPtrRaw
  ? Array.from(koffi.decode(matrixColPtrRaw, "int", matrixSize + 1))
  : null;
const matrixRowIdxArr = matrixNnz > 0 && matrixRowIdxRaw
  ? Array.from(koffi.decode(matrixRowIdxRaw, "int", matrixNnz))
  : null;
const matrixValsArr = matrixNnz > 0 && matrixValsRaw
  ? Array.from(koffi.decode(matrixValsRaw, "double", matrixNnz))
  : null;

// Convert CSC to MatrixEntry[]
const matrix: MatrixEntry[] = [];
if (matrixColPtrArr && matrixRowIdxArr && matrixValsArr) {
  for (let col = 0; col < matrixSize; col++) {
    for (let p = matrixColPtrArr[col]; p < matrixColPtrArr[col + 1]; p++) {
      matrix.push({ row: matrixRowIdxArr[p], col, value: matrixValsArr[p] });
    }
  }
}
```

Store `matrix` on the `RawNgspiceIterationEx` and pass through to `IterationSnapshot.matrix`
in `getCaptureSession()`.

**`types.ts`** — Add `matrix` field to `RawNgspiceIterationEx`:

```typescript
/** Assembled G matrix non-zeros for this iteration. */
matrix: MatrixEntry[];
```

**Performance:** ngspice/FFI side only. Zero engine impact on our side.

---

## Item 4: ngspice Device Node Indices

### Problem

The topology callback currently leaves `nodeIndices: []` for every device — the C extension
packs `devNodeIndicesFlat` and `devNodeCounts` but the current JS callback ignores them.

### Specification

**C topology callback extension** — Add two parameters to the topology callback signature:

```c
_Inout_ int* devNodeIndicesFlat,  /* concatenated node indices, all devices */
_Inout_ int* devNodeCounts        /* per-device node count, length: devCount */
```

For each device instance, read device-type-specific node pointers:
- BJT: `BJTcolNode`, `BJTbaseNode`, `BJTemitNode`, `BJTsubstNode`
- Diode: `DIOposNode`, `DIOnegNode`
- MOSFET: `MOSdNode`, `MOSgNode`, `MOSsNode`, `MOSbNode`
- JFET: `JFETdrainNode`, `JFETgateNode`, `JFETsourceNode`
- Capacitor: `CAPposNode`, `CAPnegNode`
- Inductor: `INDposNode`, `INDnegNode`
- Resistor: `RESposNode`, `RESnegNode`

Pack all device node indices contiguously into `devNodeIndicesFlat`, with counts in
`devNodeCounts` (one entry per device in topology order).

**`ngspice-bridge.ts`** — Update `_registerTopologyCallback` koffi proto to include the two
new parameters. Decode them in the callback body:

```typescript
const nodeCounts = devNodeCountsRaw
  ? Array.from(koffi.decode(devNodeCountsRaw, "int", devCount))
  : null;

let flatOffset = 0;
const devNodeFlat = devNodeFlatRaw && nodeCounts
  ? Array.from(koffi.decode(devNodeFlatRaw, "int", nodeCounts.reduce((a, b) => a + b, 0)))
  : null;

for (let i = 0; i < devCount; i++) {
  const count = nodeCounts?.[i] ?? 0;
  const nodeIndices = devNodeFlat ? devNodeFlat.slice(flatOffset, flatOffset + count) : [];
  flatOffset += count;
  devices.push({
    name: devNames[i] ?? "",
    typeName: devTypes[i] ?? "",
    stateBase: devStateBases[i] ?? 0,
    nodeIndices,
  });
}
```

---

## Item 5: BJT Companion Current Mapping

### Problem

`BJT_MAPPING` in `device-mappings.ts` maps BJT charge slots (`Q_BE`=8, `Q_BC`=10, `Q_CS`=12)
but not the companion current slots. ngspice offsets 9 (`BJTcqbe`), 11 (`BJTcqbc`), and 13
(`BJTcqcs`) are unmapped. Our slots `CCAP_BE`, `CCAP_BC`, `CCAP_CS` exist in `BJT_L1_SCHEMA`
but are missing from `BJT_MAPPING`.

### Specification

**`device-mappings.ts`** — Add to `BJT_MAPPING.slotToNgspice`:

```typescript
CCAP_BE: 9,    // BJTcqbe — companion current for BE junction
CCAP_BC: 11,   // BJTcqbc — companion current for BC junction
CCAP_CS: 13,   // BJTcqcs — companion current for CS junction
```

Add to `BJT_MAPPING.ngspiceToSlot`:

```typescript
9: "CCAP_BE",
11: "CCAP_BC",
13: "CCAP_CS",
```

No other changes required. The mapping is consumed by `_unpackElementStates` in
`ngspice-bridge.ts` and by `compareSnapshots` in `compare.ts`.

---

## Item 6: Pre-Solve RHS Capture

### Problem

`getRhsSnapshot()` on `SparseSolver` fires after `solver.solve()` — it returns the solution
vector (identical to voltages), not the loaded RHS before factorization. We capture no
pre-solve RHS on our side. `IterationSnapshot.preSolveRhs` is currently optional and
undefined for our session.

### Specification

**`sparse-solver.ts`** — Add pre-solve RHS capture infrastructure:

```typescript
private _preSolveRhs: Float64Array | null = null;
private _capturePreSolveRhs = false;

/**
 * Enable or disable pre-solve RHS capture.
 * When enabled, finalize() snapshots the RHS after stamp assembly and
 * before factorization. Zero cost when disabled.
 */
enablePreSolveRhsCapture(enabled: boolean): void {
  this._capturePreSolveRhs = enabled;
  if (enabled && (this._preSolveRhs === null || this._preSolveRhs.length !== this._n)) {
    this._preSolveRhs = new Float64Array(this._n);
  }
}

/**
 * Returns the pre-solve RHS snapshot captured during the last finalize() call.
 * Returns a zero-length array if capture is not enabled.
 */
getPreSolveRhsSnapshot(): Float64Array {
  return this._preSolveRhs ?? new Float64Array(0);
}
```

Inside `finalize()`, after all stamp assembly and before the `factor()` call:

```typescript
if (this._capturePreSolveRhs && this._preSolveRhs) {
  // Grow buffer if needed (topology may have changed)
  if (this._preSolveRhs.length !== this._n) {
    this._preSolveRhs = new Float64Array(this._n);
  }
  this._preSolveRhs.set(this._rhs.subarray(0, this._n));
}
```

**`types.ts`** — Make `preSolveRhs` required on `IterationSnapshot`. Remove the `rhs` field
entirely — it was identical to `voltages` (post-solve solution vector) and served no purpose.
All code that currently reads `IterationSnapshot.rhs` (including `compare.ts` line 80) must
switch to `IterationSnapshot.preSolveRhs`. The `rhs` field is removed entirely — no shim,
no fallback, no optional alias.

```typescript
export interface IterationSnapshot {
  iteration: number;
  voltages: Float64Array;
  prevVoltages: Float64Array;
  /** RHS after stamp assembly, before factorization and solve. */
  preSolveRhs: Float64Array;
  matrix: MatrixEntry[];
  elementStates: ElementStateSnapshot[];
  noncon: number;
  globalConverged: boolean;
  elemConverged: boolean;
  limitingEvents: LimitingEvent[];
  convergenceFailedElements: string[];
}
```

**`capture.ts`** — Update `createIterationCaptureHook` to call
`solver.getPreSolveRhsSnapshot()` instead of `solver.getRhsSnapshot()` and store the result
as `preSolveRhs` (required). Enable pre-solve RHS capture on the solver before attaching the
hook:

```typescript
export function createIterationCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
  elementLabels?: Map<number, string>,
): { hook: PostIterationHook; getSnapshots: () => IterationSnapshot[]; clear: () => void } {
  solver.enablePreSolveRhsCapture(true);
  let snapshots: IterationSnapshot[] = [];

  const hook: PostIterationHook = (
    iteration, voltages, prevVoltages, noncon, globalConverged, elemConverged,
  ) => {
    snapshots.push({
      iteration,
      voltages: voltages.slice(),
      prevVoltages: prevVoltages.slice(),
      preSolveRhs: solver.getPreSolveRhsSnapshot().slice(),
      matrix: solver.getCSCNonZeros(),
      elementStates: captureElementStates(elements, statePool, elementLabels),
      noncon,
      globalConverged,
      elemConverged,
      limitingEvents: [],      // populated in Item 9
      convergenceFailedElements: [],  // populated in Item 8
    });
  };

  return { hook, getSnapshots: () => snapshots, clear: () => { snapshots = []; } };
}
```

**Performance:** Single boolean check in `finalize()`. Buffer allocated once when enabled and
reused. Zero cost when disabled.

---

## Item 7: Integration Coefficients (ag0, ag1)

### Problem

Neither engine captures the integration coefficients ag0 and ag1 per step. These determine
the companion model conductance and are critical for diagnosing integration method divergence.
ag0 depends only on dt/order/method — same for all elements at a given step.

### Specification

**`integration.ts`** — Expose ag0/ag1 computation as a standalone function:

```typescript
/**
 * Compute integration coefficients ag0 and ag1 from step parameters.
 * ag0 is the coefficient on Q_n (or phi_n for inductors).
 * ag1 is the coefficient on Q_{n-1}.
 *
 * Used by StepSnapshot capture to record the coefficients without
 * re-deriving them from element-level calculations.
 */
export function computeIntegrationCoefficients(
  dt: number,
  h1: number,
  h2: number,
  order: number,
  method: IntegrationMethod,
): { ag0: number; ag1: number } {
  if (dt <= 0) return { ag0: 0, ag1: 0 };

  if (order <= 1) {
    return { ag0: 1 / dt, ag1: -1 / dt };
  } else if (method === "trapezoidal") {
    return { ag0: 2 / dt, ag1: -2 / dt };
  } else {
    // BDF-2
    const safeH1 = h1 > 0 ? h1 : dt;
    const safeH2 = h2 > 0 ? h2 : safeH1;
    const r1 = safeH1 / dt;
    const r2 = (safeH1 + safeH2) / dt;
    const u22 = r2 * (r2 - r1);
    if (Math.abs(u22) < 1e-30) {
      return { ag0: 1 / dt, ag1: -1 / dt };
    }
    const rhs2 = r1 / dt;
    const ag2 = rhs2 / u22;
    const ag1val = (-1 / dt - r2 * ag2) / r1;
    const ag0val = -(ag1val + ag2);
    return { ag0: ag0val, ag1: ag1val };
  }
}
```

**`types.ts`** — Add `integrationCoefficients` to `StepSnapshot`. The type uses a
dual-engine structure: `ours` is populated from `computeIntegrationCoefficients()` and
`ngspice` is populated from the callback data (`ag0`, `ag1`, `integrateMethod`, `order`):

```typescript
export interface IntegrationCoefficients {
  ours: { ag0: number; ag1: number; method: "backwardEuler" | "trapezoidal" | "gear2"; order: number };
  ngspice: { ag0: number; ag1: number; method: string; order: number };
}

export interface StepSnapshot {
  simTime: number;
  dt: number;
  iterations: IterationSnapshot[];
  converged: boolean;
  iterationCount: number;
  attempts?: NRAttempt[];
  cktMode?: number;
  /** Integration coefficients for this step, populated for both engines. */
  integrationCoefficients: IntegrationCoefficients;
  /** Analysis phase at this step. */
  analysisPhase: "dcop" | "tranInit" | "tranFloat";
}
```

Stream 1 populates both sub-objects: `ours` is set from
`computeIntegrationCoefficients(dt, h1, h2, order, method)` at step finalization time,
and `ngspice` is set from the callback data fields (`ag0`, `ag1`, `integrateMethod`,
`order`) captured from the C callback.

**`capture.ts`** — Update `finalizeStep` in `createStepCaptureHook` to accept and store
integration coefficients and analysis phase:

```typescript
finalizeStep: (
  simTime: number,
  dt: number,
  converged: boolean,
  integrationCoefficients: IntegrationCoefficients,
  analysisPhase: "dcop" | "tranInit" | "tranFloat",
) => void;
```

The caller (`comparison-session.ts` and the engine's step loop) computes
`integrationCoefficients.ours` by calling `computeIntegrationCoefficients(dt, h1, h2, order, method)`
with values read from the coordinator at step finalization time (see Item 15).
`integrationCoefficients.ngspice` is populated in `getCaptureSession()` from the
last iteration's `ag0`/`ag1`/`integrateMethod`/`order` callback fields.

**`types.ts`** — Add to `RawNgspiceIterationEx`:

```typescript
/** CKTag[0] — integration coefficient ag0. */
ag0: number;
/** CKTag[1] — integration coefficient ag1. */
ag1: number;
/** CKTintegrateMethod — 0=BE, 1=trap, 2=gear. */
integrateMethod: number;
/** CKTorder — integration order (1 or 2). */
order: number;
```

**C callback extension** — Add `ag0`, `ag1`, `integrateMethod`, `order` to the iteration
callback (see Item 15). Map from callback params to `RawNgspiceIterationEx` fields in
`_registerIterationCallback`.

**`ngspice-bridge.ts`** — In `getCaptureSession()`, group iterations into steps and populate
`integrationCoefficients` on each `StepSnapshot` from the last iteration's ag0/ag1/method/order.
Map `integrateMethod` 0→"backwardEuler", 1→"trapezoidal", 2→"gear2".

---

## Item 8: Per-Element Convergence Detail

### Problem

`checkAllConverged` in `MNAAssembler` short-circuits on first failure. We get a single
boolean. We cannot know which elements failed convergence without iterating them all.

### Specification

**`mna-assembler.ts`** — Add `checkAllConvergedDetailed`:

```typescript
/**
 * Like checkAllConverged but collects all failing element indices instead of
 * short-circuiting on the first failure.
 *
 * Only called when NROptions.detailedConvergence is true. The default path
 * (checkAllConverged) is unchanged and continues to short-circuit.
 */
checkAllConvergedDetailed(
  elements: readonly AnalogElement[],
  voltages: Float64Array,
  prevVoltages: Float64Array,
  reltol: number,
  iabstol: number,
): { allConverged: boolean; failedIndices: number[] } {
  const failedIndices: number[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el.checkConvergence) continue;
    if (!el.checkConvergence(voltages, prevVoltages, reltol, iabstol)) {
      failedIndices.push(i);
    }
  }
  return { allConverged: failedIndices.length === 0, failedIndices };
}
```

**`newton-raphson.ts`** — Add `detailedConvergence` flag to `NROptions`:

```typescript
/**
 * When true, call checkAllConvergedDetailed instead of checkAllConverged.
 * Collects all failing element indices rather than short-circuiting.
 * Defaults to false — existing short-circuit path unchanged.
 */
detailedConvergence?: boolean;
```

When `detailedConvergence` is true, replace the `checkAllConverged` call with
`checkAllConvergedDetailed`. Pass `failedIndices` to `postIterationHook` via the extended
hook signature (see Item 9 for extended signature).

**`types.ts`** — Add to `IterationSnapshot`:

```typescript
/** Our element labels that failed convergence this iteration. Empty on converged iteration. */
convergenceFailedElements: string[];
```

`checkAllConvergedDetailed` returns `failedIndices: number[]` internally. These indices are
converted to labels using the `elementLabels` map before storing on `IterationSnapshot`.
The stored field always contains string labels, never numeric indices.

**C callback extension / `ngspice-bridge.ts`** — After `CKTconvTest` in ngspice's NIiter,
iterate devices and report which ones incremented `noncon`. The C side sends:

```c
_Inout_ int* devConvFailed,  /* device indices that failed convergence */
int devConvCount             /* count */
```

`ngspice-bridge.ts` decodes `devConvFailed` into an array of device indices, resolves device
names via topology, and stores as `ngspiceConvergenceFailedDevices` on the iteration snapshot.

**`types.ts`** — Add to `IterationSnapshot`:

```typescript
/** ngspice device names that failed convergence this iteration (from C callback). */
ngspiceConvergenceFailedDevices?: string[];
```

**Performance:** `detailedConvergence` defaults false. Existing path untouched.

---

## Item 9: Voltage Limiting Capture

### Problem

Voltage limiting (`pnjlim`, `fetlim`, `limvds`) is a critical source of divergence between
our engine and ngspice. Neither side currently captures pre/post limiting values. Without
this data, debugging limiting-related divergence requires educated guessing.

### Specification

**`types.ts`** — Add `LimitingEvent` interface:

```typescript
export interface LimitingEvent {
  /** Element index in compiled.elements[]. */
  elementIndex: number;
  /** Element label. */
  label: string;
  /** Junction name: "BE", "BC", "GS", "DS", "AK", etc. */
  junction: string;
  /** Limiting function applied. */
  limitType: "pnjlim" | "fetlim" | "limvds";
  /** Input voltage before limiting. */
  vBefore: number;
  /** Output voltage after limiting. */
  vAfter: number;
  /** Whether limiting was actually applied (vAfter differs from vBefore). */
  wasLimited: boolean;
}
```

Add `limitingEvents: LimitingEvent[]` to `IterationSnapshot` (required, not optional).

**`newton-raphson.ts`** — Add `limitingCollector` to `NROptions`:

```typescript
/**
 * When non-null, elements push LimitingEvent objects here after each
 * limiting function call. The NR loop resets this array at the start
 * of each iteration before passing it to the assembler.
 * When null, elements skip limiting event collection (zero overhead).
 */
limitingCollector?: LimitingEvent[] | null;
```

At the start of each NR iteration, if `limitingCollector` is non-null, reset it:
`opts.limitingCollector.length = 0`.

Pass `limitingCollector` through the assembler to each element's `updateOperatingPoint()`.
Elements push events after calling limiting functions.

**`capture.ts`** — Update `PostIterationHook` signature to accept `limitingEvents` and
`convergenceFailedElements`:

```typescript
export type PostIterationHook = (
  iteration: number,
  voltages: Float64Array,
  prevVoltages: Float64Array,
  noncon: number,
  globalConverged: boolean,
  elemConverged: boolean,
  limitingEvents: LimitingEvent[],
  convergenceFailedElements: string[],
) => void;
```

Update `createIterationCaptureHook` hook body to store them on the snapshot.

**C callback extension / `ngspice-bridge.ts`** — Instrument `DEVpnjlim`, `DEVfetlim`,
`DEVlimvds` in ngspice source to push events to a per-iteration collector. The C side sends
a flat buffer in the callback:

```c
int numLimitEvents,
_Inout_ int* limitDevIdx,      /* device index for each event */
_Inout_ int* limitJunctionId,  /* junction enum for each event */
_Inout_ double* limitVBefore,  /* input voltage before limiting */
_Inout_ double* limitVAfter,   /* output voltage after limiting */
_Inout_ int* limitWasLimited   /* 1 if limited, 0 if not */
```

`ngspice-bridge.ts` decodes these and builds `Array<{ deviceName: string; junction: string; vBefore: number; vAfter: number; wasLimited: boolean }>`. Junction IDs are mapped to string names via a lookup table (0→"AK", 1→"BE", 2→"BC", 3→"GS", 4→"DS", etc.).

Add to `RawNgspiceIterationEx`:

```typescript
limitingEvents: Array<{
  deviceName: string;
  junction: string;
  vBefore: number;
  vAfter: number;
  wasLimited: boolean;
}>;
```

Store ngspice limiting events on the iteration snapshot via `getCaptureSession()`.

**Performance:** `limitingCollector` is null by default. Single null check per junction per
NR iteration in element code. No overhead when null.

---

## Item 10: Matrix Entry Labels

### Problem

CSC entries from `getCSCNonZeros()` are raw (row index, col index, value) with no human label.
Debugging matrix mismatches requires manual cross-referencing of node indices.

### Specification

**`types.ts`** — Add to `TopologySnapshot`:

```typescript
export interface TopologySnapshot {
  matrixSize: number;
  nodeCount: number;
  branchCount: number;
  elementCount: number;
  elements: Array<{ ... }>;
  nodeLabels: Map<number, string>;
  /** Row index → label (voltage node or branch current). */
  matrixRowLabels: Map<number, string>;
  /** Column index → label. */
  matrixColLabels: Map<number, string>;
}
```

**`capture.ts`** — Populate `matrixRowLabels` and `matrixColLabels` at the end of
`captureTopology()`:

```typescript
const matrixRowLabels = new Map<number, string>();
const matrixColLabels = new Map<number, string>();

// Rows 0..nodeCount-1 map to voltage nodes (nodeId = row + 1, 1-based)
nodeLabels.forEach((label, nodeId) => {
  const row = nodeId - 1;  // nodeId is 1-based
  if (row >= 0 && row < compiled.nodeCount) {
    matrixRowLabels.set(row, label);
    matrixColLabels.set(row, label);
  }
});

// Rows nodeCount..matrixSize-1 are branch currents contributed by voltage sources
// and inductors. These elements do not exist as a named map on the compiled circuit.
// Derive branch-row labels by scanning compiled.elements for voltage sources and inductors
// (elements that contribute branch-current rows to the MNA matrix):
let branchOffset = 0;
for (let i = 0; i < compiled.elements.length; i++) {
  const el = compiled.elements[i];
  const label = elementLabels?.get(i) ?? `element_${i}`;
  const typeId = compiled.elementToCircuitElement?.get(i)?.typeId ?? "";
  const isBranchElement =
    typeId === "DcVoltageSource" ||
    typeId === "AcVoltageSource" ||
    typeId === "Inductor";
  if (isBranchElement) {
    const branchRow = compiled.nodeCount + branchOffset;
    matrixRowLabels.set(branchRow, `${label}:branch`);
    matrixColLabels.set(branchRow, `${label}:branch`);
    branchOffset++;
  }
}
```

Branch-contributing elements are voltage sources and inductors. For each, the branch row
index is `compiled.nodeCount + branchOffset` where `branchOffset` is the element's position
among branch-contributing elements in `compiled.elements` order. Labels are formatted as
`"V1:branch"` or `"L1:branch"` using the `elementLabels` map. Read
`compiled-analog-circuit.ts` to confirm the exact element type identifiers before
implementing — the type check above uses `typeId` from `elementToCircuitElement`.

---

## Item 11: Node Label UUID Fallback Fix

### Problem

Strategy 3 in `captureTopology` (fallback when strategies 1 and 2 produce no labels) uses
`el.label` directly, which is a UUID string like `"3f8a2b1c-..."`. This causes UUID-prefixed
labels to appear in node maps and break all label-based matching.

### Specification

**`capture.ts`** — Change strategy 3 loop to use `elementLabels` map:

Current (broken):
```typescript
for (const el of compiled.elements) {
  const elLabel = el.label ?? `element`;
  // ...
}
```

Fixed (indexed loop using elementLabels):
```typescript
for (let i = 0; i < compiled.elements.length; i++) {
  const el = compiled.elements[i];
  const elLabel = elementLabels?.get(i) ?? `element_${i}`;
  // ...
}
```

The caller of `captureTopology` always passes `elementLabels` (built by `buildElementLabelMap`),
so the fallback to `element_${i}` will only trigger for elements that genuinely have no label
and no circuit element mapping.

---

## Item 12: Auto-Derive .cir from .dts

### Problem

Currently, tests require a hand-written `.cir` file alongside every `.dts` fixture. This
creates a maintenance burden and makes adding new test circuits expensive.

### Specification

**New file: `src/solver/analog/__tests__/harness/netlist-generator.ts`**

```typescript
/**
 * Auto-generates a SPICE netlist from a compiled analog circuit.
 *
 * Iterates compiled elements, uses element labels for SPICE instance names,
 * reads parameters from property bags, and emits SPICE element lines.
 * Emits model cards for semiconductors.
 */

import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";

export function generateSpiceNetlist(
  compiled: ConcreteCompiledAnalogCircuit,
  elementLabels: Map<number, string>,
  title?: string,
): string
```

The function must produce a syntactically correct SPICE netlist with:

1. Title line (`title ?? "Auto-generated netlist"`)
2. One element line per compiled element, using the label from `elementLabels`
3. Node numbers from `el.pinNodeIds` (0 = ground)
4. Parameters read from `compiled.elementToCircuitElement.get(i)?.getProperties()`
5. `.model` cards for semiconductor elements (one per unique model name)
6. `.end` terminator

**Supported element types and SPICE prefixes:**

| Our typeId | SPICE prefix | Node order | Key params |
|---|---|---|---|
| `Resistor` | `R` | A B | `R` (resistance) |
| `Capacitor` | `C` | + − | `C` (capacitance) |
| `Inductor` | `L` | + − | `L` (inductance) |
| `DcVoltageSource` | `V` | + − | `DC` value |
| `AcVoltageSource` | `V` | + − | `AC` amplitude, `DC` offset |
| `DcCurrentSource` | `I` | + − | `DC` value |
| `AcCurrentSource` | `I` | + − | `AC` amplitude |
| `Diode`, `Zener`, `Varactor`, `TunnelDiode` | `D` | A K | model name |
| `NpnBJT`, `PnpBJT` | `Q` | C B E | model name |
| `NMOS`, `PMOS` | `M` | D G S B | model name, `W`, `L` |
| `NJFET`, `PJFET` | `J` | D G S | model name |

**Model card generation:**

For each semiconductor element, emit a `.model` line derived from the component's model
parameters. Use SPICE3F5-compatible syntax. If two elements reference the same model
parameters, emit one `.model` line (deduplicate by model name).

```
.model Q1_npn NPN (IS=1e-14 BF=100 ...)
.model D1_std D (IS=1e-14 N=1 ...)
```

The model name is `{label}_{spiceModelType}` where `spiceModelType` is `NPN`, `PNP`, `NMF`
(NJFET), `PMF` (PJFET), `NMOS`, `PMOS`, or `D`.

Elements with no model parameters emit bare element lines without `.model` cards.

---

## Item 13: DC OP Capture Timing

### Problem

`ComparisonSession.runDcOp()` re-runs DC OP after compile to capture per-iteration data.
This is documented nowhere. The behavior is correct — the re-run is necessary because
`compile()` runs DC OP internally before the hook is wired.

### Specification

**`comparison-session.ts`** — Add a doc comment to `runDcOp()` that explicitly documents
the re-run approach:

```typescript
/**
 * Run DC operating point analysis on both engines.
 *
 * NOTE: DC OP runs twice on our engine:
 *   1. During compile() — this sets the operating point but has no capture hook.
 *   2. Here — the capture hook is wired before the second run, so all
 *      per-iteration data is captured from this second run.
 * The second run starts from the DC OP solution, so it typically converges
 * in 1-2 iterations. This is the intended behavior — see CLAUDE.md §DC OP.
 */
async runDcOp(): Promise<void>
```

No behavioral changes. Documentation only.

---

## Item 14: `__dirname` Path Resolution

### Problem

`comparison-session.ts` line 71 uses `resolve(__dirname, "../../../../..")`. Under Vitest
with ESM (`"type": "module"` in package.json), `__dirname` is undefined at runtime, causing
`ReferenceError: __dirname is not defined`. This silently breaks all fixture loading.

### Specification

**`comparison-session.ts`** — Replace the `ROOT` constant:

Current (broken under ESM):
```typescript
const ROOT = resolve(__dirname, "../../../../..");
```

Fixed:
```typescript
const ROOT = process.cwd();
```

Tests are always run from the project root (enforced by `vitest.config.ts` and npm scripts),
so `process.cwd()` is the project root. The `resolvePath` helper that uses `ROOT` remains
unchanged.

---

## Item 15: Analysis Phase / CKTmode

### Problem

`StepSnapshot.cktMode` captures the raw ngspice `CKTmode` bitmask but our engine exposes no
equivalent. Debugging requires knowing whether a step is DC OP, transient initialization,
or transient float.

### Specification

**`coordinator.ts`** — The coordinator does NOT currently track analysis phase. Add a
private `_analysisPhase: 'dcop' | 'tranInit' | 'tranFloat'` field. Set to `'dcop'` at
the start of `dcOperatingPoint()`. Set to `'tranInit'` at the start of transient stepping.
Set to `'tranFloat'` after the first N steps (matching ngspice's MODEINITPRED→MODETRAN
transition). Expose via a public `get analysisPhase()` getter:

```typescript
private _analysisPhase: "dcop" | "tranInit" | "tranFloat" = "dcop";

/**
 * Current analysis phase, updated at each step boundary.
 * "dcop"      — DC operating point (initial or re-solve)
 * "tranInit"  — Transient initialization (first few steps at t=0)
 * "tranFloat" — Transient free-running (t > 0)
 */
get analysisPhase(): "dcop" | "tranInit" | "tranFloat" {
  return this._analysisPhase;
}
```

Set `_analysisPhase = "dcop"` at the start of `dcOperatingPoint()`.
Set `_analysisPhase = "tranInit"` at the start of the transient step loop.
Set `_analysisPhase = "tranFloat"` after the MODEINITPRED→MODETRAN transition (when the
integrator switches from startup to free-running mode).

**`types.ts`** — `StepSnapshot.analysisPhase` (already added in Item 7).

**`capture.ts`** — `finalizeStep` already receives `analysisPhase` via the extended
signature added in Item 7. No additional changes.

**ngspice side:** `cktMode` is already captured in `RawNgspiceIterationEx`. The `StepSnapshot`
populated by `getCaptureSession()` should map `cktMode` to `analysisPhase`:

```typescript
function cktModeToPhase(mode: number): "dcop" | "tranInit" | "tranFloat" {
  // CKTmode flags from ngspice modeflags.h:
  //   MODEDCOP    = 0x0001
  //   MODETRANOP  = 0x0002  (transient operating point = init)
  //   MODETRAN    = 0x0004  (transient float)
  const MODEDCOP   = 0x0001;
  const MODETRANOP = 0x0002;
  const MODETRAN   = 0x0004;
  if (mode & MODEDCOP)   return "dcop";
  if (mode & MODETRANOP) return "tranInit";
  if (mode & MODETRAN)   return "tranFloat";
  return "dcop"; // default
}
```

---

## Item 16: Integration Method from ngspice

Covered by Item 7. `CKTintegrateMethod` and `CKTorder` are sent in the C callback and stored
on `RawNgspiceIterationEx.integrateMethod` and `.order`. `getCaptureSession()` uses them to
populate `StepSnapshot.integrationCoefficients.method` and `.order`.

---

## C Callback Extension Summary

The extended per-iteration callback signature (Items 2, 3, 7, 8, 9):

The implementation SHOULD use a C struct passed by pointer rather than individual
positional parameters to eliminate parameter ordering bugs in FFI:

```c
typedef struct {
  int iteration;
  int matrixSize;
  double *rhs;
  double *rhsOld;
  double *preSolveRhs;
  double *state0;
  double *state1;
  double *state2;
  int numStates;
  int noncon;
  int converged;
  double simTime;
  double dt;
  int cktMode;
  double ag0;
  double ag1;
  int integrateMethod;
  int order;
  int *matrixColPtr;
  int *matrixRowIdx;
  double *matrixVals;
  int matrixNnz;
  int *devConvFailed;
  int devConvCount;
  int numLimitEvents;
  int *limitDevIdx;
  int *limitJunctionId;
  double *limitVBefore;
  double *limitVAfter;
  int *limitWasLimited;
} NiIterationData;

typedef void (*ni_instrument_cb_v2)(NiIterationData *data);
```

For reference, the equivalent flat positional signature (Items 2, 3, 7, 8, 9):

```c
typedef void (*ni_instrument_cb_ex2)(
  int iteration,
  int matrixSize,
  double *rhs,            /* post-solve CKTrhs */
  double *rhsOld,         /* CKTrhsOld */
  double *preSolveRhs,    /* copy of CKTrhs after CKTload, before SMPsolve */
  double *state0,         /* CKTstate0 */
  double *state1,         /* NEW: CKTstate1 */
  double *state2,         /* NEW: CKTstate2 */
  int numStates,
  int noncon,
  int converged,
  double simTime,         /* CKTtime */
  double dt,              /* CKTdelta */
  int cktMode,            /* CKTmode */
  double ag0,             /* NEW: CKTag[0] */
  double ag1,             /* NEW: CKTag[1] */
  int integrateMethod,    /* NEW: CKTintegrateMethod */
  int order,              /* NEW: CKTorder */
  int *matrixColPtr,      /* NEW: G matrix CSC column pointers, length matrixSize+1 */
  int *matrixRowIdx,      /* NEW: G matrix CSC row indices, length matrixNnz */
  double *matrixVals,     /* NEW: G matrix CSC values, length matrixNnz */
  int matrixNnz,          /* NEW: number of G matrix non-zeros */
  int *devConvFailed,     /* NEW: device indices that failed convergence */
  int devConvCount,       /* NEW: count of failed devices */
  int numLimitEvents,     /* NEW: number of limiting events */
  int *limitDevIdx,       /* NEW: device index per event */
  int *limitJunctionId,   /* NEW: junction id per event */
  double *limitVBefore,   /* NEW: voltage before limiting per event */
  double *limitVAfter,    /* NEW: voltage after limiting per event */
  int *limitWasLimited    /* NEW: 1 if limited, 0 if not, per event */
);
```

The extended topology callback (Item 4):

```c
typedef void (*ni_topo_cb_ex)(
  char *nodeNames,           /* pipe-delimited node name string */
  int *nodeNumbers,          /* node number array, length nodeCount */
  int nodeCount,
  char *devNames,            /* pipe-delimited device name string */
  char *devTypes,            /* pipe-delimited device type string */
  int *devStateBases,        /* state base offset array, length devCount */
  int devCount,
  int matrixSize,
  int numStates,
  int *devNodeIndicesFlat,   /* NEW: concatenated device node indices */
  int *devNodeCounts         /* NEW: per-device node count, length devCount */
);
```

C-side instrumentation locations:
- `niiter.c`: NIiter function — extended callback replaces existing `ni_instrument_cb_ex`
- `DEVpnjlim`, `DEVfetlim`, `DEVlimvds`: push to per-iteration limiting event collector
- Topology callback: extended with device node index extraction

---

## File Change Summary

| File | Changes |
|---|---|
| `types.ts` | `ElementStateSnapshot`: add `state1Slots`, `state2Slots`. `IterationSnapshot`: `preSolveRhs` required; remove `rhs`; add `limitingEvents`, `convergenceFailedElements`, `ngspiceConvergenceFailedDevices`. `StepSnapshot`: add `integrationCoefficients`, `analysisPhase`. `TopologySnapshot`: add `matrixRowLabels`, `matrixColLabels`. New interfaces: `LimitingEvent`, `IntegrationCoefficients`. `RawNgspiceIterationEx`: add `state1`, `state2`, `ag0`, `ag1`, `integrateMethod`, `order`, `matrix`, `limitingEvents`. |
| `capture.ts` | `captureElementStates`: read state0/state1/state2. Strategy 3 loop: indexed, use `elementLabels?.get(i)`. `captureTopology`: populate `matrixRowLabels` and `matrixColLabels`. `createIterationCaptureHook`: enable pre-solve RHS capture; updated snapshot construction. `PostIterationHook` signature: add `limitingEvents`, `convergenceFailedElements`. `finalizeStep` signature: add `integrationCoefficients`, `analysisPhase`. |
| `ngspice-bridge.ts` | `_registerIterationCallback`: extended 28-parameter callback. Decode state1/state2, matrix CSC, ag0/ag1, per-device convergence, limiting events. `_registerTopologyCallback`: extended with `devNodeIndicesFlat`, `devNodeCounts`. `_unpackElementStates`: accepts state0/state1/state2, returns full `ElementStateSnapshot`. `getCaptureSession`: populate `integrationCoefficients`, `analysisPhase`, `limitingEvents` on steps/iterations. |
| `device-mappings.ts` | `BJT_MAPPING`: add `CCAP_BE`→9, `CCAP_BC`→11, `CCAP_CS`→13 in both `slotToNgspice` and `ngspiceToSlot`. |
| `compare.ts` | `compareSnapshots`: add `alignment: Map<number, number>` parameter; use it to look up ngspice steps. |
| `comparison-session.ts` | `_buildTimeAlignment()`: new private method. `_alignedNgIndex: Map<number, number>`: new field. Call `_buildTimeAlignment()` after `_reindexNgSession()` in both run methods. All ngspice step lookups use alignment map. `ROOT`: `process.cwd()`. `runDcOp()`: doc comment. |
| `node-mapping.ts` | No changes. |
| `sparse-solver.ts` | Add `enablePreSolveRhsCapture()`, `getPreSolveRhsSnapshot()`, `_preSolveRhs`, `_capturePreSolveRhs`. Capture in `finalize()`. |
| `mna-assembler.ts` | Add `checkAllConvergedDetailed()`. |
| `newton-raphson.ts` | Add `detailedConvergence` flag and `limitingCollector` to `NROptions`. Extended `postIterationHook` signature (add `limitingEvents`, `convergenceFailedElements`). When `detailedConvergence` true, call `checkAllConvergedDetailed`. |
| `integration.ts` | Add standalone `computeIntegrationCoefficients()`. |
| `coordinator.ts` | Add `analysisPhase` getter. |
| NEW `netlist-generator.ts` | `generateSpiceNetlist()`. |
| C: `niiter.c` | Replace `ni_instrument_cb_ex` with `ni_instrument_cb_ex2`. Add matrix serialization, state1/state2 pass-through, ag0/ag1/method/order, per-device convergence reporting, limiting event collection. |
| C: topology callback | Add `devNodeIndicesFlat`, `devNodeCounts` extraction and pass-through. |
| C: `DEVpnjlim`/`DEVfetlim`/`DEVlimvds` | Push to per-iteration `limitCollector` array. Clear at iteration start. |

---

## Verification Gate

A single completeness gate test in `src/solver/analog/__tests__/harness/stream1-gate.test.ts`.

The test loads `fixtures/buckbjt.dts` (or the equivalent path from `process.cwd()`),
auto-generates a `.cir` via `generateSpiceNetlist`, runs a short transient on both engines
(stop time: 10µs, max step: 100ns), and asserts all of the following. The test skips
(not fails) when `NGSPICE_DLL_PATH` is not set.

### Gate Assertions

**1. Field presence on IterationSnapshot (both sessions)**

For every `IterationSnapshot` in both `ourSession` and `ngspiceSession`:
- `voltages` is a `Float64Array` with length > 0
- `prevVoltages` is a `Float64Array` with length > 0
- `preSolveRhs` is a `Float64Array` with length > 0
- `matrix` is an array (not undefined); non-empty for iterations after the first
- `elementStates` is an array (not undefined); non-empty (buckbjt has pool-backed elements)
- `limitingEvents` is an array (not undefined); may be empty but must exist
- `convergenceFailedElements` is an array (not undefined)
- `convergenceFailedElements` contains only string labels (not numeric indices) — assert
  `convergenceFailedElements.every(e => typeof e === "string")`

**1b. Topology label maps populated**

For both `ourTopology` and `ngspiceTopology`:
- `matrixRowLabels` is a non-empty `Map<number, string>` (not empty, not undefined)
- `matrixColLabels` is a non-empty `Map<number, string>` (not empty, not undefined)

**2. Field presence on StepSnapshot (both sessions)**

For every `StepSnapshot` in both sessions:
- `simTime` is a finite number
- `dt` is a finite positive number
- `integrationCoefficients` is defined with both `ours` and `ngspice` sub-objects populated
- `integrationCoefficients.ours.ag0` is finite
- `integrationCoefficients.ours.ag1` is finite
- `integrationCoefficients.ours.method` is one of `"backwardEuler"`, `"trapezoidal"`, `"gear2"`
- `integrationCoefficients.ours.order` is 1 or 2
- `integrationCoefficients.ngspice.ag0` is finite
- `integrationCoefficients.ngspice.ag1` is finite
- `integrationCoefficients.ngspice.method` is a non-empty string
- `integrationCoefficients.ngspice.order` is 1 or 2
- `analysisPhase` is one of `"dcop"`, `"tranInit"`, `"tranFloat"`

**3. Field presence on ElementStateSnapshot (both sessions)**

For every `ElementStateSnapshot` across all pool-backed elements in both sessions:
- `slots` is a non-empty `Record<string, number>`
- `state1Slots` is a non-empty `Record<string, number>`
- `state2Slots` is a non-empty `Record<string, number>`

**4. State history consistency**

For the BJT element (Q1 or whichever BJT is present in buckbjt):
- `state1Slots["VBE"]` at step N equals `slots["VBE"]` at step N-1 (both sessions)
- Check for at least 5 consecutive steps where this holds.

**5. Pre-solve RHS differs from voltages**

For at least one iteration in both sessions:
- `preSolveRhs` is NOT element-wise identical to `voltages`
- (RHS contains current-source stamp contributions; voltages are the post-solve solution)

**6. Integration coefficients**

For trapezoidal steps on both engines:
- `integrationCoefficients.ours.ag0` ≈ `2 / dt` within 0.1% relative tolerance
- `integrationCoefficients.ngspice.ag0` ≈ `2 / dt` within 0.1% relative tolerance

**7. Per-element convergence**

On our session:
- At least one step has a non-empty `convergenceFailedElements` on its first iteration
- The final (converged) iteration of every converged step has empty `convergenceFailedElements`

On ngspice session (if ngspice available):
- At least one step has non-empty `ngspiceConvergenceFailedDevices` on an early iteration

**8. Limiting events**

On our session:
- At least one `LimitingEvent` with `wasLimited: true` exists somewhere in the full transient

On ngspice session:
- At least one step has a non-empty `limitingEvents` array

**9. No UUID labels**

In both topology snapshots:
- No node label matches the pattern `/[0-9a-f]{8}-[0-9a-f]{4}-/`
- No element label matches the same UUID pattern

**10. Matrix symmetry**

For every step/iteration where `ourIter.matrix.length > 0`:
- The aligned ngspice iteration also has `matrix.length > 0`

**11. BJT CCAP mapped**

In the ngspice session's element states for any BJT:
- `slots["CCAP_BE"]` is a finite number (not NaN)
- `slots["CCAP_BC"]` is a finite number (not NaN)
- `slots["CCAP_CS"]` is a finite number (not NaN)

**12. Time alignment**

For every aligned step pair `(i, alignedNgIndex.get(i))`:
- `|ourStep.simTime - ngStep.simTime| < 0.5 * min(ourStep.dt, ngStep.dt)`

**13. Analysis phase**

On our session:
- The first step has `analysisPhase === "tranInit"` (or `"dcop"` if this is the DC OP run)
- Steps at `simTime > 0` have `analysisPhase === "tranFloat"` (or `"tranInit"` for first float step)

On ngspice session:
- `analysisPhase` is populated (not undefined) for all steps

**14. Integration order**

Both sessions:
- `integrationCoefficients.order` is populated for all steps
- First step has order 1 (backward Euler startup)
- After warmup, order may increase to 2 (if method supports it)

---

## Dependencies

Stream 2 (MCP) and Stream 3 (Interface) depend on the type changes in this stream.
Stream 3 query methods consume the new fields (`state1Slots`, `state2Slots`, `limitingEvents`,
`convergenceFailedElements`, `integrationCoefficients`, `analysisPhase`).
Stream 2 exposes them through MCP tool responses.

Do not start Stream 2 or Stream 3 until all 16 items in this stream are implemented and the
verification gate test passes.
