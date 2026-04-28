# Task PB-CRYSTAL

**digiTS file:** `src/components/passives/crystal.ts`
**ngspice setup anchor (Rs):** `ref/ngspice/src/spicelib/devices/res/ressetup.c:46-49`
**ngspice setup anchor (Ls):** `ref/ngspice/src/spicelib/devices/ind/indsetup.c:78-100`
**ngspice setup anchor (Cs, C0):** `ref/ngspice/src/spicelib/devices/cap/capsetup.c:102-117`
**ngspice load anchor (Rs):** `ref/ngspice/src/spicelib/devices/res/resload.c`
**ngspice load anchor (Ls):** `ref/ngspice/src/spicelib/devices/ind/indload.c`
**ngspice load anchor (Cs, C0):** `ref/ngspice/src/spicelib/devices/cap/capload.c`

## Pin mapping (from 01-pin-mapping.md)

The crystal is a composite (Butterworth-Van Dyke model). No `ngspiceNodeMap` on `ComponentDefinition`. Sub-element pin assignments:

- `Rs` (series resistance RES): `{ A: "pos", n1: "neg" }` — between external pin A and internal node n1
- `Ls` (motional inductance IND): `{ n1: "pos", n2: "neg" }` — between internal node n1 and internal node n2, with branch row `b`
- `Cs` (motional capacitor CAP): `{ n2: "pos", B: "neg" }` — between internal node n2 and external pin B
- `C0` (shunt capacitor CAP): `{ A: "pos", B: "neg" }` — between external pin A and external pin B

| Sub-element | digiTS pin/node label | ngspice node variable |
|---|---|---|
| Rs | `A` (external) | `RESposNode` |
| Rs | `n1` (internal) | `RESnegNode` |
| Ls | `n1` (internal) | `INDposNode` |
| Ls | `n2` (internal) | `INDnegNode` |
| Cs | `n2` (internal) | `CAPposNode` |
| Cs | `B` (external) | `CAPnegNode` |
| C0 | `A` (external) | `CAPposNode` |
| C0 | `B` (external) | `CAPnegNode` |

## Internal nodes

Two internal nodes, allocated in `setup()`:
- `n1`: junction between Rs and Ls — `ctx.makeVolt(label, "n1")`
- `n2`: junction between Ls and Cs — `ctx.makeVolt(label, "n2")`

These replace the current `internalNodeIds[0]` and `internalNodeIds[1]` passed via factory (A6.3 cleanup).

## Branch rows

One branch row — for the motional inductance Ls:
- `b = ctx.makeCur(label, "Ls_branch")` — allocated in `setup()` with idempotent guard (indsetup.c:84-88 pattern).

Replaces the current `branchIdx` parameter passed to the factory (A6.3 cleanup).

## State slots

**State slots: 15 total.** This count matches the existing `CRYSTAL_SCHEMA` declaration. Allocate as a single block: `this._stateBase = ctx.allocStates(15)`. Per-slot semantics are defined by the existing CRYSTAL_SCHEMA in source — this spec does not re-derive them.

## TSTALLOC sequence (line-for-line port)

The crystal applies sub-element setup patterns in the order: Rs, Ls, Cs, C0.

**Ground-node skip rule:** Both n1 and n2 are internal nodes (allocated by `ctx.makeVolt`) and are always non-zero. External pins A and B may be ground in degenerate cases, but in standard usage they are non-zero. The existing `load()` uses ground-skip guards `if (n1 !== 0)` etc. In `setup()`, `allocElement` is idempotent — a (0, x) or (x, 0) call must be skipped because ground rows/columns are not part of the reduced MNA system. The TSTALLOC table below shows all entries; the implementer must guard each against ground following the same pattern used in the existing `load()` for the branch-row incidence entries.

