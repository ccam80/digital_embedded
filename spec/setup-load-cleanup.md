# Setup-Load + Dead-Field Cleanup — Single-Wave Execution Plan

This document is the single, self-contained source of truth for the
post-refactor cleanup. Implementation agents read only this document. Every
type, pattern, signature, and decision an agent needs to land its assigned
files is here in full.

Out-of-band lanes (TS6133 / latent-stamp-gap audit; spice-emission /
`ModelEmissionSpec`; numerical regression triage) are user-driven and run
in parallel; agents do not investigate or fix anything described as
out-of-band.

---

## Section A — The Contract

The contract is the universal target shape every analog element, factory,
engine consumer, composite, harness consumer, and test fixture must comply
with at the end of the wave. All decisions below are locked in.

### A.1 — Forbidden names (must not appear anywhere in `src/` after the wave)

| Name | Replacement / reason |
|---|---|
| `isReactive` (field, getter, literal flag, JSDoc) | Reactivity is method-presence: `typeof el.getLteTimestep === "function"` |
| `isNonlinear` (field, getter, literal flag, JSDoc) | The newton-raphson blame loop iterates all elements; the conditional guard is gone |
| `mayCreateInternalNodes` | Has zero production readers |
| `getInternalNodeCount` | Verified zero callers in production; the only test consumer is a tautology |
| `ReactiveAnalogElement` / `ReactiveAnalogElementCore` (type alias and interface) | Collapsed into `PoolBackedAnalogElement` / `PoolBackedAnalogElementCore` |
| `internalNodeLabels` (field, JSDoc) | Replaced by the optional `getInternalNodeLabels(): readonly string[]` method (see A.7) |
| `allNodeIds` (field declaration, type, constructor assignment, JSDoc) | Compiler-set parallel array; replaced by labelled access via `_pinNodes` and the new `getInternalNodeLabels()` method |
| `pinNodeIds` (field declaration, type, constructor assignment, JSDoc, `this.pinNodeIds[i]` access) | digiTS-era positional array; replaced by `_pinNodes: Map<string, number>` and `this._pinNodes.get("<label>")!` |
| `stateBaseOffset` | Renamed to `_stateBase` (single field on `PoolBackedAnalogElementCore`) |
| `withNodeIds` (test helper) | Tests use the production factory + real `setup()` instead |
| 4-arg `makeVoltageSource` test helper | Tests use the 2-arg `makeDcVoltageSource(Map, V)` production factory + real setup |
| `nonlinearElements`, `reactiveElements`, `elementsWithLte`, `elementsWithAcceptStep` (cached lists on `CKTCircuitContext`) | First two die with the flags; second two have zero production consumers (only the tautology test) |

`allNodeIds` is allowed as a function-local `const` (e.g. inside
`behavioral-remaining.ts`); the prohibition is on field declarations and
member assignments only. The greps in Section C distinguish the two via
the trailing `[!?:]` field-form anchor.

### A.2 — `AnalogElement` is the single element interface

`AnalogElement` (renamed from `AnalogElementCore`) is the sole element
contract. It is hosted in `src/core/analog-types.ts`.
`src/solver/analog/element.ts` re-exports it and adds nothing of its own.
There is no `Core` / non-`Core` split, no post-compile type promotion, no
`isReactive` / `isNonlinear` flag.

```ts
// src/core/analog-types.ts
export interface AnalogElement {
  // Identity
  label: string;                                  // "" until compiler Object.assigns
  ngspiceLoadOrder: number;                       // see NGSPICE_LOAD_ORDER (A.10)
  elementIndex?: number;

  // Topology — pin map is the single source of truth.
  // Insertion order matches pinLayout order; iterate `_pinNodes.values()`
  // to get pinLayout-ordered node IDs.
  _pinNodes: Map<string, number>;

  // Mutable, set during setup(). -1 means "no branch row / no state slots".
  branchIndex: number;
  _stateBase: number;

  // Lifecycle
  setup(ctx: SetupContext): void;
  load(ctx: LoadContext): void;
  accept?(ctx: LoadContext, simTime: number, addBp: (t: number) => void): void;
  acceptStep?(simTime: number, addBp: (t: number) => void, atBp: boolean): void;
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
  getPinCurrents(rhs: Float64Array): number[]; // returned in `_pinNodes` insertion order
  setParam(key: string, value: number): void;

}

export interface PoolBackedAnalogElement extends AnalogElement {
  readonly poolBacked: true;
  readonly stateSize: number;
  readonly stateSchema: StateSchema;
  initState(pool: StatePoolRef): void;

  // Diagnostic introspection. Returns labels for internal nodes allocated
  // during this element's setup(), in allocation order. Harness consumers
  // call this post-setup to label diagnostic nodes (e.g. `Q1:B'`). Optional
  // — pool-backed elements that allocate no internal nodes do not implement it.
  getInternalNodeLabels?(): readonly string[];
}

// There is no ReactiveAnalogElement. Reactivity = method-presence:
// an element is "reactive" iff `typeof el.getLteTimestep === "function"`.
```

### A.3 — Factory signature: 3 args, universal

Every analog factory has this exact shape, regardless of element complexity:

```ts
// src/core/registry.ts
export type AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElement;
```

Three arguments. No `internalNodeIds[]` parameter. No `branchIdx`
parameter. Internal nodes / branch rows / state slots / TSTALLOC handles
are all allocated inside `setup(ctx)`, never at construction time. If the
factory does not need `props` or `getTime`, it still accepts the
parameter (use `_props` / `_getTime` to suppress the unused warning).

### A.4 — `_pinNodes` is the single topology source

Every factory initializes `_pinNodes: new Map(pinNodes)` in the returned
literal (or in the constructor for class-implementing elements). Inside
`setup()` and `load()`, pin-node access is **always** by label:

```ts
const posNode = el._pinNodes.get("pos")!;     // not el.pinNodeIds[0]
```

Iteration sites that previously walked `pinNodeIds` use
`el._pinNodes.values()` (insertion order matches pinLayout order). The
power-calc loop in `analog-engine.ts`, the NR blame-tracking loop in
`newton-raphson.ts`, and the renderer's per-pin voltage lookups in
`viewer-controller.ts` all migrate to this form.

**`_pinNodes` is initialized in the factory/constructor and never mutated
thereafter.** It is typed `Map<string, number>` (mutable) for ergonomic
reasons (some class constructors build it incrementally), but the
contract treats it as frozen post-construction. Wave agents do not
write `el._pinNodes.set(...)` outside of constructor bodies.

### A.5 — `setup()` allocates everything; idempotent on `branchIndex`

`setup(ctx: SetupContext)` is the sole allocation site for:

- internal nodes (`ctx.makeVolt(label, suffix)`, returns the node ID)
- branch rows (`ctx.makeCur(label, suffix)`, stored to `branchIndex`)
- state-pool slots (`ctx.allocStates(N)`, stored to `_stateBase`)
- TSTALLOC matrix entries (`ctx.solver.allocElement(row, col)`, returns a
  handle stored in a closure-local `let _h... = -1` for inline factories,
  or a `private _h... = -1` for class-implementing elements; never on the
  returned object literal)

Branch-row allocation is **idempotent**: `setup()` opens with
`if (el.branchIndex === -1) { el.branchIndex = ctx.makeCur(...); }` so
that a prior call from `findBranchFor` (lazy alloc by a controlling
source) does not re-allocate. The "not-yet-allocated" sentinel is `-1`,
not ngspice's `0`. ngspice can use `0` because branch indices live in
the same positive node space as nodes (row 0 is reserved); digiTS's
branch indices are signed Float64Array indices where 0 is a valid row.
Compare with `=== -1`, not `=== 0` or falsy checks.

The branch row id returned by `makeCur` is stored to `el.branchIndex`;
the state-pool offset returned by `allocStates` is stored to
`el._stateBase`. These are the only two element fields written by
`setup` outside of element-private storage.

### A.6 — `findBranchFor` lives on the element, not on the `ModelEntry`

Sources / passives that own branch rows (VSRC, AC-VSRC, variable-rail,
VCVS, CCVS, IND, CRYSTAL, RELAY, tapped-transformer windings) carry
`findBranchFor(name, ctx)` on the returned element — not on the
`ModelEntry` literal in the component's `modelRegistry`. The body uses the
same idempotent makeCur as `setup()`:

```ts
findBranchFor(_name: string, ctx: SetupContext): number {
  if (el.branchIndex === -1) {
    el.branchIndex = ctx.makeCur(el.label, "branch");
  }
  return el.branchIndex;
},
```

The engine's `_findBranch` resolves `el = findDevice(label)` via the
context, then dispatches via `(el as any).findBranchFor?.(name, ctx) ?? 0`.
The element's `findBranchFor` body never calls `ctx.findDevice` — it only
manages its own branch row.

**Note on ngspice divergence**: ngspice's `CKTfndBranch` (cktfbran.c) instead
iterates ALL device-type hooks (`DEVfindBranch`); each per-type hook walks
its own instance list and lazy-allocates the branch row when a name match is
found. There is no separate "find device, then call hook" composition.
digiTS deliberately uses a two-step composition (`findDevice` + the
element's `findBranchFor`) for engine-side simplicity. Do NOT file in
`spec/architectural-alignment.md`.

**`findBranchFor` placement.** `VSRC`, `AC-VSRC`, `variable-rail`, `IND`,
`CRYSTAL`, `RELAY`, and `tapped-transformer` windings host
`findBranchFor` directly on the element factory return literal (per A.13
canonical pattern). `VCVS` and `CCVS` host it on the
`controlled-source-base.ts` shared base class — both source families
share identical idempotent makeCur logic and the base avoids duplication.

### A.7 — Internal-node labels via method, not field

Each element that calls `ctx.makeVolt(label, suffix)` records the suffix
in a closure-local (or instance-local) string array, in allocation order,
and exposes it via the optional `getInternalNodeLabels()` method.

Harness consumers (the topology-capture path, the diagnostic-overlay
path) call `el.getInternalNodeLabels?.() ?? []` to retrieve those labels
post-setup. The harness derives the matching internal-node IDs from the
element's own bookkeeping — typically by reading `_pinNodes.size` (= the
number of external pins) and counting up from there in allocation order.

19 production `ctx.makeVolt` call sites across 16 element files require
this update. See A.13 for the canonical pattern.

**Composite-class restriction.** A class that extends `CompositeElement`
MUST NOT call `ctx.makeVolt` directly in its own `setup()` body —
internal-node allocation belongs to leaf children. Section C.1 grep
detects parent-side `ctx.makeVolt` in any composite. Composites that
need additional internal nodes must wrap them in a leaf child element.

### A.8 — Class-implementing elements satisfy the unified shape directly

Classes that implement an analog element declare:

```ts
label: string = "";
_pinNodes: Map<string, number> = new Map();
_stateBase: number = -1;
branchIndex: number = -1;
readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.<DEVICE>;
```

No `pinNodeIds!`, no `allNodeIds!`, no `isReactive`, no `isNonlinear`, no
`stateBaseOffset`. `branchIndex` is a plain mutable field — no
`abstract readonly` declarations, no setters/getters. TSTALLOC handles
are `private` class fields.

### A.9 — TSTALLOC handles in closures, not on returned literals

Function-literal factories store TSTALLOC handles as closure-local
`let _h... = -1` declarations (mutated inside `setup`, read inside
`load`). They are **never** fields on the returned object literal.
Class-implementing elements use `private` class fields. This is what
prevents the TS2353 / TS2339 type-widening clusters that appeared when
handles lived on the literal.

Use the TypeScript `private` modifier for class-field handles
(`private _hPP = -1`), not the JavaScript `#`-prefix syntax (`#hPP`).
The two are not interchangeable here; mixing them within a single class
is forbidden.

