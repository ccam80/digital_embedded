# Task PB-BJT

**digiTS file:** `src/components/semiconductors/bjt.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/bjt/bjtsetup.c:347-465`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/bjt/bjtload.c`

## Pin mapping (from 01-pin-mapping.md)

| digiTS label | ngspice variable | Note |
|---|---|---|
| `B` | `BJTbaseNode` | Base — external |
| `C` | `BJTcolNode` | Collector — external |
| `E` | `BJTemitNode` | Emitter — external |
| `colPrime` | `BJTcolPrimeNode` | Internal collector node (when RC ≠ 0) |
| `basePrime` | `BJTbasePrimeNode` | Internal base node (when RB ≠ 0) |
| `emitPrime` | `BJTemitPrimeNode` | Internal emitter node (when RE ≠ 0) |
| substrate | `BJTsubstNode` | Substrate — **not modelled in digiTS**; treated as ground (node 0) |

```
const baseNode = pinNodes.get("B")!;   // BJTbaseNode
const colNode  = pinNodes.get("C")!;   // BJTcolNode
const emitNode = pinNodes.get("E")!;   // BJTemitNode
const substNode = 0;                   // BJTsubstNode — ground alias
```

**NPN/PNP polymorphism:** PNP is implemented as NPN with `polarity = -1`
(mirrors `BJTtype` in bjtdefs.h). setup() is polarity-independent — all
node allocation and TSTALLOC stamps are identical for NPN and PNP; the
polarity sign is applied only in load().

## Internal nodes

Three conditional internal nodes. Verbatim gates from `bjtsetup.c:372-428`:

```c
// Collector internal node (bjtsetup.c:372-390)
if(model->BJTcollectorResist == 0) {
    here->BJTcolPrimeNode = here->BJTcolNode;
} else if(here->BJTcolPrimeNode == 0) {
    error = CKTmkVolt(ckt, &tmp, here->BJTname, "collector");
    if(error) return(error);
    here->BJTcolPrimeNode = tmp->number;
}

// Base internal node (bjtsetup.c:391-409)
if(model->BJTbaseResist == 0) {
    here->BJTbasePrimeNode = here->BJTbaseNode;
} else if(here->BJTbasePrimeNode == 0) {
    error = CKTmkVolt(ckt, &tmp, here->BJTname, "base");
    if(error) return(error);
    here->BJTbasePrimeNode = tmp->number;
}

