# ngspice Alignment — Master Implementation Spec

## Governing Principles

1. **100% numerical alignment with ngspice default build** (no PREDICTOR, no WANT_SENSE2, no CLUSTER, no SHARED_MODULE). Same formula, same operands, same operation order within IEEE-754 rounding.
2. **Zero allocations in hot paths.** No `new`, no object literals, no closures, no array methods that allocate inside NR iterations, per-step code, or per-device-load code. All buffers pre-allocated at compile/init time, mutated in place.
3. **Single device load function.** `load(ctx: LoadContext): void` per device, matching ngspice `DEVload`. All ~65 analog element implementations rewritten atomically.
4. **Only permitted additions over ngspice:** convergence logging, diagnostics emission, blame tracking.
5. **Persistent linked-list sparse solver** matching ngspice `spMatrix`. No COO→CSC pipeline. No AMD ordering.

## Inter-Phase Breakage Carve-Out (reviewers: read before filing findings)

This is a far-reaching refactor. Between the start of Phase 0 and the end of
Phase 7 the codebase will not be fully working. Specifically:

- **`tsc --noEmit` may fail** at any commit between phases. Type-level
  breakage that is the direct consequence of a landed interface change
  (e.g. Wave 6.1 redefining `AnalogElement` before Wave 6.2 migrates the
  implementations) is **expected** and **must not** be papered over with
  optional chains, `as any` casts, runtime arity sniffs, conditional method
  presence checks, or any other form of compatibility shim. If tsc breaks,
  leave it broken — it is a correctness signal for the next phase, not a
  regression to chase.
- **Unit and E2E tests may fail** at any commit between phases. Phase 7 is
  the verification gate; prior phases are not expected to leave the test
  suite fully green. If tests pass uniformly between phases, it almost
  certainly means a shim was added to bridge a gap — which is a violation,
  not a success.
- **No deliberately non-equivalent numerical tests.** Every numerical
  assertion must be bit-exact against ngspice (or a pre-computed
  bit-exact reference). Relaxed tolerances, `toBeCloseTo`, or
  implementation-mirroring expected values are banned — they silently mask
  divergence.
- **No deliberate shims to keep phases connected.** If Wave 6.1 deletes
  interface methods, callers of those methods break at tsc time and fail
  at runtime. That is the intended state until the paired Wave lands.
  Restoring the methods, adding `?.` guards, or writing runtime sniffs to
  keep the engine limping is forbidden.

Reviewers: do **not** file findings that a shim/sniff/cast should be added
to keep cross-phase callers alive. Do file findings when a shim/sniff/cast
exists. The tsc-broken baseline itself is not a finding once this carve-out
is in place; the shims used to hide it are.

End of Phase 7 is the only point where the entire codebase must
simultaneously type-check clean and pass every test.

## Resolved Design Decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Sparse solver format | Persistent linked lists (Option 2) | Eliminates 350ms/sim COO→CSC overhead, enables native preorder, matches ngspice spMatrix |
| AMD ordering | Dropped — pure Markowitz on original column order | ngspice doesn't use AMD; required for per-iteration parity |
| CKTCircuitContext | Full god-object in Phase 1 (Option A) | Matches ngspice CKTcircuit; single allocation point for all buffers |
| MNAAssembler | Hoisted to ctx in Phase 1, deleted in Phase 2 | Temporary bridge until cktLoad replaces stampAll |
| NISHOULDREORDER | Explicit forceReorder() only, no auto-detection | Match ngspice exactly |
| E_SINGULAR | continue to CKTload (re-stamp + re-factor) | Match ngspice niiter.c:888-891 |
| NR signature | `newtonRaphson(ctx): void`, writes ctx.nrResult | Match ngspice NIiter void signature |
| hadNodeset gate | Derived from ctx.nodesets.size > 0 | Match ngspice niiter.c:1051-1052 |
| cktTerrVoltage | Fix to match ngspice, keep function | Code exists in ngspice, we match it |
| Method switching | Remove entirely | ngspice sets method once, never changes |
| Initial method | Trapezoidal | ngspice default is TRAPEZOIDAL |
| Element migration | Atomic — all 65 elements at once, no shims | No legacy shims policy |
| Behavioral digital | Included in rewrite (~18 elements) | Same interface, same rewrite |

