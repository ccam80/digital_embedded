# Task PB-XFMR

**digiTS file:** `src/components/passives/transformer.ts`
**New file:** `src/components/passives/mutual-inductor.ts`
**ngspice setup anchor (IND):** `ref/ngspice/src/spicelib/devices/ind/indsetup.c:84-100`
**ngspice setup anchor (MUT):** `ref/ngspice/src/spicelib/devices/ind/mutsetup.c:30-70`
**ngspice load anchor (IND):** `ref/ngspice/src/spicelib/devices/ind/indload.c`
**ngspice load anchor (MUT):** `ref/ngspice/src/spicelib/devices/ind/mutload.c`

## Pin mapping (from 01-pin-mapping.md)

The transformer composite does not get an `ngspiceNodeMap` on `ComponentDefinition`- it decomposes into sub-elements.

Sub-element maps:
- `L1` (primary winding IND): `{ P1: "pos", P2: "neg" }`
- `L2` (secondary winding IND): `{ S1: "pos", S2: "neg" }`
- `MUT` (coupling element): no pin map (uses refs to L1.branchIndex, L2.branchIndex directly)

| Sub-element | digiTS pin label | ngspice node variable |
|---|---|---|
| L1 | `P1` | `INDposNode` |
| L1 | `P2` | `INDnegNode` |
| L2 | `S1` | `INDposNode` |
| L2 | `S2` | `INDnegNode` |

## Internal nodes

None. Neither IND nor MUT allocates internal voltage nodes via `CKTmkVolt`.

## Branch rows

Two branch rows- one per inductor winding:
- `L1.branchIndex`: allocated via `ctx.makeCur(l1.label, "branch")` in `L1.setup(ctx)`
- `L2.branchIndex`: allocated via `ctx.makeCur(l2.label, "branch")` in `L2.setup(ctx)`

`MUT.setup(ctx)` reads `this._l1.branchIndex` and `this._l2.branchIndex` directly from its constructor-stored refs (the composite owns the refs, so `findDevice` is not needed).

## State slots

Per indsetup.c:78-79, each IND allocates 2 state slots:
- `L1`: `ctx.allocStates(2)` → slots for INDflux and INDvolt
- `L2`: `ctx.allocStates(2)` → slots for INDflux and INDvolt

MUT allocates no state slots (`NG_IGNORE(states)` at mutsetup.c:28).

Total: 4 state slots.

## TSTALLOC sequence (line-for-line port)

### L1 setup- indsetup.c:96-100

L1 uses pins `P1` (posNode) and `P2` (negNode), branch row `b1 = L1.branchIndex`:

| # | ngspice pair | digiTS pair | handle field on L1 |
|---|---|---|---|
| 1 | `(INDposNode, INDbrEq)` | `(p1Node, b1)` | `_hPIbr` |
| 2 | `(INDnegNode, INDbrEq)` | `(p2Node, b1)` | `_hNIbr` |
| 3 | `(INDbrEq, INDnegNode)` | `(b1, p2Node)` | `_hIbrN` |
| 4 | `(INDbrEq, INDposNode)` | `(b1, p1Node)` | `_hIbrP` |
| 5 | `(INDbrEq, INDbrEq)` | `(b1, b1)` | `_hIbrIbr` |

### L2 setup- indsetup.c:96-100

L2 uses pins `S1` (posNode) and `S2` (negNode), branch row `b2 = L2.branchIndex`:

| # | ngspice pair | digiTS pair | handle field on L2 |
|---|---|---|---|
| 6 | `(INDposNode, INDbrEq)` | `(s1Node, b2)` | `_hPIbr` |
| 7 | `(INDnegNode, INDbrEq)` | `(s2Node, b2)` | `_hNIbr` |
| 8 | `(INDbrEq, INDnegNode)` | `(b2, s2Node)` | `_hIbrN` |
| 9 | `(INDbrEq, INDposNode)` | `(b2, s1Node)` | `_hIbrP` |
| 10 | `(INDbrEq, INDbrEq)` | `(b2, b2)` | `_hIbrIbr` |

