# Setup/Load Split — Engine Spec (00)

Engine-side contract for the setup/load split (sections A0–A9). This file
is the technical spec only — wave plan, sequencing, exit criteria, and
open blockers live in `plan.md`. Per-component contracts live in
`components/PB-*.md`. Behavioral elements live in `02-behavioral.md`.
Pin-label maps live in `01-pin-mapping.md`.

ngspice line numbers anchor to `ref/ngspice/` as it exists in this checkout.

The decisions baked into this spec (lazy `findBranch`, compile-time
`findDevice` map, deleted `matrixSize` field, etc.) are documented with
rationale in `plan.md` §"Resolved decisions". Read `plan.md` first if
you need the why; read this file for the what.

---

## A0. Wrong-comment cleanup

**Path:** `src/solver/analog/sparse-solver.ts:394-398`

Delete the comment block. It miscites `spconfig.h:226` as the `EXPANDABLE`
macro definition (actual: `:207`, value `YES`) and justifies a non-port as
ngspice-equivalent. A1 removes the basis for the comment.

---

## A1. SparseSolver — expandable matrix port

**ngspice anchors:**
- `spconfig.h:207` — `#define EXPANDABLE YES`
- `spconfig.h:336` — `#define MINIMUM_ALLOCATED_SIZE 6`
- `spconfig.h:337` — `#define EXPANSION_FACTOR 1.5`
- `spalloc.c:117-277` — `spCreate`
- `spbuild.c:436-504` — `Translate`
- `spbuild.c:957-1019` — `EnlargeMatrix`
- `spbuild.c:1047-1081` — `ExpandTranslationArrays`
- `spsmp.c:249-257` — `SMPnewMatrix → spCreate(0, 1, &Error)` (initial size = 0)

### A1.1 Field renaming and addition

| ngspice (`MatrixFrame`) | digiTS | Semantic |
|---|---|---|
| `Size` | `_size: number` | Live dimension; loop bound. Bumped by `_enlargeMatrix`. |
| `CurrentSize` | `_currentSize: number` (existing; unchanged) | Internal-index assignment counter. Bumped per new ext-row/col in `_translate`. Reset in `_initStructure` and `_resetForAssembly`. |
| `AllocatedSize` | `_allocatedSize: number` | Heap capacity for `_diag`, `_rowHead`, `_colHead`, `_intToExtRow`, `_intToExtCol`. |
| `ExtSize` | `_extSize: number` | Largest external index seen. |
| `AllocatedExtSize` | `_allocatedExtSize: number` | Heap capacity for `_extToIntRow`, `_extToIntCol`. |
| `InternalVectorsAllocated` | `_internalVectorsAllocated: boolean` (existing) | Reset to `false` inside `_enlargeMatrix` per `spbuild.c:1006`. |

Drop `_n`. Every `this._n` site → `this._size` (~15-30 occurrences).

### A1.2 `_initStructure()` — no parameters

**Caller:** `src/solver/analog/ckt-context.ts:537` (single site — confirm
via `Grep` returning only this match before proceeding).

```ts
_initStructure(): void {
  const initialAlloc = MINIMUM_ALLOCATED_SIZE; // 6 per spconfig.h:336
  this._size = 0;
  this._currentSize = 0;                        // mirrors ngspice CurrentSize
  this._allocatedSize = initialAlloc;
  this._extSize = 0;
  this._allocatedExtSize = initialAlloc;
  this._intToExtCol = new Int32Array(initialAlloc + 1);
  this._intToExtRow = new Int32Array(initialAlloc + 1);
  this._extToIntCol = new Int32Array(initialAlloc + 1).fill(-1);
  this._extToIntRow = new Int32Array(initialAlloc + 1).fill(-1);
  this._extToIntCol[0] = 0;
  this._extToIntRow[0] = 0;
  this._diag = new Int32Array(initialAlloc + 1).fill(-1);
  this._rowHead = new Int32Array(initialAlloc + 1).fill(-1);
  this._colHead = new Int32Array(initialAlloc + 1).fill(-1);
  for (let i = 1; i <= initialAlloc; i++) {
    this._intToExtRow[i] = i;
    this._intToExtCol[i] = i;
  }
  // Element pool sized 6 * AllocatedSize per spalloc.c:263-264.
  const elCap = Math.max(6 * initialAlloc, 64);
  this._elRow = new Int32Array(elCap);
  this._elCol = new Int32Array(elCap);
  this._elVal = new Float64Array(elCap);
  this._elNextInRow = new Int32Array(elCap);
  this._elNextInCol = new Int32Array(elCap);
  this._elCount = 0;
  this._internalVectorsAllocated = false;
  this._insertionOrder = [];                    // for _getInsertionOrder
}
```

