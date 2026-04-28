# Split-Setup-Load Cleanup — Architectural Plan

Post-W3.5 cleanup of the 557 TypeScript errors left by the split-setup-load
refactor. This document is the contract: any agent dispatched against it must
land its file at the architectural target described here, not at "tsc-green
with the smallest diff".

## 1 — Goal and non-goals

### Goal

A single, ngspice-aligned analog element architecture in which:

- There is **one** `AnalogElement` interface (no `Core` / non-`Core` split,
  no post-compile promotion).
- All factory functions take `(pinNodes, props, getTime?)` — three arguments,
  universal.
- All allocation (internal nodes, branch rows, state slots, TSTALLOC matrix
  entries) happens inside `setup(ctx: SetupContext)` per ngspice DEVsetup.
- `findBranchFor` lives on the **element**, not on the `ModelEntry`. Engine
  dispatches via `(el as any).findBranchFor(...)` (already implemented in
  `analog-engine.ts:1335`).
- Tests construct elements via the **production** factory and run **real**
  `setup()` against a **real** `SetupContext` — they do not bypass setup or
  use 4-arg manual stamper helpers.
- ngspice-style label-keyed pin access (`_pinNodes.get("pos")!`) replaces the
  positional array access (`pinNodeIds[0]`) that was a digiTS-era convenience.

### Non-goals

- Smallest diff back to tsc-green.
- Preserving the `pinNodeIds` / `allNodeIds` parallel arrays (they go).
- Preserving the `withNodeIds` test helper (it goes — 179 call sites get
  rewritten).
- Preserving the 4-arg `makeVoltageSource` test helper or the 4-arg call form
  of `makeDcVoltageSource` (gone — every test path uses the 2-arg production
  factory plus real setup).
- Preserving any "post-compile" type promotion. The compiler sorts elements,
  walks them in NGSPICE_LOAD_ORDER bucket order, and calls `setup()`. That is
  the entire compile-to-setup contract.

### Vocabulary discipline

This work falls under `CLAUDE.md` — "No Pragmatic Patches", "ngspice Parity
Vocabulary", "Test Policy During W3 Setup-Load-Split". Specifically:

- "tolerance", "close enough", "pragmatic", "minimal", "intentional
  divergence" are banned as closing verdicts.
- During this cleanup, agents do not run, fix, or report numerical mismatches.
  Verification is strictly spec compliance against this document and the cited
  ngspice anchors.

## 2 — Architectural target

### 2.1 — Why `pinNodeIds` and `allNodeIds` go

Audit of consumers (every read of `el.pinNodeIds` / `el.allNodeIds` outside
the producing files):

| Consumer | Site | Use | Replacement |
|---|---|---|---|
| Engine power calc | `analog-engine.ts:1110-1111` | iterate pin nodes in pinLayout order | `el._pinNodes.values()` (Map insertion order = pinLayout order) |
| NR convergence | `newton-raphson.ts:616` | `for (const ni of el.pinNodeIds)` | `for (const ni of el._pinNodes.values())` |
| Renderer | `viewer-controller.ts:463/808/852` | per-pin voltage lookup; already uses `as unknown as { pinNodeIds }` cast | typed `_pinNodes` access by label |
| 13 component `.ts` files | `this.pinNodeIds[i]` inside `load()` | positional pin access | `this._pinNodes.get("<label>")!` |

Producers (writes that simply go away):

| Producer | Site | Action |
|---|---|---|
| Compiler post-factory promotion | `compiler.ts:1216` (`allNodeIds`), `compiler.ts:1247` (`nodeIds`) | delete the assignments |
| Bridge adapter for digital-pin elements | `bridge-adapter.ts:78-79`, `bridge-adapter.ts:195-196` | replace with `_pinNodes` initialization in the constructor |
| `withNodeIds` test helper | `test-helpers.ts:64-73` | delete; tests use real factory + real `setup()` |

ngspice has no `pinNodeIds[]` / `allNodeIds[]` analogue. Devices declare named
struct fields (`BJTcollNode`, `BJTbasePrimeNode`, …). The label-keyed Map form
matches that shape; the positional array form was a digiTS convenience that
the split-setup-load refactor obsoleted.

### 2.2 — Type hierarchy after collapse

```
AnalogElement                       // the one element type. (Was AnalogElementCore.)
PoolBackedAnalogElement             // adds state-pool fields.
ReactiveAnalogElement               // adds isReactive: true to PoolBacked.
```

No `Core` suffixes. No intersection types named `AnalogElement = Core & Post`.
No `withNodeIds`. No `readonly branchIndex`. The compiler does **not**
transform an `AnalogElementCore` into an `AnalogElement`. It sorts the element
array, walks it in NGSPICE_LOAD_ORDER, and calls `el.setup(ctx)` on each. That
is the only post-construction step.

### 2.3 — `AnalogElement` interface (final)

```ts
// core/analog-types.ts (renamed from AnalogElementCore)
export interface AnalogElement {
  // Identity & metadata
  label: string;                              // factory inits "", compiler Object.assigns
  ngspiceLoadOrder: number;
  isNonlinear: boolean;
  isReactive: boolean;
  elementIndex?: number;

  // Topology — pin map is the single source of truth.
  // Insertion order matches pinLayout order, so the renderer / power calc /
  // NR loop iterate `_pinNodes.values()` to get pinLayout-ordered IDs.
  _pinNodes: Map<string, number>;

  // Mutable, set during setup(). -1 means "no branch row / no state slots".
  branchIndex: number;
  _stateBase: number;

  // Lifecycle (ngspice DEVsetup → DEVload → DEVaccept)
  setup(ctx: SetupContext): void;
  load(ctx: LoadContext): void;
  accept?(ctx: LoadContext, t: number, addBp: (t: number) => void): void;
  acceptStep?(t: number, addBp: (t: number) => void, atBp: boolean): void;
  checkConvergence?(ctx: LoadContext): boolean;
  getLteTimestep?(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: LteParams,
  ): number;
  stampAc?(solver: ComplexSparseSolver, omega: number, ctx: LoadContext): void;
  nextBreakpoint?(after: number): number | null;

  // Engine queries
  findBranchFor?(name: string, ctx: SetupContext): number;
  getPinCurrents(rhs: Float64Array): number[]; // returned in _pinNodes insertion order
  setParam(key: string, value: number): void;

  // Optional diagnostic introspection (D9). Returns labels for internal nodes
  // allocated during this element's setup(), in allocation order. Harness
  // consumers call this post-setup to label diagnostic nodes (e.g. `Q1:B'`).
  getInternalNodeLabels?(): readonly string[];
}

export interface PoolBackedAnalogElement extends AnalogElement {
  readonly poolBacked: true;
  readonly stateSize: number;
  readonly stateSchema: StateSchema;
  initState(pool: StatePoolRef): void;
}

