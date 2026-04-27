# Task PB-NJFET

**digiTS file:** `src/components/semiconductors/njfet.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/jfet/jfetset.c:112-180`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/jfet/jfetload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS label | ngspice variable | Note |
|---|---|---|
| `G` | `JFETgateNode` | Gate — external |
| `S` | `JFETsourceNode` | Source — external |
| `D` | `JFETdrainNode` | Drain — external |
| `sourcePrime` | `JFETsourcePrimeNode` | Internal source node (when RS ≠ 0) |
| `drainPrime` | `JFETdrainPrimeNode` | Internal drain node (when RD ≠ 0) |

```
const gateNode   = pinNodes.get("G")!;   // JFETgateNode
const sourceNode = pinNodes.get("S")!;   // JFETsourceNode
const drainNode  = pinNodes.get("D")!;   // JFETdrainNode
```

## Internal nodes

Two conditional internal nodes. Verbatim gates from `jfetset.c:115-158`:

```c
// Source internal node (jfetset.c:115-136)
if(model->JFETsourceResist != 0) {
    if(here->JFETsourcePrimeNode == 0) {
        error = CKTmkVolt(ckt, &tmp, here->JFETname, "source");
        if(error) return(error);
        here->JFETsourcePrimeNode = tmp->number;
    }
} else {
    here->JFETsourcePrimeNode = here->JFETsourceNode;
}

// Drain internal node (jfetset.c:137-158)
if(model->JFETdrainResist != 0) {
    if(here->JFETdrainPrimeNode == 0) {
        error = CKTmkVolt(ckt, &tmp, here->JFETname, "drain");
        if(error) return(error);
        here->JFETdrainPrimeNode = tmp->number;
    }
} else {
    here->JFETdrainPrimeNode = here->JFETdrainNode;
}
```

Note: ngspice allocates source prime BEFORE drain prime. This order is
preserved in the digiTS port.

digiTS port:

```ts
this._sourcePrimeNode = (model.RS === 0)
  ? sourceNode
  : ctx.makeVolt(this.label, "source");

this._drainPrimeNode = (model.RD === 0)
  ? drainNode
  : ctx.makeVolt(this.label, "drain");
```

## Branch rows

None.

## State slots

`*states += 13` at `jfetset.c:112-113`.

```ts
this._stateBase = ctx.allocStates(13);
```

## TSTALLOC sequence (line-for-line port)

`jfetset.c:166-180`. Fifteen entries.

Variables: `sp = _sourcePrimeNode`, `dp = _drainPrimeNode`.

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `JFETdrainDrainPrimePtr` | `JFETdrainNode` | `JFETdrainPrimeNode` | `this._hDDP` |
| 2 | `JFETgateDrainPrimePtr` | `JFETgateNode` | `JFETdrainPrimeNode` | `this._hGDP` |
| 3 | `JFETgateSourcePrimePtr` | `JFETgateNode` | `JFETsourcePrimeNode` | `this._hGSP` |
| 4 | `JFETsourceSourcePrimePtr` | `JFETsourceNode` | `JFETsourcePrimeNode` | `this._hSSP` |
| 5 | `JFETdrainPrimeDrainPtr` | `JFETdrainPrimeNode` | `JFETdrainNode` | `this._hDPD` |
| 6 | `JFETdrainPrimeGatePtr` | `JFETdrainPrimeNode` | `JFETgateNode` | `this._hDPG` |
| 7 | `JFETdrainPrimeSourcePrimePtr` | `JFETdrainPrimeNode` | `JFETsourcePrimeNode` | `this._hDPSP` |
| 8 | `JFETsourcePrimeGatePtr` | `JFETsourcePrimeNode` | `JFETgateNode` | `this._hSPG` |
| 9 | `JFETsourcePrimeSourcePtr` | `JFETsourcePrimeNode` | `JFETsourceNode` | `this._hSPS` |
| 10 | `JFETsourcePrimeDrainPrimePtr` | `JFETsourcePrimeNode` | `JFETdrainPrimeNode` | `this._hSPDP` |
| 11 | `JFETdrainDrainPtr` | `JFETdrainNode` | `JFETdrainNode` | `this._hDD` |
| 12 | `JFETgateGatePtr` | `JFETgateNode` | `JFETgateNode` | `this._hGG` |
| 13 | `JFETsourceSourcePtr` | `JFETsourceNode` | `JFETsourceNode` | `this._hSS` |
| 14 | `JFETdrainPrimeDrainPrimePtr` | `JFETdrainPrimeNode` | `JFETdrainPrimeNode` | `this._hDPDP` |
| 15 | `JFETsourcePrimeSourcePrimePtr` | `JFETsourcePrimeNode` | `JFETsourcePrimeNode` | `this._hSPSP` |

