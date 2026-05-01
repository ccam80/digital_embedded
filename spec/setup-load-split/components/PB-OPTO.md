# Task PB-OPTO

**digiTS file:** `src/components/active/optocoupler.ts`
**Architecture:** composite. Decomposes into 4 sub-elements at compile time:
  `dLed` (DIO) + `vSense` (VSRC) + `cccsCouple` (CCCS) + `bjtPhoto` (BJT NPN).

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Sub-elements carry their own maps.

Composite pin labels (from `buildOptocouplerPinDeclarations()`):
- `anode`- LED anode, input+ (pinLayout index 0)
- `cathode`- LED cathode, input- (pinLayout index 1)
- `collector`- phototransistor collector, output+ (pinLayout index 2)
- `emitter`- phototransistor emitter, output- (pinLayout index 3)

Internal nodes allocated in `setup()`:
- `_nBase`: phototransistor base (no external pin). `ctx.makeVolt(label, "base")`
- `_nSenseMid`: mid-node between `dLed` cathode and `vSense` (so `vSense` sits in series with
  `dLed`). `ctx.makeVolt(label, "senseMid")`

## Sub-element decomposition

The LED input side is: `anode` → `dLed` → `_nSenseMid` → `vSense` (0 V sense source) → `cathode`.
The `vSense` branch current equals the LED forward current. `cccsCouple` reads that branch and
injects `CTR × I_LED` into the phototransistor base node.

| Sub-element | Class | ngspice anchor | Pin assignments | setParam routing |
|---|---|---|---|---|
| `dLed` | DIOElement | `dio/diosetup.c:198-238` | `anode`→`A`, `_nSenseMid`→`K` | `"Is"` → dLed, `"n"` → dLed |
| `vSense` | VSRCElement (DC 0 V) | `vsrc/vsrcsetup.c` | `_nSenseMid`→`pos`, `cathode`→`neg` | (fixed 0 V, no user setParam) |
| `cccsCouple` | CCCSElement | `cccs/cccssetup.c` | sense branch = `vSense` branch; output `pos`=`_nBase`, `neg`=`emitter` | `"CTR"` → cccsCouple (gain) |
| `bjtPhoto` | BJTElement (NPN) | `bjt/bjtsetup.c:347-465` | `_nBase`→`B`, `collector`→`C`, `emitter`→`E` | (fixed NPN L0 defaults, no user setParam) |

