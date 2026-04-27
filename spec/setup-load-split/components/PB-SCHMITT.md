# Task PB-SCHMITT

**digiTS file:** `src/components/active/schmitt-trigger.ts`
**Architecture:** composite. Decomposes into `DigitalInputPinModel` + `DigitalOutputPinModel` sub-elements; no VCVS branch. Hysteresis state stored at composite level.

Two registered component definitions share this spec:
- `SchmittInverting` (inverting = true)
- `SchmittNonInverting` (inverting = false)

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Pin models carry their own matrix allocations per `02-behavioral.md`.

Composite pin labels (from `buildSchmittPinDeclarations()`):
- `in` — input (pinLayout index 0)
- `out` — output (pinLayout index 1)

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments (parent pin → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `inModel` | DigitalInputPinModel | behavioral (02-behavioral.md) | `in` → input node | `"rIn"`, `"cIn"`, `"vIH"`, `"vIL"` → inModel |
| `outModel` | DigitalOutputPinModel | behavioral (02-behavioral.md) | `out` → output node | `"vOH"`, `"vOL"`, `"rOut"`, `"cOut"` → outModel |

`DigitalInputPinModel` and `DigitalOutputPinModel` are behavioral — they own their `setup()` bodies per `02-behavioral.md`. Each owns its own CAP companion child element for transient capacitance.

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const nIn  = pinNodes.get("in")!;
  const nOut = pinNodes.get("out")!;

  const spec = buildPinElectricalFromProps(props);
  const inModel  = new DigitalInputPinModel(spec, /*trackEdge=*/true);
  const outModel = new DigitalOutputPinModel(spec);

  if (nIn  > 0) inModel.init(nIn, 0);
  if (nOut > 0) outModel.init(nOut, -1);

  outModel.setLogicLevel(false);  // initial output low

  return new SchmittCompositeElement({ inModel, outModel, nIn, nOut, inverting, props });
}
```

## setup() body — composite forwards

```ts
setup(ctx: SetupContext): void {
  const nIn  = this._pinNodes.get("in")!;
  const nOut = this._pinNodes.get("out")!;

  // Composite-level hysteresis state: 1 slot
  this._stateBase = ctx.allocStates(1);

  // Forward to pin models (they allocate their own TSTALLOC entries)
  if (nIn  > 0) this._inModel.setup(ctx);
  if (nOut > 0) this._outModel.setup(ctx);

  // Forward to CAP children of pin models
  for (const child of this._childElements) {
    child.setup(ctx);
  }
}
```

## load() body — composite forwards

```ts
load(ctx: LoadContext): void {
  const vIn = ctx.rhsOld[this._nIn];

  // Apply hysteresis state machine (reads/writes _stateBase slot)
  const outputHigh = ctx.state0[this._stateBase] >= 0.5;
  let nextHigh = outputHigh;
  if (outputHigh && vIn < this._p.vTL) { nextHigh = false; }
  else if (!outputHigh && vIn > this._p.vTH) { nextHigh = true; }

  if (nextHigh !== outputHigh) {
    ctx.state0[this._stateBase] = nextHigh ? 1.0 : 0.0;
    const driveHigh = this._inverting ? !nextHigh : nextHigh;
    this._outModel.setLogicLevel(driveHigh);
  }

  // Forward analog stamps
  if (this._nIn  > 0) this._inModel.load(ctx);
  if (this._nOut > 0) this._outModel.load(ctx);
  for (const child of this._childElements) { child.load(ctx); }
}
```

## State slots

Composite allocates 1 slot for the hysteresis state:

| Slot offset | Name | Description | Init |
|---|---|---|---|
| `base + 0` | `OUTPUT_HIGH` | Hysteresis latch: 1.0 = output high, 0.0 = output low | `zero` (starts low) |

`ctx.allocStates(1)` called in composite's `setup()`. The existing `SCHMITT_COMPOSITE_SCHEMA` (currently empty in source) is updated to declare this 1-slot schema.

Child pin-model CAP elements own their own state slots (allocated by their own `setup()` calls).

## findDevice usage

Not needed. Direct refs to `_inModel`, `_outModel`, and `_childElements`.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Add `mayCreateInternalNodes: false`.
- Leave `ngspiceNodeMap` undefined on both `SchmittInvertingDefinition` and `SchmittNonInvertingDefinition`.
- Both `"behavioral"` models (inverting/non-inverting) follow this same setup structure; the `inverting` flag is captured at construction time, not in state.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-SCHMITT is GREEN (stamp order from pin models).
2. `src/components/active/__tests__/schmitt-trigger.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. The pin-map-coverage test allows the composite to lack `ngspiceNodeMap`.
4. No banned closing verdicts.
