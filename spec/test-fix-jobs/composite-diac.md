# composite-diac

## Site

- File: `src/components/semiconductors/diac.ts`
- Currently an anonymous object literal returned from
  `createDiacElement` (`diac.ts:40-119`); promote to a named class.
- Unauthorized edits in working tree: `+10` lines wrapping the literal in
  an `as unknown as AnalogElement` cast and adding `getSubElements()`
  manually.

## Sub-elements

Anti-parallel diode pair, both with breakdown enabled at the DIAC's
breakover voltage:

| Name | Device | Default param set | ngspice citation |
|---|---|---|---|
| `D_fwd` | Diode (anode=A, cathode=B) | `DIODE_PARAM_DEFAULTS` merged with caller-supplied DIAC params (BV, IS, N, etc.) | `diosetup.c` defaults block + `dioload.c:120-441` |
| `D_rev` | Diode (anode=B, cathode=A) | `DIODE_PARAM_DEFAULTS` merged with same | same |

`DIODE_PARAM_DEFAULTS` exported from `src/components/semiconductors/diode.ts`
and accepted as the registry's `params` field at `diac.ts:266-272` already.

Currently the diode factory is called with the parent `props` directly
(`diac.ts:64-65`), so the DIAC inherits the diode model's full defaults via
the registry's `params` field. After the refactor, sub-element prop bags are
explicit `PropertyBag.forModel(DIODE_PARAM_DEFAULTS, overrides)`, where
`overrides` is the parent's model params projected to just the diode-relevant
keys. (For DIAC there is no narrowing — every parent model param is also a
diode param. The merge is still the right contract for safety.)

## Internal nodes

None. DIAC's two diodes share the two external pins (A and B); no internal
latch or sense node. `getInternalNodeLabels()` returns `[]`.

## Setup-order

`NGSPICE_LOAD_ORDER.DIO = 22`. Declaration order is `D_fwd` then `D_rev`.

The composite's outer `ngspiceLoadOrder` is `DIO` (currently set at
`diac.ts:78`).

## Load delegation

Default `super.load(ctx)` order: `D_fwd` then `D_rev`. The current
`load()` override at `diac.ts:85-88` collapses to the base implementation.

`checkConvergence` and `getPinCurrents` need composite-level merging:

- `checkConvergence`: AND of the two children's results — already provided
  by `CompositeElement.checkConvergence` (which short-circuits on the first
  `false`). No override.
- `getPinCurrents`: sums the two children's per-pin currents to produce
  net current at A and B. Current logic at `diac.ts:96-107` is correct
  (D_fwd K = nodeB so its second-pin current contributes to A's net) and
  must be preserved as a `getPinCurrents` override.

## Specific quirks

- **Test failure** `blocks_below_breakover`: returns
  `4.758900560302758e+171` when expected `< 0.001`. Root cause likely the
  diode child's state slot is misaligned because the composite is an
  anonymous literal that has no real `_stateBase` ownership — the
  `_stateBase: -1` field on the literal is never updated by
  `initState()` because the literal isn't `poolBacked`. Promoting to a
  `CompositeElement` subclass fixes this: the base's `initState()` walks
  children and assigns each its own `_stateBase`. (The current
  "Cannot read properties of undefined (reading 'states')" shape from
  earlier rounds is the same root cause.)
- **`setParam` routing**: forwards every key to both children
  (`diac.ts:109-113`). Stays.
- **No composite-level state**: same as SCR/TRIAC.

## Migration shape

```ts
class DiacCompositeElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.DIO;
  readonly stateSchema: StateSchema = DIAC_COMPOSITE_SCHEMA;  // empty

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag, getTime: () => number) {
    super();
    this._pinNodes = new Map(pinNodes);
    const parentLabel = props.getOrDefault<string>("label", "D");
    this.label = parentLabel;

    const nodeA = pinNodes.get("A")!;
    const nodeB = pinNodes.get("B")!;

    const diodeOverrides: Record<string, number> = {};
    for (const k of props.getModelParamKeys()) {
      diodeOverrides[k] = props.getModelParam<number>(k);
    }

    const dFwd = createDiodeElement(
      new Map([["A", nodeA], ["K", nodeB]]),
      PropertyBag.forModel(DIODE_PARAM_DEFAULTS, diodeOverrides),
      getTime,
    );
    const dRev = createDiodeElement(
      new Map([["A", nodeB], ["K", nodeA]]),
      PropertyBag.forModel(DIODE_PARAM_DEFAULTS, diodeOverrides),
      getTime,
    );
    dFwd.label = `${parentLabel}#D_fwd`;
    dRev.label = `${parentLabel}#D_rev`;

    this.addSubElement("D_fwd", dFwd);
    this.addSubElement("D_rev", dRev);
  }

  getInternalNodeLabels(): readonly string[] { return []; }

  getPinCurrents(rhs: Float64Array): number[] {
    const dFwd = this.subElement<AnalogElement>("D_fwd");
    const dRev = this.subElement<AnalogElement>("D_rev");
    const fwd = dFwd.getPinCurrents(rhs);
    const rev = dRev.getPinCurrents(rhs);
    return [fwd[0] + rev[1], fwd[1] + rev[0]];
  }

  setParam(key: string, value: number): void {
    this.subElement<AnalogElement>("D_fwd").setParam!(key, value);
    this.subElement<AnalogElement>("D_rev").setParam!(key, value);
  }
}

export function createDiacElement(pinNodes, props, getTime): AnalogElement {
  return new DiacCompositeElement(pinNodes, props, getTime);
}
```

The `as unknown as AnalogElement` cast at `diac.ts:118` is gone.
The hand-rolled `getSubElements()` at `diac.ts:115-117` is gone (provided
by base). The `_stateBase` and `_pinNodes` literals at `diac.ts:75-77` are
gone (provided by `CompositeElement` and the constructor).

## Resolves

- `src/components/semiconductors/__tests__/diac.test.ts :: blocks_below_breakover`
  — currently fails with `expected 4.758900560302758e+171 to be less than
  0.001` (test-failures.json:23-32). Root cause: the anonymous-literal
  composite never gets its children's state slots initialized, so the diode
  load reads garbage state. Promotion to `CompositeElement` subclass fixes
  this via `super.initState()`.
- Any further DIAC tests in the same file with the
  `Cannot read properties of undefined (reading 'states')` failure shape
  from earlier rounds — same root cause.

## Category

`architecture-fix`
