# Task PB-TAPXFMR

**digiTS file:** `src/components/passives/tapped-transformer.ts`
**ngspice setup anchor (IND):** `ref/ngspice/src/spicelib/devices/ind/indsetup.c:84-100`
**ngspice setup anchor (MUT):** `ref/ngspice/src/spicelib/devices/ind/mutsetup.c:30-70`
**ngspice load anchor (IND):** `ref/ngspice/src/spicelib/devices/ind/indload.c`
**ngspice load anchor (MUT):** `ref/ngspice/src/spicelib/devices/ind/mutload.c`

## Pin mapping (from 01-pin-mapping.md)

The tapped transformer composite does not get an `ngspiceNodeMap` on `ComponentDefinition` — it decomposes into sub-elements.

Sub-element maps:
- `L1` (primary winding IND): `{ P1: "pos", P2: "neg" }`
- `L2` (secondary half-1 IND): `{ S1: "pos", CT: "neg" }`
- `L3` (secondary half-2 IND): `{ CT: "pos", S2: "neg" }`
- `MUT12`, `MUT13`, `MUT23` (coupling elements): no pin map (use refs to L1/L2/L3.branchIndex directly)

| Sub-element | digiTS pin label | ngspice node variable |
|---|---|---|
| L1 | `P1` | `INDposNode` |
| L1 | `P2` | `INDnegNode` |
| L2 | `S1` | `INDposNode` |
| L2 | `CT` | `INDnegNode` |
| L3 | `CT` | `INDposNode` |
| L3 | `S2` | `INDnegNode` |

**Note:** `CT` is shared between L2 (as neg) and L3 (as pos). This is the defining topology of the center-tapped secondary. The same MNA node number is passed as `negNode` for L2 and as `posNode` for L3.

## Internal nodes

None. Neither IND nor MUT allocates internal voltage nodes via `CKTmkVolt`.

## Branch rows

Three branch rows — one per inductor winding:
- `L1.branchIndex`: allocated via `ctx.makeCur(l1.label, "branch")` in `L1.setup(ctx)`
- `L2.branchIndex`: allocated via `ctx.makeCur(l2.label, "branch")` in `L2.setup(ctx)`
- `L3.branchIndex`: allocated via `ctx.makeCur(l3.label, "branch")` in `L3.setup(ctx)`

Each `MUTij.setup(ctx)` reads `this._li.branchIndex` and `this._lj.branchIndex` from its constructor-stored refs directly. No `findDevice` needed — composite owns refs.

## State slots

Per indsetup.c:78-79, each IND allocates 2 state slots. MUT allocates none.

- `L1`: `ctx.allocStates(2)` → INDflux + INDvolt
- `L2`: `ctx.allocStates(2)` → INDflux + INDvolt
- `L3`: `ctx.allocStates(2)` → INDflux + INDvolt

Total: 6 state slots.

## TSTALLOC sequence (line-for-line port)

### L1 setup — indsetup.c:96-100 (P1 pos, P2 neg, b1)

| # | ngspice pair | digiTS pair | handle field on L1 |
|---|---|---|---|
| 1 | `(INDposNode, INDbrEq)` | `(p1Node, b1)` | `_hPIbr` |
| 2 | `(INDnegNode, INDbrEq)` | `(p2Node, b1)` | `_hNIbr` |
| 3 | `(INDbrEq, INDnegNode)` | `(b1, p2Node)` | `_hIbrN` |
| 4 | `(INDbrEq, INDposNode)` | `(b1, p1Node)` | `_hIbrP` |
| 5 | `(INDbrEq, INDbrEq)` | `(b1, b1)` | `_hIbrIbr` |

### L2 setup — indsetup.c:96-100 (S1 pos, CT neg, b2)

| # | ngspice pair | digiTS pair | handle field on L2 |
|---|---|---|---|
| 6 | `(INDposNode, INDbrEq)` | `(s1Node, b2)` | `_hPIbr` |
| 7 | `(INDnegNode, INDbrEq)` | `(ctNode, b2)` | `_hNIbr` |
| 8 | `(INDbrEq, INDnegNode)` | `(b2, ctNode)` | `_hIbrN` |
| 9 | `(INDbrEq, INDposNode)` | `(b2, s1Node)` | `_hIbrP` |
| 10 | `(INDbrEq, INDbrEq)` | `(b2, b2)` | `_hIbrIbr` |

### L3 setup — indsetup.c:96-100 (CT pos, S2 neg, b3)

| # | ngspice pair | digiTS pair | handle field on L3 |
|---|---|---|---|
| 11 | `(INDposNode, INDbrEq)` | `(ctNode, b3)` | `_hPIbr` |
| 12 | `(INDnegNode, INDbrEq)` | `(s2Node, b3)` | `_hNIbr` |
| 13 | `(INDbrEq, INDnegNode)` | `(b3, s2Node)` | `_hIbrN` |
| 14 | `(INDbrEq, INDposNode)` | `(b3, ctNode)` | `_hIbrP` |
| 15 | `(INDbrEq, INDbrEq)` | `(b3, b3)` | `_hIbrIbr` |

### MUT12 setup — mutsetup.c:66-67 (L1 ↔ L2)

| # | ngspice pair | digiTS pair | handle field on MUT12 |
|---|---|---|---|
| 16 | `(MUTind1->INDbrEq, MUTind2->INDbrEq)` | `(b1, b2)` | `_hBr1Br2` |
| 17 | `(MUTind2->INDbrEq, MUTind1->INDbrEq)` | `(b2, b1)` | `_hBr2Br1` |

