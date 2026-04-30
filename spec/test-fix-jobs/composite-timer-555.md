# composite-timer-555

## Site

- File: `src/components/active/timer-555.ts`
- Class: `Timer555CompositeElement` (currently lines 371-700)
- Inline sub-element class: `Timer555ResElement` (lines 134-182) —
  stays; it's a leaf RES.
- Factory: `createTimer555Element` (lines 706-763)

## Sub-elements

| Name | Device | Default param set | ngspice citation |
|---|---|---|---|
| `rDiv1` | `Timer555ResElement` (5kΩ) | none — fixed at construction | `ressetup.c:46-49` (4 entries) |
| `rDiv2` | `Timer555ResElement` (5kΩ) | same | same |
| `rDiv3` | `Timer555ResElement` (5kΩ) | same | same |
| `comp1` | `VCVSAnalogElement` (gain=1e6, threshold comparator) | none — gain hardcoded | `vcvsset.c:53-58` |
| `comp2` | `VCVSAnalogElement` (gain=1e6, trigger comparator) | same | same |
| `bjtDis` | BJT NPN (discharge transistor) | `BJT_NPN_DEFAULTS`, no overrides | `bjtsetup.c:35-505` + `bjtload.c` |
| `outModel` | `DigitalOutputPinModel` | constructed from inline literal `{rOut, cOut, …}` | behavioral, n/a |
| `childElements` | `AnalogCapacitorElement[]` (from outModel.collectPinModelChildren) | per-cap defaults | `capsetup.c:102-117` |

The single prop-bag adapter helper `makeBjtProps` (`timer-555.ts:354-358`)
is eliminated; the BJT child gets its props from
`PropertyBag.forModel(BJT_NPN_DEFAULTS, {})`.

## Internal nodes

Four nodes, allocated in `setup()`:

| Label | Purpose |
|---|---|
| `nLower` | R-divider lower tap (1/3 VCC) |
| `nComp1Out` | Threshold comparator output |
| `nComp2Out` | Trigger comparator output |
| `nDisBase` | Discharge BJT base — driven by RS-FF glue |

`getInternalNodeLabels()` returns the four labels in that order.

## Setup-order

The composite declares the order explicitly (per the comment block at
`timer-555.ts:466-477`):

1. `rDiv1`, `rDiv2`, `rDiv3` (RES bucket = 40)
2. `comp1`, `comp2` (VCVS bucket = 47)
3. `bjtDis` (BJT bucket = 2 — declared AFTER RES/VCVS because the BJT's
   pin nodes depend on `nDisBase`, which is allocated by the composite)
4. `outModel` and `childElements` (behavioral / CAP)
5. **Composite-owned glue handle** `_hDisBaseDisBase` (single
   `solver.allocElement(nDisBase, nDisBase)` for the RS-FF base-driver
   stamp) — allocated AFTER all sub-elements

This is the one rollout site where the composite owns its own MNA handle
beyond what its children allocate. The base must allow this: subclasses
can override `setup()`, call `super.setup(ctx)` for child forwarding,
then allocate composite-owned handles before returning.

The composite's outer `ngspiceLoadOrder` is currently `VCVS`
(`timer-555.ts:373`).

## Load delegation

The override at `timer-555.ts:586-651` is non-trivial — it interleaves
sub-element loads with composite-owned RS-FF state-update logic:

1. Load `rDiv1`, `rDiv2`, `rDiv3`
2. Load `comp1`, `comp2`
3. **RS-FF glue**: read `comp1Out` and `comp2Out` from `rhsOld`,
   compute SET/RESET signals, update latch state slot, drive `nDisBase`
   via the composite-owned handle.
4. Load `bjtDis`
5. Load `outModel` (after setting its `vOH` and logic level from latch)
6. Load `childElements`

This load shape is composite-specific and stays as an override. The base
does NOT collapse it.

## Specific quirks