### A1.3 `_enlargeMatrix(newSize)` — port `EnlargeMatrix` (spbuild.c:957-1019)

```ts
private _enlargeMatrix(newSize: number): void {
  const oldAllocatedSize = this._allocatedSize;       // spbuild.c:960
  this._size = newSize;                               // spbuild.c:963
  if (newSize <= oldAllocatedSize) return;            // spbuild.c:965-966

  const EXPANSION_FACTOR = 1.5;                       // spconfig.h:337
  newSize = Math.max(newSize, Math.ceil(EXPANSION_FACTOR * oldAllocatedSize));
  this._allocatedSize = newSize;

  this._intToExtCol = this._growInt32(this._intToExtCol, newSize + 1);
  this._intToExtRow = this._growInt32(this._intToExtRow, newSize + 1);
  this._diag        = this._growInt32(this._diag,        newSize + 1, -1);
  this._rowHead     = this._growInt32(this._rowHead,     newSize + 1, -1);
  this._colHead     = this._growInt32(this._colHead,     newSize + 1, -1);

  // spbuild.c:1000-1006 — drop Markowitz/Intermediate workspace.
  this._markowitzRow  = new Int32Array(0);
  this._markowitzCol  = new Int32Array(0);
  this._markowitzProd = new Int32Array(0);
  this._doRealDirect  = new Int32Array(0);
  this._intermediate  = new Float64Array(0);
  this._internalVectorsAllocated = false;

  // spbuild.c:1009-1016 — initialise the new portion (identity map).
  for (let I = oldAllocatedSize + 1; I <= newSize; I++) {
    this._intToExtRow[I] = I;
    this._intToExtCol[I] = I;
  }
}

private _growInt32(arr: Int32Array, newLen: number, fill = 0): Int32Array {
  const next = new Int32Array(newLen);
  if (fill !== 0) next.fill(fill);
  next.set(arr.subarray(0, Math.min(arr.length, newLen)));
  return next;
}
```

If `_markowitzProd` does not currently exist as a field, add it as
`private _markowitzProd: Int32Array = new Int32Array(0);`. Confirm by
grepping `private _` in sparse-solver.ts before implementing.

### A1.4 `_expandTranslationArrays(newSize)` — port spbuild.c:1047-1081

```ts
private _expandTranslationArrays(newSize: number): void {
  const oldAllocatedSize = this._allocatedExtSize;
  this._extSize = newSize;                              // spbuild.c:1053
  if (newSize <= oldAllocatedSize) return;              // spbuild.c:1055-1056

  const EXPANSION_FACTOR = 1.5;
  newSize = Math.max(newSize, Math.ceil(EXPANSION_FACTOR * oldAllocatedSize));
  this._allocatedExtSize = newSize;

  this._extToIntRow = this._growInt32(this._extToIntRow, newSize + 1, -1);
  this._extToIntCol = this._growInt32(this._extToIntCol, newSize + 1, -1);
  this._extToIntRow[0] = 0;     // ground-pin re-pin (defensive)
  this._extToIntCol[0] = 0;
}
```

### A1.5 `_translate(extRow, extCol)` — port spbuild.c:436-504

