# composite-component-base

## Problem statement

Every multi-device analog component in digiTS (SCR, TRIAC, DIAC, optocoupler,
555 timer, transmission line, behavioral gates/flip-flops/counters/registers,
etc.) hand-rolls two pieces of glue that ngspice provides as parser/setup
infrastructure: (a) merging model defaults onto a `PropertyBag` for each
sub-element it instantiates, and (b) wiring sub-element pin maps and lifecycle
calls. Per-component prop-bag adapter helpers (`makeNpnProps`, `makePnpProps`,
`makeTriacNpnProps`, `makeLedProps`, `makeBjtProps`, …) and direct
`(child as any)._pinNodes.set(...)` mutations are evidence of the missing
abstraction. The fix is to push both responsibilities up: a
`PropertyBag.forModel(...)` constructor for the defaults merge, and a typed
sub-element / pin-binding API on `CompositeElement` (which already exists at
`src/solver/analog/composite-element.ts`) for the lifecycle and wiring.

## Existing pieces (must be reused)

- `CompositeElement` (`src/solver/analog/composite-element.ts`) already exists
  and already owns: `setup()`/`load()`/`getLteTimestep()`/`checkConvergence()`/
  `acceptStep()`/`nextBreakpoint()`/`initState()` forwarding,
  `stateSize` aggregation, `poolBacked` flag. Subclasses currently must
  implement `getSubElements()`, `getPinCurrents()`, `setParam()`,
  `ngspiceLoadOrder`, and `stateSchema`. The behavioral-gate, behavioral-
  remaining (Driver, Splitter, SevenSeg, ButtonLED), and behavioral-sequential
  (Counter, Register, CounterPreset) families already extend it.
- `defineModelParams()` (`src/core/model-params.ts:32-65`) already produces a
  paired `{ paramDefs, defaults }` from a single declaration; every sub-element
  family (BJT, diode, RES, VCVS, …) already exports a `_DEFAULTS` record.
- The engine's `_walkSubElements` (`src/solver/analog/analog-engine.ts:1383-
  1390`) already prefers `el.getSubElements()` over the legacy `_subElements`
  field; the duck-typing is already there at the engine boundary.

The work is therefore additive on top of `CompositeElement`, not a rewrite.

## Proposed APIs

### 1. `PropertyBag.forModel(modelDefaults, overrides?)`

Add to `src/core/properties.ts` next to the existing `replaceModelParams`:

```ts
class PropertyBag {
  /**
   * Build a fresh PropertyBag whose model-param partition is the merge of
   * `modelDefaults` and `overrides`. `overrides` win on key collisions; keys
   * present only in `modelDefaults` are filled with the model's declared
   * default; keys in `overrides` that are NOT in `modelDefaults` throw —
   * unknown-key writes are a programming error, not a silent fallthrough.
   *
   * The non-model partition (regular `_map`) is empty.
   *
   * Mirrors ngspice's per-parameter "*Given" convention: BJTmpar() (bjt/
   * bjtmpar.c:21-473) records every user-supplied param into a
   * BJTmodel struct and sets its `*Given` flag; bjtsetup.c:35-505 then walks
   * each `if (!model->BJT*Given) model->BJT* = <literal default>` line. The
   * ngspice algorithm collapses to the same shape as `forModel`: defaults
   * provided by the device family, overrides supplied by the netlist.
   */
  static forModel(
    modelDefaults: Readonly<Record<string, PropertyValue>>,
    overrides: Readonly<Record<string, PropertyValue>> = {},
  ): PropertyBag;
}
```

Merge semantics:

- For every key in `modelDefaults`: pick `overrides[key]` if present, else
  `modelDefaults[key]`.
- For every key in `overrides` not in `modelDefaults`: throw
  `Error("PropertyBag.forModel: unknown model param '<key>' (valid: …)")`.
- The returned bag has an empty regular-property partition; callers that need
  to set `label` etc. either set them after construction or use a separate
  ctor.

This eliminates:

- `function makeNpnProps(...)` / `function makePnpProps(...)` in `scr.ts:63-73`
- `function makeTriacNpnProps(...)` / `makeTriacPnpProps(...)` in
  `triac.ts:197-225`
- `function makeLedProps(...)` / `function makeBjtProps(...)` in
  `optocoupler.ts:116-127`
- `function makeBjtProps(...)` in `timer-555.ts:354-358`

Every callsite reduces to:

```ts
const npnProps = PropertyBag.forModel(BJT_SPICE_L1_NPN_DEFAULTS, { BF, IS, RC, RB, RE, AREA, TEMP });
```

### 2. `CompositeElement.addSubElement(...)` declarative registration

Replace the current pattern (subclass holds typed `readonly _q1`, `readonly _q2`,
… fields, manually populates them in the factory, manually overrides
`getSubElements()` to return them) with a declarative `addSubElement` call
inside the subclass constructor, plus a single `getSubElements()` provided by
the base.

```ts
abstract class CompositeElement {
  /**
   * Register a sub-element. Called by the subclass constructor (or by
   * `setup()` when the sub-element's pin nodes depend on internal nodes
   * allocated during setup; see PinBinder below).
   *
   *   name      — local handle; resolved by `subElement(name)` later.
   *   element   — already-constructed AnalogElement (factory output).
   *
   * The base appends to its internal child list in declaration order; that
   * list IS the list returned by `getSubElements()` and IS the order used by
   * forwarded `setup()` / `load()` / `initState()` calls (per
   * NGSPICE_LOAD_ORDER discipline — see "Setup-order discipline" below).
   */
  protected addSubElement(name: string, element: AnalogElement): void;