## Phase Structure

| Phase | Name | Spec File | Dependencies |
|---|---|---|---|
| **0** | Sparse Solver Rewrite (Waves 0.1–0.3 real; Wave 0.4 complex) | `spec/phase-0-sparse-solver-rewrite.md` | None |
| **1** | Zero-Alloc Infrastructure | `spec/phase-1-zero-alloc-infrastructure.md` | Phase 0 |
| **2** | NR Loop Alignment | `spec/phase-2-nr-loop-alignment.md` | Phase 1, Phase 6 (for cktLoad) |
| **3** | Numerical Fixes | `spec/phase-3-numerical-fixes.md` | Phase 1 |
| **4** | DC Operating Point Alignment | `spec/phase-4-dcop-alignment.md` | Phase 1, Phase 2 |
| **5** | Transient Step Alignment | `spec/phase-5-transient-step-alignment.md` | Phase 1, Phase 4 |
| **6** | Model Rewrites (Waves 6.1–6.3 + Wave 6.4 digital pin models) | `spec/phase-6-model-rewrites.md` | Phase 1 (for LoadContext) |
| **7** | Verification | `spec/phase-7-verification.md` | All previous phases |

## Dependency Graph

```
Phase 0 Waves 0.1–0.3 (real sparse solver — persistent linked lists, preorder, drop AMD)
  ↓
Phase 1 (CKTCircuitContext god-object, zero-alloc buffers)
  ↓
  ├── Phase 2 Wave 2.1 (pnjlim/fetlim fixes, hadNodeset gate)
  │     ↓
  │   Phase 2 Wave 2.2 (cktLoad single-pass) ◄── Phase 6 (all elements implement load())
  │
  ├── Phase 3 (ckt-terr formula fixes, integration coefficient fixes)
  │
  ├── Phase 6 Wave 6.1 (LoadContext interface definition)
  │     ↓
  │   Phase 6 Wave 6.2 (rewrite all ~65 elements — atomic)
  │     ↓
  │   ├── Phase 6 Wave 6.3 (test infrastructure, delete dead code on real solver)
  │   └── Phase 6 Wave 6.4 (digital pin models into cktLoad world)
  │
  ├── Phase 4 (DC-OP alignment — all 5 sub-algorithms)
  │     requires: Phase 2 Wave 2.1
  │
  └── Phase 5 (transient step alignment, timestep controller)
        requires: Phase 4

Phase 0 Wave 0.4 (complex sparse solver parity — mirror of 0.1/0.2/0.3 on complex-sparse-solver.ts)
  independent of 0.1/0.2/0.3; runs in parallel with Phase 6

Phase 7 (verification — ngspice parity tests)
  requires: all above
```

**Critical path:** 0 (Waves 0.1–0.3) → 1 → 6.1 → 6.2 → 2.2 → 4 → 5 → 7

**Parallelizable after Phase 1:**
- Phase 3 (numerical fixes) can run in parallel with Phase 6
- Phase 2 Wave 2.1 (pnjlim/fetlim) can run in parallel with Phase 6
- Phase 4 can start as soon as Phase 2 Wave 2.1 completes
- Phase 0 Wave 0.4 (complex solver parity) can run in parallel with Phase 6 — separate file, separate call sites
- Phase 6 Wave 6.4 (digital pin models) can run in parallel with Wave 6.3 after Wave 6.2 lands

**Wave 6.2 atomic-migration gate:** All ~65 elements must implement `load()` in the same merge — no shims, no coexistence period. Full-codebase `tsc --noEmit` must succeed before Waves 6.3 and 6.4 begin.

**Wave 0.4 scope note:** `ComplexSparseSolver.stamp(row, col, re, im)` deletion (Task 0.4.4) lands with migration of the single remaining caller inside `ac-analysis.ts`. No files under `src/components/**` are touched — per-element `stampAc` implementations do not currently exist and are out of scope for Wave 0.4. They will be defined and implemented in a later phase whose spec captures the per-element small-signal AC stamps against ngspice references. Full-codebase `tsc --noEmit` must succeed after Wave 0.4 lands.