### MUT setup- mutsetup.c:66-67

MUT reads `MUTind1->INDbrEq` = `L1.branchIndex` and `MUTind2->INDbrEq` = `L2.branchIndex`:

| # | ngspice pair | digiTS pair | handle field on MUT |
|---|---|---|---|
| 11 | `(MUTind1->INDbrEq, MUTind2->INDbrEq)` | `(b1, b2)` | `_hBr1Br2` |
| 12 | `(MUTind2->INDbrEq, MUTind1->INDbrEq)` | `(b2, b1)` | `_hBr2Br1` |

## setup() body- alloc only

### Composite `AnalogTransformerElement.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  // Composite setup: call sub-elements in order L1, L2, MUT.
  // Ordering invariant: _l1.setup() and _l2.setup() MUST complete before
  // _mut.setup() is called, because _mut reads _l1.branchIndex and
  // _l2.branchIndex (set during IND setup) directly- no findDevice needed.
  this._l1.setup(ctx);
  this._l2.setup(ctx);
  this._mut.setup(ctx);
}
```

`_mut` is constructed at factory time as `new MutualInductorElement(coupling, _l1, _l2)`, so it already holds refs to `_l1` and `_l2` by the time `setup()` is called.

### New class `InductorSubElement` (in `mutual-inductor.ts`)

A lightweight inductor sub-element for use inside transformer composites.
Implements the same setup/load/state/LTE behavior as `AnalogInductorElement`
(PB-IND) but is not registered as a top-level MNA model. Used by PB-XFMR
and PB-TAPXFMR.

This spec covers the **complete external surface** of `InductorSubElement`.
Consumers (`AnalogTransformerElement`, `AnalogTappedTransformerElement`)
depend on every method and field declared here.

#### Constructor

```ts
constructor(
  private readonly _posNode: number,    // INDposNode
  private readonly _negNode: number,    // INDnegNode
  private readonly _label: string,      // unique branch label
  private _inductance: number,          // L value at construction time
)
```

The 4th constructor parameter `_inductance` is the L value used for
state-pool initialization and load() stamping. Subsequent updates flow
through `setParam("L", value)`. Field is mutable (not `readonly`) so
`setParam` can rewrite it.

#### Pool-backed declaration

`InductorSubElement` is pool-backed (`poolBacked = true as const`). It
participates in the unified state pool exactly like a top-level
`AnalogInductorElement`:

```ts
export class InductorSubElement implements PoolBackedAnalogElementCore {
  branchIndex: number = -1;                // mutable per A3
  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema = INDUCTOR_SUB_SCHEMA;  // 2-slot ngspice schema
  readonly stateSize: number = 2;          // INDflux, INDvolt
  stateBaseOffset: number = -1;            // set by MNAEngine._setup()
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  readonly isNonlinear: false = false;
  readonly isReactive: true = true;
  s0: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s1: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s2: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s3: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s4: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s5: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s6: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s7: Float64Array<ArrayBufferLike> = new Float64Array(0);
  // ...
}
```

`INDUCTOR_SUB_SCHEMA` reuses the 2-slot ngspice schema (`INDflux` =
state[0], `INDvolt` = state[1])- same semantics as PB-IND. Implementer
imports `INDUCTOR_SCHEMA` from `inductor.ts` if the constant is exported
there post-PB-IND, otherwise defines a local 2-slot schema with the same
slot names.

`InductorSubElement` does NOT store a `_pinNodes` map- it stores
`_posNode` and `_negNode` directly via constructor args. The composite
(`AnalogTransformerElement` / `AnalogTappedTransformerElement`) owns
the user-facing `_pinNodes: Map<string, number>` per A3 invariant.

#### setup()- alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = this._posNode;
  const negNode = this._negNode;

  // indsetup.c:78-79- *states += 2 (INDflux + INDvolt slots)
  // The composite does NOT call ctx.allocStates() for sub-element pools;
  // each sub-element calls it via its own setup(). The composite's
  // stateSize aggregates from sub-elements but does not own slots.
  // Here we let the engine assign stateBaseOffset later (in _setup()
  // post-setup walk); this method only marks the state-slot count.
  // Implementer note: if MNAEngine._setup() walks sub-elements
  // recursively for state-pool allocation (per 00-engine.md ssA5.1),
  // skip the explicit allocStates here- the engine handles it.
  // Otherwise the composite calls ctx.allocStates(this.stateSize) on
  // behalf of each sub-element. The choice depends on engine policy;
  // per current `mutual-inductor.ts:45` the sub-element calls allocStates
  // directly, so this spec follows that pattern.
  if (this.stateBaseOffset === -1) {
    this.stateBaseOffset = ctx.allocStates(2);
  }

  // indsetup.c:84-88- CKTmkCur (idempotent guard)
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this._label, "branch");
  }
  const b = this.branchIndex;

  // indsetup.c:96-100- TSTALLOC sequence, line-for-line.
  this._hPIbr   = solver.allocElement(posNode, b);
  this._hNIbr   = solver.allocElement(negNode, b);
  this._hIbrN   = solver.allocElement(b, negNode);
  this._hIbrP   = solver.allocElement(b, posNode);
  this._hIbrIbr = solver.allocElement(b, b);
}
```

