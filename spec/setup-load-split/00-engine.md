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

**Production caller:** `src/solver/analog/ckt-context.ts:537` (single site in non-test production code — confirm by grepping `_initStructure` scoped to `src/solver/analog/*.ts` excluding `__tests__/` returning only this match before proceeding). Test callers that call `_initStructure(n)` with an explicit `n` are addressed in A1.9.

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

> ngspice anchor: `spbuild.c:436-504` `Translate()`. Each call to `spGetElement(M, row, col)` produces exactly one matrix-element registration regardless of whether row or col are first-seen. digiTS `_insertionOrder` mirrors this 1:1: one `allocElement` call → one entry. Index-assignment side-effects (when row or col is new) do NOT produce additional `_insertionOrder` entries.

```ts
private _translate(extRow: number, extCol: number): { intRow: number; intCol: number } {
  // Record this allocElement call in insertion order (one entry per call,
  // matching ngspice TSTALLOC semantics — one TSTALLOC macro = one matrix
  // entry registration. See spbuild.c:436-504 Translate().)
  this._insertionOrder.push({ extRow, extCol });

  let intRow = this._extToInt[extRow];
  if (intRow === -1) {
    // existing row-new branch body — assigns a new internal row index;
    // does NOT push to _insertionOrder anymore (the top-of-function push
    // already recorded this allocElement call).
    intRow = this._assignNewInternalRow(extRow);
  }

  let intCol = this._extToInt[extCol];
  if (intCol === -1) {
    // existing col-new branch body — assigns a new internal col index;
    // does NOT push to _insertionOrder anymore.
    intCol = this._assignNewInternalCol(extCol);
  }

  return { intRow, intCol };
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

Returns the array of `{extRow, extCol}` pairs in the order `allocElement` was called during `_setup()`. One entry per `allocElement` call. The A9 test asserts this array equals the per-component TSTALLOC sequence position-for-position.

**Lifetime**: `_insertionOrder` is populated during `_setup()` and persists for the life of the engine. It is RESET only by `_initStructure()` (a fresh circuit build); `_resetForAssembly()` does NOT touch it. ngspice has no equivalent reset because TSTALLOC sequences are built once at setup time and the matrix structure persists across NR iterations and across analyses (DC OP → transient). The A9 setup-stamp-order test reads `_getInsertionOrder()` after `_setup()` and the result is stable for the rest of the engine's life — read-once-after-setup is sufficient.

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

  makeCur(deviceLabel: string, suffix: string): number;

  /** Port of `*states += N` semantics (mos1set.c:96-97 etc.). Returns
   *  the offset where this device's state slots start; advances the
   *  running counter by N. */
  allocStates(slotCount: number): number;

  /** Port of CKTfndBranch (cktfbran.c:20-33). LAZY-allocating: if the
   *  controlling source's branch has not yet been allocated by its
   *  setup() call, the source's findBranchFor callback allocates it
   *  via ctx.makeCur. Returns 0 if no device with that label exists. */
  findBranch(sourceLabel: string): number;

  /** Port of CKTfndDev (cktfinddev.c:13-17 → nghash_find). Reads the
   *  device-name → AnalogElement map populated by the compiler at the
   *  end of compileAnalog (parse-time equivalent: ngspice's
   *  DEVnameHash is populated in cktcrte.c at instance creation, well
   *  before CKTsetup). Returns null if not found. */
  findDevice(deviceLabel: string): AnalogElement | null;
}
```

**`makeCur(deviceLabel: string, suffix: string): number`** — allocates a NEW branch row by calling `engine._makeNode(deviceLabel, suffix, "current")`. Returns the new branch row index (>= 1).

**NOT idempotent.** Each call allocates a fresh branch index, even with the same `(deviceLabel, suffix)` pair. Callers MUST guard against duplicate allocation using the element-level pattern:

```ts
if (this.branchIndex === -1) {
  this.branchIndex = ctx.makeCur(this.label, "branch");
}
```

ngspice anchor: `vsrcset.c:40-43` and `vcvsset.c:41-44` both use `if (here->{VSRC|VCVS}branch == 0) { CKTmkCur(ckt, &here->{VSRC|VCVS}branch, ...); }`. The guard is at the device-setup layer, not the matrix-allocator layer.

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

