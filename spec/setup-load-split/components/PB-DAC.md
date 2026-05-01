# Task PB-DAC

**digiTS file:** `src/components/active/dac.ts`
**Architecture:** composite. Decomposes into 1× VCVS (output drive) + N× `DigitalInputPinModel` (D0..D{N-1}) + 1× `DigitalInputPinModel` (VREF passive loading). VCVS gain is updated each `load()` based on decoded digital inputs.

> **Spec status note (2026-04-28):** This PB describes a target architecture in
> which the DAC owns a concrete `VCVSElement` sub-element object and rebinds it
> via `pinNodeIds = [...]` in `setup()`. The current `dac.ts` implementation
> does **not** instantiate that sub-element- it inlines the VCVS TSTALLOC
> sequence (`_hVCVSPosIbr`, `_hVCVSIbrPos`, etc.) directly into a single
> closure-backed `AnalogElementCore`. The `pinNodeIds = [...]` listing in the
> "setup() body" section below is therefore aspirational; it will become
> reachable code only once the sub-element refactor lands. For sub-element
> wiring of any element whose `setup()` reads from `_pinNodes` (BJT in
> particular), the canonical pattern is `_pinNodes.set(...)` direct
> mutation- see PB-OPTO, PB-TIMER555, PB-SCR.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Sub-elements carry their own maps.

