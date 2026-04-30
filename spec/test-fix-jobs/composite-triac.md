# composite-triac

## Site

- File: `src/components/semiconductors/triac.ts`
- Class: `TriacCompositeElement` (currently lines 72-191)
- Factory: `createTriacElement` (lines 227-272)
- Unauthorized helpers in working tree: `makeTriacNpnProps`,
  `makeTriacPnpProps` (`triac.ts:197-225`, +41 lines)

## Sub-elements

Anti-parallel pair of two-transistor SCR latches sharing the gate. Four BJT
sub-elements:

| Name | Device | Default param set | ngspice citation |
|---|---|---|---|
| `Q1` | BJT NPN (SCR1) | `BJT_NPN_DEFAULTS` merged with `{ BF, IS, RC, RB, RE, AREA, TEMP }` | `bjtsetup.c:35-505`, `bjtload.c` |
| `Q2` | BJT PNP (SCR1) | `BJT_PNP_DEFAULTS` merged with `{ BR, IS, RC, RB, RE, AREA, TEMP }` | same |
| `Q3` | BJT NPN (SCR2) | `BJT_NPN_DEFAULTS` merged with `{ BF, IS, RC, RB, RE, AREA, TEMP }` | same |
| `Q4` | BJT PNP (SCR2) | `BJT_PNP_DEFAULTS` merged with `{ BR, IS, RC, RB, RE, AREA, TEMP }` | same |

`BJT_NPN_DEFAULTS` / `BJT_PNP_DEFAULTS` exported from
`src/components/semiconductors/bjt.ts:57+, 86+`.

The current bug: the TRIAC's own `TRIAC_PARAM_DEFAULTS` (`triac.ts:53-66`)
declares only 8 keys (`BF, IS, BR, RC, RB, RE, AREA, TEMP`). When the
sub-element BJT factory reads `props.getModelParam("NF")` (BJT's NF emission
coefficient — declared in `BJT_NPN_DEFAULTS`), the lookup throws
`PropertyBag: model param "NF" not found`. The unauthorized helpers
`makeTriacNpnProps` / `makeTriacPnpProps` work around this by spreading
`BJT_NPN_DEFAULTS` first and overriding the 7 TRIAC keys on top — exactly
the pattern that `PropertyBag.forModel(...)` replaces.

## Internal nodes

Two latch nodes, allocated in `setup()`:

| Label | Purpose |
|---|---|
| `latch1` | Vint1 — SCR1 latch (between Q1 collector and Q2 base) |
| `latch2` | Vint2 — SCR2 latch (between Q3 collector and Q4 base) |

`getInternalNodeLabels()` returns `["latch1", "latch2"]`.

## Setup-order

`NGSPICE_LOAD_ORDER.BJT = 2`. All four sub-elements are in the same bucket.
Declaration order is Q1, Q2, Q3, Q4 to match what ngspice would produce
for the equivalent `.subckt` expansion of two anti-parallel SCR latches.

The composite's outer `ngspiceLoadOrder` is `BJT` (matching `triac.ts:75`).

## Load delegation

Default `super.load(ctx)` order: Q1, Q2, Q3, Q4. No composite-level glue
stamps. The override at `triac.ts:147-152` collapses to the base.

## Specific quirks

- **Setup pin-binding**: each BJT child's `setup()` reads its own
  `_pinNodes` for B/C/E. Internal latch nodes must be allocated before the
  children are setup. Same shape as SCR.
- **Topology** (verbatim from current code at `triac.ts:120-138`):
  - Q1 NPN SCR1: B=G, C=Vint1, E=MT1
  - Q2 PNP SCR1: B=Vint1, C=G, E=MT2
  - Q3 NPN SCR2: B=G, C=Vint2, E=MT2
  - Q4 PNP SCR2: B=Vint2, C=G, E=MT1
- **`setParam` routing**: `BF` → {Q1, Q3}; `BR` → {Q2, Q4}; `IS|RC|RB|RE|
  AREA|TEMP` → all four. Current routing at `triac.ts:158-174` is correct
  and stays.
- **`ngspiceNodeMap` injection** (`triac.ts:245, 253, 261, 269`): each BJT
  child gets `(q as any).ngspiceNodeMap = { B: "base", C: "col", E: "emit"
  }`. This is a separate concern from prop merging — it's a hint to the
  netlist generator. Stays unchanged after refactor; the base does not need
  to know about it.
