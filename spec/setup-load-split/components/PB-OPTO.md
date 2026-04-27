# Task PB-OPTO

**digiTS file:** `src/components/active/optocoupler.ts`
**Architecture:** composite. Decomposes into 1× DIO (LED) + 1× BJT NPN (phototransistor) at compile time. Photo-current coupling is handled in composite `load()`.

## Pin mapping (from 01-pin-mapping.md)

The composite itself has no `ngspiceNodeMap`. Sub-elements carry their own maps.

Composite pin labels (from `buildOptocouplerPinDeclarations()`):
- `anode` — LED anode, input+ (pinLayout index 0)
- `cathode` — LED cathode, input- (pinLayout index 1)
- `collector` — phototransistor collector, output+ (pinLayout index 2)
- `emitter` — phototransistor emitter, output- (pinLayout index 3)

Internal node: phototransistor base (no external pin). Allocated by `ctx.makeVolt(label, "base")` in `setup()`.

## Sub-element decomposition

| Sub-element label | Class | ngspice anchor | Pin assignments (parent pin → sub-element pin) | setParam routing |
|---|---|---|---|---|
| `ledSub` | DIOElement | `dio/diosetup.c:198-238` | `anode`→`A`, `cathode`→`K` | `"Is"` → ledSub, `"n"` → ledSub |
| `bjtSub` | BJTElement (NPN) | `bjt/bjtsetup.c:347-465` | `nBase`(internal)→`B`, `collector`→`C`, `emitter`→`E` | (fixed NPN L0 defaults, no user setParam) |

Sub-element `ngspiceNodeMap`:
```
ledSub.ngspiceNodeMap  = { A: "pos", K: "neg" }
bjtSub.ngspiceNodeMap  = { B: "base", C: "col", E: "emit" }
```

The phototransistor base node `nBase` is an internal node with no external pin. It is allocated in `setup()` and wired as `B` for `bjtSub`.

## Construction (factory body sketch)

```ts
factory(pinNodes, props, getTime): AnalogElementCore {
  const nAnode     = pinNodes.get("anode")!;
  const nCathode   = pinNodes.get("cathode")!;
  const nCollector = pinNodes.get("collector")!;
  const nEmitter   = pinNodes.get("emitter")!;

  const ledProps = makeLedProps(props.getModelParam("Is"), props.getModelParam("n"));
  const bjtProps = makeBjtProps();

  const ledSub = createDiodeElement(
    new Map([["A", nAnode], ["K", nCathode]]),
    ledProps,
  );
  ledSub.label = `${label}_ledSub`;

  // bjtSub base node resolved at setup() time — placeholder 0 here
  const bjtSub = createBjtElement(1 /* NPN */, new Map([
    ["B", 0],   // overwritten in setup()
    ["C", nCollector],
    ["E", nEmitter],
  ]), bjtProps);
  bjtSub.label = `${label}_bjtSub`;

  return new OptocouplerCompositeElement({ ledSub, bjtSub, nAnode, nCathode, nCollector, nEmitter, props });
}
```

## setup() body — composite forwards

```ts
setup(ctx: SetupContext): void {
  const nAnode     = this._pinNodes.get("anode")!;
  const nCathode   = this._pinNodes.get("cathode")!;
  const nCollector = this._pinNodes.get("collector")!;
  const nEmitter   = this._pinNodes.get("emitter")!;

  // Allocate internal base node (no external pin) — diosetup.c-style CKTmkVolt
  this._nBase = ctx.makeVolt(this.label, "base");

  // LED diode sub-element setup (diosetup.c:198-238)
  this._ledSub.pinNodeIds = [nAnode, nCathode];
  this._ledSub.setup(ctx);

  // BJT phototransistor sub-element setup (bjtsetup.c:347-465)
  // base = internal node, C = collector, E = emitter
  this._bjtSub.pinNodeIds = [this._nBase, nCollector, nEmitter];
  this._bjtSub.setup(ctx);

  // Composite state: none (sub-elements own all state slots)
  // ledSub.setup calls ctx.allocStates(5) — diosetup.c:199
  // bjtSub.setup calls ctx.allocStates(BJTnumStates=24) — bjtsetup.c:366-367

  // CCCS coupling Jacobian handles — allocated here for use in load()
  // Stamp coupling: G[nBase, nAnode] += CTR*geqLed, G[nBase, nCathode] -= CTR*geqLed
  this._hBaseAnode   = ctx.solver.allocElement(this._nBase, nAnode);
  this._hBaseCathode = ctx.solver.allocElement(this._nBase, nCathode);
}
```

