# Task PB-ADC

**digiTS file:** `src/components/active/adc.ts`
**Architecture:** composite. Purely behavioral — no analog matrix entries beyond those owned by `DigitalInputPinModel` loading on VIN/CLK/VREF and `DigitalOutputPinModel` on D0..D{N-1}/EOC. No VCVS, VCCS, or other analog sub-elements.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Pin models own their matrix allocations per `02-behavioral.md`.

Composite pin labels (from `buildADCPinDeclarations(bits)`):
- `VIN` — analog input (index 0) — `DigitalInputPinModel` for resistive loading only
- `CLK` — clock input (index 1) — `DigitalInputPinModel`
- `VREF` — reference voltage input (index 2) — passive read (no pin model, no matrix entry)
- `GND` — ground reference (index 3) — passive read (no pin model)
- `EOC` — end-of-conversion output (index 4) — `DigitalOutputPinModel`
- `D0`..`D{N-1}` — digital output bits, LSB first (indices 5..5+N-1) — `DigitalOutputPinModel` each

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments | setParam routing |
|---|---|---|---|---|
| `vinModel` | DigitalInputPinModel | behavioral (02-behavioral.md) | `VIN` → input node | `"rIn"`, `"cIn"`, `"vIH"`, `"vIL"` |
| `clkModel` | DigitalInputPinModel | behavioral (02-behavioral.md) | `CLK` → input node | same electrical spec |
| `eocModel` | DigitalOutputPinModel | behavioral (02-behavioral.md) | `EOC` → output node | `"vOH"`, `"vOL"`, `"rOut"` |
| `dBit[i]` (N entries) | DigitalOutputPinModel | behavioral (02-behavioral.md) | `D{i}` → output node | same output spec |

`VREF` and `GND` have no pin models — they are read passively from `ctx.rhsOld` in `load()` for the conversion calculation.

The current source file's `ADC_COMPOSITE_SCHEMA` is an empty schema. After migration it gains the clock-edge detection state (previous CLK voltage) and the N-bit conversion output register.

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const bits = props.getModelParam<number>("bits") ?? 8;
  const spec  = buildPinElectricalFromProps(props);

  const vinModel = new DigitalInputPinModel(spec, false);
  const clkModel = new DigitalInputPinModel(spec, /*trackEdge=*/true);
  const eocModel = new DigitalOutputPinModel(spec);
  const dBits    = Array.from({ length: bits }, () => new DigitalOutputPinModel(spec));

  const nVin  = pinNodes.get("VIN")!;
  const nClk  = pinNodes.get("CLK")!;
  const nEoc  = pinNodes.get("EOC")!;

  if (nVin > 0) vinModel.init(nVin, 0);
  if (nClk > 0) clkModel.init(nClk, 0);
  if (nEoc > 0) eocModel.init(nEoc, -1);
  for (let i = 0; i < bits; i++) {
    const nD = pinNodes.get(`D${i}`)!;
    if (nD > 0) dBits[i].init(nD, -1);
    dBits[i].setLogicLevel(false);
  }
  eocModel.setLogicLevel(false);

  return new ADCCompositeElement({ vinModel, clkModel, eocModel, dBits, pinNodes, props });
}
```

## setup() body — composite forwards to every pin model

```ts
setup(ctx: SetupContext): void {
  const nVin = this._pinNodes.get("VIN")!;
  const nClk = this._pinNodes.get("CLK")!;
  const nEoc = this._pinNodes.get("EOC")!;

  // Composite-level state: prevClkVoltage (1 slot) + N-bit output register (ceil(N/64) slots)
  // Simplest layout: 1 slot for prevClk, 1 slot for the integer code (as Float64)
  this._stateBase = ctx.allocStates(2);

  // Forward to pin models — each calls their own TSTALLOC entries
  if (nVin > 0) this._vinModel.setup(ctx);
  if (nClk > 0) this._clkModel.setup(ctx);
  if (nEoc > 0) this._eocModel.setup(ctx);
  for (let i = 0; i < this._bits; i++) {
    const nD = this._pinNodes.get(`D${i}`)!;
    if (nD > 0) this._dBits[i].setup(ctx);
  }
  // Forward to CAP children of pin models (transient capacitance)
  for (const child of this._childElements) {
    child.setup(ctx);
  }
}
```

## load() body — composite forwards

```ts
load(ctx: LoadContext): void {
  const nVin  = this._pinNodes.get("VIN")!;
  const nVref = this._pinNodes.get("VREF")!;
  const nGnd  = this._pinNodes.get("GND")!;
  const nClk  = this._pinNodes.get("CLK")!;
  const nEoc  = this._pinNodes.get("EOC")!;

  // Analog loads from pin models (resistive loading, no conversion logic here)
  if (nVin > 0) this._vinModel.load(ctx);
  if (nClk > 0) this._clkModel.load(ctx);
  if (nEoc > 0) this._eocModel.load(ctx);
  for (let i = 0; i < this._bits; i++) {
    const nD = this._pinNodes.get(`D${i}`)!;
    if (nD > 0) this._dBits[i].load(ctx);
  }
  for (const child of this._childElements) { child.load(ctx); }

  // Conversion logic is NOT done here — only in accept() (clock-edge detection)
}