// Emitter internal node (bjtsetup.c:410-428)
if(model->BJTemitterResist == 0) {
    here->BJTemitPrimeNode = here->BJTemitNode;
} else if(here->BJTemitPrimeNode == 0) {
    error = CKTmkVolt(ckt, &tmp, here->BJTname, "emitter");
    if(error) return(error);
    here->BJTemitPrimeNode = tmp->number;
}
```

digiTS port:

```ts
this._colPrimeNode  = (model.RC === 0) ? colNode  : ctx.makeVolt(this.label, "collector");
this._basePrimeNode = (model.RB === 0) ? baseNode : ctx.makeVolt(this.label, "base");
this._emitPrimeNode = (model.RE === 0) ? emitNode : ctx.makeVolt(this.label, "emitter");
```

### Substrate node

digiTS does not model the substrate terminal. `substNode = 0` (ground).
TSTALLOCs 19-21 that reference `BJTsubstNode` therefore stamp into row/col 0
(ground), which is the standard "connect to ground" alias. `allocElement(0, x)`
and `allocElement(x, 0)` allocate ground-row/col entries; the solver ignores
row 0 in load (ground KCL is not assembled). This is intentional and documented
here so the implementer does not conditionally skip these three stamps.

### Substrate connection alias (bjtsetup.c:454-460)

```c
if (model->BJTsubs == LATERAL) {
    here->BJTsubstConNode    = here->BJTbasePrimeNode;
    here->BJTsubstConSubstConPtr = here->BJTbasePrimeBasePrimePtr;  // alias
} else {
    here->BJTsubstConNode    = here->BJTcolPrimeNode;
    here->BJTsubstConSubstConPtr = here->BJTcolPrimeColPrimePtr;    // alias
}
```

digiTS port: store `_substConNode` and reuse the already-allocated handle.
No new `allocElement` call here — it is a pointer alias, not a new stamp.

```ts
// After TSTALLOC 18 (BJTcolPrimeColPrimePtr) and TSTALLOC 17 (BJTbasePrimeBasePrimePtr):
if (model.BJTsubs === 'LATERAL') {
  this._substConNode           = this._basePrimeNode;
  this._hSubstConSubstCon      = this._hBPBP;    // alias to handle 17
} else {
  this._substConNode           = this._colPrimeNode;
  this._hSubstConSubstCon      = this._hCPCP;    // alias to handle 16
}
```

## Branch rows

None.

## State slots

`*states += BJTnumStates` at `bjtsetup.c:367`. `BJTnumStates = 24` per
`bjtdefs.h:313`.

```ts
this._stateBase = ctx.allocStates(24);
```

## TSTALLOC sequence (line-for-line port)

`bjtsetup.c:435-464`. Twenty-three TSTALLOC entries.

Variables: `cp = _colPrimeNode`, `bp = _basePrimeNode`, `ep = _emitPrimeNode`,
`s = substNode (= 0)`, `sc = _substConNode`.

| # | ngspice pointer | row | col | digiTS handle |
|---|---|---|---|---|
| 1 | `BJTcolColPrimePtr` | `BJTcolNode` | `BJTcolPrimeNode` | `this._hCCP` |
| 2 | `BJTbaseBasePrimePtr` | `BJTbaseNode` | `BJTbasePrimeNode` | `this._hBBP` |
| 3 | `BJTemitEmitPrimePtr` | `BJTemitNode` | `BJTemitPrimeNode` | `this._hEEP` |
| 4 | `BJTcolPrimeColPtr` | `BJTcolPrimeNode` | `BJTcolNode` | `this._hCPC` |
| 5 | `BJTcolPrimeBasePrimePtr` | `BJTcolPrimeNode` | `BJTbasePrimeNode` | `this._hCPBP` |
| 6 | `BJTcolPrimeEmitPrimePtr` | `BJTcolPrimeNode` | `BJTemitPrimeNode` | `this._hCPEP` |
| 7 | `BJTbasePrimeBasePtr` | `BJTbasePrimeNode` | `BJTbaseNode` | `this._hBPB` |
| 8 | `BJTbasePrimeColPrimePtr` | `BJTbasePrimeNode` | `BJTcolPrimeNode` | `this._hBPCP` |
| 9 | `BJTbasePrimeEmitPrimePtr` | `BJTbasePrimeNode` | `BJTemitPrimeNode` | `this._hBPEP` |
| 10 | `BJTemitPrimeEmitPtr` | `BJTemitPrimeNode` | `BJTemitNode` | `this._hEPE` |
| 11 | `BJTemitPrimeColPrimePtr` | `BJTemitPrimeNode` | `BJTcolPrimeNode` | `this._hEPCP` |
| 12 | `BJTemitPrimeBasePrimePtr` | `BJTemitPrimeNode` | `BJTbasePrimeNode` | `this._hEPBP` |
| 13 | `BJTcolColPtr` | `BJTcolNode` | `BJTcolNode` | `this._hCC` |
| 14 | `BJTbaseBasePtr` | `BJTbaseNode` | `BJTbaseNode` | `this._hBB` |
| 15 | `BJTemitEmitPtr` | `BJTemitNode` | `BJTemitNode` | `this._hEE` |
| 16 | `BJTcolPrimeColPrimePtr` | `BJTcolPrimeNode` | `BJTcolPrimeNode` | `this._hCPCP` |
| 17 | `BJTbasePrimeBasePrimePtr` | `BJTbasePrimeNode` | `BJTbasePrimeNode` | `this._hBPBP` |
| 18 | `BJTemitPrimeEmitPrimePtr` | `BJTemitPrimeNode` | `BJTemitPrimeNode` | `this._hEPEP` |
| 19 | `BJTsubstSubstPtr` | `BJTsubstNode (=0)` | `BJTsubstNode (=0)` | `this._hSS` |
| 20 | `BJTsubstConSubstPtr` | `BJTsubstConNode` | `BJTsubstNode (=0)` | `this._hSCS` |
| 21 | `BJTsubstSubstConPtr` | `BJTsubstNode (=0)` | `BJTsubstConNode` | `this._hSSC` |
| 22 | `BJTbaseColPrimePtr` | `BJTbaseNode` | `BJTcolPrimeNode` | `this._hBCP` |
| 23 | `BJTcolPrimeBasePtr` | `BJTcolPrimeNode` | `BJTbaseNode` | `this._hCPB` |

**Entries 19-21 with substNode = 0:** `allocElement(0, 0)`, `allocElement(sc, 0)`,
`allocElement(0, sc)` all touch the ground row/column. The solver skips row 0
during KCL assembly, so these handles are written during load() but effectively
no-op. They are allocated unconditionally — no conditional skip.

**RC=0/RB=0/RE=0 collapse:** When a resistance is zero, the corresponding
prime node equals the external node. Entries (1)/(13) collapse when RC=0
(`colPrimeNode = colNode`), etc. `allocElement` returns the existing handle
on repeated calls — no special case in the port.

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver   = ctx.solver;
  const baseNode = this._pinNodes.get("B")!;
  const colNode  = this._pinNodes.get("C")!;
  const emitNode = this._pinNodes.get("E")!;
  const substNode = 0;  // ground alias — no substrate terminal
  const model    = this._model;

  // State slots — bjtsetup.c:366-367
  this._stateBase = ctx.allocStates(24);

  // Internal nodes — bjtsetup.c:372-428
  this._colPrimeNode  = (model.RC === 0) ? colNode  : ctx.makeVolt(this.label, "collector");
  this._basePrimeNode = (model.RB === 0) ? baseNode : ctx.makeVolt(this.label, "base");
  this._emitPrimeNode = (model.RE === 0) ? emitNode : ctx.makeVolt(this.label, "emitter");

  const cp = this._colPrimeNode;
  const bp = this._basePrimeNode;
  const ep = this._emitPrimeNode;

  // TSTALLOC sequence — bjtsetup.c:435-452 (entries 1-18)
  this._hCCP  = solver.allocElement(colNode,  cp);      // (1)
  this._hBBP  = solver.allocElement(baseNode, bp);      // (2)
  this._hEEP  = solver.allocElement(emitNode, ep);      // (3)
  this._hCPC  = solver.allocElement(cp,       colNode); // (4)
  this._hCPBP = solver.allocElement(cp,       bp);      // (5)
  this._hCPEP = solver.allocElement(cp,       ep);      // (6)
  this._hBPB  = solver.allocElement(bp,       baseNode);// (7)
  this._hBPCP = solver.allocElement(bp,       cp);      // (8)
  this._hBPEP = solver.allocElement(bp,       ep);      // (9)
  this._hEPE  = solver.allocElement(ep,       emitNode);// (10)
  this._hEPCP = solver.allocElement(ep,       cp);      // (11)
  this._hEPBP = solver.allocElement(ep,       bp);      // (12)
  this._hCC   = solver.allocElement(colNode,  colNode); // (13)
  this._hBB   = solver.allocElement(baseNode, baseNode);// (14)
  this._hEE   = solver.allocElement(emitNode, emitNode);// (15)
  this._hCPCP = solver.allocElement(cp,       cp);      // (16)
  this._hBPBP = solver.allocElement(bp,       bp);      // (17)
  this._hEPEP = solver.allocElement(ep,       ep);      // (18)

  // Substrate stamps — bjtsetup.c:453 (entry 19), :461-462 (entries 20-21, substNode=0)
  this._hSS   = solver.allocElement(substNode, substNode); // (19)
  // Substrate alias — bjtsetup.c:454-460
  let sc: number;
  if (model.BJTsubs === 'LATERAL') {
    sc = bp;
    this._hSubstConSubstCon = this._hBPBP;  // pointer alias — no new alloc
  } else {
    sc = cp;
    this._hSubstConSubstCon = this._hCPCP;  // pointer alias — no new alloc
  }
  this._substConNode = sc;
  this._hSCS  = solver.allocElement(sc,        substNode); // (20)
  this._hSSC  = solver.allocElement(substNode, sc);        // (21)

  // Remaining stamps — bjtsetup.c:463-464 (entries 22-23)
  this._hBCP  = solver.allocElement(baseNode, cp);      // (22)
  this._hCPB  = solver.allocElement(cp,       baseNode);// (23)
}
```

## load() body — value writes only

Implementer ports value-side from `ref/ngspice/src/spicelib/devices/bjt/bjtload.c`
line-for-line, stamping through cached handles. No allocElement calls.

- Preserve multiplicity scaling: all current and conductance stamps are multiplied by the instance `M` parameter (default 1.0). ngspice anchor: `dioload.c` / `mos1load.c` / `bjtload.c` / `jfetload.c` use `here->{DIO|MOS1|BJT|JFET}m` for this scaling. The instance `M` parameter is partition: "instance" per the in-progress phase-instance-vs-model-param-partition work.

## findBranchFor (if applicable)

Not applicable. BJT has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel.
- Add `mayCreateInternalNodes: true`.
- Add `ngspiceNodeMap: { B: "base", C: "col", E: "emit" }`.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body — alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only — zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
