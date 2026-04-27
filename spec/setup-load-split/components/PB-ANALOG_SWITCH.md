# Task PB-ANALOG_SWITCH

**digiTS file:** `src/components/active/analog-switch.ts`
**Architecture:** composite. Two variants registered under one file:
- **SPST** — decomposes into 1× SWElement
- **SPDT** — decomposes into 2× SWElement (one per throw, complementary control)

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Sub-elements carry their own maps.

### SPST pin labels

- `in` — signal input (pinLayout index 0)
- `out` — signal output (pinLayout index 1)
- `ctrl` — control voltage (pinLayout index 2)

### SPDT pin labels

- `com` — common (pinLayout index 0)
- `no` — normally-open throw (pinLayout index 1)
- `nc` — normally-closed throw (pinLayout index 2)
- `ctrl` — control voltage (pinLayout index 3)

## Sub-element decomposition

### SPST

| Sub-element label | Class | ngspice anchor | Pin assignments (parent pin → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `sw1` | SWElement | `sw/swsetup.c:47-62` | `in`→`pos`, `out`→`neg` | `"rOn"`→`sw1`, `"rOff"`→`sw1`, `"vThreshold"`→`sw1`, `"vHysteresis"`→`sw1` |

Sub-element `ngspiceNodeMap`:
```
sw1.ngspiceNodeMap = { "pos": "pos", "neg": "neg" }
```

The `ctrl` pin is a pure voltage-read in `load()` to determine switch state. `ctrl` does not appear in the SW TSTALLOC sequence — SWsetup.c stamps only `(pos,pos)`, `(pos,neg)`, `(neg,pos)`, `(neg,neg)`. The control voltage is read from `ctx.rhsOld[nCtrl]` in `load()` and passed to `sw1.setCtrlVoltage(vCtrl)` before `sw1.load(ctx)`.

### SPDT

| Sub-element label | Class | ngspice anchor | Pin assignments | setParam routing |
|---|---|---|---|---|
| `swNO` | SWElement | `sw/swsetup.c:47-62` | `com`→`pos`, `no`→`neg` | same params |
| `swNC` | SWElement | `sw/swsetup.c:47-62` | `com`→`pos`, `nc`→`neg` | same params |

`swNO` is ON when `V(ctrl) >= vThreshold + vHysteresis/2` (normal polarity).
`swNC` is ON when `V(ctrl) < vThreshold - vHysteresis/2` (inverted polarity — complementary).

Both switches use the same `(rOn, rOff, vThreshold, vHysteresis)` model parameters.

## Construction (factory body sketch)

### SPST

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const nIn   = pinNodes.get("in")!;
  const nOut  = pinNodes.get("out")!;
  const nCtrl = pinNodes.get("ctrl")!;

  const sw1 = new SWElement(props);
  sw1.label = `${label}_sw1`;
  sw1.pinNodeIds = [nIn, nOut];  // pos, neg

  return new AnalogSwitchSPSTComposite({ sw1, nCtrl, props });
}
```

### SPDT

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const nCom  = pinNodes.get("com")!;
  const nNO   = pinNodes.get("no")!;
  const nNC   = pinNodes.get("nc")!;
  const nCtrl = pinNodes.get("ctrl")!;

  const swNO = new SWElement(props);
  swNO.label = `${label}_swNO`;
  swNO.pinNodeIds = [nCom, nNO];  // pos, neg

  const swNC = new SWElement(props, /*invertedPolarity=*/true);
  swNC.label = `${label}_swNC`;
  swNC.pinNodeIds = [nCom, nNC];  // pos, neg

  return new AnalogSwitchSPDTComposite({ swNO, swNC, nCtrl, props });
}
```

## setup() body — composite forwards

### SPST

```ts
setup(ctx: SetupContext): void {
  const nIn  = this._pinNodes.get("in")!;
  const nOut = this._pinNodes.get("out")!;

  this._sw1.pinNodeIds = [nIn, nOut];
  this._sw1.setup(ctx);
  // sw1.setup calls ctx.allocStates(2) and 4×TSTALLOC (swsetup.c:47-62)
}
```

### SPDT