- **No composite-level state**: same as SCR. The base aggregates child
  state via `CompositeElement.stateSize`.

## Migration shape

```ts
class TriacCompositeElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;
  readonly stateSchema: StateSchema = TRIAC_COMPOSITE_SCHEMA;  // empty

  private _vint1Node = -1;
  private _vint2Node = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super();
    this._pinNodes = new Map(pinNodes);

    const BF   = props.getModelParam<number>("BF");
    const BR   = props.getModelParam<number>("BR");
    const IS   = props.getModelParam<number>("IS");
    const RC   = props.getModelParam<number>("RC");
    const RB   = props.getModelParam<number>("RB");
    const RE   = props.getModelParam<number>("RE");
    const AREA = props.getModelParam<number>("AREA");
    const TEMP = props.getModelParam<number>("TEMP");

    const npnProps = () => PropertyBag.forModel(BJT_NPN_DEFAULTS, { BF, IS, RC, RB, RE, AREA, TEMP });
    const pnpProps = () => PropertyBag.forModel(BJT_PNP_DEFAULTS, { BR, IS, RC, RB, RE, AREA, TEMP });

    const mt1 = pinNodes.get("MT1")!;
    const mt2 = pinNodes.get("MT2")!;
    const g   = pinNodes.get("G")!;

    const q1 = createBjtElement(    new Map([["B", g], ["C", -1], ["E", mt1]]), npnProps(), () => 0);
    const q2 = createPnpBjtElement( new Map([["B", -1], ["C", g], ["E", mt2]]), pnpProps(), () => 0);
    const q3 = createBjtElement(    new Map([["B", g], ["C", -1], ["E", mt2]]), npnProps(), () => 0);
    const q4 = createPnpBjtElement( new Map([["B", -1], ["C", g], ["E", mt1]]), pnpProps(), () => 0);

    for (const q of [q1, q2, q3, q4]) {
      (q as any).ngspiceNodeMap = { B: "base", C: "col", E: "emit" };
    }

    this.addSubElement("Q1", q1);
    this.addSubElement("Q2", q2);
    this.addSubElement("Q3", q3);
    this.addSubElement("Q4", q4);
  }

  setup(ctx: SetupContext): void {
    this._vint1Node = ctx.makeVolt(this.label, "latch1");
    this._vint2Node = ctx.makeVolt(this.label, "latch2");
    this.bindSubPin(this.subElement("Q1"), "C", this._vint1Node);
    this.bindSubPin(this.subElement("Q2"), "B", this._vint1Node);
    this.bindSubPin(this.subElement("Q3"), "C", this._vint2Node);
    this.bindSubPin(this.subElement("Q4"), "B", this._vint2Node);
    super.setup(ctx);
  }

  getInternalNodeLabels(): readonly string[] { return ["latch1", "latch2"]; }
  getPinCurrents(_rhs: Float64Array): number[] { return [0, 0, 0]; }

  setParam(key: string, value: number): void {
    const q1 = this.subElement<AnalogElement>("Q1");
    const q2 = this.subElement<AnalogElement>("Q2");
    const q3 = this.subElement<AnalogElement>("Q3");
    const q4 = this.subElement<AnalogElement>("Q4");
    if (key === "BF") { q1.setParam!("BF", value); q3.setParam!("BF", value); }
    else if (key === "BR") { q2.setParam!("BR", value); q4.setParam!("BR", value); }
    else if (["IS", "RC", "RB", "RE", "AREA", "TEMP"].includes(key)) {
      q1.setParam!(key, value); q2.setParam!(key, value);
      q3.setParam!(key, value); q4.setParam!(key, value);
    }
  }
}
```

The two unauthorized helpers `makeTriacNpnProps` and `makeTriacPnpProps`
(lines 197-225) are deleted. The factory drops to a one-liner:
`return new TriacCompositeElement(pinNodes, props);`

## Resolves

- `src/components/semiconductors/__tests__/triac.test.ts :: triggers_triac`
  — currently fails with `PropertyBag: model param "NF" not found`
  (test-failures.json:35). Replaced by `PropertyBag.forModel(BJT_NPN_DEFAULTS,
  …)` which fills NF from the defaults record.
- All other TRIAC tests in the same file (any cluster of NF / NR / ISE /
  ISC / VAF / IKF / NE failures from earlier rounds) — same root cause.

## Category

`architecture-fix`
