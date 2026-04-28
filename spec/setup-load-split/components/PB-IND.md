# Task PB-IND

**digiTS file:** `src/components/passives/inductor.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/ind/indsetup.c:78-100`
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/ind/indload.c`

## Pin mapping (from 01-pin-mapping.md)

`ngspiceNodeMap = { A: "pos", B: "neg" }`.

| digiTS pin label | pinNodes key | ngspice node variable |
|---|---|---|
| `A` | `pinNodes.get("A")` | `INDposNode` |
| `B` | `pinNodes.get("B")` | `INDnegNode` |

## Internal nodes

None. `INDsetup.c` makes no `CKTmkVolt` calls.

## Branch rows

`indsetup.c:84-88`:
```c
if(here->INDbrEq == 0) {
    error = CKTmkCur(ckt,&tmp,here->INDname,"branch");
    if(error) return(error);
    here->INDbrEq = tmp->number;
}
```

One branch row allocated for the inductor current. The guard `if (here->INDbrEq == 0)` is the idempotent pattern — mirrors `VSRCfindBr`. In digiTS, `setup()` calls `ctx.makeCur(label, "branch")` and stores the result; `findBranchFor` performs the same idempotent allocation.

## State slots

`indsetup.c:78-79`:
```c
here->INDflux = *states;
*states += 2;
```

Two state slots allocated (INDflux = state+0, INDvolt = state+1). digiTS port:
```ts
this._stateBase = ctx.allocStates(2);
```

## TSTALLOC sequence (line-for-line port)

`indsetup.c:96-100` — five unconditional TSTALLOC calls (after `INDbrEq` is allocated):

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(INDposNode, INDbrEq)` | `(pinNodes.get("A"), this.branchIndex)` | `_hPIbr` |
| 2 | `(INDnegNode, INDbrEq)` | `(pinNodes.get("B"), this.branchIndex)` | `_hNIbr` |
| 3 | `(INDbrEq, INDnegNode)` | `(this.branchIndex, pinNodes.get("B"))` | `_hIbrN` |
| 4 | `(INDbrEq, INDposNode)` | `(this.branchIndex, pinNodes.get("A"))` | `_hIbrP` |
| 5 | `(INDbrEq, INDbrEq)` | `(this.branchIndex, this.branchIndex)` | `_hIbrIbr` |

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const posNode = pinNodes.get("A")!;  // INDposNode
  const negNode = pinNodes.get("B")!;  // INDnegNode

  // indsetup.c:78-79 — *states += 2 (INDflux = state+0, INDvolt = state+1)
  this._stateBase = ctx.allocStates(2);

  // indsetup.c:84-88 — CKTmkCur guard (idempotent, mirrors VSRCfindBr pattern).
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this._label, "branch");
  }
  const b = this.branchIndex;

  // indsetup.c:96-100 — TSTALLOC sequence, line-for-line.
  this._hPIbr   = solver.allocElement(posNode, b);  // (INDposNode, INDbrEq)
  this._hNIbr   = solver.allocElement(negNode, b);  // (INDnegNode, INDbrEq)
  this._hIbrN   = solver.allocElement(b, negNode);  // (INDbrEq,    INDnegNode)
  this._hIbrP   = solver.allocElement(b, posNode);  // (INDbrEq,    INDposNode)
  this._hIbrIbr = solver.allocElement(b, b);        // (INDbrEq,    INDbrEq)
}
```

Fields to add to `AnalogInductorElement`:
```ts
private _stateBase: number = -1;
private _hPIbr:   number = -1;
private _hNIbr:   number = -1;
private _hIbrN:   number = -1;
private _hIbrP:   number = -1;
private _hIbrIbr: number = -1;
```

Note: `branchIndex` on `AnalogElementCore` must be mutable (per A3: `Drop readonly from branchIndex`). The current `AnalogInductorElement` receives `branchIndex` via constructor; after migration it starts at `-1` and is set in `setup()`.

## load() body — value writes only

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/ind/indload.c` line-for-line, stamping through cached handles only. No `solver.allocElement` calls.

## findBranchFor (if applicable)

The inductor owns a branch row and must expose `findBranchFor` so that CCCS/CCVS elements can resolve the branch number before or after the inductor's `setup()` runs:

```ts
findBranchFor(name: string, ctx: SetupContext): number {
  if (name !== this._label) return 0;
  if (this.branchIndex === -1) {
    this.branchIndex = ctx.makeCur(this._label, "branch");
  }
  return this.branchIndex;
}
```

This callback is registered on the `MnaModel` and called by `MNAEngine._findBranch()`. The guard `if (this.branchIndex === -1)` is the same idempotent pattern used in `setup()`, so call order is irrelevant — mirrors `VSRCfindBr (vsrc/vsrcfbr.c:26-39)`.

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createInductorElement` factory signature (per A6.3). `branchIndex` starts at `-1`; `setup()` populates it.
- Remove `branchCount: 1` from `MnaModel` registration (per A6.2).
- `mayCreateInternalNodes` omitted (no internal nodes).
- Add `ngspiceNodeMap: { A: "pos", B: "neg" }` to `ComponentDefinition` (`InductorDefinition`).
- Add `findBranchFor` callback to `MnaModel` entry.

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