### A.10 — `NGSPICE_LOAD_ORDER` constants

Every factory sets `ngspiceLoadOrder` to a constant from this enum. The
compiler sorts elements by this field so that per-iteration `cktLoad`
walks devices in the same per-type bucket order ngspice does:

```ts
export const NGSPICE_LOAD_ORDER = {
  URC:  0,   // Uniform RC line — pinned first
  BJT:  2,
  CAP:  17,
  CCCS: 18,
  CCVS: 19,
  DIO:  22,
  IND:  27,
  MUT:  28,
  ISRC: 29,
  JFET: 30,
  MOS:  35,
  RES:  40,
  SW:   42,
  TRA:  43,
  VCCS: 46,
  VCVS: 47,
  VSRC: 48,
} as const;
```

Composite elements (behavioral gates, opamps, ADC/DAC) inherit the load
order of their dominant sub-element type (typically VCVS or VSRC).

### A.11 — `label: ""` is initialized in every factory's returned literal

Every factory returns a literal that explicitly initializes `label: ""`
even though the compiler later `Object.assign`s an instance label. This
initialization is required for setup-body sites that read `this.label` /
`el.label` to type-check cleanly under TypeScript inference.

### A.12 — Engine consumers of dead flags

| Site (concept, not line number) | Action |
|---|---|
| `timestep.ts` LTE proposal loop — guard `if (!el.isReactive) continue;` | Delete the guard. The loop already gates on `typeof el.getLteTimestep === "function"` on the next line; that gate is the new sole reactive-check. Two occurrences in this file — one in the primary LTE-proposal pass, one in the order-2-promotion trial pass. |
| `newton-raphson.ts` blame-tracking loop — guard `if (!el.isNonlinear) continue;` | Delete the guard. The blame loop iterates all elements unconditionally. |
| `transmission-line.ts` in-file LTE loops — predicate `el.isReactive` | Replace each occurrence with `typeof el.getLteTimestep === "function"`. Three occurrences. |
| `compiler.ts` element-type discriminator — `element.isReactive ? "inductor" : "voltage"` | Replace with `typeof element.getLteTimestep === "function" ? "inductor" : "voltage"`. |
| `ckt-context.ts` cached-list filters — `elements.filter(el => el.isNonlinear)` and `el.isReactive` | Delete the two filter assignments and their field declarations. Also delete the `elementsWithLte` and `elementsWithAcceptStep` filter assignments and field declarations (zero production consumers; only test asserts the filter ran). Keep `_poolBackedElements` and `elementsWithConvergence`. |

### A.13 — Canonical inline-factory pattern

This is the reference shape for every function-literal factory. Reading
this is the single source of truth for what a factory looks like
post-cleanup.

```ts
export function makeDcVoltageSource(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const p = { voltage: props.getOrDefault<number>("voltage", 0) };

  // TSTALLOC handles — closure-local, NOT object fields.
  let _hPosBr = -1, _hNegBr = -1, _hBrNeg = -1, _hBrPos = -1;

  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,

    _pinNodes: new Map(pinNodes),
    _stateBase: -1,
    branchIndex: -1,

    setup(ctx: SetupContext): void {
      const posNode = el._pinNodes.get("pos")!;
      const negNode = el._pinNodes.get("neg")!;

      if (el.branchIndex === -1) {
        el.branchIndex = ctx.makeCur(el.label, "branch");
      }
      const k = el.branchIndex;

      _hPosBr = ctx.solver.allocElement(posNode, k);
      _hNegBr = ctx.solver.allocElement(negNode, k);
      _hBrNeg = ctx.solver.allocElement(k, negNode);
      _hBrPos = ctx.solver.allocElement(k, posNode);
    },

    findBranchFor(_name: string, ctx: SetupContext): number {
      if (el.branchIndex === -1) {
        el.branchIndex = ctx.makeCur(el.label, "branch");
      }
      return el.branchIndex;
    },

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      solver.stampElement(_hPosBr, +1.0);
      solver.stampElement(_hNegBr, -1.0);
      solver.stampElement(_hBrPos, +1.0);
      solver.stampElement(_hBrNeg, -1.0);
      // ngspice srcFact gating: applied in MODEDCOP|MODEDCTRANCURVE (vsrcload.c:47-55)
      // and MODETRANOP (vsrcload.c:405-413). Outside these modes the source value
      // is applied directly. Match this gating; do not multiply unconditionally.
      const ramp = (ctx.cktMode & (CKT_MODE_DCOP | CKT_MODE_DCTRANCURVE | CKT_MODE_TRANOP))
        ? ctx.srcFact
        : 1.0;
      ctx.rhs[el.branchIndex] += p.voltage * ramp;
    },

    getPinCurrents(rhs: Float64Array): number[] {
      const I = rhs[el.branchIndex];
      return [-I, I];   // pinLayout order ["neg", "pos"]
    },
  };

  return el;
}
```

For factories that allocate internal nodes, add the labels-recording
pattern:

```ts
export function makeBjt(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const internalLabels: string[] = [];
  // ... params, model resolution, etc. ...

  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.BJT,
    _pinNodes: new Map(pinNodes),
    _stateBase: -1,
    branchIndex: -1,

    setup(ctx: SetupContext): void {
      const colNode  = el._pinNodes.get("collector")!;
      const baseNode = el._pinNodes.get("base")!;
      const emitNode = el._pinNodes.get("emitter")!;

      // ngspice gating mirrors bjtsetup.c:372-428.
      //   model.RC ↔ BJTcollectorResist
      //   model.RB ↔ BJTbaseResist
      //   model.RE ↔ BJTemitterResist
      // Zero resistance → reuse external pin node; nonzero → allocate prime node.
      let nodeC_int: number;
      if (model.RC === 0) {
        nodeC_int = colNode;
      } else {
        nodeC_int = ctx.makeVolt(el.label ?? "bjt", "collector");
        internalLabels.push("collector");
      }

      let nodeB_int: number;
      if (model.RB === 0) {
        nodeB_int = baseNode;
      } else {
        nodeB_int = ctx.makeVolt(el.label ?? "bjt", "base");
        internalLabels.push("base");
      }

      let nodeE_int: number;
      if (model.RE === 0) {
        nodeE_int = emitNode;
      } else {
        nodeE_int = ctx.makeVolt(el.label ?? "bjt", "emitter");
        internalLabels.push("emitter");
      }

      // ... TSTALLOC sequence ...
    },

    getInternalNodeLabels(): readonly string[] {
      return internalLabels;
    },

    // load, getPinCurrents, setParam ...
  };

  return el;
}
```

### A.14 — Canonical class-implementing pattern

```ts
export class AnalogCapacitorElement implements PoolBackedAnalogElement {
  label: string = "";
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CAP;
  readonly poolBacked = true as const;
  readonly stateSchema = CAPACITOR_SCHEMA;
  readonly stateSize = CAPACITOR_SCHEMA.size;

  _pinNodes: Map<string, number>;
  _stateBase: number = -1;
  branchIndex: number = -1;

  private _hPP = -1;
  private _hNN = -1;
  private _hPN = -1;
  private _hNP = -1;

  // Plus per-element params and any private state.

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    // params init from props
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

  initState(_pool: StatePoolRef): void { /* pool-init body */ }

  load(ctx: LoadContext): void { /* stamp body */ }
  accept?(ctx: LoadContext, t: number, addBp: (t: number) => void): void { /* … */ }
  getLteTimestep?(...): number { /* … */ }
  checkConvergence?(ctx: LoadContext): boolean { /* … */ }
  getPinCurrents(rhs: Float64Array): number[] { /* … */ }
  setParam(key: string, value: number): void { /* … */ }
}
```

The constructor takes `(pinNodes, props)` — no internal-nodes / branch /
state-slot allocation at construction. All allocation is in `setup()`.

### A.15 — `CompositeElement` abstract base class

Behavioural gates, flipflops, multi-element composites, and bridge
adapters all currently hand-roll the same forwarding pattern: keep an
internal `_childElements: AnalogElement[]`, walk it in `setup`, walk it
in `load`, walk it in `getLteTimestep`, walk it in `acceptStep`, etc.
Each composite duplicates the same `for (const c of children) ...` loop
~6 times. The duplicated forwarding has rotted unevenly across the ~16
composite classes; in particular, several composites with reactive
children skip `getLteTimestep` forwarding entirely, which is asserted
elsewhere in the codebase as a latent bug source for behavioural-model
LTE handling.

This wave introduces `src/solver/analog/composite-element.ts`:

```ts
// src/solver/analog/composite-element.ts
export abstract class CompositeElement implements PoolBackedAnalogElement {
  // --- contract fields each subclass must initialize ---
  abstract readonly ngspiceLoadOrder: number;
  abstract readonly stateSchema: StateSchema;

  label: string = "";
  _pinNodes: Map<string, number> = new Map();
  _stateBase: number = -1;
  branchIndex: number = -1;
  readonly poolBacked = true as const;

  // --- the only abstract behavioural method ---
  /** Returns every child element this composite owns:
   *  pin-model children, internal sub-elements, etc. The returned array
   *  may include children that satisfy only a subset of AnalogElement
   *  (e.g. DigitalInputPinModel which has only `setup` and `load`). The
   *  base-class forwarders use `typeof child.method === "function"`
   *  guards before calling each lifecycle method. */
  protected abstract getSubElements(): readonly AnalogElement[];

  // --- subclass-supplied per-element behaviour ---
  abstract getPinCurrents(rhs: Float64Array): number[];
  abstract setParam(key: string, value: number): void;

  // --- forwarded lifecycle (concrete, base-class implementations) ---

  get stateSize(): number {
    let total = 0;
    for (const c of this.getSubElements()) {
      const pb = c as Partial<PoolBackedAnalogElement>;
      if (pb.poolBacked) total += pb.stateSize ?? 0;
    }
    return total;
  }

  setup(ctx: SetupContext): void {
    for (const c of this.getSubElements()) {
      if (typeof c.setup === "function") c.setup(ctx);
    }
  }

  load(ctx: LoadContext): void {
    for (const c of this.getSubElements()) {
      if (typeof c.load === "function") c.load(ctx);
    }
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: LteParams,
  ): number {
    let min = Infinity;
    for (const c of this.getSubElements()) {
      if (typeof c.getLteTimestep === "function") {
        const proposed = c.getLteTimestep(dt, deltaOld, order, method, lteParams);
        if (proposed < min) min = proposed;
      }
    }
    return min;
  }

  checkConvergence(ctx: LoadContext): boolean {
    for (const c of this.getSubElements()) {
      if (typeof c.checkConvergence === "function") {
        if (!c.checkConvergence(ctx)) return false;
      }
    }
    return true;
  }

  acceptStep(simTime: number, addBp: (t: number) => void, atBp: boolean): void {
    for (const c of this.getSubElements()) {
      if (typeof c.acceptStep === "function") c.acceptStep(simTime, addBp, atBp);
    }
  }

  nextBreakpoint(after: number): number | null {
    let earliest: number | null = null;
    for (const c of this.getSubElements()) {
      if (typeof c.nextBreakpoint === "function") {
        const t = c.nextBreakpoint(after);
        if (t !== null && (earliest === null || t < earliest)) earliest = t;
      }
    }
    return earliest;
  }

  initState(pool: StatePoolRef): void {
    let cumulative = this._stateBase;
    for (const c of this.getSubElements()) {
      const pb = c as Partial<PoolBackedAnalogElement> & { _stateBase?: number };
      if (pb.poolBacked && typeof pb.initState === "function") {
        pb._stateBase = cumulative;
        pb.initState(pool);
        cumulative += pb.stateSize ?? 0;
      }
    }
  }
}
```

**Subclass mandate.** Every composite class in the wave refactors to
`extends CompositeElement`. The subclass's responsibilities collapse to:

- declare `readonly ngspiceLoadOrder` and `readonly stateSchema`
- in the constructor: initialize `_pinNodes`, build `_childElements`,
  retain any per-class fields (input pin models, output pin models, etc.)
- implement `protected getSubElements()` returning the union of pin
  models + `_childElements`
- implement `getPinCurrents(rhs)` (shape varies per gate type)
- implement `setParam(key, value)` (delegation pattern varies)
- override `load(ctx)` if the composite needs class-specific stamps
  (typically: do its primary stamps, then `super.load(ctx)` to forward to
  children — or rely on the base-class forward and put the primary stamps
  inside one of the child elements)

**Note on async-flipflop classes.** `d-async.ts`, `jk-async.ts`, and
`rs-async.ts` do not currently `implements ReactiveAnalogElementCore`;
they are flat composites with non-reactive children. After this refactor
they extend `CompositeElement` like every other composite in the table.
The base-class `getLteTimestep` forwarder is a no-op for these classes
(method-presence guards on children skip non-reactive sub-elements).

**Note on `behavioral-remaining.ts`.** Three of the six classes today
report `isReactive` dynamically (`return this._childElements.length > 0`).
After this refactor all six unconditionally satisfy
`PoolBackedAnalogElement` via the `CompositeElement` base. The engine's
`_poolBackedElements` filter will admit all six instances. The
base-class `stateSize` getter handles the empty-children case correctly
(returns 0 when no children carry state).

**Subclasses required to refactor (18 classes total):**