accept(ctx: LoadContext, simTime: number, addBreakpoint: (t: number) => void): void {
  const nVin  = this._pinNodes.get("VIN")!;
  const nVref = this._pinNodes.get("VREF")!;
  const nGnd  = this._pinNodes.get("GND")!;
  const nClk  = this._pinNodes.get("CLK")!;

  const prevClk  = ctx.state0[this._stateBase + 0];
  const currClk  = nClk > 0 ? ctx.rhs[nClk] : 0;
  const vIH      = this._p.vIH;

  // Rising edge detection
  const risingEdge = prevClk < vIH && currClk >= vIH;
  ctx.state0[this._stateBase + 0] = currClk;  // save for next step

  if (risingEdge) {
    const vIn  = nVin  > 0 ? ctx.rhs[nVin]  : 0;
    const vRef = nVref > 0 ? ctx.rhs[nVref] : 0;
    const vGnd = nGnd  > 0 ? ctx.rhs[nGnd]  : 0;
    const span = vRef - vGnd;
    const maxCode = (1 << this._bits) - 1;
    const code = span > 0
      ? Math.max(0, Math.min(maxCode, Math.floor((vIn - vGnd) / span * (1 << this._bits))))
      : 0;
    ctx.state0[this._stateBase + 1] = code;

    // Drive output bits
    for (let i = 0; i < this._bits; i++) {
      this._dBits[i].setLogicLevel(((code >> i) & 1) === 1);
    }
    this._eocModel.setLogicLevel(true);
  } else {
    this._eocModel.setLogicLevel(false);
  }
}
```

**FADC-D3 — no-edge behavior:** If CLK is wired to a constant-high source, no rising edges occur and EOC never fires. This is correct clock-driven behavior; do not add a workaround DC conversion mode.

## State slots

Composite allocates 2 slots (in `setup()` via `ctx.allocStates(2)`):

| Slot offset | Name | Description | Init |
|---|---|---|---|
| `base + 0` | `PREV_CLK` | Previous clock voltage for edge detection | `zero` |
| `base + 1` | `OUTPUT_CODE` | Last conversion code as Float64 | `zero` |

Pin-model CAP children own their own state slots (allocated by their own `setup()` calls).

## findDevice usage

Not needed. Direct refs to `_vinModel`, `_clkModel`, `_eocModel`, `_dBits[]`.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Add `mayCreateInternalNodes: false`.
- Leave `ngspiceNodeMap` undefined on `ADCDefinition`.
- The existing `ADC_COMPOSITE_SCHEMA` (currently empty in source) gains the 2-slot declaration.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-ADC is GREEN (stamp order from pin models in declaration order: VIN input model, CLK input model, EOC output model, D0..D{N-1} output models).
2. `src/components/active/__tests__/adc.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. The pin-map-coverage test allows the composite to lack `ngspiceNodeMap`.
4. No banned closing verdicts.