Sub-element `ngspiceNodeMap`:
```
dLed.ngspiceNodeMap        = { A: "pos", K: "neg" }
vSense.ngspiceNodeMap      = { pos: "pos", neg: "neg" }
cccsCouple.ngspiceNodeMap  = { pos: "pos", neg: "neg" }
bjtPhoto.ngspiceNodeMap    = { B: "base", C: "col", E: "emit" }
```

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const nAnode     = pinNodes.get("anode")!;
  const nCathode   = pinNodes.get("cathode")!;
  const nCollector = pinNodes.get("collector")!;
  const nEmitter   = pinNodes.get("emitter")!;

  // dLed: anode → _nSenseMid (K assigned at setup() once _nSenseMid is allocated)
  const dLed = createDiodeElement(
    new Map([["A", nAnode], ["K", 0]]),   // K overwritten in setup()
    makeLedProps(props.getModelParam("Is"), props.getModelParam("n")),
  );
  dLed.label = `${label}_dLed`;

  // vSense: 0-volt sense source in series with dLed
  // pos = _nSenseMid (overwritten in setup()), neg = cathode
  const vSense = createVsrcElement(
    new Map([["pos", 0], ["neg", nCathode]]),
    { dc: 0 },
  );
  vSense.label = `${label}_vSense`;

  // cccsCouple: sense = vSense branch; output pos = _nBase (overwritten in setup()), neg = emitter
  const cccsCouple = createCccsElement(
    new Map([["pos", 0], ["neg", nEmitter]]),
    { gain: props.getModelParam("CTR") ?? 1.0 },
  );
  cccsCouple.label = `${label}_cccsCouple`;

  // bjtPhoto: base = _nBase (overwritten in setup()), C = collector, E = emitter
  const bjtPhoto = createBjtElement(1 /* NPN */, new Map([
    ["B", 0],   // overwritten in setup()
    ["C", nCollector],
    ["E", nEmitter],
  ]), makeBjtProps());
  bjtPhoto.label = `${label}_bjtPhoto`;

  return new OptocouplerCompositeElement({
    dLed, vSense, cccsCouple, bjtPhoto,
    nAnode, nCathode, nCollector, nEmitter, props,
  });
}
```

## setup() body- composite forwards

```ts
setup(ctx: SetupContext): void {
  const nAnode     = this._pinNodes.get("anode")!;
  const nCathode   = this._pinNodes.get("cathode")!;
  const nCollector = this._pinNodes.get("collector")!;
  const nEmitter   = this._pinNodes.get("emitter")!;

  // Allocate internal nodes
  this._nSenseMid = ctx.makeVolt(this.label, "senseMid");
  this._nBase     = ctx.makeVolt(this.label, "base");

  // Wire sub-elements by mutating their _pinNodes map directly.
  // Sub-elements are not compiler-augmented, so each sub-element's setup()
  // reads node IDs from its _pinNodes map. There is no setPinNode API on
  // AnalogElementCore; VsenseSubElement and CccsSubElement expose a thin
  // setPinNode helper for internal use only- the canonical pattern is
  // direct _pinNodes.set(...) and the BJT sub-element only supports that form.

  // Wire dLed: anode → senseMid
  (this._dLed as any)._pinNodes.set("K", this._nSenseMid);

  // Wire vSense: senseMid → cathode (0-volt sense source)
  this._vSense.setPinNode("pos", this._nSenseMid);

  // Wire cccsCouple output: nBase → emitter
  this._cccsCouple.setPinNode("pos", this._nBase);

  // Wire bjtPhoto base- BJT reads from _pinNodes, not pinNodeIds
  (this._bjtPhoto as any)._pinNodes.set("B", this._nBase);

  // Sub-element setup in NGSPICE_LOAD_ORDER
  this._dLed.setup(ctx);        // DIO TSTALLOC (diosetup.c:232-238, 7 entries)
  this._vSense.setup(ctx);      // VSRC TSTALLOC (vsrcsetup.c, 4 entries)
  this._cccsCouple.setup(ctx);  // CCCS TSTALLOC (cccssetup.c); also resolves vSense branch
  this._bjtPhoto.setup(ctx);    // BJT TSTALLOC (bjtsetup.c:435-464, 23 entries)
}
```

### Setup order

Setup order within composite's `setup()` call:
1. `ctx.makeVolt(label, "senseMid")`- allocate LED/sense-source mid-node
2. `ctx.makeVolt(label, "base")`- allocate phototransistor base node
3. `dLed.setup(ctx)`- DIO TSTALLOC sequence (7 entries, diosetup.c:232-238)
4. `vSense.setup(ctx)`- VSRC TSTALLOC sequence (4 entries, vsrcsetup.c)
5. `cccsCouple.setup(ctx)`- CCCS TSTALLOC sequence (cccssetup.c); resolves vSense branch via
   `ctx.findDevice(vSense.label).branchIndex`
6. `bjtPhoto.setup(ctx)`- BJT TSTALLOC sequence (23 entries, bjtsetup.c:435-464)

Every stamp is owned by a named sub-element with an ngspice anchor. No composite-level
`allocElement` calls.

## load() body- forwards to sub-elements in order

```ts
load(ctx: LoadContext): void {
  // 1. LED diode stamp- dioload.c:120-441
  this._dLed.load(ctx);

  // 2. Zero-volt sense source stamp- vsrcload.c
  //    The vSense branch current is I_LED (sense-source in series with dLed).
  this._vSense.load(ctx);

  // 3. CCCS coupling: CTR × I_vSense injected as photo-current to bjtPhoto base
  //    cccsload.c stamps gain × I_sense into output nodes; sense branch = vSense.
  this._cccsCouple.load(ctx);

  // 4. BJT phototransistor stamp- bjtload.c
  this._bjtPhoto.load(ctx);
}
```

State access in sub-elements uses `ctx.state0`/`ctx.state1` (per R5). No raw pool array indexing
at the composite level.

## State slots

Composite has none of its own. All state slots owned by sub-elements:

| Sub-element | State slots | Source |
|---|---|---|
| `dLed` (DIO) | 5 slots | `diosetup.c:199`: `*states += 5` |
| `vSense` (VSRC) | 0 slots | `vsrcsetup.c`: no state allocation |
| `cccsCouple` (CCCS) | 0 slots | `cccssetup.c`: no state allocation |
| `bjtPhoto` (BJT NPN) | 24 slots | `bjtsetup.c:366-367`: `*states += BJTnumStates` (24) |

Total state size: 29 slots.

## findDevice usage

Not needed. Direct refs to `_dLed`, `_vSense`, `_cccsCouple`, `_bjtPhoto`.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `getInternalNodeCount` and `getInternalNodeLabels` from `MnaModel` registration (replaced
  by `mayCreateInternalNodes: true`).
- Drop the digiTS-internal coupling handle fields `_hBaseAnode` and `_hBaseCathode` entirely.
- Add `mayCreateInternalNodes: true` (senseMid and base nodes allocated in `setup()`).
- Leave `ngspiceNodeMap` undefined on `OptocouplerDefinition`.

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