```ts
private _translate(extRow: number, extCol: number): { row: number; col: number } {
  if (extRow > this._allocatedExtSize || extCol > this._allocatedExtSize) {
    this._expandTranslationArrays(Math.max(extRow, extCol));
  }
  if (extRow > this._extSize || extCol > this._extSize) {
    this._extSize = Math.max(extRow, extCol);
  }

  let intRow = this._extToIntRow[extRow];
  if (intRow === -1) {
    this._currentSize++;
    this._extToIntRow[extRow] = this._currentSize;
    this._extToIntCol[extRow] = this._currentSize;
    intRow = this._currentSize;
    if (intRow > this._size) this._enlargeMatrix(intRow);
    this._intToExtRow[intRow] = extRow;
    this._intToExtCol[intRow] = extRow;
    this._insertionOrder.push({ extRow, extCol });
  }

  let intCol = this._extToIntCol[extCol];
  if (intCol === -1) {
    this._currentSize++;
    this._extToIntRow[extCol] = this._currentSize;
    this._extToIntCol[extCol] = this._currentSize;
    intCol = this._currentSize;
    if (intCol > this._size) this._enlargeMatrix(intCol);
    this._intToExtRow[intCol] = extCol;
    this._intToExtCol[intCol] = extCol;
    this._insertionOrder.push({ extRow, extCol });
  }

  return { row: intRow, col: intCol };
}
```

### A1.6 Loop-bound rewrite

Every loop bounded on `this._n` becomes `this._size`. Verified sites:

- `_spOrderAndFactor` (spfactor.c:191-284 port)
- `_spFactor` (spfactor.c:322-414 port)
- `solve` (spsolve.c:126-191 port)
- `preorder` (spfactor.c port)
- `_resetForAssembly` (spbuild.c:96-142 port)
- `_loadGmin`
- `getCSCNonZeros`
- `_initStructure` element-pool sizing (was `(n+1)*4`; now `this._allocatedSize` at init = 6).

### A1.7 `_getInsertionOrder()` — new test-only debug method

```ts
private _insertionOrder: Array<{ extRow: number; extCol: number }> = [];

/** Test-only: return (extRow, extCol) pairs in the order Translate
 *  first encountered them. Used by setup-stamp-order invariant tests
 *  to verify TSTALLOC ordering against ngspice's *setup.c line
 *  ordering. Not part of the runtime API. */
_getInsertionOrder(): ReadonlyArray<{ extRow: number; extCol: number }> {
  return this._insertionOrder;
}
```

Reset by `_initStructure()` (per A1.2 above) and `_resetForAssembly()`.

### A1.8 Tests

**New:** `src/solver/analog/__tests__/sparse-expandable.test.ts`.

1. Fresh `_initStructure()`: `_size === 0`, `_currentSize === 0`, `_allocatedSize === 6`.
2. `allocElement(1, 1)`: `_size === 1`, `_extToIntRow[1] === 1`.
3. `allocElement(7, 7)`: `_size === 2`, `_allocatedSize >= 7`, `_allocatedExtSize >= 7`, `_extToIntRow[7] === 2`, `_extToIntCol[7] === 2`.
4. Sequence `allocElement(N, N)` for N=1..50: `_allocatedSize` grows geometrically (1.5×), not linearly per-call.
5. `_diag`, `_rowHead`, `_colHead` are `-1` for every index `> oldAllocatedSize`.
6. `_internalVectorsAllocated === false` after every grow event.
7. Grow + factor + solve agrees with a pre-sized control where `_initStructure()` was followed by all `allocElement` calls in the same order.
8. `_getInsertionOrder()` returns `(extRow, extCol)` pairs in encounter order.

### A1.9 Existing tests must remain green

`__tests__/sparse-reset-semantics.test.ts` and `__tests__/sparse-solver.test.ts`. They call `_initStructure(n)` with explicit `n` — those calls become `_initStructure()` followed by N `allocElement` calls. Post-condition `_size === n` holds.

---

## A2. New `src/solver/analog/setup-context.ts`

ngspice `DEVsetup` signature:
`int XXXsetup(SMPmatrix *matrix, GENmodel *inModel, CKTcircuit *ckt, int *states)`