export interface ReactiveAnalogElement extends PoolBackedAnalogElement {
  readonly isReactive: true;
}
```

`stateBaseOffset` (currently a duplicate of `_stateBase` on
`PoolBackedAnalogElementCore`) is removed; `_stateBase` is the single field.
467 in-file references update to read `_stateBase`. (Sub-deliverable inside
D5.)

### 2.4 — Factory contract

```ts
// core/registry.ts
export type AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElement;
```

Three arguments. Universal. No `internalNodeIds[]` parameter. No `branchIdx`
parameter. Internal nodes / branch rows / state slots / TSTALLOC handles are
all allocated inside `setup(ctx)`.

Reference factories (canonical examples — every other factory must follow one
of these patterns):

- Function literal pattern: `dc-voltage-source.ts:158-216`. Closure-local
  `let _h... = -1;` for TSTALLOC handles. Returned object literal carries
  `_pinNodes`, `_stateBase: -1`, `branchIndex: -1`, `label: ""`,
  `ngspiceLoadOrder`, flags, methods. `setup()` allocates branch via
  `ctx.makeCur(...)` and TSTALLOC entries via `ctx.solver.allocElement(...)`.
- Class pattern: `capacitor.ts:164+` (`AnalogCapacitorElement`). Class
  fields hold the same data; `setup()` allocates state slots via
  `ctx.allocStates(N)`, schema-keyed reads via `_pool.state0[_stateBase + SLOT]`.

### 2.5 — `SetupContext` contract (no change to shape; documenting target use)

```ts
// solver/analog/setup-context.ts (already in target shape)
export interface SetupContext {
  readonly solver: SparseSolver;
  readonly temp: number;        // ckt->CKTtemp
  readonly nomTemp: number;     // ckt->CKTnomTemp
  readonly copyNodesets: boolean;

  makeVolt(deviceLabel: string, suffix: string): number;
  makeCur(deviceLabel: string, suffix: string): number;
  allocStates(slotCount: number): number;

  findBranch(sourceLabel: string): number; // engine routes to element.findBranchFor
  findDevice(deviceLabel: string): AnalogElement | null;
}
```

After D1 lands, `findDevice` returns the unified `AnalogElement`
(branchIndex mutable), so the TS2540 readonly-assign errors at
`ac-voltage-source.ts:949` / `dc-voltage-source.ts:261` /
`variable-rail.ts:267` are mooted — though those sites also relocate per D4.

### 2.6 — Test infrastructure contract

```ts
// solver/analog/__tests__/test-helpers.ts (post-D11)
export function makeTestSetupContext(opts: {
  solver: SparseSolver;
  startBranch?: number;   // first branch row id; defaults to nodeCount + 1
  startNode?: number;     // first internal node id; defaults to nodeCount + 1
  temp?: number;          // default 300.15
  nomTemp?: number;       // default 300.15
  copyNodesets?: boolean; // default false
  elements?: AnalogElement[]; // for findDevice/findBranch dispatch
}): SetupContext;

export function setupAll(
  elements: AnalogElement[],
  ctx: SetupContext,
): void; // sorts by ngspiceLoadOrder, calls setup() in bucket order
```

`makeTestSetupContext` is the **only** way tests obtain a `SetupContext`.
It is a real implementation: `makeCur` / `makeVolt` return monotonically
increasing IDs starting from the seeds; `allocStates` advances a counter and
returns the previous value; `findBranch` walks the elements list and
dispatches to each element's `findBranchFor` exactly as
`analog-engine._findBranch` does at `analog-engine.ts:1332-1339`.

`setupAll` is the test mirror of `analog-engine._setup` (`analog-engine.ts:1290-1302`),
minus the post-setup state-pool sizing (which tests handle separately when
they need it).

A test that wants element `V1` to receive branch row 3 calls:

```ts
const solver = new SparseSolver();
solver.beginAssembly(matrixSize);
const ctx = makeTestSetupContext({ solver, startBranch: 3 });
const v = makeDcVoltageSource(new Map([["pos", 1], ["neg", 0]]), 5);
v.label = "V1";
setupAll([v], ctx);     // v.branchIndex === 3 after this returns
// ... build LoadContext, call v.load(loadCtx), assert.
```

There is no opt-out path. Tests that need to inject element-private state for
an assertion do so by reaching into element fields **after** `setupAll`, not
by skipping `setupAll`.

## 3 — Reference patterns (canonical, do-not-deviate)

### 3.1 — Inline factory (function literal)

Source of truth: `dc-voltage-source.ts:158-216` (post-D4 fix).

```ts
export function makeDcVoltageSource(
  pinNodes: ReadonlyMap<string, number>,
  voltage: number,
): AnalogElement {
  const p: Record<string, number> = { voltage };

  // TSTALLOC handles — closure-local, NOT object fields.
  let _hPosBr = -1;
  let _hNegBr = -1;
  let _hBrNeg = -1;
  let _hBrPos = -1;

  const el: AnalogElement = {
    label: "",                                    // compiler Object.assigns instance label
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
    isNonlinear: false,
    isReactive: false,

    _pinNodes: new Map(pinNodes),
    _stateBase: -1,
    branchIndex: -1,

    setup(ctx: SetupContext): void {
      const posNode = el._pinNodes.get("pos")!;
      const negNode = el._pinNodes.get("neg")!;

      // vsrcset.c:40-43 — idempotent branch alloc.
      if (el.branchIndex === -1) {
        el.branchIndex = ctx.makeCur(el.label, "branch");
      }
      const k = el.branchIndex;

      // vsrcset.c:52-55 — TSTALLOC sequence (line-for-line).
      _hPosBr = ctx.solver.allocElement(posNode, k);
      _hNegBr = ctx.solver.allocElement(negNode, k);
      _hBrNeg = ctx.solver.allocElement(k, negNode);
      _hBrPos = ctx.solver.allocElement(k, posNode);
    },

    findBranchFor(_name: string, ctx: SetupContext): number {
      // Lazy-allocate own branch on demand from a controlling source's setup().
      // Pattern from setup-stamp-order.test.ts:303-306.
      if (el.branchIndex === -1) {
        el.branchIndex = ctx.makeCur(el.label, "branch");
      }
      return el.branchIndex;
    },

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      solver.stampElement(_hPosBr, +1.0);
      solver.stampElement(_hNegBr, -1.0);
      solver.stampElement(_hBrPos, +1.0);
      solver.stampElement(_hBrNeg, -1.0);
      ctx.rhs[el.branchIndex] += p.voltage * ctx.srcFact;
    },

    getPinCurrents(rhs: Float64Array): number[] {
      const I = rhs[el.branchIndex];
      return [-I, I];   // pinLayout order: ["neg", "pos"]
    },
  };

  return el;
}
```

**Key invariants** (every analog factory must satisfy):

1. The literal declares **every** `AnalogElement` field — `label`,
   `_pinNodes`, `_stateBase`, `branchIndex`, `ngspiceLoadOrder`, both
   `isNonlinear` / `isReactive`, plus the methods.
2. TSTALLOC handles are **closure-local** `let _h... = -1` declarations —
   never object fields. (Object fields force the literal type to widen, which
   triggers the TS2353 / TS2339 cluster we are fixing.)
3. `setup()` is **idempotent** — entering with `branchIndex !== -1` skips the
   allocation. This is what allows `findBranchFor` to lazy-allocate before
   `setup()` runs and `setup()` to skip re-allocating afterward.
4. `findBranchFor` (when present) is symmetric to `setup()`'s branch-alloc
   block — same idempotent makeCur, same return value.

### 3.2 — Class-implementing factory

Source of truth: `capacitor.ts:164` and downstream (`AnalogCapacitorElement`).

```ts
class AnalogCapacitorElement implements ReactiveAnalogElement {
  label: string = "";
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CAP;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = CAPACITOR_SCHEMA;
  readonly stateSize = CAPACITOR_SCHEMA.size;