#### initState- engine state-pool hook

```ts
initState(pool: StatePoolRef): void {
  // Bind typed-array refs and apply initial values per the 2-slot schema.
  // Mirrors AnalogInductorElement.initState (PB-IND).
  applyInitialValues(this.stateSchema, pool, this.stateBaseOffset, {});
  // Composite does not call this directly; engine walks pool-backed
  // sub-elements via _poolBackedElements filter at construction.
}
```

#### load()- value writes only

```ts
load(ctx: LoadContext): void {
  // Port from indload.c. Stamp through the 5 cached _hXXX handles.
  // No solver.allocElement calls.
  // State-slot reads/writes via this.s0..s3 (typed-array refs bound by
  // initState). The composite's load() body delegates to this method via
  // this._l1.load(ctx) / this._l2.load(ctx) etc.- the composite does
  // not stamp through these handles directly; sub-elements own their
  // handles privately and stamp through them inside this load() body.
  // ...full indload.c body, line-for-line, using cached handles only...
}
```

The full `load()` body is the line-for-line indload.c port- same as
PB-IND's `load()` body. The implementer copies the body from the
post-PB-IND `AnalogInductorElement.load()` and adapts to this class's
field names (`_inductance` instead of `params.L`; `s0`..`s3` typed
arrays at slot indices 0/1 for INDflux/INDvolt).

#### getLteTimestep- adaptive time-step contribution

```ts
getLteTimestep(
  dt: number,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  lteParams: LteParams,
): number {
  // Same body as PB-IND- call cktTerr with (INDflux current, prev,
  // prev-prev, prev-prev-prev) state-slot reads.
  // ...full body, identical to AnalogInductorElement.getLteTimestep...
}
```

This method is required so the composite's own `getLteTimestep` can
forward via `min(_l1.getLteTimestep, _l2.getLteTimestep[, _l3.getLteTimestep])`.

#### setParam

```ts
setParam(key: string, value: number): void {
  if (key === "L" || key === "inductance") {
    this._inductance = value;
  }
  // Other keys silently ignored- matches PB-IND setParam guard.
}
```

#### findBranchFor

```ts
findBranchFor(name: string, ctx: SetupContext): number {
  if (name !== this._label) return 0;
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this._label, "branch");
  }
  return this.branchIndex;
}
```

#### Field summary

```ts
branchIndex: number = -1;          // public- composite reads to construct MUT
private _hPIbr:   number = -1;
private _hNIbr:   number = -1;
private _hIbrN:   number = -1;
private _hIbrP:   number = -1;
private _hIbrIbr: number = -1;
stateBaseOffset: number = -1;
// (no public getters- composite does not stamp through sub-element
//  handles; sub-element's own load() does all stamping)
```

The `branchIndex` field is **public** so `MutualInductorElement.setup()`
can read `_l1.branchIndex` / `_l2.branchIndex`. All other handles are
private- the composite does NOT stamp through sub-element handles.

