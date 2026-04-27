# Task PB-REAL_OPAMP

**digiTS file:** `src/components/active/real-opamp.ts`
**Architecture:** composite. Decomposes into 1× VCVSElement (output gain stage) + 1× CAPElement (compensation, dominant-pole integrator) + 2× DIOElement (output clamp to Vcc+/Vcc-) at compile time.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Sub-elements carry their own maps.

Composite pin labels (from `buildRealOpAmpPinDeclarations()`):
- `in-` — inverting input (pinLayout index 0)
- `in+` — non-inverting input (pinLayout index 1)
- `out` — output (pinLayout index 2)
- `Vcc+` — positive supply (pinLayout index 3)
- `Vcc-` — negative supply (pinLayout index 4)

## Internal nodes

One internal node allocated in `setup()`:

| Internal node | Allocated via | Description |
|---|---|---|
| `nVint` | `ctx.makeVolt(label, "vint")` | Internal gain-stage node between VCVS output and clamp diodes (companion integrator) |

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments (parent/internal → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `vcvs1` | VCVSElement | `vcvs/vcvsset.c:53-58` | `in+`→`ctrl+`, `in-`→`ctrl-`, `nVint`→`out+`, `0`→`out-` | `"aol"` → vcvs1 gain |
| `capComp` | CAPElement | `cap/capsetup.c:114-117` | `nVint`→`pos`, `0`→`neg` | `"gbw"`, `"aol"` → derives C_eq = aol/(2π·gbw·G_int) |
| `dClampP` | DIOElement | `dio/diosetup.c:198-238` | `Vcc+`→`A`, `nVint`→`K` | forward-biased when output exceeds Vcc+ |
| `dClampN` | DIOElement | `dio/diosetup.c:198-238` | `nVint`→`A`, `Vcc-`→`K` | forward-biased when output falls below Vcc- |

Sub-element `ngspiceNodeMap`:
```
vcvs1.ngspiceNodeMap  = { "ctrl+": "contPos", "ctrl-": "contNeg", "out+": "pos", "out-": "neg" }
capComp.ngspiceNodeMap = { "pos": "pos", "neg": "neg" }
dClampP.ngspiceNodeMap = { "A": "pos", "K": "neg" }
dClampN.ngspiceNodeMap = { "A": "pos", "K": "neg" }
```

**Output resistance:** The current implementation uses a Norton output stage. After migration, `out` is connected to `nVint` through an inline RES stamp (rOut). Alternatively, if `rOut` is treated as the VCVS internal output resistance, a fifth sub-element `resOut` (RESElement) is added with `nVint`→`A`, `out`→`B`. This is the same topology as PB-OPAMP with rOut > 0.

### Extended decomposition with rOut

| Sub-element label | Class | ngspice anchor | Pin assignments | setParam routing |
|---|---|---|---|---|
| `vcvs1` | VCVSElement | `vcvs/vcvsset.c:53-58` | `in+`→`ctrl+`, `in-`→`ctrl-`, `nVint`→`out+`, `0`→`out-` | `"aol"` |
| `capComp` | CAPElement | `cap/capsetup.c:114-117` | `nVint`→`pos`, `0`→`neg` | computed from `"aol"`, `"gbw"` |
| `dClampP` | DIOElement | `dio/diosetup.c:198-238` | `Vcc+`→`A`, `nVint`→`K` | fixed clamp diode params |
| `dClampN` | DIOElement | `dio/diosetup.c:198-238` | `nVint`→`A`, `Vcc-`→`K` | fixed clamp diode params |
| `resOut` | RESElement | `res/ressetup.c:46-49` | `nVint`→`A`, `out`→`B` | `"rOut"` → resOut |

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const inP  = pinNodes.get("in+")!;
  const inN  = pinNodes.get("in-")!;
  const nOut = pinNodes.get("out")!;
  const nVccP = pinNodes.get("Vcc+")!;
  const nVccN = pinNodes.get("Vcc-")!;

  const aol  = props.getModelParam<number>("aol")  ?? 100000;
  const gbw  = props.getModelParam<number>("gbw")  ?? 1e6;
  const rOut = props.getModelParam<number>("rOut")  ?? 75;

  // vcvs1: ideal gain stage (nVint resolved in setup())
  const vcvs1 = new VCVSElement(aol);
  vcvs1.label = `${label}_vcvs1`;

  // capComp: C_eq = tau * G_int, tau = aol / (2π * gbw)
  const tau  = aol / (2 * Math.PI * gbw);
  const G_int = 1.0 / 1000;  // 1kΩ internal conductance (numerical stability)
  const cEq  = tau * G_int;
  const capComp = new CAPElement(cEq);
  capComp.label = `${label}_capComp`;

  // clamp diodes (low-drop schottky-style defaults)
  const dClampP = createDiodeElement(new Map([["A", nVccP], ["K", 0]]), makeClampDioProps());
  dClampP.label = `${label}_dClampP`;
  const dClampN = createDiodeElement(new Map([["A", 0], ["K", nVccN]]), makeClampDioProps());
  dClampN.label = `${label}_dClampN`;

  const resOut = new RESElement(rOut);
  resOut.label = `${label}_resOut`;

  return new RealOpAmpCompositeElement({
    vcvs1, capComp, dClampP, dClampN, resOut, inP, inN, nOut, nVccP, nVccN, props,
  });
}
```

The composite class declares cached field references for the input nodes (populated from constructor arguments `inP` and `inN`):

```ts
private readonly _inP: number;
private readonly _inN: number;
// In constructor:
this._inP = inP;
this._inN = inN;
```

These replace all inline `this._pinNodes.get("in+")!` and `this._pinNodes.get("in-")!` calls in `load()`. The `load()` body reads `this._inP` and `this._inN` directly.

## setup() body — composite forwards in NGSPICE_LOAD_ORDER order

```ts
setup(ctx: SetupContext): void {
  const inP  = this._pinNodes.get("in+")!;
  const inN  = this._pinNodes.get("in-")!;
  const nOut = this._pinNodes.get("out")!;
  const nVccP = this._pinNodes.get("Vcc+")!;
  const nVccN = this._pinNodes.get("Vcc-")!;

  // Allocate internal gain-stage node
  this._nVint = ctx.makeVolt(this.label, "vint");

  // 1. RES — output resistance (ressetup.c:46-49, 4 TSTALLOC)
  this._resOut.pinNodeIds = [this._nVint, nOut];
  this._resOut.setup(ctx);

  // 2. CAP — compensation capacitor (capsetup.c:114-117, 2 states, 4 TSTALLOC)
  this._capComp.pinNodeIds = [this._nVint, 0];
  this._capComp.setup(ctx);

  // 3. DIO — positive clamp (diosetup.c:198-238, 5 states, 7 TSTALLOC)
  this._dClampP.pinNodeIds = [nVccP, this._nVint];
  this._dClampP.setup(ctx);

  // 4. DIO — negative clamp (diosetup.c:198-238, 5 states, 7 TSTALLOC)
  this._dClampN.pinNodeIds = [this._nVint, nVccN];
  this._dClampN.setup(ctx);

  // 5. VCVS — main gain stage (vcvsset.c:53-58, 1 branch, 6 TSTALLOC)
  this._vcvs1.pinNodeIds = [inP, inN, this._nVint, 0];
  this._vcvs1.setup(ctx);

  // No composite-level state slots (sub-elements own all state)
}
```

### Setup ordering rationale

Order follows ascending `ngspiceLoadOrder` buckets:
1. RES (`resOut`) — `NGSPICE_LOAD_ORDER.RES`
2. CAP (`capComp`) — `NGSPICE_LOAD_ORDER.CAP`
3. DIO (`dClampP`, `dClampN`) — `NGSPICE_LOAD_ORDER.DIO`
4. VCVS (`vcvs1`) — `NGSPICE_LOAD_ORDER.VCVS`

## load() body — composite forwards

```ts
load(ctx: LoadContext): void {
  // RES output impedance
  this._resOut.load(ctx);

  // CAP compensation (transient companion model)
  this._capComp.load(ctx);

  // Clamp diodes
  this._dClampP.load(ctx);
  this._dClampN.load(ctx);

  // VCVS main gain stage
  // Slew-rate limiting: compute max allowed delta per timestep
  const dt = ctx.dt;
  if (dt > 0 && this._p.slewRate > 0) {
    const maxDelta = this._p.slewRate * dt;
    const vIntOld  = ctx.rhsOld[this._nVint];
    const vIntIdeal = this._p.aol * (
      (this._inP > 0 ? ctx.rhsOld[this._inP] : 0) -
      (this._inN > 0 ? ctx.rhsOld[this._inN] : 0) +
      this._p.vos
    );
    const vIntTarget = Math.max(vIntOld - maxDelta, Math.min(vIntOld + maxDelta, vIntIdeal));
    // Update VCVS gain to achieve clamped target
    const vDiff = (this._inP > 0 ? ctx.rhsOld[this._inP] : 0) -
                  (this._inN > 0 ? ctx.rhsOld[this._inN] : 0);
    const clampedGain = Math.abs(vDiff) > 1e-12 ? vIntTarget / vDiff : this._p.aol;
    this._vcvs1.setParam("gain", clampedGain);
  }
  this._vcvs1.load(ctx);
}
```

## State slots

Composite has none of its own. Sub-element state:

| Sub-element | State slots | Source |
|---|---|---|
| `resOut` | 0 | `NG_IGNORE(states)` |
| `capComp` | 2 | `capsetup.c:102-103`: `*states += 2` |
| `dClampP` | 5 | `diosetup.c:199`: `*states += 5` |
| `dClampN` | 5 | `diosetup.c:199`: `*states += 5` |
| `vcvs1` | 0 | `NG_IGNORE(states)` |

Total: 12 state slots across sub-elements.

## setParam routing — model presets

The `REAL_OPAMP_MODELS` presets (`741`, `LM358`, `TL072`, `OPA2134`) are applied at registration time when the `model` property is set. `setParam` routes:
- `"aol"` → `vcvs1.setParam("gain", value)`
- `"gbw"`, `"aol"` → `capComp.setParam("capacitance", aol / (2π * gbw * G_int))`
- `"rOut"` → `resOut.setParam("resistance", value)`
- Other params (`slewRate`, `vos`, `iBias`, etc.) → composite-level params only (used in `load()`)

## findDevice usage

Not needed. Direct refs to all sub-elements.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `getInternalNodeCount` (was 1 for `V_int`) — replaced by `mayCreateInternalNodes: true`.
- Add `mayCreateInternalNodes: true` (`nVint` allocated in `setup()`).
- Leave `ngspiceNodeMap` undefined on `RealOpAmpDefinition`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-REAL_OPAMP is GREEN (stamp order: resOut 4×RES, capComp 4×CAP, dClampP 7×DIO, dClampN 7×DIO, vcvs1 6×VCVS).
2. `src/components/active/__tests__/real-opamp.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. The pin-map-coverage test allows the composite to lack `ngspiceNodeMap`.
4. No banned closing verdicts.
