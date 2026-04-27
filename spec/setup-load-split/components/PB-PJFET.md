# Task PB-PJFET

**digiTS file:** `src/components/semiconductors/pjfet.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/jfet/jfetset.c:112-180`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/jfet/jfetload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS label | ngspice variable | Note |
|---|---|---|
| `G` | `JFETgateNode` | Gate — external |
| `D` | `JFETdrainNode` | Drain — external |
| `S` | `JFETsourceNode` | Source — external |
| `sourcePrime` | `JFETsourcePrimeNode` | Internal source node (when RS ≠ 0) |
| `drainPrime` | `JFETdrainPrimeNode` | Internal drain node (when RD ≠ 0) |

Note: PJFET pin layout order is `G`, `D`, `S` (drain before source in the
pin list) — distinct from NJFET which uses `G`, `S`, `D`. The `ngspiceNodeMap`
reflects this difference. The setup() body is polarity-independent: all node
allocation and TSTALLOC stamps are identical for N- and P-channel JFETs; the
polarity sign is applied in load() via the JFET type flag.

```
const gateNode   = pinNodes.get("G")!;   // JFETgateNode
const drainNode  = pinNodes.get("D")!;   // JFETdrainNode
const sourceNode = pinNodes.get("S")!;   // JFETsourceNode
```

## Internal nodes

Two conditional internal nodes. Same conditional gates as PB-NJFET — see
`jfetset.c:115-158`. Order: source prime BEFORE drain prime (ngspice order).

```ts
this._sourcePrimeNode = (model.RS === 0) ? sourceNode : ctx.makeVolt(this.label, "source");
this._drainPrimeNode  = (model.RD === 0) ? drainNode  : ctx.makeVolt(this.label, "drain");
```

## Branch rows

None.

## State slots

`*states += 13` at `jfetset.c:112-113`. Identical to PB-NJFET.

```ts
this._stateOffset = ctx.allocStates(13);
```

## TSTALLOC sequence (line-for-line port)

`jfetset.c:166-180`. Fifteen entries. Identical to PB-NJFET — the same
ngspice source file handles both N and P channel. The TSTALLOC row/col
variables `JFETdrainNode`, `JFETgateNode`, `JFETsourceNode` are resolved
from the instance's pin nodes regardless of channel type.

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

RS=0 / RD=0 collapse behaviour: identical to PB-NJFET — see that spec.

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver     = ctx.solver;
  const gateNode   = this._pinNodes.get("G")!;
  const drainNode  = this._pinNodes.get("D")!;
  const sourceNode = this._pinNodes.get("S")!;
  const model      = this._model;

  // State slots — jfetset.c:112-113
  this._stateOffset = ctx.allocStates(13);

  // Internal nodes — jfetset.c:115-158 (source prime before drain prime)
  this._sourcePrimeNode = (model.RS === 0) ? sourceNode : ctx.makeVolt(this.label, "source");
  this._drainPrimeNode  = (model.RD === 0) ? drainNode  : ctx.makeVolt(this.label, "drain");

  const sp = this._sourcePrimeNode;
  const dp = this._drainPrimeNode;

  // TSTALLOC sequence — jfetset.c:166-180 (identical to NJFET)
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
line-for-line, applying P-channel polarity (type = -1), stamping through cached
handles. No allocElement calls.

## findBranchFor (if applicable)

Not applicable. JFET has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `hasBranchRow: false`.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { G: "gate", D: "drain", S: "source" }`.

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-PJFET is GREEN.
2. `src/components/semiconductors/__tests__/pjfet.test.ts` is GREEN.
3. No banned closing verdicts.