```ts
import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";

export interface SetupContext {
  /** ckt->CKTmatrix surrogate (TSTALLOC target). */
  readonly solver: SparseSolver;

  /** ckt->CKTtemp. */
  readonly temp: number;

  /** ckt->CKTnomTemp. */
  readonly nomTemp: number;

  /** ckt->CKTcopyNodesets. */
  readonly copyNodesets: boolean;

  /** Port of CKTmkVolt (cktmkvol.c:20-41). Allocates a fresh internal
   *  voltage node, returns its 1-based MNA number. */
  makeVolt(deviceLabel: string, suffix: string): number;

  /** Port of CKTmkCur (cktmkcur.c:22-43). Allocates a fresh branch row,
   *  returns its 1-based MNA number. Idempotent: calling twice with
   *  the same (label, suffix) returns the same number. */
  makeCur(deviceLabel: string, suffix: string): number;

  /** Port of `*states += N` semantics (mos1set.c:96-97 etc.). Returns
   *  the offset where this device's state slots start; advances the
   *  running counter by N. */
  allocStates(slotCount: number): number;

  /** Port of CKTfndBranch (cktfbran.c:20-33). LAZY-allocating: if the
   *  controlling source's branch has not yet been allocated by its
   *  setup() call, the source's findBranchFor callback allocates it
   *  via ctx.makeCur. Mirrors VSRCfindBr (vsrc/vsrcfbr.c:26-39):
   *    if (here->VSRCbranch == 0) {
   *      CKTmkCur(ckt, &tmp, here->VSRCname, "branch");
   *      here->VSRCbranch = tmp->number;
   *    }
   *  Both setup() and findBranch use the same idempotent guard so
   *  call order is irrelevant. Returns 0 if no device with that label
   *  exists. */
  findBranch(sourceLabel: string): number;

  /** Port of CKTfndDev (cktfinddev.c:13-17 → nghash_find). Reads the
   *  device-name → AnalogElement map populated by the compiler at the
   *  end of compileAnalog (parse-time equivalent: ngspice's
   *  DEVnameHash is populated in cktcrte.c at instance creation, well
   *  before CKTsetup). Returns null if not found. */
  findDevice(deviceLabel: string): AnalogElement | null;
}
```

Lifetime: one `SetupContext` per `MNAEngine._setup()` call. Constructed
inside `_setup()` and passed to every `element.setup()` in
NGSPICE_LOAD_ORDER bucket order.

---

## A3. `src/core/analog-types.ts` — declare `setup()` on AnalogElementCore

Add a required method between `ngspiceLoadOrder` and `load`:

```ts
/** Allocate every internal node, branch row, state slot, and
 *  sparse-matrix entry this element will ever need, in the same
 *  order as the corresponding ngspice DEVsetup. Called once per
 *  MNAEngine._setup() invocation, before any load() call.
 *
 *  Implementations:
 *   - call ctx.makeVolt() for each internal node ngspice creates with
 *     CKTmkVolt;
 *   - call ctx.makeCur() for each branch row ngspice creates with
 *     CKTmkCur, storing the result in branchIndex;
 *   - call ctx.allocStates(N) where ngspice's *setup.c does
 *     `*states += N`;
 *   - call solver.allocElement(row, col) for every TSTALLOC line in
 *     line-for-line order, storing handles on `this`;
 *   - never call solver.allocElement from load().
 *
 *  Order of allocElement calls determines internal-index assignment.
 *  It MUST mirror the corresponding ngspice DEVsetup line-for-line —
 *  including stamps that ngspice allocates unconditionally even when
 *  their value will be zero in some operating mode.
 */
setup(ctx: import("../solver/analog/setup-context.js").SetupContext): void;
```

Drop `readonly` from `branchIndex`. setup() writes it via
`this.branchIndex = ctx.makeCur(...)`. Type stays `number`; only
mutability changes.

The `AnalogElement` interface in `src/solver/analog/element.ts` inherits
`setup` automatically via the re-export.

### A3.1 MnaModel — extend with `hasBranchRow`, `mayCreateInternalNodes`, `findBranchFor`, `ngspiceNodeMap`

In the file defining `MnaModel`, replace `branchCount` and
`getInternalNodeCount` / `getInternalNodeLabels` with:

```ts
interface MnaModel {
  factory: ModelFactory;
  /** Replaces `branchCount > 0`. True for models that allocate a
   *  branch row in setup() (VSRC, IND, VCVS, CCVS). */
  hasBranchRow: boolean;
  /** True for models that may allocate internal voltage nodes in
   *  setup() (DIO, BJT, MOS, JFET, TLINE). Used by
   *  `detectVoltageSourceLoops` and `detectInductorLoops` to size
   *  worst-case topology. Default: false. */
  mayCreateInternalNodes?: boolean;
  /** Optional pin-label → ngspice-node-suffix map. See
   *  01-pin-mapping.md for the registry. */
  ngspiceNodeMap?: Record<string, string>;
  /** When set, this device type registers a lazy-branch finder.
   *  Mirrors ngspice's per-device `DEVfindBranch` (e.g. VSRCfindBr).
   *  Required for VSRC, IND, VCVS, CCVS. Should use the same
   *  idempotent guard as setup(): if branch already allocated for
   *  this name, return existing; else call ctx.makeCur and store. */
  findBranchFor?(name: string, ctx: SetupContext): number;
}
```

`MNAEngine.findBranch(label)` dispatches by walking registered models'
`findBranchFor` — first non-zero result wins, mirroring `CKTfndBranch`
(`cktfbran.c:20-33`).

---

## A4. `src/solver/analog/analog-engine.ts` — restructure init/setup

### A4.1 Strip pre-sizing from `init()`

Current `MNAEngine.init()` (analog-engine.ts:116-191):
- Line 124: `this._solver = new SparseSolver();`
- Line 172-183: constructs `CKTCircuitContext` (which at
  ckt-context.ts:537 calls `solver._initStructure(matrixSize)`).

After A1, `_initStructure()` takes no argument. After A4, `init()` does
NOT call `_setup()`.

`init()`'s new responsibilities:
1. `this._solver = new SparseSolver(); this._solver._initStructure();`
2. Resolve `compiled.elements`, sort by `ngspiceLoadOrder`.
3. **Build `this._deviceMap: Map<string, AnalogElement>` from `compiled.elements` keyed by element label.** This is the parse-time equivalent of ngspice's `DEVnameHash` (populated in `cktcrte.c`).
4. Construct `CKTCircuitContext` with no `matrixSize` parameter.
5. Construct `TimestepController` against `ctx.deltaOld`.
6. `this._isSetup = false; this._maxEqNum = compiled.nodeCount + 1; this._numStates = 0; this._nodeTable = [];`
7. Transition to `STOPPED`.

**Delete** the `stateBaseOffset < 0` validation block at
analog-engine.ts:143-160 — after A6 strips compile-time state allocation
the guard becomes dead code. Removing avoids the "previously this was…"
anti-pattern.

### A4.2 Add `_setup()` method

```ts
/** Port of CKTsetup (cktsetup.c:30-131). Runs once per circuit
 *  lifetime. Walks elements in NGSPICE_LOAD_ORDER bucket order
 *  (matching cktsetup.c:72-81's walk of DEVices[]), calls each
 *  element's setup(ctx). Internal early-return on _isSetup
 *  mirroring cktsetup.c:52-53. After setup completes, freezes ctx's
 *  per-row buffers to the now-known solver._size. */
private _setup(): void {
  if (this._isSetup) return;
  const setupCtx = this._buildSetupContext();
  for (const el of this._elements) {  // already NGSPICE_LOAD_ORDER-sorted
    el.setup(setupCtx);
  }
  // StatePool deferred construction (per A5.3).
  this._ctx!.allocateStateBuffers(this._numStates);
  this._ctx!.allocateRowBuffers(this._solver._size);
  // Nodeset / IC handle pre-allocation (per A8).
  this._allocateNodesetIcHandles();
  this._isSetup = true;
}

private _buildSetupContext(): SetupContext {
  const engine = this;
  const params = this._params;
  return {
    solver: this._solver,
    temp: params.temperature ?? 300.15,
    nomTemp: params.nomTemp ?? 300.15,
    copyNodesets: params.copyNodesets ?? false,
    makeVolt(label, suffix) { return engine._makeNode(label, suffix, "voltage"); },
    makeCur (label, suffix) { return engine._makeNode(label, suffix, "current"); },
    allocStates(n) {
      const off = engine._numStates;
      engine._numStates += n;
      return off;
    },
    findBranch(label) { return engine._findBranch(label, this); },
    findDevice(label) { return engine._deviceMap.get(label) ?? null; },
  };
}

/** Port of CKTnewNode (cktnewn.c:23-43). Called by both makeVolt and
 *  makeCur with different `type` discriminators. */
private _makeNode(label: string, suffix: string, type: "voltage" | "current"): number {
  const number = this._maxEqNum++;
  this._nodeTable.push({ name: `${label}#${suffix}`, number, type });
  return number;
}