```ts
setup(ctx: SetupContext): void {
  const nCom = this._pinNodes.get("com")!;
  const nNO  = this._pinNodes.get("no")!;
  const nNC  = this._pinNodes.get("nc")!;

  this._swNO.pinNodeIds = [nCom, nNO];
  this._swNO.setup(ctx);
  // swNO: ctx.allocStates(2) + 4×TSTALLOC

  this._swNC.pinNodeIds = [nCom, nNC];
  this._swNC.setup(ctx);
  // swNC: ctx.allocStates(2) + 4×TSTALLOC
}
```

## load() body — read ctrl, delegate to SW sub-elements

### SPST

```ts
load(ctx: LoadContext): void {
  const nCtrl = this._pinNodes.get("ctrl")!;
  const vCtrl = nCtrl > 0 ? ctx.rhsOld[nCtrl] : 0;

  // Pass control voltage to SW sub-element for state machine evaluation
  this._sw1.setCtrlVoltage(vCtrl);  // Defined in PB-SW §"setCtrlVoltage(v) — for composite use only"
  this._sw1.load(ctx);
}
```

### SPDT

```ts
load(ctx: LoadContext): void {
  const nCtrl = this._pinNodes.get("ctrl")!;
  const vCtrl = nCtrl > 0 ? ctx.rhsOld[nCtrl] : 0;

  // NO path: normal polarity
  this._swNO.setCtrlVoltage(vCtrl);  // Defined in PB-SW §"setCtrlVoltage(v) — for composite use only"
  this._swNO.load(ctx);

  // NC path: inverted polarity — explicit ON/OFF based on threshold comparison
  // (Option A from FANALOG_SWITCH-D2: avoids -vCtrl negation pattern)
  const vThreshold = this._props.getModelParam("vThreshold") ?? 2.5;
  const vHyst      = this._props.getModelParam("vHysteresis") ?? 0.5;
  const ncOn = vCtrl < vThreshold - vHyst / 2;
  this._swNC.setSwState(ncOn);  // Defined in PB-SW §"setSwState(on) — for composite use only"
  this._swNC.load(ctx);
}
```

## State slots

Composite has none of its own. Sub-element state:

| Sub-element | State slots | Source |
|---|---|---|
| SPST: `sw1` | 2 | `swsetup.c:47-48`: `here->SWstate = *states; *states += SW_NUM_STATES` (SW_NUM_STATES=2) |
| SPDT: `swNO` | 2 | same |
| SPDT: `swNC` | 2 | same |

Total: SPST = 2 slots; SPDT = 4 slots.

State schema per SW path (from `SW_SCHEMA` in `analog-switch.ts`):
- Slot 0: `CURRENT_STATE` (REALLY_OFF=0, REALLY_ON=1, HYST_OFF=2, HYST_ON=3)
- Slot 1: `V_CTRL` (control voltage saved at load time)

## SW TSTALLOC sequence (swsetup.c:59-62)

With nodes `(nPos, nNeg)`:

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `SWposPosptr` | `nPos` | `nPos` | `_hPP` |
| 2 | `SWposNegptr` | `nPos` | `nNeg` | `_hPN` |
| 3 | `SWnegPosptr` | `nNeg` | `nPos` | `_hNP` |
| 4 | `SWnegNegptr` | `nNeg` | `nNeg` | `_hNN` |

State allocation (`swsetup.c:47-48`) precedes TSTALLOC calls:
```ts
this._stateBase = ctx.allocStates(2);  // before allocElement calls
```

## findDevice usage

Not needed. Direct refs to `_sw1` (SPST) or `_swNO`/`_swNC` (SPDT).

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Add `mayCreateInternalNodes: false`.
- Leave `ngspiceNodeMap` undefined on both `AnalogSwitchSPSTDefinition` and `AnalogSwitchSPDTDefinition`.
- The SPDT `"inverted polarity"` for `swNC` is a digiTS extension beyond `sw/swsetup.c` — it is not a new ngspice anchor. The SPDT composite is documented as a digiTS-specific composition of two standard SW primitives, each anchored at `sw/swsetup.c`.

## Verification gate

1. `setup-stamp-order.test.ts` rows for PB-ANALOG_SWITCH (SPST and SPDT variants) are GREEN.
   - SPST: `allocStates(2)` then 4×SW TSTALLOC.
   - SPDT: `swNO.setup` (allocStates(2) + 4×SW), then `swNC.setup` (allocStates(2) + 4×SW).
2. `src/components/active/__tests__/analog-switch.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. The pin-map-coverage test allows both composites to lack `ngspiceNodeMap`.