/** Optional callback used by VSRC, VCVS, CCVS, IND, CRYSTAL, and RELAY elements that own
 *  branch rows. Called by `_findBranch` when a controlling source needs lazy branch-row
 *  allocation. Returns the branch row index (allocates if missing) or 0 if this element
 *  doesn't own the requested branch. */
findBranchFor?(name: string, ctx: import("../solver/analog/setup-context.js").SetupContext): number;

/** Set during setup() via ctx.allocStates(N). Index of this element's first state-pool slot.
 *  -1 if element has no state slots. */
_stateBase: number;
```

**Pin-node access inside setup()**: every element class stores its pin-label-to-MNA-node map as the instance field:

```ts
protected _pinNodes: Map<string, number>;  // populated by the factory at construction
```

setup() bodies access pin nodes by label: `const pos = this._pinNodes.get("pos")!;`. This map is populated once at construction (factory layer) and is read-only thereafter. setup() runs once per compile, so Map.get() lookup cost is amortized; load() bodies do NOT use Map lookups — they cache resolved nodeIds in instance fields during setup().

**Field name policy**: `_pinNodes` (with leading underscore) is canonical. Specs using `pinNodes.get(...)` (no `this.` prefix) or `pinNodeIds[N]` (indexed array) are non-canonical and must be updated to `this._pinNodes.get("label")!` form.

Drop `readonly` from `branchIndex`. setup() writes it via
`this.branchIndex = ctx.makeCur(...)`. Type stays `number`; only
mutability changes.

The `AnalogElement` interface in `src/solver/analog/element.ts` inherits
`setup` automatically via the re-export.

### A3.1 MnaModel — extend with `mayCreateInternalNodes`, `findBranchFor`, `ngspiceNodeMap`

In the file defining `MnaModel`, replace `branchCount` and
`getInternalNodeCount` / `getInternalNodeLabels` with:

```ts
interface MnaModel {
  factory: ModelFactory;
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

**Branch-row tracking**: post-setup, an element's branch index is reflected in `AnalogElementCore.branchIndex` directly (-1 = no branch, ≥1 = branch row index). Topology validators walk `compiled.elements` and inspect `el.branchIndex !== -1` for each element, recursing into composites' `_subElements`. No per-model boolean flag is needed; the actual allocation is the source of truth. (Investigated: `hasBranchRow` was a proposed field with no ngspice equivalent and no production use — dropped.)

`MNAEngine.findBranch(label)` dispatches by walking registered models'
`findBranchFor` — first non-zero result wins, mirroring `CKTfndBranch`
(`cktfbran.c:20-33`).

### A3.2 — W2 component stubs (every component file)

After adding the `setup(ctx: SetupContext): void` method to `AnalogElementCore` (§A3 above), every existing file in `src/components/` that exports a factory returning an `AnalogElementCore` (or constructs an element class implementing `AnalogElementCore`) must receive a stub `setup()` whose body is exactly:

```ts
setup(ctx: SetupContext): void {
  throw new Error(`PB-${name} not yet migrated`);
}
```

where `name` is the component's registered label string (the same identifier used in the component's `ComponentDefinition.name`).

**Rationale.** This stub is the W2 intermediate state. It makes any `_setup()` call loudly fail on un-migrated components, surfacing the W2→W3 transition deterministically. Without the stub, the engine would call a missing method (TypeScript runtime undefined) or — worse — silently no-op, hiding W3 progress.

**Verification gate (W2).** Every component file under `src/components/` defines a `setup()` method matching the body above. Existing component tests that do NOT call `_setup()` (most unit tests) remain green; tests that DO trigger the engine driver path (`dcOperatingPoint`, `step`, `acAnalysis`) fail with the stub `Error` until W3 replaces the stub for that component.

**W3 obligation.** The W3 per-component spec files (`spec/setup-load-split/components/PB-*.md`) replace the stub body with the real `setup()` implementation. Until every W3 component lands, the engine cannot run any analysis driver — this is the loud-and-correct intermediate state described in `plan.md` §"Half-state risk".

