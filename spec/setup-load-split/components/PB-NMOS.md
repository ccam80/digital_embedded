# Task PB-NMOS

**digiTS file:** `src/components/semiconductors/mosfet.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/mos1/mos1set.c:92-207`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/mos1/mos1load.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS label | ngspice variable | Note |
|---|---|---|
| `G` | `MOS1gNode` | Gate — external |
| `S` | `MOS1sNode` | Source — external |
| `D` | `MOS1dNode` | Drain — external |
| `B` (bulk) | `MOS1bNode` | Bulk — set to `pinNodes.get("S")` for 3-terminal NMOS (body tied to source) |
| `dNodePrime` | `MOS1dNodePrime` | Internal drain node (conditional) |
| `sNodePrime` | `MOS1sNodePrime` | Internal source node (conditional) |

```
const gNode = pinNodes.get("G")!;   // MOS1gNode
const sNode = pinNodes.get("S")!;   // MOS1sNode
const dNode = pinNodes.get("D")!;   // MOS1dNode
const bNode = sNode;                // MOS1bNode — body tied to source (3-terminal)
```

## Property name mapping

The ngspice `mos1set.c` variable names differ from digiTS model property names.
Authoritative mapping:

| ngspice variable | digiTS model property | Default (mos1set.c) |
|---|---|---|
| `model->MOS1drainResistance` | `model.RD` | 0 |
| `model->MOS1sourceResistance` | `model.RS` | 0 |
| `model->MOS1sheetResistance` | `model.RS_sheet` | 0 |
| `here->MOS1drainSquares` | `instance.drainSquares` | 1 (mos1set.c:124-125) |
| `here->MOS1sourceSquares` | `instance.sourceSquares` | 1 (mos1set.c:127-128) |

## Internal nodes

Two conditional internal nodes. Verbatim gates from `mos1set.c:131-178`:

```c
// Drain internal node (mos1set.c:131-154)
if ((model->MOS1drainResistance != 0
        || (model->MOS1sheetResistance != 0
            && here->MOS1drainSquares != 0) )) {
    if (here->MOS1dNodePrime == 0) {
        error = CKTmkVolt(ckt, &tmp, here->MOS1name, "drain");
        if(error) return(error);
        here->MOS1dNodePrime = tmp->number;
    }
} else {
    here->MOS1dNodePrime = here->MOS1dNode;
}

// Source internal node (mos1set.c:156-178)
if((model->MOS1sourceResistance != 0 ||
        (model->MOS1sheetResistance != 0 &&
         here->MOS1sourceSquares != 0) )) {
    if (here->MOS1sNodePrime == 0) {
        error = CKTmkVolt(ckt, &tmp, here->MOS1name, "source");
        if(error) return(error);
        here->MOS1sNodePrime = tmp->number;
    }
} else {
    here->MOS1sNodePrime = here->MOS1sNode;
}
```

digiTS port:

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

**Default squares:** `drainSquares` and `sourceSquares` both default to 1 per
`mos1set.c:124-128`. A default `RS_sheet != 0` with default squares ≠ 0 therefore
creates prime nodes. The digiTS property bag must honour these defaults.

## Branch rows

None.

## State slots

`*states += MOS1numStates` at `mos1set.c:97`. `MOS1numStates = 17` per
`mos1defs.h:292`.

```ts
this._stateBase = ctx.allocStates(17);
```

## TSTALLOC sequence (line-for-line port)

`mos1set.c:186-207`. Twenty-two entries.

Variables: `dp = _dNodePrime`, `sp = _sNodePrime`, `b = bNode` (= `sNode` for
3-terminal).

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

**No conditional skips for RD=0 / RS=0:** ngspice does NOT skip entries
5/6/7/11/15/19 when the prime node aliases the external node. When
`dNodePrime = dNode`, entries (1) and (5) become `allocElement(dNode, dNode)` —
the second call returns the existing handle. Entry (7) becomes
`allocElement(dNode, dNode)` again. The port allocates all 22 entries
unconditionally.

**3-terminal bulk alias:** `bNode = sNode`. Entries (4), (8), (12), (13), (16),
(20), (21) reference `bNode`. With `bNode = sNode`, entries (3) and (4) become
`allocElement(sNode, sNode)` — repeated calls return existing handles. No
special case.

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const gNode  = this._pinNodes.get("G")!;
  const sNode  = this._pinNodes.get("S")!;
  const dNode  = this._pinNodes.get("D")!;
  const bNode  = sNode;   // 3-terminal: body tied to source
  const model    = this._model;
  const instance = this._instance;

  // State slots — mos1set.c:96-97
  this._stateBase = ctx.allocStates(17);

  // Internal nodes — mos1set.c:131-178
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

  // TSTALLOC sequence — mos1set.c:186-207 (all 22, unconditional)
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

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/mos1/mos1load.c`
line-for-line, stamping through cached handles. No allocElement calls.

- Preserve multiplicity scaling: all current and conductance stamps are multiplied by the instance `M` parameter (default 1.0). ngspice anchor: `dioload.c` / `mos1load.c` / `bjtload.c` / `jfetload.c` use `here->{DIO|MOS1|BJT|JFET}m` for this scaling. The instance `M` parameter is partition: "instance" per the in-progress phase-instance-vs-model-param-partition work.

## findBranchFor (if applicable)

Not applicable. MOS1 has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { G: "gate", S: "source", D: "drain" }`.
  (`B` bulk is not in the pin layout for 3-terminal — it is derived as `sNode` in setup().)

## Verification gate

1. `setup-stamp-order.test.ts` row for PB-NMOS is GREEN.
2. `src/components/semiconductors/__tests__/mosfet.test.ts` is GREEN (NMOS case).
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
3. No banned closing verdicts.