**Wave 6.4 atomic-migration gate:** The legacy pin-model methods (`stamp`, `stampOutput`, `stampCompanion`, `updateCompanion`) are deleted in Task 6.4.4 only after Tasks 6.4.1–6.4.3 have landed. Full-codebase `tsc --noEmit` must succeed after Wave 6.4.

## File Impact Summary

| File | Change | Phase |
|---|---|---|
| `src/solver/analog/sparse-solver.ts` | **Major rewrite** — persistent linked lists, real preorder, drop AMD | 0 (Waves 0.1–0.3) |
| `src/solver/analog/complex-sparse-solver.ts` | **Major rewrite** — persistent complex linked lists, real preorder, drop AMD, handle-based stampComplexElement, forceReorder lifecycle | 0 (Wave 0.4) |
| `src/solver/analog/ac-analysis.ts` | **Moderate** — single `forceReorder()` call on sweep entry; handle-cache invalidation contract | 0 (Wave 0.4) |
| `src/solver/analog/digital-pin-model.ts` | **Major rewrite** — load(ctx)/accept(ctx, voltage) surface, role tag on DigitalOutputPinModel, loaded getter, handle caching, delete legacy stamp methods | 6 (Wave 6.4) |
| `src/solver/analog/behavioral-*.ts` and `src/solver/analog/behavioral-flipflop/*.ts` | **Moderate** — read `_pinLoading` from PropertyBag; delegate element `load()`/`accept()` to pin-model `load()`/`accept()`; drop hardcoded `loaded=true` literals | 6 (Waves 6.2.6, 6.4.3) |
| `src/solver/analog/compiler.ts` | **Moderate** — shared `resolvePinLoading` helper; write `_pinLoading: Record<string, boolean>` into PropertyBag for every behavioural element | 6 (Wave 6.4.1) |
| `src/solver/analog/ckt-context.ts` | **New file** — CKTCircuitContext god-object | 1 |
| `src/solver/analog/load-context.ts` | **New file** — LoadContext interface | 6 |
| `src/solver/analog/ckt-load.ts` | **New file** — cktLoad function (replaces stampAll) | 2 |
| `src/solver/analog/newton-raphson.ts` | **Major rewrite** — takes ctx, void return, E_SINGULAR fix, pnjlim/fetlim fixes | 1, 2 |
| `src/solver/analog/mna-assembler.ts` | **Deleted** | 2 |
| `src/solver/analog/analog-engine.ts` | **Major rewrite** — uses ctx, remove method switching, remove separate loops | 1, 5 |
| `src/solver/analog/dc-operating-point.ts` | **Major rewrite** — takes ctx, all numerical fixes | 1, 4 |
| `src/solver/analog/timestep.ts` | **Significant rewrite** — remove method switching, fix breakpoints, initial method | 5 |
| `src/solver/analog/integration.ts` | **Moderate fixes** — coefficient bugs, zero-alloc scratch, delete integrateCapacitor/Inductor | 3, 6 |
| `src/solver/analog/ckt-terr.ts` | **Moderate fixes** — 6 formula corrections | 3 |
| `src/solver/analog/element.ts` | **Interface redesign** — unified load() | 6 |
| ~65 element implementation files | **Full rewrite** of hot-path methods | 6 |
| ~25 test files with mock elements | **Update mocks** to load() interface | 6 |

## Verification Criteria

After all phases complete, the following 9 circuits must produce IEEE-754 identical per-NR-iteration / per-frequency node voltages compared to ngspice:

1. Resistive divider (DC-OP — linear stamp, 1 iteration)
2. Diode + resistor (DC-OP — pnjlim, mode transitions)
3. BJT common-emitter (DC-OP — multi-junction limiting, gmin stepping)
4. Op-amp inverting amplifier (DC-OP — source stepping)
5. RC series with pulse (Transient — capacitor integration, LTE, order promotion)
6. RLC oscillator (Transient — inductor integration, ringing without method switch)
7. Diode bridge rectifier (Transient — multiple junctions, breakpoints)
8. MOSFET inverter (DC-OP + Transient — fetlim, FET equations)
9. **RLC bandpass filter, 10 Hz → 1 MHz log sweep (AC — complex solver, preorder on VS branch row, handle-cache reuse across frequencies)**