**Exception — `createSegmentDiodeElement.setup()` (W2.6)**:

`createSegmentDiodeElement` is a shared helper used by both `createSevenSegAnalogElement` (per PB-BEHAV-SEVENSEG) and `createButtonLEDAnalogElement` (per PB-BEHAV-BUTTONLED). In W2 it receives its REAL `setup(ctx)` body — not a throwing stub — to avoid an intra-W3 write race between SEVENSEG and BUTTONLED implementer agents.

The real setup body for `createSegmentDiodeElement(nodeAnode, nodeCathode)`:
- If `nodeAnode > 0`: allocate diagonal handle `_hAA = ctx.solver.allocElement(nodeAnode, nodeAnode)`. Else: skip (`_hAA = -1`).
- If `nodeCathode > 0`: allocate diagonal handle `_hCC = ctx.solver.allocElement(nodeCathode, nodeCathode)`. Else: skip.
- If both `nodeAnode > 0` AND `nodeCathode > 0`: allocate the two off-diagonal handles `_hAC = ctx.solver.allocElement(nodeAnode, nodeCathode)` and `_hCA = ctx.solver.allocElement(nodeCathode, nodeAnode)`. Else: skip both.
- Per BATCH1-D2 (Option C — guard only when shunt structurally possible): the cathode CAN be ground (current ButtonLED uses cathode=0), so guards are required.

PB-BEHAV-SEVENSEG and PB-BEHAV-BUTTONLED W3 tasks become parallel: both read the helper's `setup()` from this paragraph and CONFIRM it exists — neither writes it.

**Exception — `BehavioralGateElement.setup()` (W2.7)**:

`BehavioralGateElement` (in `src/solver/analog/behavioral-gate.ts`) is the shared class for all 7 gate types (NOT, AND, NAND, OR, NOR, XOR, XNOR). All 7 gate W3 tasks would otherwise compete to write the same `setup()` method on the same class, creating a parallel-write race. In W2 the method receives its REAL body (per 02-behavioral.md Shape rule 3 forward template) — not a throwing stub.

The real setup body for `BehavioralGateElement.setup(ctx)`:
- Iterate `for (const pin of this._inputs) pin.setup(ctx);` (per Shape rule 1 forwarding).
- Call `this._output.setup(ctx);` (per Shape rule 2 forwarding).
- Iterate `for (const child of this._childElements) child.setup(ctx);` (per Shape rule 3, capacitor children).
- No direct `ctx.solver.allocElement` calls — all stamping is delegated to the pin models and child elements.

The 7 gate W3 tasks (PB-BEHAV-NOT/AND/NAND/OR/NOR/XOR/XNOR) confirm the method exists; they do NOT write it.

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
3. **`_deviceMap` construction** — recursive walk of `compiled.elements`:

```ts
private _buildDeviceMap(elements: readonly AnalogElement[], prefix: string): void {
  for (const el of elements) {
    const fullLabel = prefix ? `${prefix}/${el.label}` : el.label;
    this._deviceMap.set(fullLabel, el);
    // Recurse into composites: sub-elements use namespaced labels.
    const subElements = (el as any)._subElements as readonly AnalogElement[] | undefined;
    if (subElements && subElements.length > 0) {
      this._buildDeviceMap(subElements, fullLabel);
    }
  }
}

// In init():
this._deviceMap = new Map<string, AnalogElement>();
this._buildDeviceMap(compiled.elements, "");
```

**Namespaced labels.** Subcircuit sub-element `innerLabel` inside `subcktLabel` is keyed as `subcktLabel/innerLabel`. Relay coil-IND sub-element with internal label `_coil` inside relay `R1` is keyed as `R1/_coil`. The `/` separator matches the project's existing addressing scheme (see CLAUDE.md "Addressing Scheme" — read format equals write format).

**ngspice anchor**: ngspice does not have a recursive device map — it has a flat hash table per circuit. Subcircuits in ngspice are flattened at parse time (each sub-instance gets its own top-level entry with the namespaced label baked in). digiTS preserves the composite tree at runtime, so `_deviceMap` recursion is the equivalent operation. The visible behaviour is identical to ngspice's flattened hash: `findDevice("R1/_coil")` returns the inductor instance.

