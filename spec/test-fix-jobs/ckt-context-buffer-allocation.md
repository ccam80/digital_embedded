# Test fix: ckt-context buffer allocation timing

## Problem statement

The `allocates_all_buffers_at_init` test in
`src/solver/analog/__tests__/ckt-context.test.ts` (test starts at line 160)
asserts that immediately after `new CKTCircuitContext(...)`, every
pre-allocated buffer has the right length:

```ts
expect(ctx.rhsOld).toBeInstanceOf(Float64Array);
expect(ctx.rhsOld.length).toBe(sz);   // sz = matrixSize = 10
```

The first length check fails: `expected +0 to be 10`. The buffer is a
`Float64Array` (so the `toBeInstanceOf` check passes) but its length is 0.

This is not "buffer was renamed/relocated." The buffer field name `rhsOld`
exists exactly as the test names it on `CKTCircuitContext`
(`src/solver/analog/ckt-context.ts:229`). The mismatch is on _when_ the
buffer is sized:

- Test contract: "allocates_all_buffers_at_init" — every buffer is fully
  sized at the end of the constructor.
- Production reality: the constructor allocates zero-length placeholders
  for the per-row buffers and defers actual sizing to a separate
  `allocateRowBuffers(matrixSize)` call invoked from `MNAEngine._setup()`
  after the per-element `setup()` loop runs and the matrix size is final.

The drift is documented in the constructor itself
(`src/solver/analog/ckt-context.ts:614-627`):

```ts
// Per-row buffers allocated with zero length at construction.
// allocateRowBuffers(matrixSize) is called from MNAEngine._setup() after
// setup() calls have run and solver._size is final (A5.1).
this.rhsOld = new Float64Array(0);
this.rhs = new Float64Array(0);
this.rhsSpare = new Float64Array(0);
this.acceptedVoltages = new Float64Array(0);
this.prevAcceptedVoltages = new Float64Array(0);
this.dcopVoltages = new Float64Array(0);
this.dcopSavedVoltages = new Float64Array(0);
this.dcopSavedState0 = new Float64Array(0);
this.dcopOldState0 = new Float64Array(0);
this.lteScratch = new Float64Array(64);
```

The constructor's other pre-allocated buffers (`ag`, `agp`, `gearMatScratch`,
`deltaOld`, `lteScratch`) are sized correctly at construction.

## Sites

- `src/solver/analog/ckt-context.ts` — `CKTCircuitContext` class.
  - Constructor at lines 588-735 (zero-length per-row allocation at lines
    618-626).
  - `allocateRowBuffers(matrixSize)` at lines 744-763 (the deferred sizer).
  - `allocateStateBuffers(numStates, existingPool)` at lines 777-792 (the
    deferred state-pool / state-snapshot sizer).

- `src/solver/analog/__tests__/ckt-context.test.ts` —
  `allocates_all_buffers_at_init` test at lines 160-229.

## Verified buffer inventory

### What `CKTCircuitContext` actually allocates inside the constructor

| Field | Allocation in constructor | Truly sized? |
|---|---|---|
| `rhsOld` | `new Float64Array(0)` | No — deferred to `allocateRowBuffers` |
| `rhs` | `new Float64Array(0)` | No — deferred |
| `rhsSpare` | `new Float64Array(0)` | No — deferred |
| `acceptedVoltages` | `new Float64Array(0)` | No — deferred |
| `prevAcceptedVoltages` | `new Float64Array(0)` | No — deferred |
| `dcopVoltages` | `new Float64Array(0)` | No — deferred |
| `dcopSavedVoltages` | `new Float64Array(0)` | No — deferred |
| `dcopSavedState0` | `new Float64Array(0)` | No — deferred to `allocateStateBuffers` |
| `dcopOldState0` | `new Float64Array(0)` | No — deferred to `allocateStateBuffers` |
| `lteScratch` | `new Float64Array(64)` | Constructor-sized to 64; resized in `allocateRowBuffers` to `max(matrixSize*4, 64)` |
| `ag` | `new Float64Array(7)` | Yes |
| `agp` | `new Float64Array(7)` | Yes |
| `deltaOld` | `new Array<number>(7).fill(params.maxTimeStep)` | Yes |
| `gearMatScratch` | `new Float64Array(49)` | Yes |
| `nrResult` | `new NRResult(this.rhs)` | Yes (mutable class) |
| `dcopResult` | `new DcOpResult(this.dcopVoltages)` | Yes (mutable class) |
| `loadCtx` | `new LoadCtxImpl(...)` | Yes |
| `_ncDumpPool` | `[]` (empty array) | No — populated in `allocateRowBuffers` |
| `nodesetHandles` / `icHandles` | `new Map()` | Yes |
| `nodesets` / `ics` | `new Map()` | Yes |
| `diagnostics` | `new DiagnosticCollector()` | Yes |
| `convergenceFailures` | `[]` | Yes (intentionally empty) |
| `nodeVoltageHistory` | `new NodeVoltageHistory()` | Yes (lazy-init internally) |