| File | Class(es) |
|---|---|
| `src/solver/analog/behavioral-gate.ts` | `BehavioralGateElement` |
| `src/solver/analog/behavioral-combinational.ts` | 3 classes (one per logic family represented) |
| `src/solver/analog/behavioral-sequential.ts` | 3 classes |
| `src/solver/analog/behavioral-flipflop.ts` | `BehavioralDFlipflopElement` |
| `src/solver/analog/behavioral-flipflop/d-async.ts` | 1 class |
| `src/solver/analog/behavioral-flipflop/jk.ts` | 1 class |
| `src/solver/analog/behavioral-flipflop/jk-async.ts` | 1 class |
| `src/solver/analog/behavioral-flipflop/rs.ts` | 1 class |
| `src/solver/analog/behavioral-flipflop/rs-async.ts` | 1 class |
| `src/solver/analog/behavioral-flipflop/t.ts` | 1 class |
| `src/solver/analog/behavioral-remaining.ts` | 6 classes |
| `src/components/active/adc.ts` | `ADCElement` (1 class, audited as composite — has `_childElements`) |
| `src/components/active/dac.ts` | `DACElement` (1 class, audited as composite — has `_childElements`) |
| `src/solver/analog/bridge-adapter.ts` | `BridgeOutputAdapter`, `BridgeInputAdapter` |
| `src/solver/analog/compiler.ts` | the inline composite literal in `compileSubcircuitToMnaModel` becomes an anonymous class extending `CompositeElement` |

**Explicitly NOT in the refactor (leaf reactive elements with no
sub-element children):** `polarized-cap.ts` (`AnalogPolarizedCapElement`),
`transformer.ts`, `tapped-transformer.ts`, `crystal.ts`,
`transmission-line.ts` segment sub-classes. These are flat reactive
elements; they keep their direct `PoolBackedAnalogElement` implementation.

### A.16 — `SetupContext` interface

The exact shape every `setup()` body uses:

```ts
// src/solver/analog/setup-context.ts
export interface SetupContext {
  /** Sparse solver — element setup() calls allocElement(row, col) on this
   *  to register every TSTALLOC matrix entry the element will stamp. */
  readonly solver: SparseSolver;
  // Note: tests construct the solver and call solver.beginAssembly(...) /
  // solver.endAssembly() outside the SetupContext lifecycle; element setup()
  // calls only ctx.solver.allocElement(...).

  /** Operating temperature in Kelvin (ngspice CKTtemp). */
  readonly temp: number;

  /** Nominal model temperature in Kelvin (ngspice CKTnomTemp). */
  readonly nomTemp: number;

  /** ngspice CKTcopyNodesets — true when nodesets should be copied into
   *  initial conditions. */
  readonly copyNodesets: boolean;

  /** Allocate a fresh internal node id; returns the assigned node id.
   *  `deviceLabel` and `suffix` are used for diagnostic naming only
   *  (e.g. `Q1` / `collector` → `Q1:collector`). */
  makeVolt(deviceLabel: string, suffix: string): number;

  /** Allocate a fresh branch row id; returns the assigned row index. */
  makeCur(deviceLabel: string, suffix: string): number;

  /** Reserve `slotCount` consecutive state-pool slots; returns the offset
   *  of the first slot. */
  allocStates(slotCount: number): number;

  /** Lazy branch-row lookup — digiTS-specific composition of
   *  `findDevice(label)` then `el.findBranchFor(name, ctx)`. Does not
   *  mirror ngspice's `CKTfndBranch`+`DEVfindBranch` (which iterates all
   *  device-type hooks). */
  findBranch(sourceLabel: string): number;

  /** Look up a peer element by label. Used by controlled sources to
   *  reach the controlling element directly. */
  findDevice(deviceLabel: string): AnalogElement | null;
}
```

### A.17 — `LoadContext` interface (summary)

The exact fields every `load()` body reads or writes:

```ts
// src/solver/analog/load-context.ts (summary — see file for full JSDoc)
export interface LoadContext {
  readonly solver: SparseSolver;
  readonly rhs: Float64Array;          // CKTrhs — element load() writes RHS contributions here
  readonly rhsOld: Float64Array;       // node voltages from previous NR iteration
  readonly state0: Float64Array;       // current state vector
  readonly state1: Float64Array;       // 1 step back
  readonly state2: Float64Array;       // 2 steps back
  readonly ag: Float64Array;           // integration coefficients (length 7)
  readonly dt: number;                 // current timestep
  readonly method: IntegrationMethod;  // "trapezoidal" | "gear"
  readonly order: number;              // 1 or 2
  readonly cktMode: number;            // ngspice CKTmode bitfield
  readonly srcFact: number;            // source-stepping ramp factor (0..1)
  readonly diagonalGmin: number;       // CKTdiagGmin
  readonly reltol: number;
  /** digiTS-specific name. Corresponds to ngspice `CKTabstol`
   *  (cktdefs.h:199). Do not file in `architectural-alignment.md`. */
  readonly iabstol: number;
  readonly voltTol: number;
  readonly bypass: boolean;
  // ... plus a few diagnostic / limiting-event collectors
}
```

`load()` bodies should already be using this shape post-refactor; this
section is a reference for agents to confirm — they do not edit
`LoadContext`.

### A.18 — `PropertyBag` API surface used in factories

```ts
// The current PropertyBag API — all factories use these methods:
prop.get<T>(key: string): T | undefined;
prop.getOrDefault<T>(key: string, fallback: T): T;
prop.has(key: string): boolean;
prop.set(key: string, value: PropertyValue): void;
```

Legacy `getString` / `getNumber` / `getBoolean` calls are **in scope for
this wave**. Audit at spec-write time found one surviving call site
(`src/components/passives/tapped-transformer.ts:343`,
`props.getString("label")`). Migrate it (and any other site that surfaces
during the wave) to `props.get<string>(...)` or
`props.getOrDefault<string>(..., "")` as appropriate.

A repo-wide grep `\.(getString|getNumber|getBoolean)\(` MUST return zero
hits at convergence.

### A.19 — Test-helper rewrite (foundation file `test-helpers.ts`)

`solver/analog/__tests__/test-helpers.ts` is rewritten. The old
`withNodeIds(el, pinIds)` helper and the 4-arg `makeVoltageSource(...)`
helper are deleted. The new helpers are:

```ts
export function makeTestSetupContext(opts: {
  solver: SparseSolver;
  startBranch?: number;   // first branch-row id; required if any element calls makeCur
  startNode?: number;     // first internal-node id; required if any element calls makeVolt
  temp?: number;          // default 300.15
  nomTemp?: number;       // default 300.15
  copyNodesets?: boolean; // default false
  elements?: AnalogElement[]; // for findDevice / findBranch dispatch
}): SetupContext {
  const elements = opts.elements ?? [];
  let nextBranch = opts.startBranch ?? -1;
  let nextNode   = opts.startNode   ?? -1;
  let stateCounter = 0;

  const ctx: SetupContext = {
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
    allocStates(n) {
      const off = stateCounter;
      stateCounter += n;
      return off;
    },
    findBranch(label) {
      const el = elements.find(e => e.label === label);
      if (!el) return 0;
      if (typeof el.findBranchFor === "function") {
        return el.findBranchFor(label, ctx);
      }
      return el.branchIndex !== -1 ? el.branchIndex : 0;
    },
    findDevice(label) {
      return elements.find(e => e.label === label) ?? null;
    },
  };

  return ctx;
}

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

A test that wants element `V1` to receive branch row 3:

```ts
const solver = new SparseSolver();
solver.beginAssembly(matrixSize);
const v = makeDcVoltageSource(new Map([["pos", 1], ["neg", 0]]), 5);
v.label = "V1";
const ctx = makeTestSetupContext({ solver, startBranch: 3 });
setupAll([v], ctx);
// v.branchIndex === 3 here. Build LoadContext, call v.load(loadCtx), assert.
```

**Intentional throw on unset `startBranch`.** The default `startBranch=-1`
is intentional. Any test whose elements (or whose elements' peers via
lazy `findBranchFor`) call `ctx.makeCur` MUST set `startBranch`
explicitly. The throw forces tests to declare their starting branch row
rather than silently allocating starting at 0 and propagating off-by-one
errors.

There is no opt-out path. Tests that need to inject element-private state
do so by reaching into element fields **after** `setupAll`, never by
skipping `setupAll`.

### A.20 — Out of scope (agents do not act)

These items appear during the wave but are explicitly out of scope.
Agents leave them alone and surface them in the per-file report:

- TS6133 unused-binding warnings on TSTALLOC handles, state-pool slot
  constants, model parameter destructures (these are tracked separately
  as a latent-stamp-gap audit; agents do not delete handles or fold in
  stamps)
- `harness/netlist-generator.ts`, `ModelEmissionSpec`, `modelCardPrefix`
  — pending a separate spice-emission spec
- ngspice numerical-correctness work (convergence, model parity, stamp
  algebra) — separate spec lane
- Anything in `spec/`, `ref/ngspice/`, `tsc-errors.log`,
  `vitest-output.log`, or any audit/log files

### A.21 — `compiler.ts` rewrite target

The compiler's analog path changes shape in three concrete ways. Agents
landing this file apply all three:

1. **Drop the parallel-array writes.** The `Object.assign` blocks that
   currently write `allNodeIds: [...pinNodeIds]` and
   `nodeIds: [...pinNodeIds]` onto the freshly-constructed factory return
   value are deleted. Elements no longer expose those fields.
2. **Rewrite the type discriminator.** Any predicate of the form
   `element.isReactive ? "inductor" : "voltage"` (or similar) is replaced
   by `typeof element.getLteTimestep === "function" ? "inductor" : "voltage"`.
3. **Rewrite `compileSubcircuitToMnaModel` to the 3-arg factory shape and
   class-based composite.** The function returns a `MnaModel` whose
   `factory` is a 3-arg function that builds the composite. The composite
   itself is an anonymous class extending `CompositeElement` (per A.15)
   whose `getSubElements()` returns the constructed sub-element array.
   Internal-node allocation moves from compile time into each
   sub-element's `setup()` (composites no longer pre-allocate internal
   nodes via a per-model `getInternalNodeCount`). The composite's
   `stateSize` is provided by the `CompositeElement` base-class getter
   (A.15), which dynamically sums sub-element `stateSize`. The compiler
   does not write a `stateSize` field to the composite directly.
4. **Strip dead-flag reads and writes.** The compiler currently reads
   sub-element `e.isNonlinear` / `e.isReactive` (~lines 313–314) and
   writes those flags back onto the synthesized composite literal
   (~lines 326–327). All four sites are deleted. Any predicate of the
   form `element.isReactive` (~line 1250) is rewritten to
   `typeof element.getLteTimestep === "function"`.

The compiler also drops:

- the `getInternalNodeCount` inline composite implementation (the field
  is gone from `ModelEntry`)
- the `getInternalNodeLabels` inline composite implementation (replaced
  by the per-element method on each child)
- any stale comment referencing "Allocate internal nodes via
  `getInternalNodeCount`"
- the eager `branchCount` pre-summation (sub-elements allocate their own
  branches in `setup()` now)

### A.22 — `bridge-adapter.ts` shape

Both `BridgeOutputAdapter` and `BridgeInputAdapter` extend
`CompositeElement` (per A.15). Each class:

- declares `readonly ngspiceLoadOrder` and `readonly stateSchema`
- in the constructor, initializes `_pinNodes` from the wrapped digital
  pin model's label and node id (the previous `pinNodeIds = [...]` /
  `allNodeIds = [...]` assignments are deleted)
- implements `getSubElements()` returning the wrapped pin model plus any
  child elements
- keeps class-specific fields (`_pinModel`, `outputNodeId`, `rOut` for
  output adapter; `readLogicLevel` for input adapter)
- overrides `load(ctx)` only if the adapter does primary stamps before
  forwarding (otherwise the base-class `load()` forward suffices)
- implements `getPinCurrents`, `setParam`
- when a wrapped digital pin model exposes a single (label, nodeId)
  pair, initialize `_pinNodes` as a single-entry Map:
  `this._pinNodes = new Map([[pinModel.label, pinModel.nodeId]]);`

### A.23 — `harness/capture.ts` migration

Three concrete changes:

1. The element-snapshot blob no longer carries `isNonlinear` /
   `isReactive` fields (the snapshot type's two field declarations are
   removed too).
2. The internal-node label loop currently reads
   `el.allNodeIds[pinCount + p]` and `el.internalNodeLabels`. After this
   wave it reads `el.getInternalNodeLabels?.() ?? []` for the labels and
   derives the matching node IDs from `el._pinNodes.size + p` (i.e., the
   internal nodes follow the pin nodes in allocation order). If an
   element exposes its internal node IDs through a method or property,
   prefer that; otherwise the offset-from-`_pinNodes.size` pattern is the
   fallback.
3. Pin-iteration sites that read `el.pinNodeIds` migrate to
   `[...el._pinNodes.values()]` (or directly iterate the Map values
   where an array materialization is unnecessary).

---

## Section B — Per-file work list

Each row in B.1–B.14 is one file owned by exactly one wave agent.
Partition is universal: no two agents touch the same file.

**The agent's job per assigned file**: read §A in full, then make the
file fully comply with §A. Run §C.1 greps on the file at end-of-task;
all C.1 patterns must return zero hits in the agent's own files.

The "Notes" column highlights files that need extra-specific guidance
beyond "comply with §A" — typically a pointer to a particular A-clause
that this file is the canonical or primary expression of.

The F-code glossary below is a cross-reference for prose in §A and §B
(e.g., A.21's "F1 applies to compiler.ts"). It is no longer used as
per-file annotation — agents do not consult an F-code list before
editing; they consult §A and §C.1 directly.

§B.0 (foundation files) is exempt from this model — it has detailed
per-file edit instructions because the foundation defines the contract
that the wave depends on. Foundation lands first and as a single PR.

### F-code glossary (prose cross-reference only)

| Code | Meaning |
|---|---|
| F1 | Strip dead-flag fields / getters / literal entries (A.1) |
| F2 | Strip `allNodeIds` field decl + constructor assignment (A.1) |
| F3 | Migrate `pinNodeIds` field + `this.pinNodeIds[i]` reads to `_pinNodes` Map (A.4) |
| F4 | Factory signature → 3-arg `(pinNodes, props, getTime)` (A.3) |
| F5 | Initialize `label: ""` in factory return literal / class (A.11) |
| F6 | Relocate `findBranchFor` from `ModelEntry` onto element factory (A.6) |
| F7 | Record internal-node labels alongside `ctx.makeVolt(...)`; expose via `getInternalNodeLabels()` (A.7) |
| F8 | Migrate TSTALLOC handles to closure locals or `private` class fields (A.9) |
| F9 | Rename `stateBaseOffset` → `_stateBase` (A.1) |
| F10 | Rewrite imports + casts: `ReactiveAnalogElement[Core]` → `PoolBackedAnalogElement[Core]` (A.1, A.2) |
| F11 | Replace `internalNodeLabels` field reads with `getInternalNodeLabels?.() ?? []` (A.7) |
| F12 | Class adopts unified shape (A.8) |
| F13 | Strip cached lists from `ckt-context.ts` (A.12) — applies only to `ckt-context.ts` |
| F14 | Strip engine readers of `isReactive`/`isNonlinear` (A.12) |
| F15 | Replace `el.isReactive` predicates with `typeof el.getLteTimestep === "function"` (A.12) |
| F16 | Rewrite test call sites: drop `withNodeIds`; construct via production factory + `setupAll` (A.19) |
| F17 | Rewrite test call sites: drop 4-arg `makeVoltageSource`; use `makeDcVoltageSource(Map, V)` + `setupAll` (A.19) |
| F18 | Refactor composite class to `extends CompositeElement` (A.15). MUST also declare `readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.<DEVICE>` and `readonly stateSchema` on every subclass. |

### B.0 — Foundation files (sequential, must land before the wave)

These define the contract types and the test-helper rewrite. Single
agent, single PR. Wave does not start until this lands.

| File | Edits | Est |
|---|---|---|
| `src/core/analog-types.ts` | Rename `AnalogElementCore` → `AnalogElement` per A.2; strip `isNonlinear`/`isReactive` decls; strip `allNodeIds` JSDoc references; add `getInternalNodeLabels?(): readonly string[]`; verify `_pinNodes`/`_stateBase` already present and correctly typed | med |
| `src/solver/analog/element.ts` | Delete the duplicate `AnalogElement` interface; delete `pinNodeIds`/`allNodeIds`/`internalNodeLabels`/`isReactive`/`isNonlinear` decls; collapse `ReactiveAnalogElementCore` into `PoolBackedAnalogElementCore`; collapse `ReactiveAnalogElement` type alias; re-export from `core/analog-types.js`; keep one `isPoolBacked` overload | med |
| `src/core/registry.ts` | Delete `getInternalNodeCount?`, `getInternalNodeLabels?`, `mayCreateInternalNodes?` from the inline `ModelEntry` variant. Leave `ModelEmissionSpec` / `modelCardPrefix` / `spice?` untouched | low |
| `src/compile/types.ts` | Delete `mayCreateInternalNodes?` from compile types | low |
| `src/solver/analog/composite-element.ts` | **NEW FILE.** Implement `CompositeElement` abstract base per A.15 | med |
| `src/solver/analog/__tests__/test-helpers.ts` | Delete `withNodeIds`, 4-arg `makeVoltageSource`, any helper that builds `AnalogElement` from positional args. Add `makeTestSetupContext(opts)` and `setupAll(elements, ctx)` per A.19. Rewrite type imports/casts (`ReactiveAnalogElement` → `PoolBackedAnalogElement`) | high |

### B.1 — Engine and compiler

| File | Est | Notes |
|---|---|---|
| `src/solver/analog/analog-engine.ts` | med |  |
| `src/solver/analog/compiler.ts` | high | Apply §A.21 in full (including item 4 stripping dead-flag reads/writes) |
| `src/solver/analog/newton-raphson.ts` | low |  |
| `src/solver/analog/timestep.ts` | low |  |
| `src/solver/analog/ckt-context.ts` | low | Apply §A.12 cached-list deletions; verify §C.1 C20 grep returns zero before deleting |
| `src/solver/analog/bridge-adapter.ts` | high | Apply §A.22 in full; both adapter classes refactor to `extends CompositeElement` |
| `src/solver/analog/controlled-source-base.ts` | med | Hosts shared `findBranchFor` for VCVS/CCVS per §A.6 |
| `src/core/analog-engine-interface.ts` | low | Extend `ResolvedSimulationParams` with `temperature?`, `nomTemp?`, `copyNodesets?` and matching defaults in `DEFAULT_SIMULATION_PARAMS` |

### B.2 — App layer

| File | Est | Notes |
|---|---|---|
| `src/app/viewer-controller.ts` | low |  |

### B.3 — Behavioral solver elements

| File | Est | Notes |
|---|---|---|
| `src/solver/analog/behavioral-gate.ts` | high |  |
| `src/solver/analog/behavioral-combinational.ts` | high | 3 classes |
| `src/solver/analog/behavioral-sequential.ts` | high | 3 classes |
| `src/solver/analog/behavioral-flipflop.ts` | med | 1 class |
| `src/solver/analog/behavioral-flipflop/d-async.ts` | low | 1 class — see A.15 async-flipflop note |
| `src/solver/analog/behavioral-flipflop/jk.ts` | low |  |
| `src/solver/analog/behavioral-flipflop/jk-async.ts` | low | see A.15 async-flipflop note |
| `src/solver/analog/behavioral-flipflop/rs.ts` | low |  |
| `src/solver/analog/behavioral-flipflop/rs-async.ts` | low | see A.15 async-flipflop note |
| `src/solver/analog/behavioral-flipflop/t.ts` | low |  |
| `src/solver/analog/behavioral-remaining.ts` | high | 6 classes — see A.15 behavioral-remaining note (engine routing change) |

### B.4 — Sources

| File | Est | Notes |
|---|---|---|
| `src/components/sources/dc-voltage-source.ts` | med | Canonical inline-factory reference (§A.13) |
| `src/components/sources/ac-voltage-source.ts` | med |  |
| `src/components/sources/current-source.ts` | low |  |
| `src/components/sources/variable-rail.ts` | med |  |
| `src/components/sources/ground.ts` | low | `setup()` is empty — ground stamps nothing |

### B.5 — Passives

| File | Est | Notes |
|---|---|---|
| `src/components/passives/resistor.ts` | low |  |
| `src/components/passives/capacitor.ts` | med |  |
| `src/components/passives/inductor.ts` | med |  |
| `src/components/passives/polarized-cap.ts` | med | flat reactive (excluded from A.15 composite mandate) |
| `src/components/passives/transformer.ts` | med | flat reactive (excluded from A.15) |
| `src/components/passives/tapped-transformer.ts` | high | Migrate `props.getString("label")` at line ~343 to `props.get<string>("label") ?? ""` per A.18 |
| `src/components/passives/transmission-line.ts` | high | flat reactive at top level (excluded from A.15 composite mandate); segment sub-classes also excluded |
| `src/components/passives/crystal.ts` | high | flat reactive (excluded from A.15) |
| `src/components/passives/memristor.ts` | low |  |
| `src/components/passives/analog-fuse.ts` | low |  |
| `src/components/passives/potentiometer.ts` | low |  |
| `src/components/passives/mutual-inductor.ts` | low |  |

### B.6 — Semiconductors

| File | Est | Notes |
|---|---|---|
| `src/components/semiconductors/diode.ts` | med |  |
| `src/components/semiconductors/zener.ts` | med |  |
| `src/components/semiconductors/tunnel-diode.ts` | low |  |
| `src/components/semiconductors/varactor.ts` | low | Audit only — verified clean of dead flags |
| `src/components/semiconductors/schottky.ts` | low | Audit only — verified clean of dead flags |
| `src/components/semiconductors/bjt.ts` | high |  |
| `src/components/semiconductors/mosfet.ts` | high |  |
| `src/components/semiconductors/njfet.ts` | med |  |
| `src/components/semiconductors/pjfet.ts` | med |  |
| `src/components/semiconductors/triac.ts` | med |  |
| `src/components/semiconductors/triode.ts` | med |  |
| `src/components/semiconductors/diac.ts` | low |  |
| `src/components/semiconductors/scr.ts` | med |  |

### B.7 — Switching / FETs

| File | Est | Notes |
|---|---|---|
| `src/components/switching/switch.ts` | low |  |
| `src/components/switching/switch-dt.ts` | low |  |
| `src/components/switching/relay.ts` | med |  |
| `src/components/switching/relay-dt.ts` | med |  |
| `src/components/switching/nfet.ts` | low |  |
| `src/components/switching/pfet.ts` | low |  |
| `src/components/switching/fgnfet.ts` | med |  |
| `src/components/switching/fgpfet.ts` | med |  |
| `src/components/switching/trans-gate.ts` | low |  |

### B.8 — Active / mixed-signal

| File | Est | Notes |
|---|---|---|
| `src/components/active/opamp.ts` | med |  |
| `src/components/active/real-opamp.ts` | low |  |
| `src/components/active/ota.ts` | high |  |
| `src/components/active/comparator.ts` | med |  |
| `src/components/active/schmitt-trigger.ts` | low |  |
| `src/components/active/timer-555.ts` | high |  |
| `src/components/active/optocoupler.ts` | med |  |
| `src/components/active/analog-switch.ts` | med |  |
| `src/components/active/adc.ts` | med | Composite — refactor to `extends CompositeElement` per A.15 |
| `src/components/active/dac.ts` | med | Composite — refactor to `extends CompositeElement` per A.15 |
| `src/components/active/ccvs.ts` | med | `findBranchFor` lives on `controlled-source-base.ts` per A.6 |
| `src/components/active/vcvs.ts` | med | `findBranchFor` lives on `controlled-source-base.ts` per A.6 |
| `src/components/active/vccs.ts` | low |  |
| `src/components/active/cccs.ts` | low |  |

### B.9 — Sensors / IO

| File | Est | Notes |
|---|---|---|
| `src/components/sensors/ldr.ts` | low |  |
| `src/components/sensors/ntc-thermistor.ts` | low |  |
| `src/components/sensors/spark-gap.ts` | low |  |
| `src/components/io/led.ts` | low | Audit only — verified clean per spec author |
| `src/components/io/clock.ts` | low |  |
| `src/components/io/probe.ts` | med |  |
| `src/components/io/ground.ts` | low |  |

### B.10 — Wiring / memory / flipflop

| File | Est | Notes |
|---|---|---|
| `src/components/wiring/driver-inv.ts` | low |  |
| `src/components/memory/register.ts` | low |  |
| `src/components/memory/counter.ts` | low |  |
| `src/components/memory/counter-preset.ts` | low |  |
| `src/components/flipflops/t.ts` | low |  |
| `src/components/flipflops/rs.ts` | low |  |
| `src/components/flipflops/rs-async.ts` | low |  |
| `src/components/flipflops/jk.ts` | low |  |
| `src/components/flipflops/jk-async.ts` | low |  |
| `src/components/flipflops/d.ts` | low |  |
| `src/components/flipflops/d-async.ts` | low |  |

### B.11 — Harness and scripts

| File | Est | Notes |
|---|---|---|
| `src/solver/analog/__tests__/harness/capture.ts` | high | Apply §A.23 in full |
| `src/solver/analog/__tests__/harness/types.ts` | low |  |
| `src/solver/analog/__tests__/harness/ngspice-bridge.ts` | low |  |
| `src/solver/analog/__tests__/harness/netlist-generator.test.ts` | low |  |
| `src/solver/analog/__tests__/harness/slice.test.ts` | low |  |
| `src/solver/analog/__tests__/harness/boot-step.test.ts` | med |  |
| `src/solver/analog/__tests__/harness/harness-integration.test.ts` | med |  |
| `src/solver/analog/__tests__/harness/lte-retry-grouping.test.ts` | med |  |
| `src/solver/analog/__tests__/harness/nr-retry-grouping.test.ts` | med |  |
| `src/solver/analog/__tests__/harness/query-methods.test.ts` | med |  |
| `src/solver/analog/__tests__/harness/comparison-session.ts` | med |  |
| `scripts/mcp/harness-tools.ts` | low |  |

### B.12 — Test fixtures

| File | Est | Notes |
|---|---|---|
| `src/test-fixtures/registry-builders.ts` | low |  |
| `src/test-fixtures/model-fixtures.ts` | low |  |

### B.13 — Engine / solver tests

| File | Est | Notes |
|---|---|---|
| `src/solver/analog/__tests__/ckt-context.test.ts` | med | Delete the entire "precomputed lists" `describe` block (cached-list tautology tests) |
| `src/solver/analog/__tests__/element-interface.test.ts` | med | Review whether the file still has a reason to exist post-contract; if not, delete |
| `src/solver/analog/__tests__/timestep.test.ts` | low |  |
| `src/solver/analog/__tests__/rc-ac-transient.test.ts` | low |  |
| `src/solver/analog/__tests__/analog-engine.test.ts` | low |  |
| `src/solver/analog/__tests__/ac-analysis.test.ts` | low |  |
| `src/solver/analog/__tests__/compiler.test.ts` | high |  |
| `src/solver/analog/__tests__/compile-analog-partition.test.ts` | med |  |
| `src/solver/analog/__tests__/dc-operating-point.test.ts` | low |  |
| `src/solver/analog/__tests__/dcop-init-jct.test.ts` | low |  |
| `src/solver/analog/__tests__/digital-pin-loading.test.ts` | low |  |
| `src/solver/analog/__tests__/digital-pin-model.test.ts` | low |  |
| `src/solver/analog/__tests__/spice-import-dialog.test.ts` | med |  |
| `src/solver/analog/__tests__/convergence-regression.test.ts` | low |  |
| `src/solver/analog/__tests__/setup-stamp-order.test.ts` | med |  |
| `src/solver/analog/__tests__/behavioral-gate.test.ts` | med | Delete `it()` blocks dedicated solely to flag assertions |
| `src/solver/analog/__tests__/behavioral-combinational.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/solver/analog/__tests__/behavioral-sequential.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/solver/analog/__tests__/behavioral-remaining.test.ts` | low |  |
| `src/solver/analog/__tests__/behavioral-integration.test.ts` | med |  |
| `src/solver/analog/__tests__/phase-3-relay-composite.test.ts` | low |  |
| `src/solver/analog/__tests__/bridge-adapter.test.ts` | high |  |
| `src/solver/analog/__tests__/bridge-compilation.test.ts` | med |  |
| `src/solver/analog/__tests__/mna-end-to-end.test.ts` | med |  |
| `src/solver/analog/__tests__/buckbjt-nr-probe.test.ts` | low |  |
| `src/solver/analog/__tests__/sparse-solver.test.ts` | low |  |
| `src/solver/__tests__/coordinator-bridge.test.ts` | med |  |
| `src/solver/__tests__/coordinator-bridge-hotload.test.ts` | med |  |
| `src/solver/__tests__/coordinator-capability.test.ts` | low |  |
| `src/solver/__tests__/coordinator-clock.test.ts` | low |  |
| `src/solver/__tests__/coordinator-speed-control.test.ts` | low |  |
| `src/compile/__tests__/compile.test.ts` | low |  |
| `src/compile/__tests__/compile-integration.test.ts` | med |  |
| `src/compile/__tests__/coordinator.test.ts` | low |  |
| `src/compile/__tests__/pin-loading-menu.test.ts` | low |  |
| `src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts` | low |  |
| `src/editor/__tests__/wire-current-resolver.test.ts` | low |  |
| `src/core/__tests__/analog-types-setparam.test.ts` | low |  |

### B.14 — Component tests

#### Passives (10):

| File | Est | Notes |
|---|---|---|
| `src/components/passives/__tests__/resistor.test.ts` | low |  |
| `src/components/passives/__tests__/capacitor.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/passives/__tests__/inductor.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/passives/__tests__/polarized-cap.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/passives/__tests__/transformer.test.ts` | med | Delete dedicated flag-only `it()` block |
| `src/components/passives/__tests__/tapped-transformer.test.ts` | low |  |
| `src/components/passives/__tests__/transmission-line.test.ts` | med | Delete dedicated flag-only `it()` blocks; delete dead `getInternalNodeCount` assertions inside the `it("requires branch row")` block; KEEP the `branchCount` assertions |
| `src/components/passives/__tests__/crystal.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/passives/__tests__/memristor.test.ts` | low |  |
| `src/components/passives/__tests__/analog-fuse.test.ts` | low |  |

#### Semiconductors (12):

| File | Est | Notes |
|---|---|---|
| `src/components/semiconductors/__tests__/diode.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/semiconductors/__tests__/zener.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/semiconductors/__tests__/tunnel-diode.test.ts` | low |  |
| `src/components/semiconductors/__tests__/varactor.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/semiconductors/__tests__/schottky.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/semiconductors/__tests__/bjt.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/semiconductors/__tests__/mosfet.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/semiconductors/__tests__/jfet.test.ts` | med |  |
| `src/components/semiconductors/__tests__/scr.test.ts` | low |  |
| `src/components/semiconductors/__tests__/triac.test.ts` | low |  |
| `src/components/semiconductors/__tests__/triode.test.ts` | low | Delete dedicated flag-only `it()` block |
| `src/components/semiconductors/__tests__/diac.test.ts` | low |  |
| `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts` | med |  |

#### Active / mixed (12):

| File | Est | Notes |
|---|---|---|
| `src/components/active/__tests__/opamp.test.ts` | med |  |
| `src/components/active/__tests__/real-opamp.test.ts` | low |  |
| `src/components/active/__tests__/comparator.test.ts` | low |  |
| `src/components/active/__tests__/timer-555.test.ts` | low |  |
| `src/components/active/__tests__/timer-555-debug.test.ts` | low | Audit only — verify no field-form `allNodeIds` survives |
| `src/components/active/__tests__/optocoupler.test.ts` | med | Delete dedicated flag-only `it()` blocks |
| `src/components/active/__tests__/analog-switch.test.ts` | high | Delete dedicated flag-only `it()` blocks (multiple) |
| `src/components/active/__tests__/adc.test.ts` | low |  |
| `src/components/active/__tests__/dac.test.ts` | low |  |
| `src/components/active/__tests__/cccs.test.ts` | low |  |
| `src/components/active/__tests__/ccvs.test.ts` | low |  |
| `src/components/active/__tests__/ota.test.ts` | low |  |
| `src/components/active/__tests__/schmitt-trigger.test.ts` | low |  |

#### Sources / sensors / IO (12):

| File | Est | Notes |
|---|---|---|
| `src/components/sources/__tests__/dc-voltage-source.test.ts` | med |  |
| `src/components/sources/__tests__/ac-voltage-source.test.ts` | med |  |
| `src/components/sources/__tests__/current-source.test.ts` | low |  |
| `src/components/sources/__tests__/variable-rail.test.ts` | low |  |
| `src/components/sources/__tests__/ground.test.ts` | low |  |
| `src/components/sensors/__tests__/ldr.test.ts` | low |  |
| `src/components/sensors/__tests__/ntc-thermistor.test.ts` | low |  |
| `src/components/sensors/__tests__/spark-gap.test.ts` | low |  |
| `src/components/io/__tests__/led.test.ts` | med | Resolve any `LED_CAP_STATE_SCHEMA` import drift per current state |
| `src/components/io/__tests__/probe.test.ts` | low |  |
| `src/components/io/__tests__/analog-clock.test.ts` | low |  |
| `src/components/io/__tests__/pin-loading-menu.test.ts` | low |  |
| `src/io/__tests__/dts-load-repro.test.ts` | low |  |

#### Switching (3):

| File | Est | Notes |
|---|---|---|
| `src/components/switching/__tests__/fuse.test.ts` | low |  |
| `src/components/switching/__tests__/switches.test.ts` | low |  |
| `src/components/switching/__tests__/trans-gate.test.ts` | med | Delete the dedicated flag-only `describe` block |

---

## Section C — Per-file contract-compliance checklist

After editing a file, the agent runs the following greps **inside that
file** and reports the results in the format defined in C.4. Each grep is
a pass/fail. The agent does not run tsc, does not run tests, does not
edit files outside its assignment to make a grep pass — it leaves
conflicts and unknowns for the user-driven convergence pass.

### C.1 — Forbidden patterns (zero matches required)

| # | Grep pattern | Scope | Note |
|---|---|---|---|
| C1 | `\bisReactive\b` | all files | Field, getter, literal entry, JSDoc — all must go |
| C2 | `\bisNonlinear\b` | all files | Same |
| C3 | `\bmayCreateInternalNodes\b` | all files | |
| C4 | `\bgetInternalNodeCount\b` | all files | |
| C5 | `\bReactiveAnalogElement(Core)?\b` | all files | Type alias and interface — gone everywhere |
| C6 | `\b(readonly\s+)?allNodeIds\s*[!?:]` | element / test / harness files | Field-decl form. Function-local `const allNodeIds = ...` is allowed and not matched by this pattern. |
| C7 | `\b(readonly\s+)?pinNodeIds\s*[!?:]` | element / test / harness files | Field-decl form. The agent reports any `pinNodeIds` survival on plain harness data records (e.g. snapshot types) as out-of-band rather than auto-deleting; the snapshot-record form may be intentional. |
| C8 | `\bthis\.pinNodeIds\b` | production element files | Replaced by `this._pinNodes.get(...)` or iteration over `this._pinNodes.values()` |
| C9 | `\bthis\.allNodeIds\b` | production element files | |
| C10 | `\bel\.pinNodeIds\b` | engine / app / harness files | Replaced by `el._pinNodes.values()` or labelled access |
| C11 | `\bel\.allNodeIds\b` | engine / app / harness files | |
| C12 | `\bel\.internalNodeLabels\b` | harness / app files | Replaced by `el.getInternalNodeLabels?.() ?? []` |
| C13 | `\b\w+\.(isReactive\|isNonlinear)\b` | engine / app / test files | Predicates replaced by method-presence checks. Catches `el.X`, `element.X`, `c.X`, `child.X` etc. |
| C14 | `\bwithNodeIds\s*\(` | test files | Helper deleted |
| C15 | `\bmakeVoltageSource\s*\(` | test files | 4-arg helper deleted; only `makeDcVoltageSource(Map, V)` survives |
| C16 | `\bstateBaseOffset\b` | all files | Renamed to `_stateBase` |
| C17 | `\binternalNodeLabels\s*[?:]` | element / type files | Field-decl form replaced by the method |
| C18 | `\bnonlinearElements\b` \| `\breactiveElements\b` \| `\belementsWithLte\b` \| `\belementsWithAcceptStep\b` | `ckt-context.ts`, `ckt-context.test.ts` only | Cached lists deleted |
| C19 | `class\s+\w+\s+extends\s+CompositeElement[\s\S]*?ctx\.makeVolt\(` (multiline) | composite class files | Composite must not call makeVolt directly; allocation belongs to leaf children (A.7) |
| C20 | `\b(elementsWithLte\|elementsWithAcceptStep)\b` | repo-wide except `ckt-context.ts` and `ckt-context.test.ts` | Verifies A.12's "zero callers" claim before deletion |

### C.2 — Required patterns (must appear where applicable)

| # | Grep pattern | When applicable |
|---|---|---|
| R1 | `_pinNodes:\s*new Map\(pinNodes\)` (literal) **or** `this\._pinNodes\s*=\s*new Map\(pinNodes\)` (class) | Every analog element factory / constructor |
| R2 | `label:\s*""` (literal) **or** `label:\s*string\s*=\s*""` (class) | Every analog element factory / constructor |
| R3 | Factory exported with signature matching `\(\s*pinNodes:\s*ReadonlyMap<string,\s*number>,\s*props:\s*PropertyBag,\s*getTime:\s*\(\)\s*=>\s*number\s*\)` | Every exported analog factory function |
| R4 | A `getInternalNodeLabels\(\)` method that returns the `internalLabels` array recorded during `setup()` | Elements that contain at least one `ctx\.makeVolt\(` call |
| R5 | `findBranchFor\(` defined on the element factory return literal / class — not on the `ModelEntry` literal in `modelRegistry` | Files that own a branch row: VSRC, AC-VSRC, variable-rail, VCVS, CCVS, IND, CRYSTAL, RELAY, tapped-transformer windings |
| R6 | `extends CompositeElement` on every composite class listed in A.15's subclass mandate | All 18 classes per A.15 mandate, spanning B.1 (`bridge-adapter.ts`, `compiler.ts` anonymous class), B.3 (behavioral-* classes), and B.8 (`adc.ts`, `dac.ts`) |

### C.3 — Out-of-band findings (agent reports; does not act)

The agent surfaces the following in the per-file report and moves on:

- Any `poolBacked` literal usage that is ambiguous between the canonical
  class-level discriminator and a redundant duplicate
- Any TS6133 unused-binding on TSTALLOC handles, state-pool slot
  constants, or model parameter destructures (latent-stamp-gap audit —
  separate user-driven lane)
- Any `ModelEmissionSpec` / `modelCardPrefix` / `harness/netlist-generator.ts`
  references (spice-emission spec — separate)
- Any `pinNodeIds` survival on a plain data-record type that is clearly
  not an `AnalogElement` (e.g. snapshot/topology records) — verify
  intent before flagging as a contract violation

### C.4 — Per-file output format

For each file the agent owns, produce one block:

```
File: <path>
Status: complete | partial | blocked
Edits applied: <prose summary, e.g. "Migrated to A.13 canonical pattern; recorded internal labels per A.7; added findBranchFor per A.6.">
Forbidden-pattern greps (Section C.1):
  (list only rows with ≥1 hit; "all clean" if zero rows fail)
  C1 isReactive: 0 hits
  C2 ...
Required-pattern greps (Section C.2):
  (list only missing-where-applicable rows; "all present" if none missing)
Out-of-band findings (Section C.3):
  - <one line per finding>
Flow-on effects (other files this change requires but I did not edit):
  - <one line per signaled flow-on>
Notes:
  - <free-form>
```

---

## Section D — Execution model

1. **Foundation.** A single agent applies Section B.0 in one PR
   (`analog-types.ts`, `element.ts`, `registry.ts`, `compile/types.ts`,
   `composite-element.ts` (new file), `test-helpers.ts`). Wave does not
   start until this lands.
2. **Wave.** The remaining files in §B.1–B.14 are dispatched as parallel
   agent tasks, ~3 files per agent. Each wave agent owns assigned files
   and:
   - makes each assigned file fully comply with §A;
   - runs §C.1 greps on each assigned file at end-of-task and reports
     any non-zero hits as part of their per-file output (§C.4);
   - if full compliance would require editing OTHER files (cross-file
     flow-on effect), the agent STOPS at their file boundary on that
     specific change, documents the flow-on effect in their per-file
     out-of-band report, and continues with their remaining work;
   - does not coordinate, does not run tsc, does not run tests.

   The agent's own assigned files MUST meet all C.1 grep standards at
   end-of-task. Flow-on effects on OTHER files are signaled, not acted
   on. End-of-wave collection rolls up flow-on effects for the
   convergence pass to address.
3. **Convergence.** After the wave lands, a single sweep agent (or the
   user) runs Section C.1 greps repo-wide to confirm no forbidden
   pattern survives. The wave is considered complete only when ALL of
   the following hold:
   - C.1 greps return zero hits repo-wide.
   - `tsc --noEmit` returns zero errors.
   - The test suite shows no NEW failures relative to the pre-wave
     baseline (see `spec/test-baseline.md`); pre-existing failures are
     not introduced or removed by the wave.
   - Section C.4 per-file reports are aggregated; any unresolved C.2
     missing-row blocks closure.

   Convergence may take more than one pass. If a pass cannot achieve
   all four conditions, the residual is filed as a follow-up
   spec / fix list (per the standing CLAUDE.md "Completion Definition"
   rule), not treated as wave-complete.
4. **Out-of-band lanes (parallel to the wave, not in scope here):**
   - TS6133 / latent-stamp-gap audit
   - `ModelEmissionSpec` / `modelCardPrefix` / spice-emission spec
   - Numerical / convergence regression triage

The wave will not be tsc-clean or test-clean while in flight. That is
expected and is the cost of the parallel execution model. tsc / test
remediation is a single post-wave pass, not an agent-by-agent burden.
That sole post-wave pass IS the convergence pass; it has the hard exit
conditions above.