### New class `MutualInductorElement` (in `mutual-inductor.ts`)

Coupling element between two `InductorSubElement` instances. Reads
branch indices from constructor-stored sub-inductor refs. Not pool-backed
(MUT allocates no state slots- `mutsetup.c:28` calls `NG_IGNORE(states)`).

This spec covers the **complete external surface** of `MutualInductorElement`.

#### Constructor

```ts
constructor(
  private _coupling: number,                  // K coupling coefficient (mutable; setParam updates)
  private readonly _l1: InductorSubElement,   // first coupled inductor (ref)
  private readonly _l2: InductorSubElement,   // second coupled inductor (ref)
)
```

`_coupling` is mutable so `setParam("coupling", value)` / `setParam("K", value)`
updates work without reconstruction.

#### Pool-backed declaration

`MutualInductorElement` is **NOT** pool-backed. It owns no state slots.
The class does not declare `poolBacked = true`, has no `stateSchema`, no
`stateBaseOffset`, no `s0..s7` typed-array slots, no `initState` method.
This matches `mutsetup.c:28` (`NG_IGNORE(states)`).

```ts
export class MutualInductorElement implements AnalogElementCore {
  branchIndex: number = -1;                  // unused- MUT has no branch row
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;
  readonly isNonlinear: false = false;
  readonly isReactive: false = false;
  // No poolBacked / stateSchema / stateBaseOffset / s0..s7 / initState.
  // ...
}
```

`MutualInductorElement` does NOT store a `_pinNodes` map- it reads from
its `_l1` / `_l2` refs directly. The composite owns the user-facing
`_pinNodes` map.