- **Composite-level state**: 1 slot for the SR latch (`_stateBase_latch`,
  `timer-555.ts:411`). The composite's `stateSchema` should declare this
  slot explicitly (currently a stub at `timer-555.ts:379`). Once
  declared, `super.initState()` will allocate the latch slot at
  `_stateBase` and the children's state at `_stateBase + 1`.
- **`stateSize` getter** at `timer-555.ts:380-386` manually sums
  children. This collapses to the base implementation once the composite
  schema declares the latch slot, plus the children walk:
  `super.stateSize` (sum of pool-backed children) + 1 (latch). The base
  does the children sum for free; subclass adds the +1 explicitly.
- **`_bjtDis` is mutable** (`timer-555.ts:396`) — currently re-created in
  `setup()` once `nDisBase` is known, replacing a factory placeholder.
  After the refactor, `bjtDis` is constructed once at composite
  construction time (with placeholder pin -1 for B), `addSubElement`
  registers it, and `setup()` calls `bindSubPin(bjtDis, "B", nDisBase)`
  before forwarding. The mutable `_bjtDis` field goes away.
- **`accept()` override** (`timer-555.ts:653-658`) forwards to children's
  optional `accept` — this duplicates `CompositeElement.acceptStep`
  (`composite-element.ts:108-112`). Once registered through `addSubElement`,
  the base's `acceptStep` walks children automatically. The custom
  `accept` override at the composite goes away.
- **`outModel` and `childElements`**: `outModel.setup(ctx)` is conditional
  on `nOutNode > 0` (`timer-555.ts:538`). After the refactor, the
  composite either always registers `outModel` and `outModel.setup()`
  handles the no-op case internally, or the composite skips registration
  in the constructor if the OUT pin isn't bound. The cleaner shape is to
  always register and let `outModel.setup()` early-return — that matches
  the behavioral-gate pattern.
- **`getPinCurrents`** returns a real KCL-respecting 8-pin vector
  (`timer-555.ts:660-691`) — not a placeholder. Stays as a subclass
  override.

## Migration shape (sketch — full rollout is larger than other sites)