/** Port of CKTfndBranch (cktfbran.c:20-33). Walks registered models'
 *  findBranchFor callbacks; first non-zero result wins. Lazy-
 *  allocating when the source's setup() hasn't run yet (mirrors
 *  VSRCfindBr's `if (VSRCbranch == 0) CKTmkCur(...)` guard). */
private _findBranch(label: string, ctx: SetupContext): number {
  for (const model of this._registeredMnaModels) {
    if (!model.findBranchFor) continue;
    const n = model.findBranchFor(label, ctx);
    if (n !== 0) return n;
  }
  return 0;  // ngspice "no branch" sentinel
}
```

**Engine state additions:**
- `_isSetup: boolean = false;`
- `_maxEqNum: number;` — initialised in `init()` to `compiled.nodeCount + 1`.
- `_numStates: number = 0;`
- `_nodeTable: Array<{ name: string; number: number; type: "voltage" | "current" }>;`
- `_deviceMap: Map<string, AnalogElement>;` — populated in `init()` from `compiled.elements`.
- `_registeredMnaModels: MnaModel[];` — set of all MnaModels in use; constructed in `init()` from `compiled` for `_findBranch` dispatch.

### A4.3 Driver entry calls

Add `this._setup();` at the top of every analysis driver, before any
solver work:

- `MNAEngine.dcOperatingPoint()` — immediately above the
  `solveDcOperatingPoint(this._ctx!)` call.
- `MNAEngine.step()` — immediately after the `if (!this._compiled) return;`
  guard.
- `MNAEngine.acAnalysis(params)` — first non-guard line.

(The earlier spec listed `monteCarloRun` and `parameterSweep`. Those
methods do not exist on `MNAEngine`. `ParameterSweepRunner` and the
`MonteCarlo` runner construct their own `MNAEngine` instances and hit
`_setup()` via the driver methods above. No instrumentation needed.)

The early-return inside `_setup()` makes repeat calls O(1).

---

## A5. `src/solver/analog/ckt-context.ts` — defer per-row buffer allocation

### A5.1 Constructor change + `allocateRowBuffers` / `allocateStateBuffers`

Drop the `matrixSize` parameter from `CKTCircuitInput`. Constructor allocates **zero-length** Float64Arrays for all per-row buffers. Add two new methods:

```ts
allocateRowBuffers(matrixSize: number): void {
  const sizePlusOne = matrixSize + 1;
  this.rhsOld               = new Float64Array(sizePlusOne);
  this.rhs                  = new Float64Array(sizePlusOne);
  this.rhsSpare             = new Float64Array(sizePlusOne);
  this.acceptedVoltages     = new Float64Array(sizePlusOne);
  this.prevAcceptedVoltages = new Float64Array(sizePlusOne);
  this.dcopVoltages         = new Float64Array(sizePlusOne);
  this.dcopSavedVoltages    = new Float64Array(sizePlusOne);
  this.lteScratch           = new Float64Array(Math.max(matrixSize * 4, 64));
  // _ncDumpPool: drop and rebuild at correct size.
  this._ncDumpPool = new Array(matrixSize);
  for (let i = 0; i < matrixSize; i++) {
    this._ncDumpPool[i] = { node: 0, delta: 0, tol: 0 };
  }
  this.nrResult.voltages         = this.rhs;
  this.dcopResult.nodeVoltages   = this.dcopVoltages;
  this.loadCtx.rhs               = this.rhs;
  this.loadCtx.rhsOld            = this.rhsOld;
  this.nodeVoltageHistory.initNodeVoltages(sizePlusOne);
}