Pass criteria per circuit:
- **DC-OP:** Every NR iteration's rhsOld[] matches exactly (IEEE-754 bit-identical, absDelta === 0). Mode transitions match. Iteration count matches.
- **Transient:** Every accepted timestep's dt, order, method match. Per-step NR iteration count matches. Node voltages match exactly (absDelta === 0).
- **AC:** Every swept frequency's solution matches ngspice `.AC` output with `absDelta === 0` on both real and imaginary parts of every node voltage. Single reorder across the sweep (`solver.lastFactorUsedReorder === true` only on the first frequency).
- **Convergence flow:** noncon, diagGmin, srcFact match at every iteration/step.
- **Device state:** state0[] (per DEVICE_MAPPINGS slots) matches exactly at every NR iteration.

## Testing Surface Policy

Phases 0–6 are **engine-internal refactors**. CLAUDE.md's Three-Surface Testing Rule (headless API + MCP + E2E) is satisfied for these phases by:
1. Unit tests colocated with each phase's task definitions (headless API surface), AND
2. Phase 7 ngspice parity tests serving as the E2E surface via `ComparisonSession` harness.

No per-phase MCP or Playwright tests are required for Phases 0–6. Regressions that escape unit coverage will be caught by Phase 7 parity tests before the overall work is accepted. Phase 7 is itself the E2E surface for this entire initiative.

## Appendix A: CKTCircuitContext Field Inventory

Canonical field list for `CKTCircuitContext` (mirrored by Phase 1 Task 1.1.1 — this appendix is authoritative if the two diverge):

```typescript
class CKTCircuitContext {
  // Matrix/solver
  solver: SparseSolver;
  assembler: MNAAssembler;  // Hoisted per master plan resolved decisions; deleted in Phase 2 Wave 2.2

  // Node voltages
  rhsOld: Float64Array;          // length = matrixSize
  rhs: Float64Array;
  rhsSpare: Float64Array;

  // Accepted solution
  acceptedVoltages: Float64Array;
  prevAcceptedVoltages: Float64Array;

  // DC-OP scratch
  dcopVoltages: Float64Array;
  dcopSavedVoltages: Float64Array;
  dcopSavedState0: Float64Array;
  dcopOldState0: Float64Array;

  // Integration
  ag: Float64Array;              // length 7
  agp: Float64Array;              // length 7
  nodeVoltageHistory: NodeVoltageHistory;  // CKTsols[0..7][] — per-node voltage history used by NIpred predictor
  deltaOld: number[];             // pre-allocated length 7 (matches computeNIcomCof/solveGearVandermonde `readonly number[]` parameter)

  // Gear scratch
  gearMatScratch: Float64Array;   // length 49 (7x7 flat)

  // Results
  nrResult: NRResult;             // mutable class, not interface
  dcopResult: DcOpResult;         // mutable class, not interface

  // Load context
  loadCtx: LoadContext;           // see Phase 6 Wave 6.1 for field list

  // Assembler state
  noncon: number;

  // Mode flags
  initMode: InitMode;
  isDcOp: boolean;
  isTransient: boolean;
  srcFact: number;
  hadNodeset: boolean;            // derived from nodesets.size > 0

  // Circuit refs
  elements: readonly AnalogElement[];
  matrixSize: number;
  nodeCount: number;
  statePool: StatePool;

  // Pre-computed lists (eliminate .filter() calls in hot paths)
  nonlinearElements: readonly AnalogElement[];
  reactiveElements: readonly AnalogElement[];
  poolBackedElements: readonly AnalogElement[];
  elementsWithConvergence: readonly AnalogElement[];
  elementsWithLte: readonly AnalogElement[];
  elementsWithAcceptStep: readonly AnalogElement[];

  // Tolerances
  reltol: number;
  abstol: number;
  voltTol: number;
  iabstol: number;
  maxIterations: number;
  transientMaxIterations: number;
  dcTrcvMaxIter: number;

  // Damping
  nodeDamping: number;
  diagonalGmin: number;

  // Nodesets/ICs
  nodesets: Map<number, number>;
  ics: Map<number, number>;

  // Instrumentation
  diagnostics: DiagnosticsEmitter | null;
  limitingCollector: LimitingEvent[] | null;
  enableBlameTracking: boolean;
  postIterationHook: ((iter: number, v: Float64Array) => void) | null;
  detailedConvergence: boolean;

  // Bound closures (zero-alloc replacement for per-step arrow functions)
  addBreakpointBound: (t: number) => void;
  preIterationHook: ((iteration: number, iterVoltages: Float64Array) => void) | null;
}
```