### What the test asserts (per lines 167-229)

The test builds a circuit with `nodeCount = 9, branchCount = 1`, so
`matrixSize = 10`. It then asserts:

| Assertion | Expected length | What the constructor produces |
|---|---|---|
| `ctx.rhsOld.length === 10` | 10 | 0 (FAIL) |
| `ctx.rhs.length === 10` | 10 | 0 |
| `ctx.rhsSpare.length === 10` | 10 | 0 |
| `ctx.acceptedVoltages.length === 10` | 10 | 0 |
| `ctx.prevAcceptedVoltages.length === 10` | 10 | 0 |
| `ctx.dcopVoltages.length === 10` | 10 | 0 |
| `ctx.dcopSavedVoltages.length === 10` | 10 | 0 |
| `ctx.dcopSavedState0.length === stateSlots` | (statePool.totalSlots) | 0 |
| `ctx.dcopOldState0.length === stateSlots` | (statePool.totalSlots) | 0 |
| `ctx.ag.length === 7` | 7 | 7 (pass) |
| `ctx.agp.length === 7` | 7 | 7 (pass) |
| `Array.isArray(ctx.deltaOld) && ctx.deltaOld.length === 7` | 7 | 7 (pass) |
| `ctx.gearMatScratch.length === 49` | 49 | 49 (pass) |
| `ctx.lteScratch.length >= 10` | ≥10 | 64 (pass — `lteScratch` ctor-sized to 64) |
| `ctx.nrResult instanceof NRResult` | true | true (pass) |
| `ctx.dcopResult instanceof DcOpResult` | true | true (pass) |
| `ctx.statePool === circuit.statePool` | identity | likely fail — see below |

The first failing assertion stops the test at line 169
(`expect(ctx.rhsOld.length).toBe(sz)`).

### What the test never does

The test calls only `new CKTCircuitContext(circuit, defaultParams,
noopBreakpoint, new SparseSolver())`. It does **not** call
`allocateRowBuffers(matrixSize)` or `allocateStateBuffers(numStates,
statePool)` afterwards.

In production, `MNAEngine._setup()` is the one that calls those two methods
in sequence after the per-element `setup()` loop completes. The test bypasses
the engine entirely (it constructs `CKTCircuitContext` directly), so neither
of the deferred sizers ever runs.

### `statePool` field at construction

Constructor sets `this.statePool = null` (line 598). The test at line 228
asserts `ctx.statePool === circuit.statePool`. The test's `makeTestCircuit`
helper at line 142 sets `statePool: pool` (a real `StatePool` via
`allocateStatePool(elements)`). So the test expects `ctx.statePool` to
adopt `circuit.statePool` at construction. The constructor never reads
`circuit.statePool`. This is a separate failure that follows the first one.

## Recommendation

**Category: `architecture-fix`** — but the architecture decision is one only
the user can make.

There are exactly two ways to reconcile this:

### Option A: Move all allocation into the constructor (test-as-spec)

The test name is "allocates_all_buffers_at_init". Honor that contract by:

1. Threading `matrixSize` and `numStates` into the `CKTCircuitInput`
   interface (or accepting them as constructor args).
2. Inside the constructor, allocate `rhsOld` / `rhs` / `rhsSpare` /
   `acceptedVoltages` / `prevAcceptedVoltages` / `dcopVoltages` /
   `dcopSavedVoltages` at the matrix-size width.
3. Adopt `circuit.statePool` (or build a fresh `StatePool(numStates)`) and
   pre-size `dcopSavedState0` / `dcopOldState0` against it.
4. Delete `allocateRowBuffers` and `allocateStateBuffers`, or repurpose them
   as no-ops / hot-resize methods if matrix-size growth post-construction is
   ever needed.
5. Update `MNAEngine._setup()` to compute the matrix size before
   constructing the context, not after.

This works only if the engine actually knows the matrix size before any
element `setup()` runs. The constructor comment at line 615-617 says it
doesn't:

> Per-row buffers allocated with zero length at construction.
> `allocateRowBuffers(matrixSize)` is called from `MNAEngine._setup()` after
> `setup()` calls have run and `solver._size` is final (A5.1).

So Option A requires reorganizing `MNAEngine` to compute matrix size in two
phases: a pre-pass that walks elements to count `makeVolt` / `makeCur`
calls (or to ask each element for its node/branch contribution), then the
context construction with that size, then the actual `setup()` calls. This
is a non-trivial refactor of the engine init order.

### Option B: Update the test to call `allocateRowBuffers` and `allocateStateBuffers` after construction (contract-update)

Rename the test to `allocates_all_buffers_after_setup` (or similar) and
invoke the deferred sizers explicitly:

```ts
const ctx = new CKTCircuitContext(circuit, defaultParams, noopBreakpoint,
                                   new SparseSolver());
ctx.allocateRowBuffers(circuit.matrixSize);
ctx.allocateStateBuffers(circuit.statePool!.totalSlots, circuit.statePool);
// then the existing length assertions follow.
```

This makes the test reflect the actual production lifecycle — it exercises
the same call sequence `MNAEngine._setup()` does — but loses the
"allocates_at_init" guarantee. The cost is that nothing now pins the
"every buffer must be fully sized at the end of the constructor"
invariant; if a future regression makes the constructor allocate
`rhsOld` lazily inside the engine instead of at `allocateRowBuffers`-time,
no test catches it.

### My recommendation

**Option B is the smaller, lower-risk fix.** The deferred-sizing pattern
is well-established (mirrors ngspice's `cktsetup.c:82-84` per the citation
in the constructor docstring), and Option A would require a non-trivial
engine refactor. But Option A is what the test name promises, and the
test was clearly written with Option A semantics in mind. **Escalate to
user.** The decision is whether the "all buffers sized at constructor
exit" invariant is worth a two-phase init refactor.

If the user picks Option B, this is `contract-update` and the fix is local
to the test file.

If the user picks Option A, this is `architecture-fix` and the blast
radius extends through `MNAEngine._setup()`, every place that constructs
`CKTCircuitContext`, and the `CKTCircuitInput` interface.

## ngspice citation

`ref/ngspice/src/spicelib/devices/cktinit.c:23-135` (`CKTinit`) verified.
The relevant comparison points:

- Line 43: `sckt->CKTmaxEqNum = 1;` — matrix size starts at 1, grows as
  devices are parsed and call CKTmkVolt / CKTmkCur. So ngspice's
  `CKTinit` does **not** know the final matrix size either; per-row
  buffers are allocated later in `cktsetup.c:82-84`.
- Lines 48-67 set scalar fields (gmin, abstol, reltol, voltTol, bypass,
  etc.) — these are the "constructor-time" defaults that digiTS already
  honors in its constructor.

So ngspice's `CKTinit` is closer to digiTS's two-phase model than to the
"all buffers sized at init" model the test describes. This nudges toward
Option B (the test should reflect the deferred-allocation reality), but
the ngspice precedent is not binding — digiTS may legitimately choose a
stricter contract than ngspice.

## Tensions / uncertainties

1. **The test asserts `ctx.statePool === circuit.statePool` at line 228**
   but the constructor sets `this.statePool = null` (line 598). This
   assertion will fail even after the per-row buffer fix. Both options
   above need to also adopt `circuit.statePool` (Option A in the
   constructor; Option B by calling `allocateStateBuffers` with the
   pool).

2. **The test asserts `ctx.dcopSavedState0` and `ctx.dcopOldState0`
   exist as `Float64Array`s of length `statePool.totalSlots`**
   (lines 188-191). The constructor never assigns these fields a
   `Float64Array(0)` placeholder — they remain `undefined` at
   constructor exit. Verified from the constructor body: only
   `dcopSavedState0` / `dcopOldState0` declarations live on the class
   (lines 253-255), but the constructor body does not initialize them.
   So `ctx.dcopSavedState0` is `undefined` at construction, not a
   zero-length `Float64Array`. The test would fail
   `toBeInstanceOf(Float64Array)` even if `rhsOld` were sized correctly.
   This needs to be fixed in tandem.

3. **`lteScratch` lifetime asymmetry.** It is sized to 64 in the
   constructor (line 627) and may be resized to `max(matrixSize*4, 64)`
   in `allocateRowBuffers` (line 753). The test's
   `expect(ctx.lteScratch.length).toBeGreaterThanOrEqual(sz)` is a
   weaker check than the others — it passes at length 64 because
   `sz=10`. If a circuit has `matrixSize > 16`, the lower-bound check
   only passes after `allocateRowBuffers` runs. The current test's
   `nodeCount=9, branchCount=1` keeps it under that threshold, so the
   assertion is currently order-independent. Worth flagging because
   a future test that increases `matrixSize` would expose this.

4. **The test directly imports `NRResult` and `DcOpResult` from
   `ckt-context.js`** (line 11) and asserts `instanceof`. Both classes
   are exported and instantiated in the constructor, so this part of
   the test is unaffected by the buffer-allocation question.

5. **`_ncDumpPool` is `[]` at constructor exit but populated to
   `matrixSize` length in `allocateRowBuffers` (line 754-757).** The
   test does not assert anything about `_ncDumpPool`, but a future
   "every buffer is sized at init" tightening should include it.

6. **`nodeVoltageHistory.initNodeVoltages(sizePlusOne)` is called in
   `allocateRowBuffers` (line 762).** Same deferred-sizing pattern.
   If Option A is picked, this also has to move to the constructor.