allocateStateBuffers(numStates: number): void {
  // Constructed AFTER all setup() calls; ngspice cktsetup.c:82-84
  // allocates state vectors after the DEVsetup loop completes.
  this.statePool             = new StatePool(numStates);
  this.dcopSavedState0       = new Float64Array(numStates);
  this.dcopOldState0         = new Float64Array(numStates);
  // Element back-refs into pool: each pool-backed element's
  // `s0..s7` and `stateBaseOffset` are bound here.
  for (const el of this._poolBackedElements) {
    el.initState(this.statePool);
  }
}
```

`MNAEngine._setup()` calls `allocateStateBuffers` BEFORE `allocateRowBuffers` (state pool sized first; row buffers depend only on `solver._size`).

### A5.2 `matrixSize` field — DELETED

The `matrixSize: number` field on `CKTCircuitContext` (ckt-context.ts:271)
is **deleted**. Every read site is replaced with `this._solver._size`.

Read sites to migrate (full enumeration via grep `\.matrixSize` in
`src/solver/analog/`):
- Inside `CKTCircuitContext` itself: any internal `this.matrixSize` →
  `this._solver._size`.
- `loadCtx`-relative reads downstream: replace with
  `loadCtx.solver._size`.
- `nrResult` / `dcopResult` reads: replace with `ctx.solver._size`.

If grep surfaces consumers outside `src/solver/analog/`, they migrate
to `solver._size` access via the engine's `solver` getter.

### A5.3 StatePool — deferred to setup-end

`compiled.statePool` is `null` at engine init. Compile-time stops
computing state-pool size. Construction moves to
`CKTCircuitContext.allocateStateBuffers(numStates)` (A5.1), called from
`MNAEngine._setup()` after the per-element setup loop.

### A5.4 Tests

Existing `ckt-context` tests must still pass. Tests that construct
`CKTCircuitContext` with explicit `matrixSize` arg drop the arg; tests
that read `ctx.matrixSize` migrate to `ctx.solver._size`.

---

## A6. `src/solver/analog/compiler.ts` — strip-down

### A6.1 Drop matrix-structure allocation from Pass A

`runPassA_partition` (compiler.ts:662-721):
- For each component, still resolve route (`stamp` / `skip` / `bridge`).
- Do NOT call `route.model.branchCount` or
  `route.model.getInternalNodeCount`.
- `elementMeta` carries only `pc` and `route` — no `branchIdx`, no
  `internalNodeOffset`, no `internalNodeCount`.

`ResultPassAPartition` drops `branchCount` and `nextInternalNode`
fields. `matrixSize` is no longer computable at compile time.

### A6.2 Drop `branchCount`, `getInternalNodeCount`, `getInternalNodeLabels` from `MnaModel`

After A6, all three are dead code. Replaced by:
- `hasBranchRow: boolean` (required) — see A3.1.
- `mayCreateInternalNodes?: boolean` (optional) — see A3.1.
- Diagnostic labels for internal nodes are built at setup-time inside
  `_makeNode` (`${label}#${suffix}`) — see A4.2.

### A6.3 Factory signature change

Old:
```ts
factory(pinNodes, internalNodeIds, branchIdx, props, getTime): AnalogElementCore
```

New:
```ts
factory(pinNodes, props, getTime): AnalogElementCore
```

`internalNodeIds` and `branchIdx` are removed. The factory returns an
element with `branchIndex = -1` and no internal-node fields set —
`setup()` populates both.

This change ripples to **every** registered factory — any
`make<Component>(...)` factory in the model registry. Whether the
factory currently uses `internalNodeIds` / `branchIdx` or ignores them,
the parameter must be dropped to avoid signature drift.

### A6.4 Subcircuit composite

`compileSubcircuitToMnaModel` (compiler.ts:200-379):
- Composite carries an internal `subElements: AnalogElement[]` array.
- Composite's `setup(ctx)` forwards to each sub-element's `setup(ctx)` in
  the order the sub-elements appear in the array (which is itself sorted
  by `ngspiceLoadOrder`).
- Branch / internal-node allocation happens inside each sub-element's
  setup(), with the composite holding direct refs (no `findDevice`
  needed for sub-element traversal).

`bindings: Map<string, Array<{ el; key }>>` (compiler.ts:262) for
`setParam` survives — sub-elements are constructed at compile time so
the bind targets exist; their internal-node IDs become valid only after
setup, but `setParam` doesn't care about node IDs.