  _pinNodes: Map<string, number>;
  _stateBase: number = -1;
  branchIndex: number = -1;

  // ... params, handles ...
  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, /* params */) {
    this._pinNodes = new Map(pinNodes);
    // ...
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const p = this._pinNodes.get("pos")!;
    const n = this._pinNodes.get("neg")!;
    this._hPP = ctx.solver.allocElement(p, p);
    this._hNN = ctx.solver.allocElement(n, n);
    this._hPN = ctx.solver.allocElement(p, n);
    this._hNP = ctx.solver.allocElement(n, p);
  }

  // load(), accept(), getLteTimestep(), checkConvergence(), getPinCurrents(),
  // setParam(), initState() — ngspice port bodies, no architectural surprises.
}
```

**Class-pattern invariants**:

- Constructor takes `(pinNodes, ...elementParams)`. Initializes
  `_pinNodes: new Map(pinNodes)`. Does **not** allocate state slots, branches,
  internal nodes, or TSTALLOC handles.
- `setup()` does all the allocation, exactly as the function-literal pattern.
- TSTALLOC handles are **private class fields** (this is the only place the
  class pattern diverges from the closure pattern; the data still lives with
  the instance, not on the public type).

## 4 — Per-deliverable details

Each deliverable lists every TS error site it resolves, plus the concrete
edit. Line numbers reference the current state of the repository at the audit
checkpoint (`tsc-errors.log` produced 2026-04-28).

### D1 — Type collapse

**Files**: `core/analog-types.ts`, `solver/analog/element.ts`.

#### Step 1 — `core/analog-types.ts`

- Rename `AnalogElementCore` → `AnalogElement` everywhere in this file.
- Drop the documentation paragraph about "set by the compiler from resolved
  pins — never by factory functions" — that contract is gone.
- Move `PoolBackedAnalogElementCore` and `ReactiveAnalogElementCore` here from
  `solver/analog/element.ts`. Rename to drop `Core`. Re-define as extensions
  of the unified `AnalogElement`.
- Add `getInternalNodeLabels?(): readonly string[]` to `AnalogElement` per D9.
- Keep `_stateBase` as a single field; remove `stateBaseOffset` from
  `PoolBackedAnalogElement` (downstream files in D5 also rename their
  occurrences — 467 file references).
- Export the three interfaces: `AnalogElement`, `PoolBackedAnalogElement`,
  `ReactiveAnalogElement`.

#### Step 2 — `solver/analog/element.ts`

- Delete the standalone `AnalogElement` interface (lines ~42-225).
- Delete `PoolBackedAnalogElementCore`, `ReactiveAnalogElementCore`,
  `PoolBackedAnalogElement`, `ReactiveAnalogElement` types (lines ~232-261).
- Delete the `isPoolBacked` overloads (lines 263-264). Keep one signature:
  `export function isPoolBacked(el: AnalogElement): el is PoolBackedAnalogElement;`
- Re-export from `core/analog-types.js`:
  `export type { AnalogElement, PoolBackedAnalogElement, ReactiveAnalogElement } from "../../core/analog-types.js";`

**Resolves**: TS2394 at `element.ts:263`, indirectly the entire TS2420 / TS2739
cluster across class files (once the unified shape lands, classes that already
declare `_pinNodes` / `_stateBase` / `setup` satisfy the interface).

### D2 — Engine and compiler rebase off `pinNodeIds` / `allNodeIds`

**Files**: `solver/analog/analog-engine.ts`, `solver/analog/compiler.ts`,
`solver/analog/newton-raphson.ts`, `solver/analog/bridge-adapter.ts`,
`core/analog-engine-interface.ts`.

#### `analog-engine.ts`

- `1110-1111` — power calc rewrite:
  ```ts
  let pinIdx = 0;
  for (const nodeId of el._pinNodes.values()) {
    if (pinIdx >= currents.length) break;
    power += this.getNodeVoltage(nodeId) * currents[pinIdx++];
  }
  ```
- `1294` — `el.setup(setupCtx)` — works after D1.
- `1309-1311` — fields exist after the `ResolvedSimulationParams` extension
  below.

#### `core/analog-engine-interface.ts` — `ResolvedSimulationParams` extension

Add:
```ts
temperature?: number;   // CKTtemp (Kelvin), default 300.15
nomTemp?: number;       // CKTnomTemp (Kelvin), default 300.15
copyNodesets?: boolean; // CKTcopyNodesets, default false
```

Plus the corresponding entries in `DEFAULT_SIMULATION_PARAMS`.

#### `compiler.ts`

- `41` — drop the `isPoolBacked` import (TS6133).
- `1216` — delete the `allNodeIds: [...pinNodeIds]` write.
- `1247` — delete the `nodeIds: [...pinNodeIds]` write.
- `191-340` — full rewrite of `compileSubcircuitToMnaModel`. Target shape:
  ```ts
  function compileSubcircuitToMnaModel(...): MnaModel {
    return {
      factory(
        pinNodes: ReadonlyMap<string, number>,
        props: PropertyBag,
        getTime: () => number,
      ): AnalogElement {
        // 1. Build subElements via leaf factories with their own pinNode maps
        //    (the netlist remap logic from the current implementation moves
        //    here, but no internalNodeIds parameter — internal nodes get
        //    allocated by the leaf elements' setup()).
        // 2. Composite factory returns an AnalogElement whose setup() walks
        //    subElements and calls setup(ctx) on each in the order required
        //    by NGSPICE_LOAD_ORDER (the leaf order is fixed at compile time
        //    and must be preserved).
        // 3. Composite branchIndex = subElements[0].branchIndex if any
        //    sub-element owns a branch row; else -1.
        // 4. _pinNodes mirrors the outer-pin map; _stateBase aggregates
        //    sub-element state via ctx.allocStates(totalStates).
      },
      // ... paramDefs, params, etc.
    };
  }
  ```
- The current `branchCount` parameter becomes derivable from sub-element
  `setup()` calls; remove the eager pre-summation at `compiler.ts:196-199`.

#### `newton-raphson.ts:616`

- Replace `for (const ni of el.pinNodeIds)` with
  `for (const ni of el._pinNodes.values())`.

#### `bridge-adapter.ts`

- `78-79` and `195-196` — replace
  ```ts
  this.pinNodeIds = [pinModel.nodeId];
  this.allNodeIds = [pinModel.nodeId];
  ```
  with
  ```ts
  this._pinNodes = new Map([[pinModel.label, pinModel.nodeId]]);
  ```
  (or whatever the actual pin label is on the wrapped digital pin model).
- The class is a `PoolBackedAnalogElement` adapter; ensure it implements the
  unified interface fully (label, setup, _stateBase, branchIndex,
  ngspiceLoadOrder, etc.).

**Resolves**: TS2339 at `analog-engine.ts:1294/1309/1310/1311`, the `compiler.ts`
factory-shape errors at 202/297/316, the `newton-raphson.ts` post-D1 typing
fall-out, and the `bridge-adapter.ts` shape errors.

### D3 — Render-side and component-side `pinNodeIds` consumers

**Files**: `app/viewer-controller.ts` (3 sites), 13 component `.ts` files.

#### `viewer-controller.ts`

- `463` — replace `(analogEl as unknown as { pinNodeIds: number[] }).pinNodeIds ?? []`
  with `[...(analogEl._pinNodes?.values() ?? [])]` (or — better — refactor the
  caller to take the `_pinNodes` Map directly so we don't need an array copy).
- `808` and `852` — `resolverCtx.elements[i].pinNodeIds ?? []`. Same swap.
  `ResolverCtx.elements[]` is typed `AnalogElement[]` after D1; `pinNodeIds`
  is gone, so this becomes a typed Map access.

#### Per-component refactor (positional → label-keyed pin access)

Each file: replace every `this.pinNodeIds[<i>]` with the matching label lookup.
Look up the element's pin layout in the corresponding component's
`buildXxxPinDeclarations()` to learn the label-to-index mapping.

| File | Sites | Mapping |
|---|---|---|
| `tapped-transformer.ts` | use `_pinNodes.get("p1"/"p2"/"s1"/"s2"/"tap")!` | per `buildTappedTransformerPinDeclarations` |
| `transmission-line.ts` | per pinLayout | per `buildTransmissionLinePinDeclarations` |
| `transformer.ts` | 4 pins (`p1/p2/s1/s2`) | per `buildTransformerPinDeclarations` |
| `polarized-cap.ts` | 3 pins (`pos/neg/case`) | per `buildPolarizedCapPinDeclarations` |
| `capacitor.ts` | 2 pins (`pos/neg`) | already uses `_pinNodes` in some sites; finish the migration |
| `crystal.ts` | 2 pins | per layout |
| `potentiometer.ts` | 3 pins (`a/b/wiper`) | per layout |
| `analog-fuse.ts` | 2 pins | per layout |
| `spark-gap.ts` | 2 pins | per layout |
| `ntc-thermistor.ts` | 2 pins | per layout |
| `ldr.ts` | 2 pins | per layout |
| `digital-pin-model.ts` | depends on ctor | per pin |
| `probe.ts` | 1 pin (`in`) | per layout |

**Resolves**: ~30 TS errors across the listed files plus all
`viewer-controller.ts` sites.

### D4 — Sources / passives: `findBranchFor` relocation

**Files**: `ac-voltage-source.ts`, `dc-voltage-source.ts`, `variable-rail.ts`,
`ccvs.ts`, `vcvs.ts`, `crystal.ts`, `inductor.ts`, `tapped-transformer.ts`.

#### Pattern (per file)

1. Locate the `modelRegistry["<name>"]` `ModelEntry` literal that currently
   contains `findBranchFor`.
2. Cut the `findBranchFor` body.
3. Inside the factory function called by that ModelEntry's `factory:` field,
   add the relocated `findBranchFor` to the returned `AnalogElement` literal /
   class. Use the canonical pattern from §3.1:
   ```ts
   findBranchFor(_name: string, ctx: SetupContext): number {
     if (el.branchIndex === -1) {
       el.branchIndex = ctx.makeCur(el.label, "branch");
     }
     return el.branchIndex;
   },
   ```
4. Drop `ctx.findDevice(name)` from the body — the engine already resolved
   `el = findDevice(label)` at `analog-engine.ts:1333` before dispatching
   here. The element's `findBranchFor` only handles its own branch.
5. Verify the factory's `setup()` is **idempotent** on `branchIndex`
   allocation (so a `findBranchFor` call **before** `setup()` does not cause
   double-allocation when `setup()` runs later).

#### Per-file specifics

| File | Excess-property site | Readonly-write site | Notes |
|---|---|---|---|
| `ac-voltage-source.ts` | 944 | 949 | factory at `createAcVoltageSourceElement`; class-based with branchIndex setter |
| `dc-voltage-source.ts` | 257 | 261 | factory `makeDcVoltageSource`; canonical pattern after fix |
| `variable-rail.ts` | 260 | 267 | factory `createVariableRailElement` plus 185 `getString` default |
| `ccvs.ts` | 403 | — | factory return is the `CCVSAnalogElement` class instance per `controlled-source-base.ts` |
| `vcvs.ts` | 362 | — | same — factory returns `VCVSAnalogElement` class |
| `crystal.ts` | 759 | — | also see D5 (class shape fixes for `AnalogCrystalElement`) |
| `inductor.ts` | 494 | — | factory `createInductorElement` returns `AnalogInductorElement` |
| `tapped-transformer.ts` | 497 | — | placement is on `ComponentDefinition` not `ModelEntry` — even more wrong; relocate into the actual factory |

`variable-rail.ts:185` — the `props.getString(...)` returns `string | undefined`.
Provide an explicit default at the call site (e.g.
`props.getString("waveformLabel") ?? ""`) — there is no architectural
restructure needed for that one.

**Resolves**: TS2353 at the 7 ModelEntry sites + the 1 ComponentDefinition
site, TS2540 at 3 sites, TS2345 at `variable-rail.ts:185`.

### D5 — Class-implementing elements

**Files**: `behavioral-gate.ts`, `controlled-source-base.ts`, `probe.ts`,
`ground.ts`, `triode.ts`, `mutual-inductor.ts`, `crystal.ts`,
`switching/relay.ts`.

Per file (where applicable):

#### `controlled-source-base.ts:88` — `ControlledSourceElement`

This class is the base for VCVS / CCVS / VCCS / CCCS. It must satisfy the
unified `AnalogElement` interface so subclasses inherit a complete shape.
Concrete edits:

- Drop `pinNodeIds!`, `allNodeIds!` declarations (lines 89-90).
- Add `label: string = "";`.
- Add `_pinNodes: Map<string, number> = new Map();`.
- Add `_stateBase: number = -1;`.
- Change `abstract readonly branchIndex: number;` → `branchIndex: number = -1;`
  (mutable; subclass setters/getters become plain assignments).
- Add `abstract setup(ctx: SetupContext): void;` (each subclass implements
  its own TSTALLOC sequence per the matching ngspice setup file).
- Update `_bindContext` and helpers that previously read `this.pinNodeIds[i]`
  to read `this._pinNodes.get("<label>")!`.

This single base-class fix cascades to VCVS / CCVS / VCCS / CCCS subclasses
(`vcvs.ts`, `ccvs.ts`, `vccs.ts`, `cccs.ts`).

#### `behavioral-gate.ts:70-103` — `BehavioralGateElement`

- Drop `pinNodeIds!: readonly number[]` (line 80).
- Add `_pinNodes: Map<string, number>` (initialized in constructor from
  arg).
- Replace `readonly branchIndex: number = -1;` with `branchIndex: number = -1;`.
- Replace `stateBaseOffset = -1;` with `_stateBase: number = -1;` (and
  rename every read site, ~3 in this file plus children).
- Constructor signature gains a `pinNodes: ReadonlyMap<string, number>`
  parameter; the existing 4-arg constructor becomes 5-arg.
- Update the factory in `solver/analog/compiler.ts` (or wherever
  `BehavioralGateElement` is constructed) to pass `pinNodes`.

#### `probe.ts:217-281`

- `class AnalogProbeElement` becomes a full `AnalogElement` with `_pinNodes`,
  `_stateBase`, `branchIndex`, `label`, `setup()`.
- The exported factory drops the 5-arg shape (line 281) for the canonical
  3-arg shape.

#### `ground.ts:107-135`

- `createGroundAnalogElement` factory currently has the legacy 4-arg
  signature `(pinNodes, _internalNodeIds, _branchIdx, _props)`. Convert to
  3-arg `(pinNodes, _props, _getTime?)`.
- Returned object adds `label: ""`, `_pinNodes: new Map(pinNodes)`,
  `_stateBase: -1`, `setup(_ctx) {}` (ground stamps nothing — empty setup).
- Drop `import type { SetupContext }` if it stays unused after the change
  (line 30 currently is TS6133).

#### `triode.ts:141-501` — `TriodeElement` class

- `144` — drop `Readonly` from `_pinNodes: ReadonlyMap<string, number>`. The
  interface declares `Map<string, number>`; the field must be mutable to
  satisfy assignability.
- `351` — class instance must be a full `AnalogElement` (gets all unified
  fields).
- `501` — exported factory drops 3-arg legacy signature (currently
  `(pinNodes, props, _ngspiceNodeMap?)`) — must include `getTime` parameter
  even if unused.

#### `mutual-inductor.ts:17, 243`

- `17` — change import from `core/analog-types.js` to import
  `PoolBackedAnalogElement` (post-D1 rename).
- `243` — class implements the unified `PoolBackedAnalogElement`. Add the
  required fields (`label`, `_pinNodes`, `_stateBase`, `setup`).

#### `crystal.ts:246-762` — `AnalogCrystalElement`

- Make the class implement `ReactiveAnalogElement` (unified shape).
- Fields: `label: string = ""`, `_pinNodes: Map<string, number>`,
  `_stateBase: number = -1`, `branchIndex: number = -1`.
- `setup()` allocates state slots, branch row (if needed for the resonator
  series-LC representation), and TSTALLOC handles.
- `364`, `641`, `762` casts disappear once the class shape is correct.
- `759` `findBranchFor` move per D4.

#### `switching/relay.ts:63` — `RelayInductorSubElement`

- The class extends `AnalogInductorElement`. After D4 fixes
  `AnalogInductorElement` to the unified shape, this subclass must:
  - Override `setup()` (or rely on `super.setup()` if the relay coil has the
    same TSTALLOC pattern as a plain inductor).
  - Not redeclare `_pinNodes` / `_stateBase` / `branchIndex` (inherits from
    base).
  - Read inherited fields, not re-declare them with conflicting types.

**Resolves**: TS2420 / TS2415 / TS2416 / TS2739 / TS2741 / TS2322 cluster
across these files (~80 errors).

### D6 — Composite / active elements

**Files**: `opamp.ts`, `ota.ts`, `dac.ts`, `timer-555.ts`, `real-opamp.ts`.

#### `ota.ts:170-234` — `_h*` field migration to closure

The current factory declares TSTALLOC handles as **object fields** on the
returned literal:
```ts
return {
  ...
  _hPCP: -1 as number,
  _hPCN: -1 as number,
  _hNCP: -1 as number,
  _hNCN: -1 as number,
  setup(ctx) { this._hPCP = ctx.solver.allocElement(...); ... },
  load(ctx) { solver.stampElement(this._hPCP, ...); ... },
};
```

This trips TS2353 at 182 and TS2339 at 190-229 because the inferred return
type is `AnalogElement` (which has no `_hPCP`).

Refactor to closure-local pattern (matches `dc-voltage-source.ts:163-166`):
```ts
let _hPCP = -1, _hPCN = -1, _hNCP = -1, _hNCN = -1;
const el: AnalogElement = {
  ...
  setup(ctx) {
    if (nOutP > 0 && nVp > 0) _hPCP = ctx.solver.allocElement(nOutP, nVp);
    // ...
  },
  load(ctx) {
    if (_hPCP >= 0) ctx.solver.stampElement(_hPCP, -gmEff);
    // ...
  },
};
```

Same change applied wherever a factory uses `this._h*` for handle storage on
the returned literal.

#### `dac.ts:43`, `opamp.ts:185/187`, `real-opamp.ts:409`, `timer-555.ts:409-410`

These are TS6133 unused-binding errors. Routed through D8 (audit against
ngspice) — do **not** auto-delete. Expected outcome of audit:

- `dac.ts:43` `stampRHS` import: DAC stamps current sources, not voltage RHS.
  Likely safe to delete after confirming.
- `opamp.ts:185, 187` (`hVcvsNegIbr`, `hVcvsIbrNeg`): if our VCVS sub-element
  stamps `(neg, branch)` and `(branch, neg)` per `vcvssetup.c`, these handles
  must be **used** in `load()` — current TS6133 means we are missing those
  stamp calls. This is a latent stamp gap, not dead code.
- `timer-555.ts:409-410` (`_hComp1OutComp1Out`, `_hComp2OutComp2Out`):
  comparator output diagonal stamps. Audit against the comparator
  sub-element's expected TSTALLOC list; latent gap is the likely outcome.
- `real-opamp.ts:409` `stampCond`: same — function intended to be called
  somewhere; find the expected call site.

### D7 — Semiconductor `label` access

**Files**: `bjt.ts`, `diac.ts`, `diode.ts`, `mosfet.ts`, `zener.ts`,
`fgnfet.ts`, `fgpfet.ts`.

Current pattern (e.g. `bjt.ts:1222-1224`):
```ts
return {
  branchIndex: -1,
  _stateBase: -1,
  _pinNodes: new Map(pinNodes),
  ngspiceLoadOrder: NGSPICE_LOAD_ORDER.BJT,
  // ... no `label` field ...
  setup(ctx) {
    // TS2339: 'label' does not exist on inferred type
    nodeC_int = (model.RC === 0) ? colNode : ctx.makeVolt(this.label ?? "bjt", "collector");
  },
};
```

The literal does not declare `label`. The contextual return type post-D1 will
include `label`, so once D1 lands the inferred type at `this` should pick it
up. **However**, when the literal is ascribed via a wider type than the
declared interface (or through `Object.assign` later), the inference still
doesn't include `label` unless we initialize it.

Fix: initialize `label: ""` in the returned literal of every factory in
these files. Compiler `Object.assign`s the instance label later. After this
edit, `this.label ?? "bjt"` resolves cleanly.

Files / sites (line numbers from `tsc-errors.log`):

| File | Sites |
|---|---|
| `bjt.ts` | 1222, 1223, 1224 |
| `diac.ts` | 68, 69 |
| `diode.ts` | 567 |
| `mosfet.ts` | 874, 880 |
| `zener.ts` | 262 |
| `fgnfet.ts` | 980 |
| `fgpfet.ts` | 927 |

`bjt.ts:626` — `TS2367: This comparison appears to be unintentional` between
`number` and `string`. Read the context, fix the comparison's left or right
side to align types. (Likely a `props.getModelParam<number>(...)` where the
return type is wider than expected.)

`bjt.ts:34` — `stampG` import unused; route through D8 (likely a missing
stamp call).

### D8 — TS6133 audit cluster (NOT auto-deletes)

For every TS6133 (unused binding) on a TSTALLOC handle, state-pool slot
constant, or model parameter, walk the matching ngspice setup / load file
before deleting. The handles in question are:

| digiTS site | digiTS handle / binding | ngspice anchor (TSTALLOC line) | Stamp expected? |
|---|---|---|---|
| `bjt.ts:559-569` | `_hCPC`, `_hBPB`, `_hEPE`, `_hSubstConSubstCon`, `_substConNode` | `bjtsetup.c:435-464`, `bjtload.c` stamps | **likely yes** — these are diagonal entries that ngspice always stamps |
| `polarized-cap.ts:282-283` | `_hDIO_PP_clamp`, `_hDIO_NN_clamp`, `_hDIO_PN_clamp`, `_hDIO_NP_clamp` | `dioload.c` clamp branch | **likely yes** — diode reverse-clamp stamps |
| `opamp.ts:185, 187` | `hVcvsNegIbr`, `hVcvsIbrNeg` | `vcvssetup.c:39-43` (entries 2 and 3 of 4) | **likely yes** — without these the VCVS branch incidence is asymmetric |
| `real-opamp.ts:409` | `stampCond` (function) | n/a | check who should be calling it |
| `timer-555.ts:409-410` | `_hComp1OutComp1Out`, `_hComp2OutComp2Out` | comparator's expected TSTALLOC list | **likely yes** — comparator output diagonals |
| `dac.ts:43` | `stampRHS` import | n/a | likely truly unused (DAC uses current sources) |
| `pjfet.ts:255-256` | `nodeD`, `nodeS` | `jfetload.c` | **likely yes** — drain/source nodes are read every load() |
| `fgnfet.ts:91, 93` / `fgpfet.ts:90, 92` | `MOS_SLOT_CQBD`, `MOS_SLOT_CQBS` | `mos1load.c` body-charge slots | **likely yes** — body-drain / body-source charge state |
| `fgnfet.ts:544` / `fgpfet.ts:546` | `OxideCap` | `mos1setup.c` | check whether oxide capacitance computation is wired into the floating-gate model |
| `fgnfet.ts:778` | "All variables are unused" | n/a | block likely needs deleting wholesale or fully wired |
| `tapped-transformer.ts:50` | `cktTerr` import | n/a | check whether LTE is supposed to be wired |
| `tapped-transformer.ts:80-82` | `SLOT_PHI1`, `SLOT_PHI2`, `SLOT_PHI3` | mutual-inductance state schema | **likely yes** — flux state slots per winding |
| `tapped-transformer.ts:240` | `_pool` | n/a | unused param — verify whether load() should use it for state-pool reads |
| `tapped-transformer.ts:343` | `getString` on `PropertyBag` (TS2339) | n/a | API rename: `getString` no longer exists; switch to whatever is current |
| `transformer.ts:355` | `lSecondary` | n/a | local computed but never used; check whether the secondary-inductance value should feed the `_pair` / `_l2` instances |
| `transformer.ts:294-295` | `new InductorSubElement(p1, p2, label)` (3-arg) — but currently called with 4 (TS2554) | n/a | **API mismatch**: re-read the new `InductorSubElement` ctor and pass the right args; if the constructor changed shape, update transformer accordingly |
| `transformer.ts:502-505` | `_l1.hIbrIbr`, `_mut.hBr1Br2`, `_mut.hBr2Br1`, `_l2.hIbrIbr` (TS2339) | n/a | the `InductorSubElement` and `MutualInductorElement` private fields were renamed or dropped — find the new exposed handles or expose them via a method |
| `bjt.ts:34` | `stampG` import | check call sites | likely an indication of a missing stamp wrapper invocation |
| `switch.ts:320` | `_pendingCtrlVoltage` | n/a | check whether the switch's hysteresis logic should retain it |

**Authority** (resolved): agents **do not** fold latent stamps in. Each
suspected gap is **collected and escalated** as a finding. The D8 deliverable
is a written audit report listing every audited handle, its digiTS site, the
ngspice anchor, and a verdict (`dead` / `latent stamp gap` / `inconclusive`).
Stamp folding happens only after the user reviews the report and authorizes
the fold per item.

### D9 — `internalNodeLabels` migration

3 readers today: `bridge-adapter.ts`, `harness/capture.ts`, `element.ts` (the
declaration). The harness uses them for diagnostic node labels (`Q1:B'` etc.).