**Note on Rs ground skip:** The current `load()` stamps Rs using `stampG(solver, nA, nA, G)` etc. without ground checks, because `stampG` internally handles the ground skip. In `setup()`, `allocElement` does NOT automatically skip ground. Therefore, each `allocElement(row, col)` call where either `row` or `col` might be 0 (ground) must be wrapped with a ground check. For Rs, nA and n1 are structural non-ground nodes in all typical uses (the crystal is never pinned to ground on the A terminal and the n1 internal node is always non-zero). However, the spec requires the implementer to follow the same guard pattern as the existing Ls incidence code, i.e. guard on the actual node value.

### Rs setup — ressetup.c:46-49 (A=posNode, n1=negNode)

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 1 | `(RESposNode, RESposNode)` | `(aNode, aNode)` | `_hRs_PP` |
| 2 | `(RESnegNode, RESnegNode)` | `(n1Node, n1Node)` | `_hRs_NN` |
| 3 | `(RESposNode, RESnegNode)` | `(aNode, n1Node)` | `_hRs_PN` |
| 4 | `(RESnegNode, RESposNode)` | `(n1Node, aNode)` | `_hRs_NP` |

### Ls setup — indsetup.c:78-100 (n1=posNode, n2=negNode, b=branchRow)

State allocation: `ctx.allocStates(15)` covers all crystal state slots (per CRYSTAL_SCHEMA).
Branch allocation: `b = ctx.makeCur(label, "Ls_branch")` (idempotent guard).

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 5 | `(INDposNode, INDbrEq)` | `(n1Node, b)` | `_hLs_PIbr` |
| 6 | `(INDnegNode, INDbrEq)` | `(n2Node, b)` | `_hLs_NIbr` |
| 7 | `(INDbrEq, INDnegNode)` | `(b, n2Node)` | `_hLs_IbrN` |
| 8 | `(INDbrEq, INDposNode)` | `(b, n1Node)` | `_hLs_IbrP` |
| 9 | `(INDbrEq, INDbrEq)` | `(b, b)` | `_hLs_IbrIbr` |