  /** Resolve a previously-registered sub-element by its local name. */
  protected subElement<T extends AnalogElement>(name: string): T;

  /** Final (non-overridable) implementation supplied by the base. */
  protected getSubElements(): readonly AnalogElement[];
}
```

The existing `protected abstract getSubElements()` becomes a `protected
getSubElements()` with a concrete implementation. Subclasses that want a
non-default order (rare; see optocoupler discussion below) can still override.

### 3. Typed pin-binding API

Replace `(this._q1 as any)._pinNodes.set("B", node)` with a typed call. The
binding is a per-sub-element operation that runs during the composite's
`setup()` (after internal nodes are allocated). Add:

```ts
abstract class CompositeElement {
  /**
   * Bind one of `child`'s pin labels to an MNA node id. The default
   * implementation mutates `child._pinNodes`; sub-element classes that need
   * additional bookkeeping (e.g. cached node refs, recompute of derived
   * quantities) can override `setPinNode()` on themselves and the base will
   * delegate to it when present.
   */
  protected bindSubPin(child: AnalogElement, pinLabel: string, nodeId: number): void;
}
```

Detection rule (matches current `VsenseSubElement.setPinNode` /
`CccsSubElement.setPinNode` shape in `optocoupler.ts:154-156, 235-237`):

- If `typeof (child as any).setPinNode === "function"`, call it.
- Else mutate `child._pinNodes.set(pinLabel, nodeId)` (the only public field in
  the `AnalogElement` interface that holds pin maps — `analog-types.ts:261+`).

The composite never reaches into `child` via `as any` again. The few
sub-element classes that need extra setPinNode logic (VsenseSubElement,
CccsSubElement) already implement the method — the base just calls it.

### 4. Setup-order discipline

The ngspice contract is: device load order is a per-device-type ordinal in
`DEVices[]` (`ref/ngspice/src/spicelib/devices/dev.c`), surfaced in digiTS as
`NGSPICE_LOAD_ORDER` (`src/core/analog-types.ts:53-71`). Within a composite,
sub-elements are independent device instances of possibly different types, and
the composite's own outer wrapper occupies a single `ngspiceLoadOrder` bucket
(see comment at `analog-types.ts:82-90`).

The base provides:

```ts
abstract class CompositeElement {
  /**
   * Default order is the order in which `addSubElement` was called. Per the
   * NGSPICE_LOAD_ORDER discipline, that order SHOULD be NGSPICE-ascending
   * (lower-ordinal sub-elements first) so that lazy sparse-matrix index
   * assignment matches what ngspice would produce for the equivalent
   * .subckt expansion. The base does NOT re-sort — the subclass is
   * responsible for declaring sub-elements in NGSPICE_LOAD_ORDER ascending
   * order. A debug-mode assertion at registration time MAY check for
   * monotonic ordinals.
   */
}
```

The reason the base does not sort: some composites have a
`findBranchFor` dependency between two sub-elements (e.g. CCCS reads VSRC's
branch in optocoupler) where the dependent must be set up after the provider.
Ordinals alone don't capture this; the subclass must order.

### 5. Default `load()` delegation

The existing `CompositeElement.load(ctx)` already iterates
`getSubElements()` and calls each child's `load(ctx)`. That is the canonical
delegation — subclasses with extra glue (composite-owned matrix handles, RS-FF
state, etc.) call `super.load(ctx)` and then add their own stamps, OR
override entirely (timer-555 case). No change.

### 6. State partitioning (`initState`)

The existing `CompositeElement.initState(pool)` already walks
`getSubElements()`, assigns each pool-backed child a contiguous state base,
and recurses. That is the contract; remove all bespoke `initState`
implementations that duplicate it (timer-555 has its own; transmission-line
has its own — both should reduce to the base implementation once their
`stateSchema` declares the latch slot). See per-site specs.

## ngspice parity citations (verified)

- **Defaults merge — `BJTmParam` / `bjtsetup` defaults block**

  `ref/ngspice/src/spicelib/devices/bjt/bjtmpar.c:21-473` records every
  `.MODEL`-line param into `BJTmodel` and sets its `*Given` flag (one
  `case` per param, e.g. `BJT_MOD_BF` → `mods->BJTbetaF = value->rValue;
  mods->BJTbetaFGiven = TRUE`).

  `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c:35-505` then walks
  `if (!model->BJT*Given) model->BJT* = <literal default>` for every
  `.MODEL` param. Examples verified by hand:
  - `bjtsetup.c:47-48`: `BJTsatCur = 1e-16` if `!BJTsatCurGiven`
  - `bjtsetup.c:50-51`: `BJTbetaF = 100` if `!BJTbetaFGiven`
  - `bjtsetup.c:53-54`: `BJTemissionCoeffF = 1` if `!BJTemissionCoeffFGiven`

- **Defaults merge — `DIOmParam` / `diosetup` defaults block**

  `ref/ngspice/src/spicelib/devices/dio/diompar.c:17-220` (full file) is
  the diode equivalent of `BJTmParam`: per-case `mods->DIO* = value->rValue;
  mods->DIO*Given = TRUE`. The defaults-fill block lives in `diosetup.c`
  (same shape as bjtsetup.c).

- **`.subckt` expansion**

  `ref/ngspice/src/frontend/subckt.c:42-56` (file header comment): "Expand
  all subcircuits in the deck. … whenever a line that starts with 'x' is
  found, copy the subcircuit associated with that name and splice it in.
  … the nodes in the spliced-in stuff must be unique, so when we copy it,
  append 'subcktname:' to each node." `subckt.c:87` declares the
  expansion entry point `static struct line *doit(struct line *deck,
  wordlist *modnames)`.

  Implication for digiTS: ngspice has no runtime "composite element"; by
  the time the simulator sees devices they are first-class instances with
  globally renamed nodes. digiTS keeps the composite at runtime (because
  the editor needs a single user-visible object), but the sub-element
  list returned by `getSubElements()` IS the digiTS analogue of ngspice's
  post-`doit()` flat device list, and the composite's
  `setup()`-time `ctx.makeVolt(label, "internal")` is the analogue of
  ngspice's `subname:` node renaming.

- **Engine sub-element walk**

  `src/solver/analog/analog-engine.ts:1366-1390` (existing code): the
  recursive `_buildDeviceMap` walks composites via
  `el.getSubElements()`, fallback `el._subElements`. After the
  refactor only `getSubElements()` remains; the `_subElements` legacy
  branch is removed (transmission-line is the last user — see
  `composite-transmission-line.md`).

## Migration shape — SCR (the simplest example)

Before (`src/components/semiconductors/scr.ts:63-167`):

```ts
function makeNpnProps(BF, IS, RC, RB, RE, AREA, TEMP): PropertyBag { … }
function makePnpProps(BR, IS, RC, RB, RE, AREA, TEMP): PropertyBag { … }