**Mechanism** (resolved): option (a) — method on element.

Concrete change:

- `AnalogElement` declares
  `getInternalNodeLabels?(): readonly string[]` (D1 already includes it).
- Each element that calls `ctx.makeVolt(label, suffix)` during `setup()`
  records the suffix it passed (e.g. into a closure-local
  `const internalLabels: string[] = []` array). After setup, the optional
  method returns those suffixes in allocation order.
- Reader migration:
  - `bridge-adapter.ts` — switch from `el.internalNodeLabels` to
    `el.getInternalNodeLabels?.() ?? []`.
  - `harness/capture.ts` — same.
  - `element.ts` — drop the legacy `internalNodeLabels?: readonly string[]`
    field declaration (already absent in the unified `AnalogElement`).
- Each element that allocates internal nodes (BJT, MOS, JFET, DIO with non-
  zero RS, TLINE, BehavioralGate, subcircuit composites, …) gains a small
  internal-labels array populated alongside the corresponding `makeVolt`
  call. Existing per-suffix strings (`"collector"`, `"base"`, etc. — see
  `bjt.ts:1222-1224`) carry through unchanged; we just remember them.

### D10 — *(removed)*

LED `color` non-numeric param hoist landed in parallel work. No action here.

### D11 — Test-helpers rewrite

