# Task PB-TIMER555

**digiTS file:** `src/components/active/timer-555.ts`
**Architecture:** composite. Decomposes into 2× VCVSElement (comparators, each as a VCVS sub-element) + 1× BJTElement NPN (discharge transistor) + composite-level SR latch state + inline resistor stamps for the R-divider. Output stage via `DigitalOutputPinModel`.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Sub-elements carry their own maps.

Composite pin labels (from `buildTimer555PinDeclarations()`, pinLayout order):
- `DIS` — discharge (index 0, position x:0, y:1)
- `TRIG` — trigger (index 1, position x:0, y:3)
- `THR` — threshold (index 2, position x:0, y:5)
- `VCC` — supply voltage (index 3, position x:3, y:-1)
- `CTRL` — control voltage (index 4, position x:6, y:5)
- `OUT` — output (index 5, position x:6, y:3)
- `RST` — reset (active-low) (index 6, position x:6, y:1)
- `GND` — ground reference (index 7, position x:3, y:7)

## Internal nodes

Four internal nodes allocated in `setup()`:

| Internal node | Allocated via | Description |
|---|---|---|
| `nLower` | `ctx.makeVolt(label, "nLower")` | R-divider lower tap (1/3 VCC) |
| `nComp1Out` | `ctx.makeVolt(label, "nComp1Out")` | Threshold comparator OC output |
| `nComp2Out` | `ctx.makeVolt(label, "nComp2Out")` | Trigger comparator OC output |
| `nDisBase` | `ctx.makeVolt(label, "nDisBase")` | Discharge BJT base (RS-FF glue) |

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments (parent/internal → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `comp1` | VCVSElement (high-gain) | `vcvs/vcvsset.c:53-58` | `THR`→`ctrl+`, `CTRL`→`ctrl-`, `nComp1Out`→`out+`, `GND`→`out-` | fixed gain 1e6 |
| `comp2` | VCVSElement (high-gain) | `vcvs/vcvsset.c:53-58` | `nLower`→`ctrl+`, `TRIG`→`ctrl-`, `nComp2Out`→`out+`, `GND`→`out-` | fixed gain 1e6 |
| `bjtDis` | BJTElement NPN | `bjt/bjtsetup.c:347-465` | `nDisBase`→`B`, `DIS`→`C`, `GND`→`E` | `"rDischarge"` → rDischarge param |
| `outModel` | DigitalOutputPinModel | behavioral (02-behavioral.md) | `OUT` → output node | `"vDrop"` (drives vOH relative to VCC) |

**R-divider inline stamps:** Three equal 5 kΩ resistors (VCC→CTRL, CTRL→nLower, nLower→GND) are stamped inline in `load()` using `ctx.solver.stampElement()` via handles allocated in `setup()`. These are modelled as three RESElement sub-elements (`rDiv1`, `rDiv2`, `rDiv3`) sharing the `res/ressetup.c` anchor.

| Sub-element label | Class | ngspice anchor | Pin assignments | setParam routing |
|---|---|---|---|---|
| `rDiv1` | RESElement (5 kΩ) | `res/ressetup.c:46-49` | `VCC`→`A`, `CTRL`→`B` | fixed 5 kΩ |
| `rDiv2` | RESElement (5 kΩ) | `res/ressetup.c:46-49` | `CTRL`→`A`, `nLower`→`B` | fixed 5 kΩ |
| `rDiv3` | RESElement (5 kΩ) | `res/ressetup.c:46-49` | `nLower`→`A`, `GND`→`B` | fixed 5 kΩ |

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const nVcc  = pinNodes.get("VCC")!;
  const nCtrl = pinNodes.get("CTRL")!;
  const nGnd  = pinNodes.get("GND")!;
  const nThr  = pinNodes.get("THR")!;
  const nTrig = pinNodes.get("TRIG")!;
  const nDis  = pinNodes.get("DIS")!;
  const nOut  = pinNodes.get("OUT")!;

  // R-divider resistors (internal nodes assigned in setup())
  const rDiv1 = new RESElement(5000);  // VCC → CTRL
  const rDiv2 = new RESElement(5000);  // CTRL → nLower
  const rDiv3 = new RESElement(5000);  // nLower → GND

  // Comparators as high-gain VCVS (pin assignment in setup() after internal nodes allocated)
  const comp1 = new VCVSElement(1e6);  // threshold comparator
  const comp2 = new VCVSElement(1e6);  // trigger comparator

  // Discharge BJT NPN (pin assignment in setup() after nDisBase allocated)
  const bjtDis = createBjtElement(1 /* NPN */, new Map([
    ["B", 0], ["C", nDis], ["E", nGnd],  // B overwritten in setup()
  ]), makeBjtProps(BJT_NPN_DEFAULTS, { RC: props.getModelParam("rDischarge") ?? 10 }));

  // Output pin model
  const outModel = new DigitalOutputPinModel(buildOutputSpec(props));
  if (nOut > 0) outModel.init(nOut, -1);

  return new Timer555CompositeElement({
    rDiv1, rDiv2, rDiv3, comp1, comp2, bjtDis, outModel, pinNodes, props,
  });
}
```

## setup() body — composite forwards in NGSPICE_LOAD_ORDER order

```ts
setup(ctx: SetupContext): void {
  const nVcc  = this._pinNodes.get("VCC")!;
  const nCtrl = this._pinNodes.get("CTRL")!;
  const nGnd  = this._pinNodes.get("GND")!;
  const nThr  = this._pinNodes.get("THR")!;
  const nTrig = this._pinNodes.get("TRIG")!;
  const nDis  = this._pinNodes.get("DIS")!;
  const nOut  = this._pinNodes.get("OUT")!;

  // Allocate internal nodes
  this._nLower    = ctx.makeVolt(this.label, "nLower");
  this._nComp1Out = ctx.makeVolt(this.label, "nComp1Out");
  this._nComp2Out = ctx.makeVolt(this.label, "nComp2Out");
  this._nDisBase  = ctx.makeVolt(this.label, "nDisBase");

  // Composite SR latch state (1 slot: 0.0 = Q reset, 1.0 = Q set)
  this._stateBase = ctx.allocStates(1);

  // R-divider resistors (RES TSTALLOC: 4 entries each, ressetup.c:46-49)
  this._rDiv1.pinNodeIds = [nVcc, nCtrl];
  this._rDiv1.setup(ctx);

  this._rDiv2.pinNodeIds = [nCtrl, this._nLower];
  this._rDiv2.setup(ctx);

  this._rDiv3.pinNodeIds = [this._nLower, nGnd];
  this._rDiv3.setup(ctx);

  // Threshold comparator VCVS (vcvsset.c:53-58, 1 branch + 6 TSTALLOC)
  // comp1: in+ = THR, in- = CTRL, out+ = nComp1Out, out- = GND
  this._comp1.pinNodeIds = [nThr, nCtrl, this._nComp1Out, nGnd];
  this._comp1.setup(ctx);

  // Trigger comparator VCVS (vcvsset.c:53-58, 1 branch + 6 TSTALLOC)
  // comp2: in+ = nLower, in- = TRIG, out+ = nComp2Out, out- = GND
  this._comp2.pinNodeIds = [this._nLower, nTrig, this._nComp2Out, nGnd];
  this._comp2.setup(ctx);

  // Discharge BJT NPN (bjtsetup.c:347-465, 24 states, 23 TSTALLOC)
  this._bjtDis.pinNodeIds = [this._nDisBase, nDis, nGnd];
  this._bjtDis.setup(ctx);

  // Output pin model (behavioral, DigitalOutputPinModel)
  if (nOut > 0) this._outModel.setup(ctx);

  // CAP children of outModel
  for (const child of this._childElements) { child.setup(ctx); }

  // RS-FF glue handle: composite-owned allocation comes AFTER all sub-element setups,
  // since it wires pre-existing nodes rather than introducing new sub-element structure.
  this._hDisBaseDisBase = ctx.solver.allocElement(this._nDisBase, this._nDisBase);
}
```

### Setup ordering rationale

Sub-elements are set up in ascending `ngspiceLoadOrder` bucket order, matching `cktsetup.c:72-81`, followed by composite-owned allocElement calls:
1. RES (rDiv1, rDiv2, rDiv3) — `NGSPICE_LOAD_ORDER.RES`
2. VCVS (comp1, comp2) — `NGSPICE_LOAD_ORDER.VCVS`
3. BJT (bjtDis) — `NGSPICE_LOAD_ORDER.BJT`
4. Behavioral (outModel, CAP children)
5. Composite-owned glue handle (RS-FF `_hDisBaseDisBase`) — allocated last, after all sub-element setups, since it wires pre-existing nodes

## load() body — composite forwards with RS latch coupling

```ts
load(ctx: LoadContext): void {
  // R-divider stamps (resload.c pattern — G stamped at 4 entries)
  this._rDiv1.load(ctx);
  this._rDiv2.load(ctx);
  this._rDiv3.load(ctx);

  // Comparator stamps (VCVS load — vcvsload.c pattern)
  this._comp1.load(ctx);
  this._comp2.load(ctx);

  // RS-FF glue: read comparator outputs from rhsOld, compute latch state
  const vComp1Out = ctx.rhsOld[this._nComp1Out];  // >0 = THR > CTRL (RESET)
  const vComp2Out = ctx.rhsOld[this._nComp2Out];  // >0 = TRIG < nLower (SET)
  const nRst      = this._pinNodes.get("RST")!;
  const nGnd      = this._pinNodes.get("GND")!;
  const nVcc      = this._pinNodes.get("VCC")!;
  const vRst      = nRst > 0 ? ctx.rhsOld[nRst] : 5;
  const vGnd      = nGnd > 0 ? ctx.rhsOld[nGnd] : 0;

  // Active-low RST: if RST < GND + 0.7V → force Q=0
  const rstActive = vRst < vGnd + 0.7;
  let q = ctx.state0[this._stateBase] >= 0.5;  // current latch state

  const resetSignal = vComp1Out > 0.5 || rstActive;  // RESET dominant
  const setSignal   = vComp2Out > 0.5 && !resetSignal;

  if (resetSignal) q = false;
  else if (setSignal) q = true;
  // else hold

  ctx.state0[this._stateBase] = q ? 1.0 : 0.0;

  // Drive discharge BJT base: Q=0 → BJT ON (saturated); Q=1 → BJT OFF
  const bjtBaseV = q ? 0.0 : 5.0;  // drive to rail to turn ON/OFF
  const G_base = 1.0 / 100.0;  // 100Ω base drive resistance
  ctx.solver.stampElement(this._hDisBaseDisBase, G_base);
  ctx.rhs[this._nDisBase] += bjtBaseV * G_base;

  // Discharge BJT stamp (bjtload.c)
  this._bjtDis.load(ctx);

  // Output stage: Q=1 → OUT = VCC - vDrop; Q=0 → OUT ≈ GND + 0.1V
  const vVcc = nVcc > 0 ? ctx.rhsOld[nVcc] : 5;
  const vOut = q ? vVcc - this._p.vDrop : vGnd + 0.1;
  // Output tracks VCC dynamically: update vOH each load() cycle, then drive logic level.
  // This pattern keeps DigitalOutputPinModel API minimal; vOH is hot-loadable per the
  // project's hot-loadable-params requirement (see CLAUDE.md ref).
  this._outModel.setParam("vOH", vOut);
  this._outModel.setLogicLevel(q);  // q is the RS-FF state already computed
  this._outModel.load(ctx);

  // CAP children
  for (const child of this._childElements) { child.load(ctx); }
}
```

## State slots

Composite allocates 1 slot for the SR latch (in `setup()` via `ctx.allocStates(1)`):

| Slot offset | Name | Description | Init |
|---|---|---|---|
| `base + 0` | `FLIPFLOP_Q` | SR latch output: 1.0 = Q set (OUT high), 0.0 = Q reset (OUT low) | `zero` |

Sub-element state slots:
- `rDiv1`, `rDiv2`, `rDiv3`: no state (RES has `NG_IGNORE(states)`)
- `comp1`, `comp2`: no state (VCVS has `NG_IGNORE(states)`)
- `bjtDis`: 24 state slots (`BJTnumStates`, bjtsetup.c:367)
- `outModel` CAP children: own state slots

## findDevice usage

Not needed. Direct refs to all sub-elements.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `getInternalNodeCount` (was 4) — replaced by `mayCreateInternalNodes: true`.
- Add `mayCreateInternalNodes: true` (4 internal nodes in `setup()`).
- Leave `ngspiceNodeMap` undefined on `Timer555Definition`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-TIMER555 is GREEN (stamp order: rDiv1 4×RES, rDiv2 4×RES, rDiv3 4×RES, comp1 6×VCVS, comp2 6×VCVS, bjtDis 23×BJT, outModel setup, CAP children, then RS-FF glue handle (composite-owned, last)).
2. `src/components/active/__tests__/timer-555.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. The pin-map-coverage test allows the composite to lack `ngspiceNodeMap`.
4. No banned closing verdicts.