### MUT13 setup — mutsetup.c:66-67 (L1 ↔ L3)

| # | ngspice pair | digiTS pair | handle field on MUT13 |
|---|---|---|---|
| 18 | `(MUTind1->INDbrEq, MUTind2->INDbrEq)` | `(b1, b3)` | `_hBr1Br2` |
| 19 | `(MUTind2->INDbrEq, MUTind1->INDbrEq)` | `(b3, b1)` | `_hBr2Br1` |

### MUT23 setup — mutsetup.c:66-67 (L2 ↔ L3)

| # | ngspice pair | digiTS pair | handle field on MUT23 |
|---|---|---|---|
| 20 | `(MUTind1->INDbrEq, MUTind2->INDbrEq)` | `(b2, b3)` | `_hBr1Br2` |
| 21 | `(MUTind2->INDbrEq, MUTind1->INDbrEq)` | `(b3, b2)` | `_hBr2Br1` |

Total: 21 TSTALLOC entries.

## setup() body — alloc only

```ts
setup(ctx: SetupContext): void {
  // Composite setup: call sub-elements in NGSPICE_LOAD_ORDER — IND before MUT.
  // Order: L1, L2, L3 (INDs), then MUT12, MUT13, MUT23.
  // MUT setup reads li.branchIndex directly — no findDevice needed.

  this._l1.setup(ctx);   // indsetup.c pattern: allocStates(2) + makeCur + 5×allocElement
  this._l2.setup(ctx);   // indsetup.c pattern: allocStates(2) + makeCur + 5×allocElement
  this._l3.setup(ctx);   // indsetup.c pattern: allocStates(2) + makeCur + 5×allocElement

  // MUT instances require INDbrEq to be set on both inductors before calling setup.
  // Ordering invariant: all three IND setup() calls MUST complete before any MUT setup() call.
  // Each MutualInductorElement holds refs to its two inductors (stored at construction time).
  this._mut12.setup(ctx);  // mutsetup.c: 2×allocElement
  this._mut13.setup(ctx);  // mutsetup.c: 2×allocElement
  this._mut23.setup(ctx);  // mutsetup.c: 2×allocElement
}
```

Sub-element classes reuse `InductorSubElement` and `MutualInductorElement` from `src/components/passives/mutual-inductor.ts` (introduced by PB-XFMR). The tapped transformer composite constructs:
- `_l1 = new InductorSubElement(p1Node, p2Node, label + "_L1")`
- `_l2 = new InductorSubElement(s1Node, ctNode, label + "_L2")`
- `_l3 = new InductorSubElement(ctNode, s2Node, label + "_L3")`
- `_mut12 = new MutualInductorElement(m12_coupling, _l1, _l2)`
- `_mut13 = new MutualInductorElement(m13_coupling, _l1, _l3)`
- `_mut23 = new MutualInductorElement(m23_coupling, _l2, _l3)`

## load() body — value writes only

Implementer ports value-side equations from `ref/ngspice/src/spicelib/devices/ind/indload.c` (for L1, L2, L3) and `ref/ngspice/src/spicelib/devices/ind/mutload.c` (for MUT12, MUT13, MUT23), stamping through cached handles only. No `solver.allocElement` calls.

The existing `AnalogTappedTransformerElement.load()` monolithic implementation is replaced by delegated calls to each sub-element's `load()`. The composite `load()` body:

```ts
load(ctx: LoadContext): void {
  this._l1.load(ctx);
  this._l2.load(ctx);
  this._l3.load(ctx);
  this._mut12.load(ctx, this._l1, this._l2);
  this._mut13.load(ctx, this._l1, this._l3);
  this._mut23.load(ctx, this._l2, this._l3);
}
```

## Factory cleanup

- Drop `internalNodeIds` and `branchIdx` parameters from `createTappedTransformerElement` factory signature (per A6.3).
- Remove `branchCount: 3` from `MnaModel` registration (per A6.2).
- `mayCreateInternalNodes` omitted.
- `ComponentDefinition.ngspiceNodeMap` left undefined (composite).
- Add `findBranchFor` callback that delegates to `l1.findBranchFor`, `l2.findBranchFor`, `l3.findBranchFor` (first non-zero wins).

`setParam` routes by key prefix:
- `L1.*` → `this._l1.setParam(key.slice(3), value)`
- `L2.*` → `this._l2.setParam(key.slice(3), value)`
- `L3.*` → `this._l3.setParam(key.slice(3), value)`
- `K12`, `K13`, `K23` → respective MUT elements
- `primaryInductance`: recompute `L1 = primaryInductance`, `L2 = primaryInductance × turnsRatio²`, `L3 = primaryInductance × turnsRatio²`, then call `this._l1.setParam("L", L1)`, `this._l2.setParam("L", L2)`, `this._l3.setParam("L", L3)`.
- `turnsRatio`: recompute `L2 = primaryInductance × turnsRatio²`, `L3 = primaryInductance × turnsRatio²`, then call `this._l2.setParam("L", L2)`, `this._l3.setParam("L", L3)`.
- `couplingCoefficient`: call `this._mut12.setParam("coupling", value)`, `this._mut13.setParam("coupling", value)`, `this._mut23.setParam("coupling", value)`.

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