**File**: `solver/analog/__tests__/test-helpers.ts`.

#### Deletions

- `withNodeIds` (lines ~64-73). 179 call sites across 27 test files.
- `makeVoltageSource` (lines 173-…). The 4-arg manual stamper.
- Any other helper that builds `AnalogElement` from positional pin-node
  arguments without going through the production factory.

#### Additions

- `makeTestSetupContext(opts: TestSetupOpts): SetupContext` per §2.6.
  Reference implementation:
  ```ts
  export function makeTestSetupContext(opts: {
    solver: SparseSolver;
    startBranch?: number;
    startNode?: number;
    temp?: number;
    nomTemp?: number;
    copyNodesets?: boolean;
    elements?: AnalogElement[];
  }): SetupContext {
    const elements = opts.elements ?? [];
    let nextBranch = opts.startBranch ?? -1; // -1 means "auto from solver"
    let nextNode   = opts.startNode   ?? -1;
    let stateCounter = 0;

    return {
      solver: opts.solver,
      temp: opts.temp ?? 300.15,
      nomTemp: opts.nomTemp ?? 300.15,
      copyNodesets: opts.copyNodesets ?? false,
      makeVolt(_label, _suffix) {
        if (nextNode < 0) throw new Error("startNode unset");
        return nextNode++;
      },
      makeCur(_label, _suffix) {
        if (nextBranch < 0) throw new Error("startBranch unset");
        return nextBranch++;
      },
      allocStates(n: number): number {
        const off = stateCounter;
        stateCounter += n;
        return off;
      },
      findBranch(label: string): number {
        const el = elements.find(e => e.label === label);
        if (!el) return 0;
        if (typeof el.findBranchFor === "function") {
          return el.findBranchFor(label, this);
        }
        return el.branchIndex !== -1 ? el.branchIndex : 0;
      },
      findDevice(label: string): AnalogElement | null {
        return elements.find(e => e.label === label) ?? null;
      },
    };
  }
  ```