### A6.5 Topology validation

`detectWeakNodes`, `detectVoltageSourceLoops`, `detectInductorLoops`,
`detectCompetingVoltageConstraints` (compiler.ts:459-616) run on the
post-Pass-A element list. After A6 they only see user-visible nodes.

`isBranch` flag: replaced by reading `model.hasBranchRow` directly.
Topology validators that previously did `branchCount > 0` now do
`hasBranchRow`. `typeHint` semantics unchanged.

### A6.6 `ConcreteCompiledAnalogCircuit`

Drop `branchCount` and `matrixSize` fields (compiled-analog-circuit.ts:64-66).
`nodeCount` stays (user-visible MNA nodes; mirrors `compiled.nodeCount`
read by `init()` for `_maxEqNum` initialisation).

`netCount` getter (line 178) keeps aliasing `nodeCount`.

Read-site migrations:
- `ckt-context.ts:520` — drop the read.
- `analog-engine.ts:174-178` — drop the field from ctx ctor args.
- Any test fixture constructing `ConcreteCompiledAnalogCircuit` with
  explicit `matrixSize` parameter — drop the parameter.

---

## A7. load() no allocations — convention only

ngspice has no runtime guard. `*load.c` files do not call `SMPmakeElt`;
this is enforced by source-file split alone. digiTS port matches
exactly: convention only. Component agents are spec-bound to call
`solver.allocElement` only inside `setup()`. A load() body that calls
`allocElement` is a port error caught at component-spec verification
time (Part B per-task gate).

The previous revision proposed a TypeScript-typed solver split. Dropped
— it's invented machinery ngspice does not have.

**Verification:** after wave-2 lands, `Grep "allocElement" src/components/`
must return only matches inside `setup()` method bodies.

---

## A8. cktLoad nodeset/IC enforcement — setup-time allocation

`src/solver/analog/ckt-load.ts:107-127` currently calls `solver.allocElement`
during cktLoad (the only non-element load-time allocation site). Move
to setup time, mirroring ngspice's `cktload.c:104-129` where
`node->ptr` is read directly (allocated by setup).

Engine-side change in `MNAEngine._setup()` after the per-element setup
loop:

```ts
private _allocateNodesetIcHandles(): void {
  for (const [node] of this._ctx!.nodesets) {
    this._ctx!.nodesetHandles.set(node, this._solver.allocElement(node, node));
  }
  for (const [node] of this._ctx!.ics) {
    this._ctx!.icHandles.set(node, this._solver.allocElement(node, node));
  }
}
```

**Add fields to `CKTCircuitContext` (initialized at construction):**
- `nodesetHandles: Map<number, number> = new Map();`
- `icHandles: Map<number, number> = new Map();`

(Initialized to empty Map at construction, mirroring how `nodesets` and
`ics` are initialized today at ckt-context.ts:630-631. No optional/null-guard.)

**Update `cktLoad`** (ckt-load.ts:109, :124):

```ts
// :109 — was: solver.stampElement(solver.allocElement(node, node), CKTNS_PIN);
solver.stampElement(ctx.nodesetHandles.get(node)!, CKTNS_PIN);

// :124 — same shape.
solver.stampElement(ctx.icHandles.get(node)!, CKTNS_PIN);
```

After A8, the post-spec invariant holds: `solver.allocElement` runs only
during `_setup()`.

---

## A9. New invariant test — `setup-stamp-order.test.ts`

**Path:** `src/solver/analog/__tests__/setup-stamp-order.test.ts`

For each component listed in `components/PB-*.md`, build a minimal
one-instance circuit (component + supply + ground), run only
`MNAEngine.init()` + `_setup()` (no NR call), then read
`solver._getInsertionOrder()` (per A1.7) and assert the resulting
`(extRow, extCol)` sequence equals the corresponding ngspice `*setup.c`
TSTALLOC sequence position-for-position.

Failure on any component → port error. Component's `setup()` body
diverges from its ngspice anchor.

**Gate:** test exists with rows for every Part B component before any
of them lands. Initially every row is RED. Turns green as component
agents complete tasks.

---

Engine-wave exit criteria and per-wave gates live in `plan.md`.