Note: The existing `load()` uses `if (n1 !== 0)` and `if (n2 !== 0)` guards on these four incidence entries. Since n1 and n2 are `ctx.makeVolt`-allocated internal nodes, they are always non-zero after setup. The implementer should still apply the guard for correctness. The `(b, b)` entry (entry #9) requires no ground guard since `b` is a branch row (always non-zero).

### Cs setup — capsetup.c:114-117 (n2=posNode, B=negNode)

State slots for Cs are included in the monolithic 15-slot `allocStates(15)` call above (slots 4-8 in CRYSTAL_SCHEMA).

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 10 | `(CAPposNode, CAPposNode)` | `(n2Node, n2Node)` | `_hCs_PP` |
| 11 | `(CAPnegNode, CAPnegNode)` | `(extBNode, extBNode)` | `_hCs_NN` |
| 12 | `(CAPposNode, CAPnegNode)` | `(n2Node, extBNode)` | `_hCs_PN` |
| 13 | `(CAPnegNode, CAPposNode)` | `(extBNode, n2Node)` | `_hCs_NP` |

Where `extBNode` = `pinNodes.get("B")` (external terminal B). The existing `load()` uses `stampG(solver, n2, nB, ...)` without explicit ground checks, but `stampG` skips ground internally. In `setup()`, apply explicit ground guards on `extBNode` and `n2Node`.

### C0 setup — capsetup.c:114-117 (A=posNode, B=negNode)

State slots for C0 are included in the monolithic 15-slot `allocStates(15)` call above (slots 8-12 in CRYSTAL_SCHEMA).

| # | ngspice pair | digiTS pair | handle field |
|---|---|---|---|
| 14 | `(CAPposNode, CAPposNode)` | `(aNode, aNode)` | `_hC0_PP` |
| 15 | `(CAPnegNode, CAPnegNode)` | `(bNode, bNode)` | `_hC0_NN` |
| 16 | `(CAPposNode, CAPnegNode)` | `(aNode, bNode)` | `_hC0_PN` |
| 17 | `(CAPnegNode, CAPposNode)` | `(bNode, aNode)` | `_hC0_NP` |

Note: `_hC0_NN` and `_hCs_NN` both address `(bNode, bNode)`. `solver.allocElement` is idempotent for duplicate `(row, col)` pairs — the same handle is returned for both. The existing `load()` calls `stampG(solver, n2, nB, geqCs)` and separately `stampG(solver, nA, nB, geqC0)`, both accumulating onto `(nB, nB)` — this is correct MNA behavior.

Total: 17 TSTALLOC entries (4 for Rs + 5 for Ls + 4 for Cs + 4 for C0).

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  const solver = ctx.solver;
  const aNode = this.pinNodeIds[0];  // external terminal A
  const bNode = this.pinNodeIds[1];  // external terminal B

  // Allocate 15 state slots as a monolithic block (CRYSTAL_SCHEMA).
  this._stateBase = ctx.allocStates(15);

  // Allocate internal nodes — replace internalNodeIds[0], internalNodeIds[1].
  const n1Node = ctx.makeVolt(this._label, "n1");  // Rs↔Ls junction
  const n2Node = ctx.makeVolt(this._label, "n2");  // Ls↔Cs junction
  this._n1Node = n1Node;
  this._n2Node = n2Node;

  // Allocate Ls branch row — indsetup.c:84-88 idempotent guard.
  if (this._branchIndex === -1) {
    this._branchIndex = ctx.makeCur(this._label, "Ls_branch");
  }
  const b = this._branchIndex;

  // Rs — ressetup.c:46-49 (aNode=pos, n1Node=neg)
  this._hRs_PP = solver.allocElement(aNode, aNode);
  this._hRs_NN = solver.allocElement(n1Node, n1Node);
  this._hRs_PN = solver.allocElement(aNode, n1Node);
  this._hRs_NP = solver.allocElement(n1Node, aNode);

  // Ls — indsetup.c:96-100 (n1Node=pos, n2Node=neg, b=branch)
  if (n1Node !== 0) this._hLs_PIbr = solver.allocElement(n1Node, b);
  if (n2Node !== 0) this._hLs_NIbr = solver.allocElement(n2Node, b);
  if (n2Node !== 0) this._hLs_IbrN = solver.allocElement(b, n2Node);
  if (n1Node !== 0) this._hLs_IbrP = solver.allocElement(b, n1Node);
  this._hLs_IbrIbr = solver.allocElement(b, b);

  // Cs — capsetup.c:114-117 (n2Node=pos, bNode=neg)
  if (n2Node !== 0) this._hCs_PP = solver.allocElement(n2Node, n2Node);
  if (bNode !== 0)  this._hCs_NN = solver.allocElement(bNode, bNode);
  if (n2Node !== 0 && bNode !== 0) this._hCs_PN = solver.allocElement(n2Node, bNode);
  if (bNode !== 0 && n2Node !== 0) this._hCs_NP = solver.allocElement(bNode, n2Node);

  // C0 — capsetup.c:114-117 (aNode=pos, bNode=neg)
  if (aNode !== 0) this._hC0_PP = solver.allocElement(aNode, aNode);
  if (bNode !== 0) this._hC0_NN = solver.allocElement(bNode, bNode);
  if (aNode !== 0 && bNode !== 0) this._hC0_PN = solver.allocElement(aNode, bNode);
  if (bNode !== 0 && aNode !== 0) this._hC0_NP = solver.allocElement(bNode, aNode);
}
```

Fields to add to `AnalogCrystalElement`:
```ts
private _stateBase: number = -1;
private _n1Node: number = -1;
private _n2Node: number = -1;
private _branchIndex: number = -1;
// Rs handles
private _hRs_PP: number = -1;  private _hRs_NN: number = -1;
private _hRs_PN: number = -1;  private _hRs_NP: number = -1;
// Ls handles
private _hLs_PIbr:   number = -1;  private _hLs_NIbr:   number = -1;
private _hLs_IbrN:   number = -1;  private _hLs_IbrP:   number = -1;
private _hLs_IbrIbr: number = -1;
// Cs handles
private _hCs_PP: number = -1;  private _hCs_NN: number = -1;
private _hCs_PN: number = -1;  private _hCs_NP: number = -1;
// C0 handles
private _hC0_PP: number = -1;  private _hC0_NN: number = -1;
private _hC0_PN: number = -1;  private _hC0_NP: number = -1;
```

The `readonly branchIndex` field on the current `AnalogCrystalElement` must become `private _branchIndex: number = -1;` (mutable, per A3). The constructor no longer receives `branchIndex` or `internalNodeIds` — those are populated in `setup()`. The existing `pinNodeIds` will become `[aNode, bNode]` (just the two external pins); `n1Node` and `n2Node` are stored as separate instance fields `_n1Node` and `_n2Node`.

**Constructor migration note:** The existing constructor takes `pinNodeIds: number[]` as `[n_A, n_B, n1, n2]` and `branchIndex: number`. After migration, the constructor takes only `[n_A, n_B]` for `pinNodeIds`. The `load()` body must be updated to read `n1 = this._n1Node` and `n2 = this._n2Node` and `b = this._branchIndex` instead of `this.pinNodeIds[2]`, `this.pinNodeIds[3]`, and `this.branchIndex`.

## load() body — value writes only

Implementer ports value-side equations from:
- `ref/ngspice/src/spicelib/devices/res/resload.c` — Rs conductance stamp via `_hRs_PP`, `_hRs_NN`, `_hRs_PN`, `_hRs_NP`
- `ref/ngspice/src/spicelib/devices/ind/indload.c` — Ls companion stamp via `_hLs_PIbr`, `_hLs_NIbr`, `_hLs_IbrN`, `_hLs_IbrP`, `_hLs_IbrIbr`
- `ref/ngspice/src/spicelib/devices/cap/capload.c` — Cs companion stamp via `_hCs_PP`, `_hCs_NN`, `_hCs_PN`, `_hCs_NP`; C0 companion stamp via `_hC0_PP`, `_hC0_NN`, `_hC0_PN`, `_hC0_NP`

All stamps use cached handles only. No `solver.allocElement` calls in `load()`. The NIintegrate calls (for Ls flux, Cs charge, C0 charge) remain unchanged from the existing implementation — only the matrix write calls change from `stampG(solver, ...)` / `solver.stampElement(solver.allocElement(...), v)` to `solver.stampElement(handle, v)`.

## findBranchFor

The crystal exposes a branch row for Ls and must implement `findBranchFor` so CCCS/CCVS elements can resolve the Ls branch number:

```ts
findBranchFor(name: string, ctx: SetupContext): number {
  // Look up the device by namespaced label (auto-registered per 00-engine.md §A4.1 recursive _deviceMap walk).
  const el = ctx.findDevice(name);
  if (!el) return 0;
  // The element owns its branch row (Ls branch). Lazy-allocate if needed.
  if (el.branchIndex === -1) {
    el.branchIndex = ctx.makeCur(name, "Ls_branch");
  }
  return el.branchIndex;
}
```

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createCrystalElement` factory signature (per A6.3). Both are now allocated in `setup()`.
- Remove `branchCount: 1` from `modelRegistry` entry (per A6.2).
- Add `findBranchFor` callback to `modelRegistry` entry (branch allocation is the source of truth; no boolean flag needed).
- Add `mayCreateInternalNodes: true` to `modelRegistry` entry.
- `ComponentDefinition.ngspiceNodeMap` left undefined (composite decomposes).
- Add `findBranchFor` callback to `MnaModel` entry (delegates to `AnalogCrystalElement.findBranchFor`).

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