- `setupAll(elements: AnalogElement[], ctx: SetupContext): void`:
  ```ts
  export function setupAll(
    elements: AnalogElement[],
    ctx: SetupContext,
  ): void {
    const sorted = [...elements].sort(
      (a, b) => a.ngspiceLoadOrder - b.ngspiceLoadOrder,
    );
    for (const el of sorted) el.setup(ctx);
  }
  ```
- A `makeTestLoadContext(...)` helper if not already present, mirroring
  `makeLoadCtx` from the current test-helpers but with all fields documented.
- A `runUnitStamp({elements, expect, opts})` convenience that wires solver +
  setup + load + readVal in one call, since most tests follow the same
  4-step shape.

### D12 — Test-side rewrite

~470 of the 557 tsc errors live in test files. Once D11 lands, every test
follows the same skeleton:

```ts
import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";
import { makeTestSetupContext, setupAll, makeLoadCtx } from "./test-helpers.js";
import { make<X> } from "<source>.js";

describe("<name>", () => {
  let solver: SparseSolver;
  beforeEach(() => {
    solver = new SparseSolver();
    solver.beginAssembly(/* matrixSize */);
  });

  it("<case>", () => {
    const v = make<X>(new Map([["pos", 1], ["neg", 0]]), /* params */);
    v.label = "V1";
    const ctx = makeTestSetupContext({ solver, startBranch: 3 });
    setupAll([v /*, other elements */], ctx);
    // build LoadContext, call v.load(loadCtx), assert.
  });
});
```

