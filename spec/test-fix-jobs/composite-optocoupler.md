# composite-optocoupler

## Site

- File: `src/components/active/optocoupler.ts`
- Class: `OptocouplerCompositeElement` (currently lines 286-391)
- Inline sub-element classes: `VsenseSubElement` (lines 137-205),
  `CccsSubElement` (lines 215-280) — these stay; they ARE first-class
  `AnalogElement` implementations and the only pin-binding glue they own
  is the existing `setPinNode(label, node)` method.
- Factory: `createOptocouplerElement` (lines 397-440)

## Sub-elements

Four sub-elements implementing the F4b composition (LED → 0V sense →
CCCS → photoBJT):

| Name | Device | Default param set | ngspice citation |
|---|---|---|---|
| `dLed` | Diode (LED input) | `DIODE_PARAM_DEFAULTS` merged with `{ IS, N }` from optocoupler params | `diosetup.c` + `dioload.c:120-441` |
| `vSense` | Inline `VsenseSubElement` (0-volt sense source) | none — no model params | `vsrcset.c:40-55` (4-entry TSTALLOC), `vsrcload.c:43-46` |
| `cccsCouple` | Inline `CccsSubElement` (CTR × I_LED → photoBase) | gain = `ctr` (composite-internal), no .MODEL | `cccsset.c:30-50`, `cccsload.c` |
| `bjtPhoto` | BJT NPN (phototransistor) | `BJT_NPN_DEFAULTS` (no caller overrides) | `bjtsetup.c:35-505` + `bjtload.c` |

The two prop-bag adapter helpers `makeLedProps` (`optocoupler.ts:116-121`)
and `makeBjtProps` (`optocoupler.ts:123-127`) are eliminated: the LED and
BJT children get their props from `PropertyBag.forModel(...)` directly.

## Internal nodes

Two nodes, allocated in `setup()`:

| Label | Purpose |
|---|---|
| `senseMid` | LED cathode / VSrc positive — measures I_LED via VSrc branch |
| `base` | Phototransistor base node — driven by CCCS output |

`getInternalNodeLabels()` returns `["senseMid", "base"]`.

## Setup-order

This composite has a `findBranch` dependency: `cccsCouple.setup(ctx)` calls
`ctx.findBranch(vSenseLabel)`, which requires `vSense.setup(ctx)` to have
run first (so its branch index is allocated). Setup order is therefore:

1. `dLed` (DIO bucket = 22, `diosetup.c:232-238`, 7 entries)
2. `vSense` (VSRC bucket = 48, `vsrcset.c:52-55`, 4 entries; allocates branch)
3. `cccsCouple` (CCCS bucket = 18, `cccsset.c:49-50`, 2 entries; reads vSense branch)
4. `bjtPhoto` (BJT bucket = 2, `bjtsetup.c:435-464`, 23 entries)

This is NOT NGSPICE_LOAD_ORDER ascending — the BJT bucket has the lowest
ordinal (2) but must run last because it shares the `base` internal node
with cccsCouple's output. The dependency graph forces the order; the
composite's outer `ngspiceLoadOrder` is `DIO` (matching `optocoupler.ts:289`).

The base does NOT auto-sort. The subclass declares `addSubElement` calls in
the order above, and `super.setup(ctx)` walks them in declaration order.

## Load delegation

Default `super.load(ctx)` order matches setup order: dLed → vSense →
cccsCouple → bjtPhoto. The current override at `optocoupler.ts:357-369`
collapses to the base.

## Specific quirks

- **`setPinNode` already exists on VsenseSubElement and CccsSubElement.**
  `optocoupler.ts:154-156, 235-237`. The new `bindSubPin()` on the base
  detects this and delegates. The diode and BJT children don't have
  `setPinNode` — for them, `bindSubPin` falls back to mutating
  `_pinNodes`. No `as any` cast in either path.
- **Galvanic isolation**: no shared MNA node between LED side
  (anode/cathode) and BJT side (collector/emitter). The CCCS coupling is
  algebraic only. The composite topology preserves this; the
  `bindSubPin` calls only wire internal nodes (senseMid, base) to the
  appropriate sub-elements.
- **`setParam`** is currently a no-op (`optocoupler.ts:371-373`). User-
  facing optocoupler params (ctr, Is, n) are baked into sub-elements at
  factory time and not currently hot-loadable. **Escalation**: per the
  user's hot-loadable-params memory, this is a defect. After the refactor,
  `setParam("ctr", v)` should re-read into the CccsSubElement's gain;
  `setParam("Is", v)` and `setParam("n", v)` should forward to the LED
  diode's `setParam` (which already handles per-key writes). Spec the
  routing — but flag for user decision whether the hot-load fix lands in
  the same PR as the composite refactor.
- **Output pin model**: optocoupler has no DigitalOutputPinModel — the
  collector/emitter are raw analog pins. No pin-model children, no CAP
  children to walk. `getPinCurrents` returns `[0, 0, 0, 0]` placeholder
  (current code) — this is the same as SCR/TRIAC and is its own
  separate concern.
- **No composite-level state**: aggregated by base from children.

## Migration shape