#### setup()- alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;

  // mutsetup.c:44-57- resolve inductor references via constructor-stored
  // refs (no CKTfndDev needed; composite owns the refs).
  // Pre-condition: both _l1.setup(ctx) and _l2.setup(ctx) MUST have run
  // before this method, so branchIndex is populated. Composite enforces
  // this ordering by calling sub-inductor setup() before MUT setup().
  const b1 = this._l1.branchIndex;
  const b2 = this._l2.branchIndex;
  if (b1 === -1 || b2 === -1) {
    throw new Error("MutualInductorElement.setup(): branchIndex not yet allocated on sub-inductor");
  }

  // mutsetup.c:66-67- TSTALLOC sequence, 2 entries.
  this._hBr1Br2 = solver.allocElement(b1, b2);
  this._hBr2Br1 = solver.allocElement(b2, b1);
}
```

#### load()- value writes only

```ts
load(ctx: LoadContext): void {
  // Port from mutload.c. The MUT load body computes mutual inductance
  // contributions using:
  //   M = K · sqrt(L1 · L2)
  //   geq_M = ag · M  (companion-model conductance for cross-coupling)
  // and stamps:
  //   stampElement(_hBr1Br2, -geq_M)
  //   stampElement(_hBr2Br1, -geq_M)
  // plus RHS terms for cross-coupling history.
  // The L1, L2 inductance values come from this._l1._inductance /
  // this._l2._inductance (sub-inductor private fields exposed via
  // package-internal getter or read from setParam-tracked state).
  // The branch currents at the previous timestep come from the state
  // pools of _l1 and _l2 (slot 0 = INDflux; slot 1 = INDvolt).
  // ...full mutload.c body, line-for-line, using cached handles only...
}
```

The full `load()` body is the line-for-line mutload.c port. The
implementer needs cross-class read access to:
- `_l1._inductance` / `_l2._inductance` for L1, L2 values
- `_l1` / `_l2` state-pool slots for INDflux history

To avoid scope creep into "make these fields public," `InductorSubElement`
exposes two **package-internal** getters used only by `MutualInductorElement`:

```ts
// On InductorSubElement (in mutual-inductor.ts):
get inductanceForMut(): number { return this._inductance; }
get statePoolForMut(): { s0: Float64Array; s1: Float64Array; ... ; stateBaseOffset: number } {
  return { s0: this.s0, s1: this.s1, /* ... */ stateBaseOffset: this.stateBaseOffset };
}
```

These getters are scoped to mutual-inductor.ts and have no consumers
outside that file. They are NOT the same as the out-of-spec public
getters previously appended to mutual-inductor.ts during the partial
PB-TAPXFMR run- those exposed handle fields (`hPIbr`, `hNIbr`, etc.)
and were used to bypass the missing `load()` method on the sub-element.
After this spec patch, the `load()` method is on the sub-element class
itself; handles never need to leave the class.

#### getLteTimestep

`MutualInductorElement` does NOT implement `getLteTimestep`. The
composite's `getLteTimestep` forwards only to the sub-inductor
sub-elements (`_l1`, `_l2`), not to MUT. MUT contributes no LTE
timestep constraint of its own.

#### setParam

```ts
setParam(key: string, value: number): void {
  if (key === "K" || key === "coupling") {
    this._coupling = value;
  }
  // Other keys silently ignored.
}
```

#### Field summary

```ts
branchIndex: number = -1;                    // unused; satisfies AnalogElementCore interface
private _hBr1Br2: number = -1;
private _hBr2Br1: number = -1;
// _coupling is the constructor-bound mutable field.
// _l1 and _l2 are constructor-bound readonly refs.
```

No public getters. No pool participation.

## load() body- value writes only

The composite's `AnalogTransformerElement.load(ctx)` body delegates to
sub-elements:

```ts
load(ctx: LoadContext): void {
  // Sub-inductor load() bodies stamp through their own cached handles
  // (5 handles each, populated in their setup()). MUT load() stamps
  // through its own 2 cached handles plus reads sub-inductor state.
  this._l1.load(ctx);
  this._l2.load(ctx);
  this._mut.load(ctx);
}
```

Each sub-element's `load()` body is specified in its class section above
(InductorSubElement.load and MutualInductorElement.load). The composite
contributes no stamping of its own- all `solver.stampElement` calls live
inside the sub-elements.

## Composite getLteTimestep

```ts
getLteTimestep(
  dt: number,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  lteParams: LteParams,
): number {
  // Forward to the two sub-inductors. MUT contributes no LTE
  // constraint of its own.
  return Math.min(
    this._l1.getLteTimestep(dt, deltaOld, order, method, lteParams),
    this._l2.getLteTimestep(dt, deltaOld, order, method, lteParams),
  );
}
```

## Composite `_pinNodes` ownership

`AnalogTransformerElement` owns `_pinNodes: Map<string, number>` per the
A3 invariant. Sub-elements (`InductorSubElement`, `MutualInductorElement`)
do NOT carry their own `_pinNodes` maps- they store node ids directly
via constructor args and read sub-inductor refs as needed. The composite's
`_pinNodes` is populated at construction with all four user-facing pin
labels (`P1`, `P2`, `S1`, `S2`).

## Factory cleanup

The existing `AnalogTransformerElement` (a monolithic class stamping all entries inline in `load()`) is refactored into the three-sub-element architecture: `InductorSubElement` (L1) + `InductorSubElement` (L2) + `MutualInductorElement` (K).

`setParam` routes by key prefix:
- Keys starting with `L1.` → `this._l1.setParam(key.slice(3), value)`
- Keys starting with `L2.` → `this._l2.setParam(key.slice(3), value)`
- Keys `K` or `coupling` → `this._mut.setParam(key, value)`
- Keys `primaryInductance`, `turnsRatio` → recompute L1/L2 and coupling, delegate accordingly.
- All other (unrecognized) keys → throw `Error(`Unrecognized setParam key: ${key}`)`

Factory signature changes:
- Drop `internalNodeIds` and `branchIdx` parameters (per A6.3).
- Remove `branchCount: 2` from `MnaModel` registration (per A6.2).
- `mayCreateInternalNodes` omitted.
- `ComponentDefinition.ngspiceNodeMap` left undefined (composite).
- Add `findBranchFor` callback that delegates to `l1.findBranchFor` and `l2.findBranchFor`.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body- alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only- zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
