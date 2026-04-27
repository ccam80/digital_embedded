# Task PB-TLINE — Ideal lossless transmission line

**digiTS file:** `src/components/passives/transmission-line.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/tra/trasetup.c:37-92`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/tra/traload.c`

## Architecture

This component is a flat element (no composite sub-elements). It directly ports the ngspice ideal
lossless TRA primitive from `trasetup.c`. The previous lumped RLCG segmented model is removed in
its entirety. Any circuits using the old lossy-line behavior will lose that capability; a separate
`transmission-line-lossy` component would be needed for lossy-line modeling (not in this scope).

## Pin layout

4 pins, matching ngspice TRA node names:

| digiTS pin label | ngspiceNodeMap key | ngspice variable |
|---|---|---|
| `inP` | `pos1` | `TRAposNode1` |
| `inN` | `neg1` | `TRAnegNode1` |
| `outP` | `pos2` | `TRAposNode2` |
| `outN` | `neg2` | `TRAnegNode2` |

```ts
ngspiceNodeMap = { inP: "pos1", inN: "neg1", outP: "pos2", outN: "neg2" }
```

## Sub-elements

NONE. This is a flat element; all handles owned directly.

## Internal nodes (trasetup.c:37-59)

4 internal nodes, allocated with `CKTmkVolt` in `setup()`:

| digiTS name | ngspice variable | trasetup.c line | Allocation call |
|---|---|---|---|
| `_brEq1` | `TRAbrEq1` | 38-41 | `ctx.makeCur(label, "i1")` |
| `_brEq2` | `TRAbrEq2` | 43-46 | `ctx.makeCur(label, "i2")` |
| `_intNode1` | `TRAintNode1` | 48-51 | `ctx.makeVolt(label, "int1")` |
| `_intNode2` | `TRAintNode2` | 53-56 | `ctx.makeVolt(label, "int2")` |

Note: ngspice uses `CKTmkVolt` for all four (the "branch" rows `TRAbrEq1`/`TRAbrEq2` are voltage
nodes in the ngspice TRA formulation, allocated via `CKTmkVolt` with suffixes `"i1"` and `"i2"`).
digiTS maps them as `ctx.makeCur` calls since they function as branch rows in the MNA sense.

## State slots

Per `trasetup.c`: the TRA model allocates a delay table (`here->TRAdelays = TMALLOC(double, 15)`)
at trasetup.c:62-63 rather than using the standard `*states` mechanism. The digiTS port allocates
a delay buffer of 15 doubles via `ctx.allocStates(15)` to maintain the same per-instance storage.
State offset stored in `_stateBase`.

## TSTALLOC sequence (22 entries — trasetup.c:71-92, line-for-line)

All 22 entries are unconditional. Node abbreviations: `b1`=`_brEq1`, `b2`=`_brEq2`,
`n1`=`_intNode1`, `n2`=`_intNode2`, `p1`=`inP pin node`, `q1`=`inN pin node`,
`p2`=`outP pin node`, `q2`=`outN pin node`.

| # | trasetup.c line | ngspice pair | digiTS pair | handle field |
|---|---|---|---|---|
| 1 | 71 | `(TRAbrEq1, TRAbrEq2)` | `(_brEq1, _brEq2)` | `_hIbr1Ibr2` |
| 2 | 72 | `(TRAbrEq1, TRAintNode1)` | `(_brEq1, _intNode1)` | `_hIbr1Int1` |
| 3 | 73 | `(TRAbrEq1, TRAnegNode1)` | `(_brEq1, inN)` | `_hIbr1Neg1` |
| 4 | 74 | `(TRAbrEq1, TRAnegNode2)` | `(_brEq1, outN)` | `_hIbr1Neg2` |
| 5 | 75 | `(TRAbrEq1, TRAposNode2)` | `(_brEq1, outP)` | `_hIbr1Pos2` |
| 6 | 76 | `(TRAbrEq2, TRAbrEq1)` | `(_brEq2, _brEq1)` | `_hIbr2Ibr1` |
| 7 | 77 | `(TRAbrEq2, TRAintNode2)` | `(_brEq2, _intNode2)` | `_hIbr2Int2` |
| 8 | 78 | `(TRAbrEq2, TRAnegNode1)` | `(_brEq2, inN)` | `_hIbr2Neg1` |
| 9 | 79 | `(TRAbrEq2, TRAnegNode2)` | `(_brEq2, outN)` | `_hIbr2Neg2` |
| 10 | 80 | `(TRAbrEq2, TRAposNode1)` | `(_brEq2, inP)` | `_hIbr2Pos1` |
| 11 | 81 | `(TRAintNode1, TRAbrEq1)` | `(_intNode1, _brEq1)` | `_hInt1Ibr1` |
| 12 | 82 | `(TRAintNode1, TRAintNode1)` | `(_intNode1, _intNode1)` | `_hInt1Int1` |
| 13 | 83 | `(TRAintNode1, TRAposNode1)` | `(_intNode1, inP)` | `_hInt1Pos1` |
| 14 | 84 | `(TRAintNode2, TRAbrEq2)` | `(_intNode2, _brEq2)` | `_hInt2Ibr2` |
| 15 | 85 | `(TRAintNode2, TRAintNode2)` | `(_intNode2, _intNode2)` | `_hInt2Int2` |
| 16 | 86 | `(TRAintNode2, TRAposNode2)` | `(_intNode2, outP)` | `_hInt2Pos2` |
| 17 | 87 | `(TRAnegNode1, TRAbrEq1)` | `(inN, _brEq1)` | `_hNeg1Ibr1` |
| 18 | 88 | `(TRAnegNode2, TRAbrEq2)` | `(outN, _brEq2)` | `_hNeg2Ibr2` |
| 19 | 89 | `(TRAposNode1, TRAintNode1)` | `(inP, _intNode1)` | `_hPos1Int1` |
| 20 | 90 | `(TRAposNode1, TRAposNode1)` | `(inP, inP)` | `_hPos1Pos1` |
| 21 | 91 | `(TRAposNode2, TRAintNode2)` | `(outP, _intNode2)` | `_hPos2Int2` |
| 22 | 92 | `(TRAposNode2, TRAposNode2)` | `(outP, outP)` | `_hPos2Pos2` |

## setup() body

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const inP  = this._pinNodes.get("inP")!;   // TRAposNode1
  const inN  = this._pinNodes.get("inN")!;   // TRAnegNode1
  const outP = this._pinNodes.get("outP")!;  // TRAposNode2
  const outN = this._pinNodes.get("outN")!;  // TRAnegNode2

  // trasetup.c:37-59 — allocate 4 internal nodes (idempotent guards)
  if (this._brEq1 === 0) {
    this._brEq1 = ctx.makeCur(this._label, "i1");
  }
  if (this._brEq2 === 0) {
    this._brEq2 = ctx.makeCur(this._label, "i2");
  }
  if (this._intNode1 === 0) {
    this._intNode1 = ctx.makeVolt(this._label, "int1");
  }
  if (this._intNode2 === 0) {
    this._intNode2 = ctx.makeVolt(this._label, "int2");
  }

  // trasetup.c:62-63 — delay table (15 doubles)
  this._stateBase = ctx.allocStates(15);

  const b1 = this._brEq1;
  const b2 = this._brEq2;
  const n1 = this._intNode1;
  const n2 = this._intNode2;

  // trasetup.c:71-92 — 22 unconditional TSTALLOC calls, line-for-line
  this._hIbr1Ibr2 = solver.allocElement(b1, b2);   // line 71
  this._hIbr1Int1 = solver.allocElement(b1, n1);   // line 72
  this._hIbr1Neg1 = solver.allocElement(b1, inN);  // line 73
  this._hIbr1Neg2 = solver.allocElement(b1, outN); // line 74
  this._hIbr1Pos2 = solver.allocElement(b1, outP); // line 75
  this._hIbr2Ibr1 = solver.allocElement(b2, b1);   // line 76
  this._hIbr2Int2 = solver.allocElement(b2, n2);   // line 77
  this._hIbr2Neg1 = solver.allocElement(b2, inN);  // line 78
  this._hIbr2Neg2 = solver.allocElement(b2, outN); // line 79
  this._hIbr2Pos1 = solver.allocElement(b2, inP);  // line 80
  this._hInt1Ibr1 = solver.allocElement(n1, b1);   // line 81
  this._hInt1Int1 = solver.allocElement(n1, n1);   // line 82
  this._hInt1Pos1 = solver.allocElement(n1, inP);  // line 83
  this._hInt2Ibr2 = solver.allocElement(n2, b2);   // line 84
  this._hInt2Int2 = solver.allocElement(n2, n2);   // line 85
  this._hInt2Pos2 = solver.allocElement(n2, outP); // line 86
  this._hNeg1Ibr1 = solver.allocElement(inN, b1);  // line 87
  this._hNeg2Ibr2 = solver.allocElement(outN, b2); // line 88
  this._hPos1Int1 = solver.allocElement(inP, n1);  // line 89
  this._hPos1Pos1 = solver.allocElement(inP, inP); // line 90
  this._hPos2Int2 = solver.allocElement(outP, n2); // line 91
  this._hPos2Pos2 = solver.allocElement(outP, outP); // line 92
}
```