```ts
class OptocouplerCompositeElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.DIO;
  readonly stateSchema: StateSchema = OPTOCOUPLER_COMPOSITE_SCHEMA;  // empty

  private _nSenseMid = -1;
  private _nBase = -1;
  private readonly _ctr: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag, getTime: () => number) {
    super();
    this._pinNodes = new Map(pinNodes);
    const ctr = props.getModelParam<number>("ctr");
    const Is  = props.getModelParam<number>("Is");
    const n   = props.getModelParam<number>("n");
    this._ctr = ctr;

    const nAnode     = pinNodes.get("anode")!;
    const nCathode   = pinNodes.get("cathode")!;
    const nCollector = pinNodes.get("collector")!;
    const nEmitter   = pinNodes.get("emitter")!;
    const instanceLabel = "Optocoupler";

    const dLed = createDiodeElement(
      new Map([["A", nAnode], ["K", -1]]),       // K rebound in setup()
      PropertyBag.forModel(DIODE_PARAM_DEFAULTS, { IS: Is, N: n }),
      getTime,
    );
    (dLed as any).label = `${instanceLabel}_dLed`;

    const vSense = new VsenseSubElement(`${instanceLabel}_vSense`, -1, nCathode);
    const cccsCouple = new CccsSubElement(
      `${instanceLabel}_cccsCouple`, -1, nEmitter, ctr, vSense.label,
    );

    const bjtPhoto = createBjtElement(
      new Map([["B", -1], ["C", nCollector], ["E", nEmitter]]),
      PropertyBag.forModel(BJT_NPN_DEFAULTS, {}),
      getTime,
    );
    (bjtPhoto as any).label = `${instanceLabel}_bjtPhoto`;

    // Declaration order = NGSPICE setup order with the topology dependency.
    this.addSubElement("dLed", dLed);
    this.addSubElement("vSense", vSense);
    this.addSubElement("cccsCouple", cccsCouple);
    this.addSubElement("bjtPhoto", bjtPhoto);
  }

  setup(ctx: SetupContext): void {
    this._nSenseMid = ctx.makeVolt(this.label || "optocoupler", "senseMid");
    this._nBase     = ctx.makeVolt(this.label || "optocoupler", "base");

    this.bindSubPin(this.subElement("dLed"),       "K",   this._nSenseMid);
    this.bindSubPin(this.subElement("vSense"),     "pos", this._nSenseMid);
    this.bindSubPin(this.subElement("cccsCouple"), "pos", this._nBase);
    this.bindSubPin(this.subElement("bjtPhoto"),   "B",   this._nBase);

    super.setup(ctx);  // dLed → vSense → cccsCouple → bjtPhoto
  }

  getInternalNodeLabels(): readonly string[] { return ["senseMid", "base"]; }
  getPinCurrents(_rhs: Float64Array): number[] { return [0, 0, 0, 0]; }

  setParam(key: string, value: number): void {
    if (key === "ctr") {
      // CccsSubElement.gain is currently `private readonly` — see escalation.
      // The fix is a typed setParam("gain", ...) on CccsSubElement.
      this.subElement<AnalogElement>("cccsCouple").setParam!("gain", value);
    } else if (key === "Is") {
      this.subElement<AnalogElement>("dLed").setParam!("IS", value);
    } else if (key === "n") {
      this.subElement<AnalogElement>("dLed").setParam!("N", value);
    }
  }
}
```

The two `make*Props` helpers (`optocoupler.ts:116-127`) are gone. The
`(this._dLed as any)._pinNodes.set(...)` (`optocoupler.ts:333`) and
`(this._bjtPhoto as any)._pinNodes.set(...)` (`optocoupler.ts:344`) are
gone. The hand-rolled `getSubElements()` (`optocoupler.ts:383-390`) is
gone (provided by base).

## Resolves

This refactor is the §K3 / §K6 deliverable per the existing test-fix-jobs
notes. Specifically:

- `src/components/active/__tests__/optocoupler.test.ts ::
  current_transfer`
- `src/components/active/__tests__/optocoupler.test.ts ::
  galvanic_isolation`
- `src/components/active/__tests__/optocoupler.test.ts ::
  ctr_scaling`
- `src/components/active/__tests__/optocoupler.test.ts ::
  led_forward_voltage`

(per `spec/test-fix-jobs.md` §K3 line 161, the optocoupler is "scaffolding
only; tests still fail until §K6 lands". The refactor here IS §K6 for
this site.)

## Category

`architecture-fix`

## Out of scope (escalations)

- **`setParam` hot-load contract for `ctr`**: `CccsSubElement.gain` is
  declared `private readonly` and stamped at load time. To support
  `setParam("ctr", v)`, `gain` must become mutable and `setParam("gain",
  v)` must be added. The user's hot-loadable-params memory makes this a
  required fix. Escalating because it touches `CccsSubElement` outside
  the composite-base scope. **User decision needed.**
- **`getPinCurrents` is `[0, 0, 0, 0]`**: a placeholder, same as
  SCR/TRIAC. Real per-pin current resolution requires sub-element pin-
  current aggregation. Out of scope for this refactor; flag for follow-up.