**`findDevice(name: string)` semantics**: returns `this._deviceMap.get(name) ?? null`. Callers use the namespaced form. CCCS/CCVS/MUT inside a subcircuit referencing an internal element pass the namespaced name (the netlist generator emits the namespaced label per the existing addressing scheme).
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

private _findBranch(label: string, ctx: SetupContext): number {
  const el = this._deviceMap.get(label);
  if (!el) return 0;
  if (typeof (el as any).findBranchFor === "function") {
    return (el as any).findBranchFor(label, ctx);
  }
  return (el as any).branchIndex !== -1 ? (el as any).branchIndex : 0;
}
```

**`_findBranch(name: string)` dispatch**: looks up `name` directly in `this._deviceMap` (built recursively from `compiled.elements` per §A4.1). If the resolved element has a `findBranchFor?` method (defined on the element class, not the model), invokes it; otherwise checks the element's `branchIndex` field directly. ngspice anchor: `cktfbran.c:20-33` walks model types; digiTS uses the device map (already populated with namespaced labels per R7) for the same effect. The `_registeredMnaModels` field proposed in an earlier draft is NOT used.

**Engine state additions:**
- `_isSetup: boolean = false;`
- `_maxEqNum: number;` — initialised in `init()` to `compiled.nodeCount + 1`.
- `_numStates: number = 0;`
- `_nodeTable: Array<{ name: string; number: number; type: "voltage" | "current" }>;`
- `_deviceMap: Map<string, AnalogElement>;` — populated in `init()` from `compiled.elements`.

### A4.3 Driver entry calls

Add `this._setup();` at the top of every analysis driver, before any
solver work:

- `MNAEngine.dcOperatingPoint()` — immediately above the
  `solveDcOperatingPoint(this._ctx!)` call.
- `MNAEngine.step()` — immediately after the `if (!this._compiled) return;`
  guard.
- `MNAEngine.acAnalysis(params)` — first non-guard line.

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

**`CKTCircuitContext` field addition:**

```ts
/** Subset of compiled elements that implement isPoolBacked. Populated at construction. */
private readonly _poolBackedElements: readonly AnalogElement[];
```

**Constructor change**: `CKTCircuitContext.constructor(circuit, ...)` extracts pool-backed elements at construction:

```ts
this._poolBackedElements = circuit.elements.filter(isPoolBacked);
```

This list is read by `allocateStateBuffers(numStates)` to call `el.initState(statePool)` on each pool-backed element after the pool is constructed.

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

### A5.5 LoadContext — state0/state1 fields

`LoadContext` (the object passed to each element's `load()` and `accept()`) gains:

```ts
/** Current-iteration state vector (ngspice CKTstate0). Indexed by `_stateBase + SLOT_X` per element. */
state0: Float64Array;

