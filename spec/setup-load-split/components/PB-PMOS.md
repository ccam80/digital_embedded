# Task PB-PMOS

**digiTS file:** `src/components/semiconductors/mosfet.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/mos1/mos1set.c:92-207`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/mos1/mos1load.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS label | ngspice variable | Note |
|---|---|---|
| `G` | `MOS1gNode` | Gate- external |
| `D` | `MOS1dNode` | Drain- external |
| `S` | `MOS1sNode` | Source- external |
| `B` (bulk) | `MOS1bNode` | Bulk- set to `pinNodes.get("S")` for 3-terminal PMOS (body tied to source) |
| `dNodePrime` | `MOS1dNodePrime` | Internal drain node (conditional) |
| `sNodePrime` | `MOS1sNodePrime` | Internal source node (conditional) |

Note: PMOS pin layout order is `G`, `D`, `S` (drain before source)- distinct
from NMOS which uses `G`, `S`, `D`. The `ngspiceNodeMap` reflects this.

```
const gNode = pinNodes.get("G")!;   // MOS1gNode
const dNode = pinNodes.get("D")!;   // MOS1dNode
const sNode = pinNodes.get("S")!;   // MOS1sNode
const bNode = sNode;                // MOS1bNode- body tied to source
```

## Property name mapping

Identical to PB-NMOS- see that spec's "Property name mapping" subsection.

| ngspice variable | digiTS model property | Default |
|---|---|---|
| `model->MOS1drainResistance` | `model.RD` | 0 |
| `model->MOS1sourceResistance` | `model.RS` | 0 |
| `model->MOS1sheetResistance` | `model.RS_sheet` | 0 |
| `here->MOS1drainSquares` | `instance.drainSquares` | 1 |
| `here->MOS1sourceSquares` | `instance.sourceSquares` | 1 |

## Internal nodes

Two conditional internal nodes. Same conditional gates as PB-NMOS- see
`mos1set.c:131-178`. Drain prime BEFORE source prime (ngspice order).

```ts
const needDrainPrime = (model.RD !== 0) ||
  (model.RS_sheet !== 0 && instance.drainSquares !== 0);
this._dNodePrime = needDrainPrime
  ? ctx.makeVolt(this.label, "drain")
  : dNode;

const needSourcePrime = (model.RS !== 0) ||
  (model.RS_sheet !== 0 && instance.sourceSquares !== 0);
this._sNodePrime = needSourcePrime
  ? ctx.makeVolt(this.label, "source")
  : sNode;
```

## Branch rows

None.

## State slots

`*states += MOS1numStates` at `mos1set.c:97`. `MOS1numStates = 17`.

```ts
this._stateBase = ctx.allocStates(17);
```

## TSTALLOC sequence (line-for-line port)

`mos1set.c:186-207`. Twenty-two entries. Identical to PB-NMOS- the same
ngspice source file handles both N and P channel MOSFET via the `MOS1type`
flag (+1 for NMOS, -1 for PMOS). All 22 TSTALLOC entries are unconditional.

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `MOS1DdPtr` | `MOS1dNode` | `MOS1dNode` | `this._hDD` |
| 2 | `MOS1GgPtr` | `MOS1gNode` | `MOS1gNode` | `this._hGG` |
| 3 | `MOS1SsPtr` | `MOS1sNode` | `MOS1sNode` | `this._hSS` |
| 4 | `MOS1BbPtr` | `MOS1bNode` | `MOS1bNode` | `this._hBB` |
| 5 | `MOS1DPdpPtr` | `MOS1dNodePrime` | `MOS1dNodePrime` | `this._hDPDP` |
| 6 | `MOS1SPspPtr` | `MOS1sNodePrime` | `MOS1sNodePrime` | `this._hSPSP` |
| 7 | `MOS1DdpPtr` | `MOS1dNode` | `MOS1dNodePrime` | `this._hDDP` |
| 8 | `MOS1GbPtr` | `MOS1gNode` | `MOS1bNode` | `this._hGB` |
| 9 | `MOS1GdpPtr` | `MOS1gNode` | `MOS1dNodePrime` | `this._hGDP` |
| 10 | `MOS1GspPtr` | `MOS1gNode` | `MOS1sNodePrime` | `this._hGSP` |
| 11 | `MOS1SspPtr` | `MOS1sNode` | `MOS1sNodePrime` | `this._hSSP` |
| 12 | `MOS1BdpPtr` | `MOS1bNode` | `MOS1dNodePrime` | `this._hBDP` |
| 13 | `MOS1BspPtr` | `MOS1bNode` | `MOS1sNodePrime` | `this._hBSP` |
| 14 | `MOS1DPspPtr` | `MOS1dNodePrime` | `MOS1sNodePrime` | `this._hDPSP` |
| 15 | `MOS1DPdPtr` | `MOS1dNodePrime` | `MOS1dNode` | `this._hDPD` |
| 16 | `MOS1BgPtr` | `MOS1bNode` | `MOS1gNode` | `this._hBG` |
| 17 | `MOS1DPgPtr` | `MOS1dNodePrime` | `MOS1gNode` | `this._hDPG` |
| 18 | `MOS1SPgPtr` | `MOS1sNodePrime` | `MOS1gNode` | `this._hSPG` |
| 19 | `MOS1SPsPtr` | `MOS1sNodePrime` | `MOS1sNode` | `this._hSPS` |
| 20 | `MOS1DPbPtr` | `MOS1dNodePrime` | `MOS1bNode` | `this._hDPB` |
| 21 | `MOS1SPbPtr` | `MOS1sNodePrime` | `MOS1bNode` | `this._hSPB` |
| 22 | `MOS1SPdpPtr` | `MOS1sNodePrime` | `MOS1dNodePrime` | `this._hSPDP` |

