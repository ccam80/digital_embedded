# Task PB-XFMR

**digiTS file:** `src/components/passives/transformer.ts`
**New file:** `src/components/passives/mutual-inductor.ts`
**ngspice setup anchor (IND):** `ref/ngspice/src/spicelib/devices/ind/indsetup.c:84-100`
**ngspice setup anchor (MUT):** `ref/ngspice/src/spicelib/devices/ind/mutsetup.c:30-70`
**ngspice load anchor (IND):** `ref/ngspice/src/spicelib/devices/ind/indload.c`
**ngspice load anchor (MUT):** `ref/ngspice/src/spicelib/devices/ind/mutload.c`

## Pin mapping (from 01-pin-mapping.md)

The transformer composite does not get an `ngspiceNodeMap` on `ComponentDefinition` — it decomposes into sub-elements.

Sub-element maps:
- `L1` (primary winding IND): `{ P1: "pos", P2: "neg" }`
- `L2` (secondary winding IND): `{ S1: "pos", S2: "neg" }`
- `MUT` (coupling element): no pin map (uses refs to L1.branchIndex, L2.branchIndex directly)

| Sub-element | digiTS pin label | ngspice node variable |
|---|---|---|
| L1 | `P1` | `INDposNode` |
| L1 | `P2` | `INDnegNode` |
| L2 | `S1` | `INDposNode` |
| L2 | `S2` | `INDnegNode` |

## Internal nodes

None. Neither IND nor MUT allocates internal voltage nodes via `CKTmkVolt`.

## Branch rows

Two branch rows — one per inductor winding:
- `L1.branchIndex`: allocated via `ctx.makeCur(l1.label, "branch")` in `L1.setup(ctx)`
- `L2.branchIndex`: allocated via `ctx.makeCur(l2.label, "branch")` in `L2.setup(ctx)`

`MUT.setup(ctx)` reads `this._l1.branchIndex` and `this._l2.branchIndex` directly from its constructor-stored refs (the composite owns the refs, so `findDevice` is not needed).

## State slots

Per indsetup.c:78-79, each IND allocates 2 state slots:
- `L1`: `ctx.allocStates(2)` → slots for INDflux and INDvolt
- `L2`: `ctx.allocStates(2)` → slots for INDflux and INDvolt

MUT allocates no state slots (`NG_IGNORE(states)` at mutsetup.c:28).

Total: 4 state slots.

## TSTALLOC sequence (line-for-line port)

### L1 setup — indsetup.c:96-100

L1 uses pins `P1` (posNode) and `P2` (negNode), branch row `b1 = L1.branchIndex`:

| # | ngspice pair | digiTS pair | handle field on L1 |
|---|---|---|---|
| 1 | `(INDposNode, INDbrEq)` | `(p1Node, b1)` | `_hPIbr` |
| 2 | `(INDnegNode, INDbrEq)` | `(p2Node, b1)` | `_hNIbr` |
| 3 | `(INDbrEq, INDnegNode)` | `(b1, p2Node)` | `_hIbrN` |
| 4 | `(INDbrEq, INDposNode)` | `(b1, p1Node)` | `_hIbrP` |
| 5 | `(INDbrEq, INDbrEq)` | `(b1, b1)` | `_hIbrIbr` |

### L2 setup — indsetup.c:96-100

L2 uses pins `S1` (posNode) and `S2` (negNode), branch row `b2 = L2.branchIndex`:

| # | ngspice pair | digiTS pair | handle field on L2 |
|---|---|---|---|
| 6 | `(INDposNode, INDbrEq)` | `(s1Node, b2)` | `_hPIbr` |
| 7 | `(INDnegNode, INDbrEq)` | `(s2Node, b2)` | `_hNIbr` |
| 8 | `(INDbrEq, INDnegNode)` | `(b2, s2Node)` | `_hIbrN` |
| 9 | `(INDbrEq, INDposNode)` | `(b2, s1Node)` | `_hIbrP` |
| 10 | `(INDbrEq, INDbrEq)` | `(b2, b2)` | `_hIbrIbr` |

### MUT setup — mutsetup.c:66-67

MUT reads `MUTind1->INDbrEq` = `L1.branchIndex` and `MUTind2->INDbrEq` = `L2.branchIndex`:

| # | ngspice pair | digiTS pair | handle field on MUT |
|---|---|---|---|
| 11 | `(MUTind1->INDbrEq, MUTind2->INDbrEq)` | `(b1, b2)` | `_hBr1Br2` |
| 12 | `(MUTind2->INDbrEq, MUTind1->INDbrEq)` | `(b2, b1)` | `_hBr2Br1` |

## setup() body — alloc only

### Composite `AnalogTransformerElement.setup(ctx)`