Composite pin labels (from `buildDACPinDeclarations(bits)`):
- `D0`..`D{N-1}`- digital input pins, LSB first (indices 0..N-1)
- `VREF`- voltage reference input (index N)- `DigitalInputPinModel` for loading
- `OUT`- analog output (index N+1)- VCVS output positive terminal; VCVS out- = GND
- `GND`- ground reference (index N+2)- passive read

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments (parent pin → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `vcvs1` | VCVSElement | `vcvs/vcvsset.c:53-58` | `VREF`→`ctrl+`, `GND`→`ctrl-`, `OUT`→`out+`, `GND`→`out-` | `"gain"` updated each load() |
| `dBit[i]` (N entries) | DigitalInputPinModel | behavioral (02-behavioral.md) | `D{i}` → input node | `"rIn"`, `"cIn"`, `"vIH"`, `"vIL"` |
| `vrefModel` | DigitalInputPinModel | behavioral (02-behavioral.md) | `VREF` → input node | same electrical spec |

Sub-element `ngspiceNodeMap` for vcvs1:
```
vcvs1.ngspiceNodeMap = {
  "ctrl+": "contPos",
  "ctrl-": "contNeg",
  "out+":  "pos",
  "out-":  "neg",
}
```

The VCVS `ctrl+` is wired to `VREF` and `ctrl-` to `GND` so the VCVS gain encodes `code / 2^N` as a dimensionless fraction; the output voltage `V_out = gain * (V_VREF - V_GND)`. The gain is recomputed each `load()` from the current digital-input threshold comparisons.

**Note on GND pin:** `GND` (index N+2) is wired to both `ctrl-` (VCVS control negative) and `out-` (VCVS output negative). When `GND` is tied to circuit ground (node 0), both entries are 0 and the corresponding TSTALLOC entries become no-ops.

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const bits  = props.getModelParam<number>("bits") ?? 8;
  const nVref = pinNodes.get("VREF")!;
  const nOut  = pinNodes.get("OUT")!;
  const nGnd  = pinNodes.get("GND")!;

  const vcvs1 = new VCVSElement(0);  // gain = 0 initially; updated each load()
  vcvs1.label = `${label}_vcvs1`;
  vcvs1.pinNodeIds = [nVref, nGnd, nOut, nGnd];  // ctrl+, ctrl-, out+, out-

  const spec     = buildPinElectricalFromProps(props);
  const dBits    = Array.from({ length: bits }, (_, i) => {
    const m = new DigitalInputPinModel(spec, false);
    const nD = pinNodes.get(`D${i}`)!;
    if (nD > 0) m.init(nD, 0);
    return m;
  });
  const vrefModel = new DigitalInputPinModel(spec, false);
  if (nVref > 0) vrefModel.init(nVref, 0);

  return new DACCompositeElement({ vcvs1, dBits, vrefModel, pinNodes, props, bits });
}
```

## setup() body- composite forwards

```ts
setup(ctx: SetupContext): void {
  const nVref = this._pinNodes.get("VREF")!;
  const nOut  = this._pinNodes.get("OUT")!;
  const nGnd  = this._pinNodes.get("GND")!;

  // VCVS sub-element: ctrl+(VREF), ctrl-(GND), out+(OUT), out-(GND)
  this._vcvs1.pinNodeIds = [nVref, nGnd, nOut, nGnd];
  this._vcvs1.setup(ctx);
  // vcvs1.setup allocates branch via ctx.makeCur, then 6 TSTALLOC entries

  // Digital input pin models- each allocates their own TSTALLOC entries
  for (let i = 0; i < this._bits; i++) {
    const nD = this._pinNodes.get(`D${i}`)!;
    if (nD > 0) this._dBits[i].setup(ctx);
  }
  if (nVref > 0) this._vrefModel.setup(ctx);

  // Forward to CAP children of pin models (transient capacitance)
  for (const child of this._childElements) {
    child.setup(ctx);
  }
  // No composite-level state slots needed (DAC_COMPOSITE_SCHEMA is empty)
}
```

## load() body- decode inputs, update VCVS gain, forward

```ts
load(ctx: LoadContext): void {
  const nGnd  = this._pinNodes.get("GND")!;
  const bits  = this._bits;

  // Decode digital inputs using threshold comparison
  // DigitalInputPinModel.currentLogicLevel reflects threshold comparison
  let code = 0;
  for (let i = 0; i < bits; i++) {
    const nD = this._pinNodes.get(`D${i}`)!;
    if (nD > 0) {
      const vD = ctx.rhsOld[nD];
      if (vD >= this._p.vIH) code |= (1 << i);
    }
  }

  // Compute VCVS gain = code / 2^N (unipolar) or (2*code/2^N - 1) (bipolar)
  const gain = code / (1 << bits);  // unipolar
  this._vcvs1.setParam("gain", gain);

  // Forward to VCVS (stamps 6 TSTALLOC entries via cached handles)
  this._vcvs1.load(ctx);

  // Forward to input pin models (resistive loading stamps)
  for (let i = 0; i < bits; i++) {
    const nD = this._pinNodes.get(`D${i}`)!;
    if (nD > 0) this._dBits[i].load(ctx);
  }
  const nVref = this._pinNodes.get("VREF")!;
  if (nVref > 0) this._vrefModel.load(ctx);

  // CAP children
  for (const child of this._childElements) { child.load(ctx); }
}
```

## State slots

Composite has none of its own (`DAC_COMPOSITE_SCHEMA` is empty). Sub-elements:
- `vcvs1`: `NG_IGNORE(states)`- no state slots.
- `dBits[i]`, `vrefModel`: CAP children own state slots via their own `setup()`.

## VCVS TSTALLOC sequence (vcvsset.c:53-58)

With nodes `(nVref, nGnd, nOut, nGnd)`- `ctrl+ = nVref`, `ctrl- = nGnd`, `out+ = nOut`, `out- = nGnd`:

| # | ngspice pointer | row | col |
|---|---|---|---|
| 1 | `VCVSposIbrptr` | `nOut` | `branch` |
| 2 | `VCVSnegIbrptr` | `nGnd` | `branch` |
| 3 | `VCVSibrPosptr` | `branch` | `nOut` |
| 4 | `VCVSibrNegptr` | `branch` | `nGnd` |
| 5 | `VCVSibrContPosptr` | `branch` | `nVref` |
| 6 | `VCVSibrContNegptr` | `branch` | `nGnd` |

Note: entries where node = 0 (ground) are no-ops in `allocElement`. When `nGnd = 0`, entries (2), (4), (6) are skipped by the VCVSElement's `setup()` body.

## findDevice usage

Not needed. Direct refs to `_vcvs1`, `_dBits[]`, `_vrefModel`.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Add `mayCreateInternalNodes: false`.
- Leave `ngspiceNodeMap` undefined on `DACDefinition`.
- The existing `DAC_COMPOSITE_SCHEMA` (empty in source) remains empty.

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