#### Per-test-file workload (concrete)

The TS error counts below come from `tsc-errors.log` (2026-04-28).

**TS2554 cluster — wrong arg count** (194 errors):

| Pattern | Sites | Migration |
|---|---|---|
| `make<X>(pinNodes, internalNodes, branchIdx, props, getTime)` (5-arg) | ~120 | Convert to `make<X>(pinNodes, props, getTime)`; if the test relied on a pre-allocated branch row, drive via `makeTestSetupContext({ startBranch: N })` + `setupAll([el], ctx)` |
| `makeDcVoltageSource(nodePos, nodeNeg, branchIdx, V)` (4-arg) | ~70 | Convert to `makeDcVoltageSource(new Map([["pos", p], ["neg", n]]), V)` + `setupAll`; do **not** swap to `makeVoltageSource` (4-arg helper is deleted) |
| `new AnalogPolarizedCapElement(pinIds, ...)` (6-arg) but new ctor expects 8 | `polarized-cap.test.ts:115` | Update the test fixture to pass all 8 parameters; if the test does not need the new params, supply defaults consistent with the production constructor's defaults |
| `(pinNodes, props, ngspiceMap)` (3-arg legacy triode/memristor) | `crystal.test.ts:228/231`, `memristor.test.ts:346` | Convert to canonical 3-arg `(pinNodes, props, getTime)` with a `() => 0` getTime stub when timing is irrelevant |

**TS2304 cluster — `solver` undefined** (26 errors):

| Files | Action |
|---|---|
| `opamp.test.ts` (24 sites), `ota.test.ts` (3 sites) | Add `let solver: SparseSolver;` plus `beforeEach(() => { solver = new SparseSolver(); solver.beginAssembly(...); })` at the top of each `describe` block |

**TS2300 cluster — duplicate identifier** (2 errors at `ccvs.test.ts:32, 36`):

- Remove the duplicate `import type { SetupContext }` line.

**TS2305 / TS2724 / TS2459 cluster — broken imports** (8 errors):

| Site | Action |
|---|---|
| `led.test.ts:25` `LED_CAP_STATE_SCHEMA` | The schema was either renamed or made non-public; either re-export from `led.ts` (if still load-bearing) or remove the import and update the consumers. Look at how the test uses it before deciding. |
| `mutual-inductor.ts:17` `PoolBackedAnalogElementCore` | Resolved by D1 (rename to `PoolBackedAnalogElement`) |
| `diac.test.ts:12` `DIAC_PARAM_DEFAULTS` | Likely renamed to follow `DIAC_DEFAULTS` convention; re-export under both names if existing consumers depend on it, otherwise update the test |
| `diac.test.ts:13`, `triac.test.ts:14` `createTriacElement` | Renamed; either re-export `createTriacElement` as an alias on `triac.ts` or update both tests to use `TriacElement` |
| `scr.test.ts:18` `createScrElement` | Currently local-only; either export it from `scr.ts` (if the test legitimately needs the factory directly) or update the test to construct via the registry's modelEntry factory |

**TS2353 cluster — excess properties** (11 errors): mostly resolved by D4 / D5
(`findBranchFor` move and class-shape fixes). Remaining:

- `mosfet.test.ts:181` `state0`-on-LoadContext — the `LoadContext` shape no
  longer accepts those state slots directly; rebuild the test fixture using
  the canonical `makeLoadCtx({ ... })` helper that takes a state pool, not raw
  slot fields.

**TS2739 / TS2352 cluster — fixture build / cast errors** (32 errors):

- Each hand-built `AnalogElement` literal must be either (i) replaced with a
  call to the production factory (the preferred path), or (ii) extended to
  satisfy the unified interface (`label`, `_pinNodes`, `_stateBase`,
  `branchIndex`, `setup`, etc.) — no partial casts.
- File-by-file:
  - `compile-integration.test.ts:269/507/888` — three different fake
    `ComponentDefinition` literals. Each gets the missing fields from the
    current `ComponentDefinition` type; do not cast through `unknown`.
  - `pin-loading-menu.test.ts:153` — same.
  - `adc.test.ts:112` — `ADCElementExt` cast over `AnalogElement`. Resolve by
    constructing a real ADCElement via the factory; the `Ext` interface
    likely no longer exists.
  - `optocoupler.test.ts:169` — `AnalogElement → AnalogElementCore`
    assignment (TS2379) — moot after D1.
  - `behavioral-gate.test.ts` (21 sites) — most tests build a partial
    `BehavioralGateElement` stand-in. After D5's class fix, replace those
    stand-ins with real factory construction (the gate factory is exported
    from `solver/analog/behavioral-gate.ts`).

**TS6133 cluster** (52 errors in tests): unused imports / declarations. Walk
each — most are genuinely dead post-refactor and can be deleted; a handful
mirror D8 (test-side counterparts of latent stamp gaps). Audit each.

**TS7006 cluster** (44 errors): mostly `model-fixtures.ts:10-15` — implicit
any on the legacy 5-arg factory parameters. Resolved by D11 (factory drops to
3-arg, parameter types are explicit).