```ts
setup(ctx: SetupContext): void {
  // Composite setup: call sub-elements in order L1, L2, MUT.
  // Ordering invariant: _l1.setup() and _l2.setup() MUST complete before
  // _mut.setup() is called, because _mut reads _l1.branchIndex and
  // _l2.branchIndex (set during IND setup) directly — no findDevice needed.
  this._l1.setup(ctx);
  this._l2.setup(ctx);
  this._mut.setup(ctx);
}
```

`_mut` is constructed at factory time as `new MutualInductorElement(coupling, _l1, _l2)`, so it already holds refs to `_l1` and `_l2` by the time `setup()` is called.

### New class `InductorSubElement` (in `mutual-inductor.ts`)

A lightweight inductor sub-element for use inside transformer composites. Implements the same `setup()` as `AnalogInductorElement` (PB-IND) but is not registered as a top-level MNA model.

```ts
// src/components/passives/mutual-inductor.ts
export class InductorSubElement {
  branchIndex: number = -1;
  private _hPIbr:   number = -1;
  private _hNIbr:   number = -1;
  private _hIbrN:   number = -1;
  private _hIbrP:   number = -1;
  private _hIbrIbr: number = -1;
  private _stateBase: number = -1;

  constructor(
    private readonly _posNode: number,  // INDposNode
    private readonly _negNode: number,  // INDnegNode
    private readonly _label: string,
  ) {}

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._posNode;
    const negNode = this._negNode;

    // indsetup.c:78-79 — *states += 2
    this._stateBase = ctx.allocStates(2);

    // indsetup.c:84-88 — CKTmkCur (idempotent guard)
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._label, "branch");
    }
    const b = this.branchIndex;

    // indsetup.c:96-100 — TSTALLOC sequence, line-for-line.
    this._hPIbr   = solver.allocElement(posNode, b);
    this._hNIbr   = solver.allocElement(negNode, b);
    this._hIbrN   = solver.allocElement(b, negNode);
    this._hIbrP   = solver.allocElement(b, posNode);
    this._hIbrIbr = solver.allocElement(b, b);
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    if (name !== this._label) return 0;
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._label, "branch");
    }
    return this.branchIndex;
  }
}
```

### New class `MutualInductorElement` (in `mutual-inductor.ts`)

```ts
export class MutualInductorElement {
  private _hBr1Br2: number = -1;
  private _hBr2Br1: number = -1;

  constructor(
    private readonly _coupling: number,
    private readonly _l1: InductorSubElement,
    private readonly _l2: InductorSubElement,
  ) {}

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    // mutsetup.c:44-57 — resolve inductor references via direct refs (no CKTfndDev needed).
    // mutsetup.c:66-67 — TSTALLOC sequence.
    const b1 = this._l1.branchIndex;
    const b2 = this._l2.branchIndex;
    if (b1 === -1 || b2 === -1) {
      throw new Error("MutualInductorElement.setup(): branchIndex not yet allocated on sub-inductor");
    }

    this._hBr1Br2 = solver.allocElement(b1, b2);  // (MUTind1->INDbrEq, MUTind2->INDbrEq)
    this._hBr2Br1 = solver.allocElement(b2, b1);  // (MUTind2->INDbrEq, MUTind1->INDbrEq)
  }
}
```

## load() body — value writes only

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/ind/indload.c` (for L1 and L2) and `ref/ngspice/src/spicelib/devices/ind/mutload.c` (for MUT), stamping through cached handles only. No `solver.allocElement` calls.

## Factory cleanup

The existing `AnalogTransformerElement` (a monolithic class stamping all entries inline in `load()`) is refactored into the three-sub-element architecture: `InductorSubElement` (L1) + `InductorSubElement` (L2) + `MutualInductorElement` (K).

`setParam` routes by key prefix:
- Keys starting with `L1.` → `this._l1.setParam(key.slice(3), value)`
- Keys starting with `L2.` → `this._l2.setParam(key.slice(3), value)`
- Keys `K` or `coupling` → `this._mut.setParam(key, value)`
- Keys `primaryInductance`, `turnsRatio` → recompute L1/L2 and coupling, delegate accordingly.
- All other (unrecognized) keys → throw `Error(`Unrecognized setParam key: ${key}`)`

Factory signature changes:
- Drop `internalNodeIds` and `branchIdx` parameters (per A6.3).
- Remove `branchCount: 2` from `MnaModel` registration (per A6.2).
- `mayCreateInternalNodes` omitted.
- `ComponentDefinition.ngspiceNodeMap` left undefined (composite).
- Add `findBranchFor` callback that delegates to `l1.findBranchFor` and `l2.findBranchFor`.

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