```ts
const TIMER555_COMPOSITE_SCHEMA: StateSchema = defineStateSchema(
  "Timer555Composite",
  [{ name: "Q_LATCH", doc: "RS flip-flop output (0 reset, 1 set)", init: { kind: "zero" } }],
);

class Timer555CompositeElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly stateSchema = TIMER555_COMPOSITE_SCHEMA;

  private _nLower = -1;
  private _nComp1Out = -1;
  private _nComp2Out = -1;
  private _nDisBase = -1;
  private _hDisBaseDisBase = -1;
  private _stateBase_latch = -1;
  private readonly _p: Timer555Props;

  constructor(pinNodes, props, getTime) {
    super();
    this._pinNodes = new Map(pinNodes);
    this._p = {
      vDrop:      props.getModelParam<number>("vDrop"),
      rDischarge: props.getModelParam<number>("rDischarge"),
    };

    this.addSubElement("rDiv1", new Timer555ResElement(R_DIV));
    this.addSubElement("rDiv2", new Timer555ResElement(R_DIV));
    this.addSubElement("rDiv3", new Timer555ResElement(R_DIV));

    const { expr, deriv } = makeVcvsComparatorExpression();
    this.addSubElement("comp1", new VCVSAnalogElement(expr, deriv, "V(ctrl)", "voltage"));
    this.addSubElement("comp2", new VCVSAnalogElement(expr, deriv, "V(ctrl)", "voltage"));

    const bjtDis = createBjtElement(
      new Map([["B", -1], ["C", -1], ["E", -1]]),
      PropertyBag.forModel(BJT_NPN_DEFAULTS, {}),
      getTime,
    ) as PoolBackedAnalogElement;
    this.addSubElement("bjtDis", bjtDis);

    const outModel = new DigitalOutputPinModel({ rOut: R_OUT, /* … */ });
    const nOutNode = pinNodes.get("OUT")!;
    if (nOutNode > 0) outModel.init(nOutNode, -1);
    this.addSubElement("outModel", outModel);

    for (const cap of collectPinModelChildren([outModel])) {
      this.addSubElement(`cap${cap.label}`, cap);
    }
  }

  setup(ctx: SetupContext): void {
    this._stateBase_latch = ctx.allocStates(1);
    this._stateBase = this._stateBase_latch;

    const nVcc  = this._pinNodes.get("VCC")!;
    const nCtrl = this._pinNodes.get("CTRL")!;
    const nGnd  = this._pinNodes.get("GND")!;
    const nThr  = this._pinNodes.get("THR")!;
    const nTrig = this._pinNodes.get("TRIG")!;
    const nDis  = this._pinNodes.get("DIS")!;

    this._nLower    = ctx.makeVolt(this.label, "nLower");
    this._nComp1Out = ctx.makeVolt(this.label, "nComp1Out");
    this._nComp2Out = ctx.makeVolt(this.label, "nComp2Out");
    this._nDisBase  = ctx.makeVolt(this.label, "nDisBase");

    // Bind divider chain
    this.bindSubPin(this.subElement("rDiv1"), "A", nVcc);
    this.bindSubPin(this.subElement("rDiv1"), "B", nCtrl);
    this.bindSubPin(this.subElement("rDiv2"), "A", nCtrl);
    this.bindSubPin(this.subElement("rDiv2"), "B", this._nLower);
    this.bindSubPin(this.subElement("rDiv3"), "A", this._nLower);
    this.bindSubPin(this.subElement("rDiv3"), "B", nGnd);

    // Bind comparators
    this.bindSubPin(this.subElement("comp1"), "ctrl+", nThr);
    this.bindSubPin(this.subElement("comp1"), "ctrl-", nCtrl);
    this.bindSubPin(this.subElement("comp1"), "out+",  this._nComp1Out);
    this.bindSubPin(this.subElement("comp1"), "out-",  nGnd);
    this.bindSubPin(this.subElement("comp2"), "ctrl+", this._nLower);
    this.bindSubPin(this.subElement("comp2"), "ctrl-", nTrig);
    this.bindSubPin(this.subElement("comp2"), "out+",  this._nComp2Out);
    this.bindSubPin(this.subElement("comp2"), "out-",  nGnd);

    // Bind discharge BJT
    this.bindSubPin(this.subElement("bjtDis"), "B", this._nDisBase);
    this.bindSubPin(this.subElement("bjtDis"), "C", nDis);
    this.bindSubPin(this.subElement("bjtDis"), "E", nGnd);

    super.setup(ctx);
    this._hDisBaseDisBase = ctx.solver.allocElement(this._nDisBase, this._nDisBase);
  }

  load(ctx: LoadContext): void {
    // Custom interleaved load: see "Load delegation" above.
    // … same as current timer-555.ts:586-651 body, but children resolved via this.subElement(...)
  }

  // initState collapses to base (which sees the +1 latch slot in stateSchema)
  // accept removed (base.acceptStep walks children for free)
}
```

The factory drops to `return new Timer555CompositeElement(pinNodes, props, getTime);`.

## Resolves

The 555 composite refactor is a precondition for §J22 (PB-TIMER555 stamp-
order golden re-record). Direct test-failure resolutions:

- (No active timer-555 test failures listed in current
  `test-results/test-failures.json`; per `spec/test-fix-jobs.md` the
  555-transient suite was failing pre-round and tagged for re-record after
  §K6.)
- Indirectly resolves `setup-stamp-order PB-TIMER555` (§J22) once the new
  emission shape is captured.

## Category

`architecture-fix`

## Out of scope (escalations)

- **`comp1Out` / `comp2Out` rhsOld read pattern**: the load body reads
  `rhsOld[nComp1Out]` and `rhsOld[nComp2Out]` to derive SET/RESET. Reading
  `rhsOld` (the previous NR iterate) for digital-threshold logic is the
  canonical ngspice pattern (`bsim*ld.c` polynomial-evaluation reads
  rhsOld), but tying RS-FF state to a 1e6-gain VCVS output that's still
  oscillating in early NR can prevent convergence. This is independent of
  the composite refactor; flag for separate review.