class ScrCompositeElement implements AnalogElement {
  readonly _q1: AnalogElement;
  readonly _q2: AnalogElement;
  // … 80 lines of pinNodes, setup(), load(), getSubElements()
}

function createScrElement(pinNodes, props, _getTime) {
  const BF = props.getModelParam("BF"); /* … 7 more */
  const npnProps = makeNpnProps(BF, IS, RC, RB, RE, AREA, TEMP);
  const pnpProps = makePnpProps(BR, IS, RC, RB, RE, AREA, TEMP);
  const q1 = createBjtL1Element(1, false)(/* placeholder pin nodes */);
  const q2 = createBjtL1Element(-1, false)(/* placeholder pin nodes */);
  return new ScrCompositeElement(label, pinNodes, q1, q2);
}
```

After:

```ts
class ScrCompositeElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;
  readonly stateSchema = SCR_COMPOSITE_SCHEMA;  // empty; children own state

  private _vintNode = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super();
    this._pinNodes = new Map(pinNodes);

    const BF = props.getModelParam<number>("BF");
    const BR = props.getModelParam<number>("BR");
    const IS = props.getModelParam<number>("IS");
    const RC = props.getModelParam<number>("RC");
    const RB = props.getModelParam<number>("RB");
    const RE = props.getModelParam<number>("RE");
    const AREA = props.getModelParam<number>("AREA");
    const TEMP = props.getModelParam<number>("TEMP");

    // Q1 NPN, Q2 PNP — internal node ids supplied during setup().
    const q1 = createBjtL1Element(+1, false)(
      new Map([["B", pinNodes.get("G")!], ["C", -1], ["E", pinNodes.get("K")!]]),
      PropertyBag.forModel(BJT_SPICE_L1_NPN_DEFAULTS, { BF, IS, RC, RB, RE, AREA, TEMP }),
      () => 0,
    );
    const q2 = createBjtL1Element(-1, false)(
      new Map([["B", -1], ["C", pinNodes.get("G")!], ["E", pinNodes.get("A")!]]),
      PropertyBag.forModel(BJT_SPICE_L1_PNP_DEFAULTS, { BR, IS, RC, RB, RE, AREA, TEMP }),
      () => 0,
    );
    this.addSubElement("Q1", q1);
    this.addSubElement("Q2", q2);
  }

  setup(ctx: SetupContext): void {
    this._vintNode = ctx.makeVolt(this.label, "latch");
    const q1 = this.subElement<AnalogElement>("Q1");
    const q2 = this.subElement<AnalogElement>("Q2");
    this.bindSubPin(q1, "C", this._vintNode);   // Q1 NPN: C=Vint
    this.bindSubPin(q2, "B", this._vintNode);   // Q2 PNP: B=Vint
    super.setup(ctx);                           // forwards to Q1 then Q2
  }

  getInternalNodeLabels(): readonly string[] {
    return ["latch"];
  }

  getPinCurrents(_rhs: Float64Array): number[] { return [0, 0, 0]; }

  setParam(key: string, value: number): void {
    const q1 = this.subElement<AnalogElement>("Q1");
    const q2 = this.subElement<AnalogElement>("Q2");
    if (key === "BF") q1.setParam!("BF", value);
    else if (key === "BR") q2.setParam!("BR", value);
    else if (["IS", "RC", "RB", "RE", "AREA", "TEMP"].includes(key)) {
      q1.setParam!(key, value);
      q2.setParam!(key, value);
    }
  }
}
```

The two `make*Props` helpers are gone. The two `_pinNodes.set("B", ...)` /
`_pinNodes.set("C", ...)` casts are replaced by `bindSubPin(...)`. The
explicit Q1/Q2 fields on the composite are gone — `subElement("Q1")` resolves
via the base.

## Tensions / uncertainties

1. **Should `real-opamp` become a `CompositeElement`?**

   `src/components/active/real-opamp.ts:331-640` is structurally a single MNA
   element with closure-captured state (`vIntPrev`, `outputSaturated`,
   `slewLimited`, …) and no real sub-elements — it allocates its own
   handles directly via `solver.allocElement(...)` in `setup()`. The
   `railLim`-style NR limiter discipline (§K1 in `test-fix-jobs.md`) is a
   per-element NR contract, not a composite shape. **Recommendation: real-
   opamp stays a leaf `PoolBackedAnalogElement`; the §K1 rail-limiter work
   is independent of the composite refactor.** This is the closest call in
   the rollout list and is flagged for user review.

2. **Optocoupler — `setPinNode` already exists on two of four children**

   `VsenseSubElement` (`optocoupler.ts:154-156`) and `CccsSubElement`
   (`optocoupler.ts:235-237`) implement `setPinNode(label, node)`. The diode
   and BJT children do not — the existing code uses
   `(this._dLed as any)._pinNodes.set("K", nSenseMid)` /
   `(this._bjtPhoto as any)._pinNodes.set("B", nBase)`. The proposed
   `bindSubPin()` falls back to direct `_pinNodes.set()` for those, so the
   diode/BJT factories don't need a new method. If the user prefers a
   uniform contract, `setPinNode` can be added to `AnalogElement` as
   `optional?` — that's a downstream interface tweak, not blocking.

3. **`CompositeElement` already exists but is `poolBacked: true`**

   `composite-element.ts:39` declares `readonly poolBacked = true as const`,
   and `stateSize` is a getter that sums children. SCR/TRIAC/DIAC have no
   composite-level state of their own; their composite `stateSize` is purely
   the sum of children's state. That's correct under the existing design.
   No change needed — but specs for SCR/TRIAC/DIAC must NOT define a
   composite-level slot count.

4. **Behavioral families already extend `CompositeElement`**

   The behavioral-gate, behavioral-remaining (Driver, DriverInv, Splitter,
   SevenSeg, ButtonLED), and behavioral-sequential (Counter, Register,
   CounterPreset) classes already extend `CompositeElement`. They need
   only the `PropertyBag.forModel` migration where applicable (most do
   not instantiate sub-element prop bags from defaults — they construct
   `DigitalInputPinModel` / `DigitalOutputPinModel` from
   `ResolvedPinElectrical` directly, which is a different code path).
   See `composite-behavioral-families.md`.

5. **`getSubElements()` becomes non-virtual on the base**

   The base will provide a final `getSubElements()` that returns the array
   built from `addSubElement` calls. The current abstract
   `protected abstract getSubElements()` declaration in
   `composite-element.ts:49` becomes `protected getSubElements()` with a
   concrete body. Subclasses that currently implement `getSubElements()`
   manually (every behavioral family) must either remove their override
   and use `addSubElement`, OR keep the override (which still satisfies
   the contract). The migration path is per-subclass; both shapes will
   coexist during rollout.

## Out of scope (escalations)

- Whether `setPinNode` should be added as an optional method on the
  `AnalogElement` interface (`src/core/analog-types.ts:261+`) rather than
  duck-typed inside `bindSubPin`. Both options work; the duck-typed option
  is the smaller surface change. **User decision needed before agent dispatch.**
- Whether `PropertyBag.forModel` should also accept (and store) the
  `ParamDef[]` schema so unknown-key validation produces a higher-quality
  error message than just "valid: <list>". The current `deviceParams()`
  helper in `model-params.ts:84-94` already does schema validation; the
  cleanest design folds that into `forModel`. **User decision needed.**