**TS2345 / TS2339 / TS2322 cluster** (~145 errors): post-D1 / D5 / D11, most
collapse. Run a sweep at the end and address the residue with the same
"construct via factory + real setup" pattern.

#### Test-file inventory (38 files)

For visibility — every test file that has at least one error in
`tsc-errors.log` and falls inside the D12 sweep:

```
src/compile/__tests__/compile-integration.test.ts          (3 errors)
src/compile/__tests__/pin-loading-menu.test.ts             (1)
src/components/active/__tests__/adc.test.ts                (1)
src/components/active/__tests__/ccvs.test.ts               (2)
src/components/active/__tests__/dac.test.ts                (2)
src/components/active/__tests__/opamp.test.ts              (34)
src/components/active/__tests__/optocoupler.test.ts        (1)
src/components/active/__tests__/ota.test.ts                (16)
src/components/active/__tests__/schmitt-trigger.test.ts    (varies)
src/components/active/__tests__/timer-555-debug.test.ts    (varies)
src/components/active/__tests__/timer-555.test.ts          (varies)
src/components/io/__tests__/analog-clock.test.ts           (5)
src/components/io/__tests__/led.test.ts                    (11)
src/components/io/__tests__/probe.test.ts                  (3)
src/components/passives/__tests__/analog-fuse.test.ts      (varies)
src/components/passives/__tests__/capacitor.test.ts        (13)
src/components/passives/__tests__/crystal.test.ts          (5)
src/components/passives/__tests__/inductor.test.ts         (12)
src/components/passives/__tests__/memristor.test.ts        (varies)
src/components/passives/__tests__/polarized-cap.test.ts    (16)
src/components/passives/__tests__/potentiometer.test.ts    (4)
src/components/passives/__tests__/resistor.test.ts         (7)
src/components/passives/__tests__/tapped-transformer.test.ts (9)
src/components/passives/__tests__/transformer.test.ts      (6)
src/components/passives/__tests__/transmission-line.test.ts (12)
src/components/passives/__tests__/tx_trace.test.ts         (varies)
src/components/semiconductors/__tests__/bjt.test.ts        (varies)
src/components/semiconductors/__tests__/diac.test.ts       (2 import + N)
src/components/semiconductors/__tests__/diode.test.ts      (5)
src/components/semiconductors/__tests__/jfet.test.ts       (4)
src/components/semiconductors/__tests__/mosfet.test.ts     (5)
src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts (varies)
src/components/semiconductors/__tests__/scr.test.ts        (1 import + N)
src/components/semiconductors/__tests__/triac.test.ts      (1 import + N)
src/components/semiconductors/__tests__/triode.test.ts     (5)
src/components/semiconductors/__tests__/tunnel-diode.test.ts (7)
src/components/sources/__tests__/ac-voltage-source.test.ts (16)
src/components/sources/__tests__/current-source.test.ts    (8)
src/components/sources/__tests__/dc-voltage-source.test.ts (16)
src/components/sources/__tests__/ground.test.ts            (4)
src/components/sources/__tests__/variable-rail.test.ts     (12)
src/components/switching/__tests__/fuse.test.ts            (varies)
src/components/switching/__tests__/switches.test.ts        (varies)
src/components/switching/__tests__/trans-gate.test.ts      (varies)
src/core/__tests__/analog-types-setparam.test.ts           (varies)
src/solver/__tests__/coordinator-bridge-hotload.test.ts    (6)
src/solver/__tests__/coordinator-bridge.test.ts            (5)
src/solver/analog/__tests__/analog-engine.test.ts          (5)
src/solver/analog/__tests__/behavioral-combinational.test.ts (4)
src/solver/analog/__tests__/behavioral-gate.test.ts        (21)
src/solver/analog/__tests__/behavioral-integration.test.ts (5)
src/solver/analog/__tests__/behavioral-remaining.test.ts   (varies)
src/solver/analog/__tests__/behavioral-sequential.test.ts  (4)
src/solver/analog/__tests__/bridge-adapter.test.ts         (9)
src/solver/analog/__tests__/bridge-compilation.test.ts     (5)
src/solver/analog/__tests__/compiler.test.ts               (38)
src/solver/analog/__tests__/convergence-regression.test.ts (varies)
src/solver/analog/__tests__/dcop-init-jct.test.ts          (6)
src/solver/analog/__tests__/digital-pin-loading.test.ts    (varies)
src/solver/analog/__tests__/digital-pin-model.test.ts      (varies)
src/solver/analog/__tests__/element-interface.test.ts      (varies)
src/solver/analog/__tests__/harness/boot-step.test.ts      (varies)
src/solver/analog/__tests__/harness/harness-integration.test.ts (varies)
src/solver/analog/__tests__/harness/lte-retry-grouping.test.ts (varies)
src/solver/analog/__tests__/harness/nr-retry-grouping.test.ts (varies)
src/solver/analog/__tests__/harness/query-methods.test.ts  (varies)
src/solver/analog/__tests__/harness/tVbi-pmos.test.ts      (varies)
src/solver/analog/__tests__/setup-stamp-order.test.ts      (9)
src/solver/analog/__tests__/sparse-solver.test.ts          (varies)
src/solver/analog/__tests__/spice-import-dialog.test.ts    (8)
src/solver/analog/__tests__/test-helpers.ts                (9 — handled in D11)
src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts (varies)
src/test-fixtures/model-fixtures.ts                         (6 — handled in D11)
src/test-fixtures/registry-builders.ts                      (2)
```

The "varies" entries didn't appear with a precise count in the head-limited
TS6133 / TS2345 dumps; agents enumerate per file as they go.

## 5 — Execution dependencies

```
D1 type collapse                      ─ blocks all of D2–D7, D11
  └─ D2 engine/compiler rebase
       └─ D5 ControlledSourceElement  ─ blocks ccvs/vcvs/cccs/vccs in D4
            └─ D4 sources/passives findBranchFor relocation
                 └─ D5 (rest of class fixes)
                      └─ D6 active composites
                           └─ D7 semiconductor label initialization
D3 render-side rebase                 ─ parallel to D4–D7 once D1 lands
D8 TS6133 vs ngspice audit            ─ runs alongside; not auto-deletes
D9 internalNodeLabels migration       ─ parallel to D2; needs Open Q 2 answered
D11 test-helpers rewrite              ─ blocks D12; needs D1 first
  └─ D12 test rewrite                 ─ final sweep, parallelizable per file
```

D1 + D2 + D11 are the load-bearing inflection points. Everything else falls
out.

## 6 — Resolved decisions

1. **D8 authority** — agents collect and escalate. No latent stamps are folded
   in during the TS6133 audit. The D8 deliverable is a written audit report
   per the table in §4 D8 (every audited handle, its digiTS site, the ngspice
   anchor, and a verdict). User reviews the report and authorizes any folds
   item-by-item in a follow-up pass.
2. **D9 mechanism** — option (a). Each element exposes
   `getInternalNodeLabels?(): readonly string[]` returning suffixes in the
   order it passed them to `ctx.makeVolt(...)`. Harness queries post-setup.