No conditional skips- identical reasoning to PB-NMOS.

## setup() body- alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const gNode  = this._pinNodes.get("G")!;
  const dNode  = this._pinNodes.get("D")!;
  const sNode  = this._pinNodes.get("S")!;
  const bNode  = sNode;   // 3-terminal: body tied to source
  const model    = this._model;
  const instance = this._instance;

  // State slots- mos1set.c:96-97
  this._stateBase = ctx.allocStates(17);

  // Internal nodes- mos1set.c:131-178 (drain prime before source prime)
  const needDrainPrime = (model.RD !== 0) ||
    (model.RS_sheet !== 0 && instance.drainSquares !== 0);
  this._dNodePrime = needDrainPrime
    ? ctx.makeVolt(this.label, "drain")
    : dNode;

  const needSourcePrime = (model.RS !== 0) ||
    (model.RS_sheet !== 0 && instance.sourceSquares !== 0);
  this._sNodePrime = needSourcePrime
    ? ctx.makeVolt(this.label, "source")
    : sNode;

  const dp = this._dNodePrime;
  const sp = this._sNodePrime;

  // TSTALLOC sequence- mos1set.c:186-207 (all 22, unconditional)
  this._hDD   = solver.allocElement(dNode, dNode); // (1)
  this._hGG   = solver.allocElement(gNode, gNode); // (2)
  this._hSS   = solver.allocElement(sNode, sNode); // (3)
  this._hBB   = solver.allocElement(bNode, bNode); // (4)
  this._hDPDP = solver.allocElement(dp,    dp);    // (5)
  this._hSPSP = solver.allocElement(sp,    sp);    // (6)
  this._hDDP  = solver.allocElement(dNode, dp);    // (7)
  this._hGB   = solver.allocElement(gNode, bNode); // (8)
  this._hGDP  = solver.allocElement(gNode, dp);    // (9)
  this._hGSP  = solver.allocElement(gNode, sp);    // (10)
  this._hSSP  = solver.allocElement(sNode, sp);    // (11)
  this._hBDP  = solver.allocElement(bNode, dp);    // (12)
  this._hBSP  = solver.allocElement(bNode, sp);    // (13)
  this._hDPSP = solver.allocElement(dp,    sp);    // (14)
  this._hDPD  = solver.allocElement(dp,    dNode); // (15)
  this._hBG   = solver.allocElement(bNode, gNode); // (16)
  this._hDPG  = solver.allocElement(dp,    gNode); // (17)
  this._hSPG  = solver.allocElement(sp,    gNode); // (18)
  this._hSPS  = solver.allocElement(sp,    sNode); // (19)
  this._hDPB  = solver.allocElement(dp,    bNode); // (20)
  this._hSPB  = solver.allocElement(sp,    bNode); // (21)
  this._hSPDP = solver.allocElement(sp,    dp);    // (22)
}
```

## load() body- value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/mos1/mos1load.c`
line-for-line, applying P-channel polarity (`MOS1type = -1`), stamping through
cached handles. No allocElement calls.

- Preserve multiplicity scaling: all current and conductance stamps are multiplied by the instance `M` parameter (default 1.0). ngspice anchor: `dioload.c` / `mos1load.c` / `bjtload.c` / `jfetload.c` use `here->{DIO|MOS1|BJT|JFET}m` for this scaling. The instance `M` parameter is partition: "instance" per the in-progress phase-instance-vs-model-param-partition work.

## findBranchFor (if applicable)

Not applicable. MOS1 has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { G: "gate", D: "drain", S: "source" }`.

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