Fields to add to element class:
```ts
private _brEq1:    number = 0;
private _brEq2:    number = 0;
private _intNode1: number = 0;
private _intNode2: number = 0;
private _stateBase: number = -1;
private _hIbr1Ibr2: number = -1;
private _hIbr1Int1: number = -1;
private _hIbr1Neg1: number = -1;
private _hIbr1Neg2: number = -1;
private _hIbr1Pos2: number = -1;
private _hIbr2Ibr1: number = -1;
private _hIbr2Int2: number = -1;
private _hIbr2Neg1: number = -1;
private _hIbr2Neg2: number = -1;
private _hIbr2Pos1: number = -1;
private _hInt1Ibr1: number = -1;
private _hInt1Int1: number = -1;
private _hInt1Pos1: number = -1;
private _hInt2Ibr2: number = -1;
private _hInt2Int2: number = -1;
private _hInt2Pos2: number = -1;
private _hNeg1Ibr1: number = -1;
private _hNeg2Ibr2: number = -1;
private _hPos1Int1: number = -1;
private _hPos1Pos1: number = -1;
private _hPos2Int2: number = -1;
private _hPos2Pos2: number = -1;
```

## load() body

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/tra/traload.c`
line-for-line, stamping through the 22 cached handles only. No `solver.allocElement` calls.

The TRA load uses a history-based (method-of-characteristics) formulation: the delayed voltage and
current at one port drive the other. The delay table (`_stateBase` buffer) stores past port
values at discrete time points for interpolation.

## Factory cleanup

- Pin labels renamed from `P1a`/`P1b`/`P2a`/`P2b` to `inP`/`inN`/`outP`/`outN`.
- `ngspiceNodeMap: { inP: "pos1", inN: "neg1", outP: "pos2", outN: "neg2" }` added to
  `ComponentDefinition`.
- Drop `internalNodeIds`, `branchIdx`, `segments` parameters from factory signature.
- Drop `branchCount`, `getInternalNodeCount`, `getInternalNodeLabels` from `MnaModel`.
- Add `mayCreateInternalNodes: true` (four nodes allocated in `setup()`).
- No `findBranchFor` callback (TRA does not appear as a sense element for CCCS/CCVS in standard
  usage).

## Verification gate

1. `src/components/passives/__tests__/transmission-line.test.ts` is GREEN. The test must be
   rewritten to match ideal-TRA behavior (delay-based port equations from `traload.c`); the old
   lumped RLCG assertions are removed with the old model.
   - **Setup-mocking removal**: the implementer MUST audit the test file for any pattern that fakes the migrated `setup()` process (e.g., manually constructing element handles, stub solver objects that bypass the real allocation path, or directly calling `load()` without going through `_setup()` first). Every such pattern MUST be replaced with the real path: instantiate the element via its factory, call `_setup()` on the engine to allocate handles, then exercise `load()`/`accept()`. Tests that pass only because they bypass the new setup contract are NOT a valid GREEN signal — those tests are themselves a defect to be fixed in this same task.
2. `setup-stamp-order.test.ts` row for PB-TLINE asserts the exact 22-entry sequence from
   trasetup.c:71-92 in that order.
3. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence)
   used in any commit message or report.

## Migration impact

The previous lumped RLCG model (`N` cascaded segments, `segments` parameter, `9N-4` stamps) is
removed. Existing circuits using `transmission-line` for lossy lines lose that capability. A
separate `transmission-line-lossy` component handles lossy-line modeling when needed (not in this
scope).