### Setup order

Setup order within composite's `setup()` call:
1. `ctx.makeVolt(label, "base")` — allocate internal base node
2. `ledSub.setup(ctx)` — DIO TSTALLOC sequence (7 entries, diosetup.c:232-238)
3. `bjtSub.setup(ctx)` — BJT TSTALLOC sequence (23 entries, bjtsetup.c:435-464)
4. `ctx.solver.allocElement(nBase, nAnode)` — CCCS Jacobian coupling (anode column)
5. `ctx.solver.allocElement(nBase, nCathode)` — CCCS Jacobian coupling (cathode column)

Steps 4–5 are composite-level allocations (not delegated to a named sub-element class). They follow all sub-element TSTALLOCs so that `setup-stamp-order.test.ts` can verify the full sequence.

## load() body — composite with photo-current coupling

```ts
load(ctx: LoadContext): void {
  // 1. LED diode stamp — dioload.c:120-441
  this._ledSub.load(ctx);

  // 2. CCCS coupling — CTR * I_LED injected into nBase (photo-current)
  const s0     = pool.states[0];
  const iLed   = s0[diodeBase + DIODE_SLOT_ID];   // dioload.c DIOcurrent
  const geqLed = s0[diodeBase + DIODE_SLOT_GEQ];   // NR companion conductance
  const ctr    = this._ctr;
  const gmCtr  = ctr * geqLed;

  // Jacobian: coupling from input voltage to base row
  ctx.solver.stampElement(this._hBaseAnode,   gmCtr);
  ctx.solver.stampElement(this._hBaseCathode, -gmCtr);

  // Norton current: iBase - gmCtr * vd (constant term)
  const vd         = ctx.rhsOld[nAnode] - ctx.rhsOld[nCathode];
  const iBaseNorton = ctr * iLed - gmCtr * vd;
  ctx.rhs[this._nBase] += iBaseNorton;

  // 3. BJT phototransistor stamp — bjtload.c:170-end
  this._bjtSub.load(ctx);
}
```

## State slots

Composite has none of its own. All state slots owned by sub-elements:

| Sub-element | State slots | Source |
|---|---|---|
| `ledSub` (DIO) | 5 slots | `diosetup.c:199`: `*states += 5` |
| `bjtSub` (BJT NPN) | 24 slots | `bjtsetup.c:366-367`: `*states += BJTnumStates` (24) |

Total state size: 29 slots. State layout:
- `[0 .. 4]` — LED diode state (diodeBase = composite stateBaseOffset)
- `[5 .. 28]` — BJT phototransistor state (bjtBase = diodeBase + 5)

## findDevice usage

Not needed. Direct refs to `_ledSub` and `_bjtSub`.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `getInternalNodeCount` and `getInternalNodeLabels` from `MnaModel` registration (replaced by `mayCreateInternalNodes: true`).
- Add `hasBranchRow: false` on the composite's `MnaModel`.
- Add `mayCreateInternalNodes: true` (base node allocated in `setup()`).
- Leave `ngspiceNodeMap` undefined on `OptocouplerDefinition`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-OPTO is GREEN (DIO 7 entries, BJT 23 entries, then 2 CCCS coupling entries, in that order).
2. `src/components/active/__tests__/optocoupler.test.ts` is GREEN.
3. The pin-map-coverage test allows the composite to lack `ngspiceNodeMap`.
4. No banned closing verdicts.