/** Previous-iteration state vector (ngspice CKTstate1). Read for predictor / time-history. */
state1: Float64Array;
```

**State-vector access from load()/accept()**: ngspice elements access state via `*(ckt->CKTstate0 + here->slot_idx)`. digiTS mirrors this directly: load() and accept() bodies read/write `ctx.state0[this._stateBase + SLOT_X]` and `ctx.state1[this._stateBase + SLOT_X]`, where `this._stateBase` is the element's first state-pool offset (set during setup() via `ctx.allocStates(N)`). No `_pool` instance field on the element is needed — state is accessed through the LoadContext, identical to ngspice.

The existing `LoadContext.temp: number` (already at `load-context.ts:115`) provides circuit temperature for elements that need it (e.g., NTC, semiconductor temp dependence). Earlier spec assertions that `ctx.temp` was only on SetupContext were errors — `temp` has been on LoadContext since the original ngspice port.

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

### A6.4 Sub-element ordering rule

Composite elements (XFMR, TAPXFMR, RELAY, OPTO, OPAMP, COMPARATOR, REAL_OPAMP, TIMER555, NFET, PFET, FGNFET, FGPFET, ANALOG_SWITCH, SCR, TRIAC, DIAC, SEVENSEG, SEVENSEGHEX, SUBCKT, etc.) MUST call `setup()` on their sub-elements in NGSPICE_LOAD_ORDER ordinal sequence (ascending). The composite's `setup()` body is responsible for the ordering — sort its `_subElements` by `ngspiceLoadOrder` before iteration, OR construct sub-elements in load-order order.

Example (PB-OPAMP after this rule applies):

```ts
setup(ctx: SetupContext): void {
  // RES (NGSPICE_LOAD_ORDER.RES = 1) before VCVS (NGSPICE_LOAD_ORDER.VCVS = 47)
  this._res1.setup(ctx);
  this._vcvs1.setup(ctx);
}
```

Rationale: sub-element ordering affects the `_insertionOrder` sequence (per A1.5). Two composites with identical sub-element sets but different setup orders would produce different stamp-order test rows. Enforcing NGSPICE_LOAD_ORDER provides a deterministic, single right answer per composite.

ngspice anchor: ngspice does not have nested composites (subcircuits are flattened at parse time), so the load-order constraint applies at the top level only. digiTS preserves composites at runtime and applies the same rule recursively to maintain stamp-order determinism.

### A6.5 Subcircuit composite

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

### A6.6 — Ground-node guard policy in setup() bodies

`solver.allocElement(row, col)` does NOT silently skip ground (node 0). It allocates a real handle pointing at row/col, including row=0 or col=0 entries. If the calling element does not want a ground stamp, the setup() body must guard explicitly.

Rule (matches ngspice trasetup.c convention):

- **Series elements between two non-ground pins** (RES, CAP, IND, NTC, LDR, POT slot resistors, transformer windings, MOS bulk path) — NO guard. Both pin nodes are structurally non-ground in any valid circuit; allocating handles unconditionally is correct and minimum-noise.
- **Shunt elements with one pin potentially at ground** (MEMR, AFUSE, the incidence terms of CRYSTAL, any element where one terminal is structurally allowed to be node 0 in a valid circuit) — guard each allocElement call with `if (xNode !== 0)`. Document in the spec why the guard is needed for that specific element.
- **Composite sub-elements that may receive node 0 from the parent's pinNodeIds reassignment** (DAC's VCVS with out-=0; OPAMP rOut=0 case; SCR/TRIAC internal latch nodes) — sub-element setup() must apply its own guard, since the parent intentionally passes 0.

This is the canonical rule. Per-PB-* specs do NOT need to repeat the rule — they may simply declare which category their element falls into and follow the corresponding pattern.

### A6.7 Topology validation

`detectWeakNodes`, `detectVoltageSourceLoops`, `detectInductorLoops`,
`detectCompetingVoltageConstraints` (compiler.ts:459-616) run on the
post-Pass-A element list. After A6 they only see user-visible nodes.

`isBranch` flag: replaced by inspecting `el.branchIndex !== -1` directly on each `AnalogElementCore` instance (post-setup). Topology validators that previously did `branchCount > 0` now walk `compiled.elements` and check `el.branchIndex !== -1`, recursing into composites' `_subElements`. `typeHint` semantics unchanged.

### A6.8 `ConcreteCompiledAnalogCircuit`

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

**Verification (verifier-agent gated):** After W2 lands, the verifier agent runs `Grep "allocElement" src/components/` and confirms every match falls inside a `setup()` method body. Any match inside a `load()`, `accept()`, or other body is a violation. This is a verifier-gate, not an automated CI test — but it is a hard gate, not advisory.

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

**A9 test pattern for invoking `_setup()`**: `_setup()` is private on `MNAEngine` (production code never calls it directly — it runs unconditionally from each analysis driver). The A9 test uses TypeScript's escape hatch:

```ts
const engine = new MNAEngine(/* ... */);
engine.init(compiled);
(engine as any)._setup();   // private-method bypass, test-only
const order = (engine as any)._solver._getInsertionOrder();
expect(order).toEqual(EXPECTED_TSTALLOC_SEQUENCE);
```

Rationale: production callers never invoke `_setup()` directly (it's the engine's internal initialization step). Adding a public test-only entry point would pollute the API; the cast is contained and explicit.

---

Engine-wave exit criteria and per-wave gates live in `plan.md`.
