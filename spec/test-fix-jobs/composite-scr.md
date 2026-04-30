# composite-scr

## Site

- File: `src/components/semiconductors/scr.ts`
- Class: `ScrCompositeElement` (currently lines 79-167)
- Factory: `createScrElement` (lines 173-209)

## Sub-elements

| Name | Device | Default param set | ngspice citation |
|---|---|---|---|
| `Q1` | BJT NPN, polarity = +1 | `BJT_SPICE_L1_NPN_DEFAULTS` (`src/components/semiconductors/bjt.ts:119+`) merged with `{ BF, IS, RC, RB, RE, AREA, TEMP }` from the SCR's own `SCR_PARAM_DEFAULTS` (`scr.ts:42-57`) | `bjtsetup.c:35-505` (defaults block) + `bjtload.c:1-end` (Gummel-Poon stamp) |
| `Q2` | BJT PNP, polarity = -1 | `BJT_SPICE_L1_PNP_DEFAULTS` (`src/components/semiconductors/bjt.ts:180+`) merged with `{ BR, IS, RC, RB, RE, AREA, TEMP }` | same as Q1 with PNP polarity |

The BJT NPN model owns ~30 ngspice parameters (`NF`, `NR`, `ISE`, `ISC`,
`VAF`, `VAR`, `IKF`, `IKR`, `NE`, `NC`, `M`, `TNOM`, `OFF`, `ICVBE`, `ICVCE`,
plus the seven the SCR exposes). Currently `makeNpnProps` /
`makePnpProps` (`scr.ts:63-73`) spread `BJT_SPICE_L1_NPN_DEFAULTS` /
`BJT_SPICE_L1_PNP_DEFAULTS` on top of the seven SCR-level overrides. After
the refactor that responsibility moves to `PropertyBag.forModel(...)`.

## Internal nodes

One node, allocated in `setup()`:

| Label | Purpose |
|---|---|
| `latch` | Vint — shared latch node between Q1 collector and Q2 base |

`getInternalNodeLabels()` returns `["latch"]`.

## Setup-order

`NGSPICE_LOAD_ORDER.BJT = 2` (`src/core/analog-types.ts:55`). Both sub-
elements are BJTs in the same bucket; declaration order is Q1 then Q2 so
that the deck-walk node-numbering matches what ngspice would produce for the
equivalent `.subckt` expansion `Q1 …; Q2 …`.

The composite's outer `ngspiceLoadOrder` is `BJT` (matching the existing
field at `scr.ts:82`).

## Load delegation

Default `super.load(ctx)` order: Q1 then Q2. No additional composite-level
stamps (no RS-FF glue, no shared matrix handles outside the children). The
override at `scr.ts:139-142` collapses to the base implementation.

## Specific quirks

- **Pin binding ordering**: `setup()` MUST allocate `latch` before forwarding
  to children, because each child's BJT `setup()` reads `_pinNodes.get("B"|
  "C"|"E")` to allocate its 23 TSTALLOC entries. The current code mutates
  `(this._q1 as any)._pinNodes.set("C", this._vintNode)` directly (lines
  125-132). After the refactor, this becomes:
  ```
  this._vintNode = ctx.makeVolt(this.label, "latch");
  this.bindSubPin(this.subElement("Q1"), "C", this._vintNode);
  this.bindSubPin(this.subElement("Q2"), "B", this._vintNode);
  super.setup(ctx);
  ```
- **`setParam` routing**: `BF` → Q1 only, `BR` → Q2 only, `IS|RC|RB|RE|AREA|
  TEMP` → both. Current routing at `scr.ts:144-153` is correct and stays.
- **No state of its own**: the SCR composite has zero state slots. Each BJT
  child carries its own 24-slot state (per `bjtsetup.c:366-367`). The base
  `CompositeElement.stateSize` getter sums children automatically.

## Migration shape (declarative)

```ts
class ScrCompositeElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;
  readonly stateSchema: StateSchema = SCR_COMPOSITE_SCHEMA;  // empty

  private _vintNode = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super();
    this._pinNodes = new Map(pinNodes);
    this.label = props.getOrDefault<string>("label", "") || "SCR";

    const BF   = props.getModelParam<number>("BF");
    const BR   = props.getModelParam<number>("BR");
    const IS   = props.getModelParam<number>("IS");
    const RC   = props.getModelParam<number>("RC");
    const RB   = props.getModelParam<number>("RB");
    const RE   = props.getModelParam<number>("RE");
    const AREA = props.getModelParam<number>("AREA");
    const TEMP = props.getModelParam<number>("TEMP");

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
    (q1 as any).label = `${this.label}#Q1`;
    (q2 as any).label = `${this.label}#Q2`;

    this.addSubElement("Q1", q1);
    this.addSubElement("Q2", q2);
  }

  setup(ctx: SetupContext): void {
    this._vintNode = ctx.makeVolt(this.label, "latch");
    this.bindSubPin(this.subElement("Q1"), "C", this._vintNode);
    this.bindSubPin(this.subElement("Q2"), "B", this._vintNode);
    super.setup(ctx);
  }

  getInternalNodeLabels(): readonly string[] { return ["latch"]; }
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

The factory shrinks to:

```ts
function createScrElement(pinNodes, props, _getTime) {
  return new ScrCompositeElement(pinNodes, props);
}
```

## Resolves

This refactor is structural (eliminates `makeNpnProps` / `makePnpProps`); it
does not directly change the SCR's electrical behavior, so SCR-specific tests
already pass. It does, however, set the precedent for TRIAC and unblocks the
TRIAC `NF not found` cluster:

- (no SCR-only test failures listed in `test-results/test-failures.json`).
- Indirectly enables the TRIAC fix (see `composite-triac.md`) which resolves
  `triggers_triac` (currently failing with `PropertyBag: model param "NF"
  not found`).

## Category

`architecture-fix`