**RS=0 / RD=0 collapse:** When RS=0, `sourcePrimeNode = sourceNode` — entries (4) and (13)
collapse to `allocElement(sourceNode, sourceNode)`. When RD=0, `drainPrimeNode = drainNode`
— entries (1) and (11) collapse similarly. `allocElement` returns existing handle on
repeated calls. No conditional skip in the port.

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver     = ctx.solver;
  const gateNode   = this._pinNodes.get("G")!;
  const sourceNode = this._pinNodes.get("S")!;
  const drainNode  = this._pinNodes.get("D")!;
  const model      = this._model;

  // State slots — jfetset.c:112-113
  this._stateBase = ctx.allocStates(13);

  // Internal nodes — jfetset.c:115-158
  // Source prime BEFORE drain prime (ngspice order)
  this._sourcePrimeNode = (model.RS === 0) ? sourceNode : ctx.makeVolt(this.label, "source");
  this._drainPrimeNode  = (model.RD === 0) ? drainNode  : ctx.makeVolt(this.label, "drain");

  const sp = this._sourcePrimeNode;
  const dp = this._drainPrimeNode;

  // TSTALLOC sequence — jfetset.c:166-180
  this._hDDP  = solver.allocElement(drainNode,  dp);          // (1)
  this._hGDP  = solver.allocElement(gateNode,   dp);          // (2)
  this._hGSP  = solver.allocElement(gateNode,   sp);          // (3)
  this._hSSP  = solver.allocElement(sourceNode, sp);          // (4)
  this._hDPD  = solver.allocElement(dp,         drainNode);   // (5)
  this._hDPG  = solver.allocElement(dp,         gateNode);    // (6)
  this._hDPSP = solver.allocElement(dp,         sp);          // (7)
  this._hSPG  = solver.allocElement(sp,         gateNode);    // (8)
  this._hSPS  = solver.allocElement(sp,         sourceNode);  // (9)
  this._hSPDP = solver.allocElement(sp,         dp);          // (10)
  this._hDD   = solver.allocElement(drainNode,  drainNode);   // (11)
  this._hGG   = solver.allocElement(gateNode,   gateNode);    // (12)
  this._hSS   = solver.allocElement(sourceNode, sourceNode);  // (13)
  this._hDPDP = solver.allocElement(dp,         dp);          // (14)
  this._hSPSP = solver.allocElement(sp,         sp);          // (15)
}
```

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/jfet/jfetload.c`
line-for-line, stamping through cached handles. No allocElement calls.

- Preserve multiplicity scaling: all current and conductance stamps are multiplied by the instance `M` parameter (default 1.0). ngspice anchor: `dioload.c` / `mos1load.c` / `bjtload.c` / `jfetload.c` use `here->{DIO|MOS1|BJT|JFET}m` for this scaling. The instance `M` parameter is partition: "instance" per the in-progress phase-instance-vs-model-param-partition work.

## findBranchFor (if applicable)

Not applicable. JFET has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { G: "gate", S: "source", D: "drain" }`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-NJFET is GREEN.
2. `src/components/semiconductors/__tests__/jfet.test.ts` is GREEN.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