## Appendix B: cktLoad Function Pseudocode

Matches ngspice cktload.c:29-158. Single-pass device load replacing `MNAAssembler.stampAll()`.

```typescript
function cktLoad(ctx: CKTCircuitContext, iteration: number): void {
  // Step 1: clear matrix and RHS (ngspice cktload.c:34-47)
  ctx.solver.beginAssembly(ctx.matrixSize);

  // Step 2: update per-iteration load context fields
  ctx.loadCtx.iteration = iteration;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.dt = ctx.isTransient ? /* current dt */ 0 : 0;
  ctx.loadCtx.method = /* current integration method */;
  ctx.loadCtx.order = /* current order */;
  ctx.loadCtx.deltaOld = ctx.deltaOld;
  ctx.loadCtx.ag = ctx.ag;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.noncon.value = 0;  // mutable ref — elements increment

  // Step 3: single device loop (ngspice cktload.c:71-95, calls DEVload)
  for (const element of ctx.elements) {
    element.load(ctx.loadCtx);
  }
  ctx.noncon = ctx.loadCtx.noncon.value;

  // Step 4: apply nodesets/ICs inside cktLoad (ngspice cktload.c:96-136)
  // Only in DC mode during initJct or initFix.
  // Both nodesets and ICs receive srcFact scaling on the RHS target voltage.
  // CKTNS_PIN = 1e10 matches ngspice cktload.c:113.
  //
  // Variable mapping (ngspice → ours):
  //   ckt->CKTnodeset    → ctx.nodesets
  //   ckt->CKTnodeValues → ctx.ics
  //   1e10               → CKTNS_PIN
  //   CKTsrcFact         → ctx.srcFact
  if (ctx.isDcOp && (ctx.initMode === "initJct" || ctx.initMode === "initFix")) {
    for (const [node, value] of ctx.nodesets) {
      ctx.solver.stamp(node, node, CKTNS_PIN);
      ctx.solver.stampRHS(node, CKTNS_PIN * value * ctx.srcFact);
    }
    for (const [node, value] of ctx.ics) {
      ctx.solver.stamp(node, node, CKTNS_PIN);
      ctx.solver.stampRHS(node, CKTNS_PIN * value * ctx.srcFact);
    }
  }

  // Step 5: finalize matrix
  ctx.solver.finalize();
}
```

## Appendix C: SMPpreOrder Algorithm

Matches ngspice sputils.c:177-301. Operates on the persistent linked-list matrix. Finds zero-diagonal columns and swaps with symmetric twin columns.

```typescript
// Twin pair = (J,R) and (R,J) entries with |value| === 1.0, where diagonal at col J is zero.
function smpPreorder(): void {
  let didSwap = true;
  while (didSwap) {
    didSwap = false;
    for (let col = 0; col < matrixSize; col++) {
      if (!isDiagonalZero(col)) continue;

      // Walk column J chain looking for an entry at row R with |value| === 1.0
      for (let el = _colHead[col]; el !== -1; el = _elNextInCol[el]) {
        const row = _elRow[el];
        if (Math.abs(_elVal[el]) !== 1.0) continue;

        // Check column R for symmetric partner at row J with |value| === 1.0
        let foundTwin = false;
        for (let el2 = _colHead[row]; el2 !== -1; el2 = _elNextInCol[el2]) {
          if (_elRow[el2] === col && Math.abs(_elVal[el2]) === 1.0) {
            foundTwin = true;
            break;
          }
        }

        if (foundTwin) {
          swapColumns(col, row);  // swaps _colHead, _elCol fields, _diag entries
          didSwap = true;
          break;
        }
      }
    }
  }
}
```
